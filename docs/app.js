/* STS Voice Studio – chạy hoàn toàn trên trình duyệt */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ================= ĐĂNG NHẬP =================
 * Lưu ý: website tĩnh (GitHub Pages) nên đây là lớp khoá ở phía trình duyệt,
 * chỉ lưu mã băm SHA-256 của "user:pass", không lưu mật khẩu dạng chữ.     */
const AUTH_HASH = 'b0336d1da7a2cac035e27ee79276d3d5d5b2c784502de9de8860078bbc5db1a8';

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function isAuthed() {
  return sessionStorage.getItem('auth') === AUTH_HASH || localStorage.getItem('auth') === AUTH_HASH;
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const h = await sha256($('#loginUser').value.trim() + ':' + $('#loginPass').value);
    if (h !== AUTH_HASH) { $('#loginErr').textContent = 'Sai tài khoản hoặc mật khẩu'; $('#loginPass').value = ''; return; }
    ($('#loginRemember').checked ? localStorage : sessionStorage).setItem('auth', AUTH_HASH);
    $('#loginPass').value = '';
    unlock();
  } catch (err) {
    $('#loginErr').textContent = 'Trình duyệt không hỗ trợ đăng nhập an toàn (cần https): ' + err.message;
  }
};
$('#logoutBtn').onclick = () => {
  sessionStorage.removeItem('auth');
  localStorage.removeItem('auth');
  location.reload();
};

/* Chặn mọi thao tác trong Studio khi chưa đăng nhập (kể cả khi CSS bị lỗi/cache cũ) */
function lock() {
  document.body.classList.add('locked');
  $('#app').hidden = true;
}
['click', 'change', 'input', 'submit', 'keydown', 'drop'].forEach((ev) => {
  $('#app').addEventListener(ev, (e) => {
    if (!isAuthed()) { e.stopImmediatePropagation(); e.preventDefault(); lock(); }
  }, true);
});

/* ================= STATE ================= */
const FORMAT_CHAIN = ['pcm_48000', 'pcm_44100', 'pcm_24000', 'pcm_22050', 'pcm_16000'];
const S = {
  base: 'https://api.elevenlabs.io',
  dir: null,
  apiKey: localStorage.getItem('xi_key') || '',
  voices: [],
  models: [],
  lines: [],
  nextId: 1,
  extraChars: JSON.parse(localStorage.getItem('extra_chars') || '[]'),
  selected: new Set(),
  sheets: [],
  cols: {},
  mapping: JSON.parse(localStorage.getItem('voice_map') || '{}'),
  workingFormat: null,
  stop: false,
  history: [],
};

/* ================= UTILS ================= */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 't ' + type;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 8000 : 4000);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saveMap = () => localStorage.setItem('voice_map', JSON.stringify(S.mapping));
const savePref = (k, v) => localStorage.setItem('pref_' + k, v);
const getPref = (k, d) => localStorage.getItem('pref_' + k) ?? d;
const fsSafe = (s) => String(s).replace(/[\/\\:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim();
const stripTags = (t) => String(t || '').replace(/\[[^\]]*\]\s*/g, '').trim();

async function errText(res) {
  const t = await res.text();
  try {
    const d = JSON.parse(t).detail;
    if (typeof d === 'string') return d;
    if (d?.message) return (d.status ? d.status + ': ' : '') + d.message;
    if (Array.isArray(d)) return d.map((x) => x.msg).join('; ');
    return t;
  } catch { return t || res.statusText; }
}

async function xi(path, opts = {}) {
  if (!isAuthed()) { lock(); throw new Error('Cần đăng nhập'); }
  if (!S.apiKey) throw new Error('Chưa nhập API key');
  const doFetch = () => fetch(S.base + path, { ...opts, headers: { 'xi-api-key': S.apiKey, ...(opts.headers || {}) } });
  let res;
  try {
    res = await doFetch();
  } catch (e) {
    if (S.base !== '/eleven' && /localhost|127\.0\.0\.1/.test(location.hostname)) { S.base = '/eleven'; res = await doFetch(); }
    else throw new Error('Không gọi được api.elevenlabs.io: ' + e.message);
  }
  if (!res.ok) {
    const e = new Error(`[${res.status}] ${await errText(res)}`);
    e.status = res.status;
    throw e;
  }
  return res;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ================= FILE SYSTEM ================= */
const FS_OK = 'showDirectoryPicker' in window;
const idb = {
  db: () => new Promise((ok, fail) => {
    const r = indexedDB.open('voice-studio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  }),
  async get(k) { const d = await this.db(); return new Promise((ok) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); }); },
  async set(k, v) { const d = await this.db(); return new Promise((ok) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = ok; }); },
};
async function ensureDirPermission() {
  if (!S.dir) return false;
  const opt = { mode: 'readwrite' };
  if ((await S.dir.queryPermission(opt)) === 'granted') return true;
  return (await S.dir.requestPermission(opt)) === 'granted';
}
async function getSubDir(subPath, create) {
  let d = S.dir;
  for (const part of String(subPath || '').split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}
async function fileExists(subPath, filename) {
  if (!S.dir) return false;
  try { await (await getSubDir(subPath, false)).getFileHandle(filename); return true; } catch { return false; }
}
async function writeFile(subPath, filename, blob) {
  if (!S.dir) {
    const name = (subPath ? subPath.replace(/\//g, '_') + '_' : '') + filename;
    downloadBlob(blob, name);
    return name;
  }
  const d = await getSubDir(subPath, true);
  const w = await (await d.getFileHandle(filename, { create: true })).createWritable();
  await w.write(blob);
  await w.close();
  return `${S.dir.name}/${subPath ? subPath + '/' : ''}${filename}`;
}
async function pickFolder() {
  if (!FS_OK) { toast('Trình duyệt không hỗ trợ chọn thư mục. Hãy dùng Chrome hoặc Edge.', 'err'); return false; }
  try {
    S.dir = await window.showDirectoryPicker({ id: 'voice-out', mode: 'readwrite' });
    $('#outFolder').value = S.dir.name;
    await idb.set('outDir', S.dir);
    return true;
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); return false; }
}

/* ================= AUDIO ================= */
function pcmToWav(pcmBuf, rate, bits = 16, ch = 1) {
  const len = pcmBuf.byteLength;
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); h.setUint32(4, 36 + len, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * bits / 8, true);
  h.setUint16(32, ch * bits / 8, true); h.setUint16(34, bits, true);
  str(36, 'data'); h.setUint32(40, len, true);
  return new Blob([h.buffer, pcmBuf], { type: 'audio/wav' });
}
function formatInfo(fmt) {
  if (fmt.startsWith('pcm_')) return { ext: 'wav', mime: 'audio/wav' };
  if (fmt.startsWith('mp3_')) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (fmt.startsWith('opus_')) return { ext: 'opus', mime: 'audio/ogg' };
  return { ext: 'raw', mime: 'application/octet-stream' };
}
async function toAudioBlob(res, fmt) {
  const buf = await res.arrayBuffer();
  if (fmt.startsWith('pcm_')) return pcmToWav(buf, +fmt.split('_')[1]);
  if (fmt.startsWith('ulaw_')) return ulawToWav(buf);
  return new Blob([buf], { type: formatInfo(fmt).mime });
}
function ulawToWav(buf) {
  const u = new Uint8Array(buf), out = new Int16Array(u.length);
  for (let i = 0; i < u.length; i++) {
    const x = ~u[i] & 0xff, sign = x & 0x80, exp = (x >> 4) & 7, man = x & 0x0f;
    let s = ((man << 3) + 0x84) << exp; s -= 0x84;
    out[i] = sign ? -s : s;
  }
  return pcmToWav(out.buffer, 8000);
}

/* ================= XLSX ================= */
async function readZip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('File không phải .xlsx hợp lệ');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    entries[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + nlen + elen + clen;
  }
  return {
    async text(name) {
      const e = entries[name];
      if (!e) return null;
      if (e.method === 0) return dec.decode(e.data);
      return new Response(new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    },
  };
}
async function parseXlsx(buf) {
  const zip = await readZip(buf);
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const tags = (node, name) => [...node.getElementsByTagNameNS('*', name)];
  const textOf = (node) => tags(node, 't').map((t) => t.textContent).join('');
  const shared = [];
  const ss = await zip.text('xl/sharedStrings.xml');
  if (ss) tags(xml(ss), 'si').forEach((si) => shared.push(textOf(si)));
  const rels = {};
  const relXml = await zip.text('xl/_rels/workbook.xml.rels');
  if (relXml) tags(xml(relXml), 'Relationship').forEach((r) => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
  const wb = xml(await zip.text('xl/workbook.xml'));
  const sheets = [];
  const sheetEls = tags(wb, 'sheet');
  for (let i = 0; i < sheetEls.length; i++) {
    const el = sheetEls[i];
    const rid = el.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || el.getAttribute('r:id');
    let target = (rels[rid] || `worksheets/sheet${i + 1}.xml`).replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target;
    const sx = await zip.text(target);
    if (!sx) continue;
    const rows = [];
    tags(xml(sx), 'c').forEach((c) => {
      const m = /^([A-Z]+)(\d+)$/.exec(c.getAttribute('r') || '');
      if (!m) return;
      const col = [...m[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = c.getAttribute('t');
      const v = tags(c, 'v')[0]?.textContent ?? '';
      const val = t === 's' ? (shared[+v] ?? '') : t === 'inlineStr' ? textOf(c) : v;
      if (val === '') return;
      (rows[+m[2] - 1] ||= [])[col] = val;
    });
    sheets.push({ name: el.getAttribute('name'), rows: Array.from(rows, (r) => Array.from(r || [], (x) => x ?? '')) });
  }
  return sheets;
}

/* ================= TABS ================= */
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'generate') renderGenTable();
}));

/* ================= VOICE SETTINGS (dùng chung) ================= */
const VS_DEF = { Stab: 0.5, Sim: 0.75, Style: 0, Speed: 1 };
function buildVS(p) {
  const box = $(`.vs[data-prefix="${p}"]`);
  box.innerHTML = `
    <div class="field">
      <label>Độ ổn định <b id="${p}StabV" class="val"></b></label>
      <input type="range" id="${p}Stab" min="0" max="1" step="0.05">
      <div class="range-ends"><span>Biểu cảm hơn</span><span>Ổn định hơn</span></div>
    </div>
    <div class="field">
      <label>Độ giống giọng gốc <b id="${p}SimV" class="val"></b></label>
      <input type="range" id="${p}Sim" min="0" max="1" step="0.05">
      <div class="range-ends"><span>Thấp</span><span>Cao</span></div>
    </div>
    <div class="field">
      <label>Phóng đại phong cách <b id="${p}StyleV" class="val"></b></label>
      <input type="range" id="${p}Style" min="0" max="1" step="0.05">
      <div class="range-ends"><span>Không</span><span>Phóng đại</span></div>
    </div>
    <div class="field">
      <label>Tốc độ <b id="${p}SpeedV" class="val"></b></label>
      <input type="range" id="${p}Speed" min="0.7" max="1.2" step="0.01">
      <div class="range-ends"><span>Chậm</span><span>Nhanh</span></div>
    </div>
    <label class="switch"><input type="checkbox" id="${p}Boost"><span></span> Speaker boost</label>
    <small class="hint">Model v3 chỉ dùng độ ổn định 0 / 0.5 / 1 (Creative / Natural / Robust).</small>`;
  Object.keys(VS_DEF).forEach((k) => {
    const el = $('#' + p + k);
    el.value = getPref(p + k, VS_DEF[k]);
    $('#' + p + k + 'V').textContent = el.value;
    el.oninput = () => { $('#' + p + k + 'V').textContent = el.value; savePref(p + k, el.value); };
  });
  const b = $('#' + p + 'Boost');
  b.checked = getPref(p + 'Boost', '1') === '1';
  b.onchange = () => savePref(p + 'Boost', b.checked ? '1' : '0');
}
function resetVS(p) {
  Object.keys(VS_DEF).forEach((k) => { localStorage.removeItem('pref_' + p + k); });
  localStorage.removeItem('pref_' + p + 'Boost');
  buildVS(p);
}
const isV3 = (model) => /eleven_v3|v4/.test(model || '');
function readVS(p, model) {
  let stab = +$('#' + p + 'Stab').value;
  if (isV3(model)) stab = [0, 0.5, 1].reduce((a, b) => (Math.abs(b - stab) < Math.abs(a - stab) ? b : a));
  const vs = { stability: stab, similarity_boost: +$('#' + p + 'Sim').value, style: +$('#' + p + 'Style').value, use_speaker_boost: $('#' + p + 'Boost').checked };
  if (+$('#' + p + 'Speed').value !== 1) vs.speed = +$('#' + p + 'Speed').value;
  return vs;
}

/* Gọi TTS – tự bỏ language_code nếu model không hỗ trợ */
async function tts(voiceId, text, format, o) {
  const body = { text, model_id: o.model, voice_settings: o.vs };
  if (o.lang) body.language_code = o.lang;
  if (o.seed !== undefined && o.seed !== '') body.seed = +o.seed;
  if (o.norm && o.norm !== 'auto') body.apply_text_normalization = o.norm;
  const call = () => xi(`/v1/text-to-speech/${voiceId}?output_format=${format}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/*' }, body: JSON.stringify(body),
  });
  try { return await call(); } catch (e) {
    if ((e.status === 400 || e.status === 422) && /language/i.test(e.message) && body.language_code) { delete body.language_code; return call(); }
    if ((e.status === 400 || e.status === 422) && /normaliz/i.test(e.message) && body.apply_text_normalization) { delete body.apply_text_normalization; return call(); }
    throw e;
  }
}

/* ================= TAB 1: API ================= */
$('#apiKey').value = S.apiKey;
$('#toggleKey').onclick = () => { const i = $('#apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#connectBtn').onclick = connect;
$('#refreshVoices').onclick = loadVoices;
$('#onlyCloned').onchange = renderVoices;
$('#voiceSearch').oninput = renderVoices;

$('#clearKeyBtn').onclick = () => {
  if (!confirm('Xoá sạch API key khỏi trình duyệt này?')) return;
  localStorage.removeItem('xi_key');
  sessionStorage.removeItem('xi_key');
  S.apiKey = '';
  S.base = 'https://api.elevenlabs.io';
  S.voices = [];
  S.models = [];
  $('#apiKey').value = '';
  $('#apiKey').type = 'password';
  $('#accountInfo').textContent = '🗑 Đã xoá API key. Chưa kết nối.';
  setConn('off', 'Chưa kết nối');
  $$('.model-select').forEach((s) => { s.innerHTML = ''; });
  renderVoices(); renderChars(); fillVoiceSelects(); renderGenTable();
  toast('Đã xoá sạch API key', 'ok');
};

function setConn(state, text) {
  const p = $('#connPill');
  p.className = 'pill ' + state;
  p.querySelector('.txt').textContent = text;
  p.title = text;
}

async function connect() {
  S.apiKey = $('#apiKey').value.trim();
  if (!S.apiKey) return toast('Nhập API key', 'err');
  localStorage.setItem('xi_key', S.apiKey);
  $('#accountInfo').textContent = 'Đang kết nối…';
  setConn('busy', 'Đang kết nối…');
  try {
    let tier = '';
    try {
      const sub = await (await xi('/v1/user/subscription')).json();
      tier = sub.tier || '';
      $('#accountInfo').innerHTML = `✅ Đã kết nối • Gói: <b>${esc(sub.tier)}</b> • Ký tự: ${(sub.character_count || 0).toLocaleString()} / ${(sub.character_limit || 0).toLocaleString()} • Giọng tối đa: ${sub.voice_limit ?? '?'}`;
    } catch (e) {
      if (e.status === 401 && !/permission/i.test(e.message)) throw e;
      $('#accountInfo').textContent = '✅ Đã kết nối (key không có quyền đọc thông tin gói).';
    }
    await Promise.all([loadVoices(), loadModels()]);
    setConn('on', 'Đã kết nối' + (tier ? ' · ' + tier : ''));
    toast('Kết nối thành công', 'ok');
  } catch (e) {
    $('#accountInfo').textContent = '❌ ' + e.message;
    setConn('err', 'Lỗi kết nối');
    toast(e.message, 'err');
  }
}

async function loadVoices() {
  try {
    const j = await (await xi('/v1/voices?show_legacy=true')).json();
    S.voices = (j.voices || []).sort((a, b) => a.name.localeCompare(b.name));
    renderVoices(); renderChars(); fillVoiceSelects(); renderGenTable();
  } catch (e) { toast('Tải giọng lỗi: ' + e.message, 'err'); }
}

async function loadModels() {
  try {
    const list = await (await xi('/v1/models')).json();
    S.models = list.filter((m) => m.can_do_text_to_speech);
    const ids = S.models.map((m) => m.model_id);
    const def = ids.find((i) => /v4/.test(i)) || ids.find((i) => i === 'eleven_v3') || ids.find((i) => /multilingual_v2/.test(i)) || ids[0];
    $$('.model-select').forEach((sel) => {
      sel.innerHTML = S.models.map((m) => `<option value="${esc(m.model_id)}">${esc(m.name)} (${esc(m.model_id)})</option>`).join('');
      const saved = getPref(sel.id, '');
      sel.value = ids.includes(saved) ? saved : def;
      sel.onchange = () => savePref(sel.id, sel.value);
    });
  } catch (e) { toast('Tải models lỗi: ' + e.message, 'err'); }
}

const ownVoice = (v) => v.category !== 'premade';

function renderVoices() {
  const only = $('#onlyCloned').checked, q = $('#voiceSearch').value.trim().toLowerCase();
  const list = S.voices.filter((v) => (!only || ownVoice(v)) && (!q || v.name.toLowerCase().includes(q)));
  if (!list.length) { $('#voiceList').innerHTML = `<p class="empty">${S.apiKey ? 'Không có giọng nào.' : 'Kết nối API để tải giọng.'}</p>`; return; }
  $('#voiceList').innerHTML = list.map((v) => `
    <div class="voice">
      <b>${esc(v.name)}</b>
      <div class="meta"><span class="badge">${esc(v.category)}</span>${esc(v.voice_id)}</div>
      ${v.preview_url ? `<audio controls preload="none" src="${esc(v.preview_url)}"></audio>` : ''}
      <div class="row" style="margin-top:8px">
        <button class="ghost small" data-copy="${esc(v.voice_id)}">Copy ID</button>
        <button class="ghost small" data-usetts="${esc(v.voice_id)}">🔊 Dùng để tạo voice</button>
        ${ownVoice(v) ? `<button class="ghost small" data-del="${esc(v.voice_id)}">🗑</button>` : ''}
      </div>
    </div>`).join('');
}
$('#voiceList').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) { navigator.clipboard.writeText(b.dataset.copy); toast('Đã copy ID'); }
  if (b.dataset.usetts) { setTtsVoice(b.dataset.usetts); $('.tab[data-tab="tts"]').click(); }
  if (b.dataset.del) {
    const v = S.voices.find((x) => x.voice_id === b.dataset.del);
    if (!confirm(`Xoá giọng "${v?.name}" khỏi tài khoản ElevenLabs? Không thể hoàn tác.`)) return;
    try { await xi('/v1/voices/' + b.dataset.del, { method: 'DELETE' }); toast('Đã xoá', 'ok'); loadVoices(); }
    catch (err) { toast(err.message, 'err'); }
  }
};

function voiceOptions(sel, emptyLabel = '— chưa gán —') {
  const own = S.voices.filter(ownVoice), pre = S.voices.filter((v) => !ownVoice(v));
  const o = (v) => `<option value="${esc(v.voice_id)}" ${v.voice_id === sel ? 'selected' : ''}>${esc(v.name)}</option>`;
  return `<option value="">${emptyLabel}</option>`
    + (own.length ? `<optgroup label="Giọng clone / của tôi">${own.map(o).join('')}</optgroup>` : '')
    + (pre.length ? `<optgroup label="Giọng có sẵn">${pre.map(o).join('')}</optgroup>` : '');
}
function fillVoiceSelects() {
  const cur = $('#ttsVoice').value || getPref('ttsVoice', '');
  $('#ttsVoice').innerHTML = voiceOptions(cur, '— chọn giọng —');
  if (cur && !S.voices.some((v) => v.voice_id === cur)) $('#ttsVoice').value = '';
  updatePickerLabel();
  if (!$('#vpPanel').classList.contains('hidden')) renderPicker();
}

/* ---------- Bộ chọn giọng có nghe thử (giống ElevenLabs) ---------- */
const player = new Audio();
let playingId = null;
const previewCache = {};
const SAMPLE_TEXT = 'Xin chào, đây là giọng đọc mẫu của tôi. Bạn thấy giọng này có phù hợp với nhân vật không?';

function setTtsVoice(id) {
  $('#ttsVoice').value = id;
  savePref('ttsVoice', id);
  updatePickerLabel();
}
function updatePickerLabel() {
  const v = S.voices.find((x) => x.voice_id === $('#ttsVoice').value);
  $('#vpName').textContent = v ? v.name : (S.voices.length ? '— chọn giọng —' : '— kết nối API để tải giọng —');
}
function voiceDesc(v) {
  const l = v.labels || {};
  return [v.category === 'premade' ? 'Có sẵn' : v.category === 'cloned' ? 'Clone' : v.category, l.gender, l.age, l.accent, l.description || l.descriptive, l.use_case || l.use_case]
    .filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · ');
}
function syncPlayButtons() {
  $$('[data-pv]').forEach((b) => {
    const on = b.dataset.pv === playingId;
    b.classList.toggle('playing', on);
    if (!b.dataset.loading) b.textContent = on ? '⏸' : '▶';
  });
  $('#vpPlay').classList.toggle('playing', playingId && playingId === $('#ttsVoice').value);
  $('#vpPlay').textContent = playingId && playingId === $('#ttsVoice').value ? '⏸' : '▶';
}
player.onended = player.onpause = () => { if (player.paused) { playingId = null; syncPlayButtons(); } };

async function previewVoice(id, btn) {
  if (!id) return toast('Chọn giọng trước', 'err');
  if (playingId === id) { player.pause(); return; }
  player.pause();
  const v = S.voices.find((x) => x.voice_id === id);
  let url = v?.preview_url || previewCache[id];
  if (!url) {
    // Giọng clone thường chưa có bản mẫu -> tạo nhanh 1 câu ngắn bằng model hiện tại
    const all = [btn, $('#vpPlay')].filter(Boolean);
    all.forEach((b) => { b.dataset.loading = '1'; b.textContent = '…'; b.disabled = true; });
    try {
      const model = $('#ttsModel').value;
      const typed = stripTags($('#ttsText').value).slice(0, 120).trim();
      const res = await tts(id, typed.length >= 20 ? typed : SAMPLE_TEXT, 'mp3_44100_128', { model, vs: readVS('t', model), lang: $('#ttsLang').value });
      url = previewCache[id] = URL.createObjectURL(await res.blob());
    } catch (e) {
      toast('Không tạo được bản nghe thử: ' + e.message, 'err');
      return;
    } finally {
      all.forEach((b) => { delete b.dataset.loading; b.disabled = false; });
      syncPlayButtons();
    }
  }
  player.src = url;
  playingId = id;
  syncPlayButtons();
  player.play().catch((e) => { playingId = null; syncPlayButtons(); toast('Không phát được: ' + e.message, 'err'); });
}

let pickerFilter = 'all';
function renderPicker() {
  const q = $('#vpSearch').value.trim().toLowerCase();
  const cur = $('#ttsVoice').value;
  const list = S.voices
    .filter((v) => pickerFilter === 'all' || (pickerFilter === 'own' ? ownVoice(v) : !ownVoice(v)))
    .filter((v) => !q || (v.name + ' ' + voiceDesc(v)).toLowerCase().includes(q))
    .sort((a, b) => (ownVoice(b) - ownVoice(a)) || a.name.localeCompare(b.name));
  $('#vpList').innerHTML = list.length ? list.map((v) => `
    <div class="vp-item ${v.voice_id === cur ? 'sel' : ''}" data-pick="${esc(v.voice_id)}">
      <button type="button" class="ghost pbtn" data-pv="${esc(v.voice_id)}" title="${v.preview_url ? 'Nghe bản mẫu' : 'Tạo & nghe câu mẫu'}">▶</button>
      <div class="info"><b>${esc(v.name)}</b><small>${esc(voiceDesc(v))}${v.preview_url ? '' : ' · chưa có mẫu'}</small></div>
      ${v.voice_id === cur ? '<span>✓</span>' : ''}
    </div>`).join('') : `<p class="muted" style="padding:8px">${S.voices.length ? 'Không tìm thấy giọng.' : 'Kết nối API ở tab 1 để tải giọng.'}</p>`;
  syncPlayButtons();
}
$('#vpBtn').onclick = () => {
  const p = $('#vpPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { renderPicker(); $('#vpSearch').focus(); }
};
$('#vpSearch').oninput = renderPicker;
$$('.vp-tab').forEach((t) => t.onclick = () => {
  pickerFilter = t.dataset.f;
  $$('.vp-tab').forEach((x) => x.classList.toggle('active', x === t));
  renderPicker();
});
$('#vpList').onclick = (e) => {
  const pv = e.target.closest('[data-pv]');
  if (pv) { e.stopPropagation(); previewVoice(pv.dataset.pv, pv); return; }
  const item = e.target.closest('[data-pick]');
  if (item) { setTtsVoice(item.dataset.pick); $('#vpPanel').classList.add('hidden'); }
};
$('#vpPlay').onclick = () => previewVoice($('#ttsVoice').value, $('#vpPlay'));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.vp')) $('#vpPanel').classList.add('hidden');
});

/* ================= TAB 2: TẠO VOICE (TTS) ================= */
const TAGS = ['[happy]', '[sad]', '[angry]', '[excited]', '[whispering]', '[shouting]', '[laughs]', '[chuckles]', '[sighs]', '[crying]', '[sarcastic]', '[curious]', '[calm]', '[nervous]', '[pause]'];
$('#tagBar').innerHTML = TAGS.map((t) => `<button class="ghost" data-tag="${t}">${t}</button>`).join('');
$('#tagBar').onclick = (e) => {
  const t = e.target.dataset.tag;
  if (!t) return;
  const ta = $('#ttsText'), s = ta.selectionStart;
  ta.value = ta.value.slice(0, s) + t + ' ' + ta.value.slice(ta.selectionEnd);
  ta.focus(); ta.selectionStart = ta.selectionEnd = s + t.length + 1;
  ta.dispatchEvent(new Event('input'));
};
$('#ttsText').value = getPref('ttsText', '');
const updCount = () => { $('#ttsCount').textContent = `${$('#ttsText').value.length.toLocaleString()} ký tự`; };
$('#ttsText').oninput = () => { updCount(); savePref('ttsText', $('#ttsText').value); };
updCount();
['ttsFormat', 'ttsLang', 'ttsNorm', 'ttsSeed'].forEach((id) => {
  const el = $('#' + id);
  el.value = getPref(id, el.value);
  el.onchange = () => savePref(id, el.value);
});
$('#ttsReset').onclick = () => {
  resetVS('t');
  $('#ttsFormat').value = 'pcm_44100'; $('#ttsLang').value = ''; $('#ttsNorm').value = 'auto'; $('#ttsSeed').value = '';
  ['ttsFormat', 'ttsLang', 'ttsNorm', 'ttsSeed'].forEach((id) => localStorage.removeItem('pref_' + id));
};

$('#ttsGen').onclick = async () => {
  const vid = $('#ttsVoice').value, text = $('#ttsText').value.trim(), model = $('#ttsModel').value;
  if (!vid) return toast('Chọn giọng', 'err');
  if (!text) return toast('Nhập nội dung', 'err');
  const fmt = $('#ttsFormat').value;
  $('#ttsGen').disabled = true;
  $('#ttsStatus').textContent = 'Đang tạo…';
  try {
    const finalText = isV3(model) ? text : stripTags(text);
    const res = await tts(vid, finalText, fmt, { model, vs: readVS('t', model), lang: $('#ttsLang').value, seed: $('#ttsSeed').value, norm: $('#ttsNorm').value });
    const blob = await toAudioBlob(res, fmt);
    const voice = S.voices.find((v) => v.voice_id === vid)?.name || vid;
    const ext = fmt.startsWith('ulaw') ? 'wav' : formatInfo(fmt).ext;
    const snippet = fsSafe(stripTags(finalText).slice(0, 30)).replace(/[ .]+$/, '');
    const name = `${fsSafe(voice)}_${snippet}_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`;
    const h = { id: Date.now(), blob, url: URL.createObjectURL(blob), name, voice, model, fmt, text: finalText };
    S.history.unshift(h);
    renderHistory();
    renderResult(h);
    $('#ttsStatus').textContent = '✅ Xong';
    player.pause();
    $('#ttsResult audio')?.play().catch(() => {});
    if ($('#ttsAutoDl').checked) downloadBlob(h.blob, h.name);
  } catch (e) {
    $('#ttsStatus').textContent = '❌ ' + e.message;
    toast(e.message, 'err');
  } finally { $('#ttsGen').disabled = false; }
};

function renderResult(h) {
  const box = $('#ttsResult');
  if (!h) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="meta muted">✅ Đã tạo xong • 🎤 ${esc(h.voice)} • ${esc(h.fmt)} • ${(h.blob.size / 1024).toFixed(0)} KB</div>
    <audio controls src="${h.url}" style="margin-top:8px"></audio>
    <div class="row">
      <button class="primary big" data-dl="${h.id}">⬇ Tải về (.${esc(h.name.split('.').pop())})</button>
      <button class="ghost" data-save="${h.id}">📁 Lưu vào thư mục xuất</button>
      <small class="muted">${esc(h.name)}</small>
    </div>`;
}
function renderHistory() {
  if (!S.history.length) { $('#ttsHistory').innerHTML = '<p class="empty">Chưa có bản nào.</p>'; return; }
  $('#ttsHistory').innerHTML = S.history.map((h) => `
    <div class="hist">
      <div class="meta">🎤 ${esc(h.voice)} • ${esc(h.model)} • ${esc(h.fmt)} • ${(h.blob.size / 1024).toFixed(0)} KB</div>
      <div class="txt">${esc(h.text)}</div>
      <audio controls src="${h.url}"></audio>
      <div class="row" style="margin-top:6px">
        <button class="ghost small" data-dl="${h.id}">⬇ Tải xuống</button>
        <button class="ghost small" data-save="${h.id}">📁 Lưu vào thư mục xuất</button>
        <button class="ghost small" data-rm="${h.id}">✕</button>
      </div>
    </div>`).join('');
}
async function onHistoryAction(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const id = +(b.dataset.dl || b.dataset.save || b.dataset.rm);
  const h = S.history.find((x) => x.id === id);
  if (!h) return;
  if (b.dataset.dl) downloadBlob(h.blob, h.name);
  if (b.dataset.save) {
    if (!S.dir && !(await pickFolder())) return;
    if (!(await ensureDirPermission())) return toast('Chưa được cấp quyền ghi', 'err');
    toast('Đã lưu: ' + await writeFile('', h.name, h.blob), 'ok');
  }
  if (b.dataset.rm) {
    URL.revokeObjectURL(h.url);
    S.history = S.history.filter((x) => x !== h);
    renderHistory();
    if ($(`#ttsResult [data-dl="${h.id}"]`)) renderResult(null);
  }
}
$('#ttsHistory').onclick = onHistoryAction;
$('#ttsResult').onclick = onHistoryAction;
$('#ttsAutoDl').checked = getPref('ttsAutoDl', '0') === '1';
$('#ttsAutoDl').onchange = () => savePref('ttsAutoDl', $('#ttsAutoDl').checked ? '1' : '0');

/* ================= TAB 3: CLONE ================= */
let cloneFiles = [];
const dz = $('#dropZone');
dz.onclick = () => $('#cloneFiles').click();
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); addCloneFiles(e.dataTransfer.files); };
$('#cloneFiles').onchange = (e) => { addCloneFiles(e.target.files); e.target.value = ''; };
function addCloneFiles(fl) {
  cloneFiles.push(...fl);
  $('#cloneFileList').innerHTML = cloneFiles.map((f, i) =>
    `<li>${esc(f.name)} (${(f.size / 1048576).toFixed(2)} MB) <a href="#" data-rmfile="${i}">✕</a></li>`).join('');
}
$('#cloneFileList').onclick = (e) => {
  const i = e.target.dataset.rmfile;
  if (i === undefined) return;
  e.preventDefault(); cloneFiles.splice(+i, 1); addCloneFiles([]);
};
$('#cloneBtn').onclick = async () => {
  const name = $('#cloneName').value.trim();
  if (!name) return toast('Nhập tên giọng', 'err');
  if (!cloneFiles.length) return toast('Chọn ít nhất 1 file mẫu', 'err');
  const fd = new FormData();
  fd.append('name', name);
  if ($('#cloneDesc').value.trim()) fd.append('description', $('#cloneDesc').value.trim());
  fd.append('remove_background_noise', $('#cloneDenoise').checked ? 'true' : 'false');
  cloneFiles.forEach((f) => fd.append('files', f, f.name));
  $('#cloneBtn').disabled = true;
  $('#cloneStatus').textContent = 'Đang tải lên & clone…';
  try {
    const j = await (await xi('/v1/voices/add', { method: 'POST', body: fd })).json();
    $('#cloneStatus').textContent = `✅ Đã lưu "${name}" vào tài khoản (ID ${j.voice_id})`;
    cloneFiles = []; addCloneFiles([]);
    $('#cloneName').value = ''; $('#cloneDesc').value = '';
    await onVoiceCreated(j.voice_id, name, 'cloned');
  } catch (e) {
    $('#cloneStatus').textContent = '❌ ' + e.message;
    toast(e.message, 'err');
  } finally { $('#cloneBtn').disabled = false; }
};

/* Sau khi tạo giọng: tải lại danh sách để giọng mới hiện ở tab API & Giọng,
 * bộ chọn giọng (Tạo voice) và phần gán giọng; tự chọn giọng mới ở tab Tạo voice. */
async function onVoiceCreated(id, name, category) {
  await loadVoices();
  if (!S.voices.some((v) => v.voice_id === id)) {
    S.voices.push({ voice_id: id, name, category, preview_url: null, labels: {} });
    S.voices.sort((a, b) => a.name.localeCompare(b.name));
    renderVoices(); renderChars(); fillVoiceSelects(); renderGenTable();
  }
  setTtsVoice(id);
  toast(`Đã lưu giọng "${name}" — có ở tab API & Giọng, Tạo voice và Gán giọng`, 'ok');
}

/* ---- Voice Design ---- */
$('#designLoud').oninput = () => { $('#designLoudV').textContent = $('#designLoud').value; };
$('#designAuto').onchange = () => { $('#designText').disabled = $('#designAuto').checked; };
$('#designText').disabled = true;
const D = { desc: '', name: '', previews: [], savedGid: null, savedVoiceId: null };

const jsonPost = (path, body) => xi(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function saveDesigned(gid) {
  const body = { voice_name: D.name, voice_description: D.desc, generated_voice_id: gid };
  let res;
  try { res = await jsonPost('/v1/text-to-voice', body); } catch (err) {
    if (err.status !== 404 && err.status !== 405) throw err;
    res = await jsonPost('/v1/text-to-voice/create-voice-from-preview', body);
  }
  const j = await res.json().catch(() => ({}));
  return j.voice_id;
}

function renderDesignPreviews() {
  $('#designPreviews').innerHTML = D.previews.map((p, i) => {
    const saved = p.generated_voice_id === D.savedGid;
    return `<div class="voice" style="${saved ? 'border-color:var(--ok)' : ''}">
      <b>Bản ${i + 1} ${saved ? '<span class="badge" style="background:#1d3a2a;color:var(--ok)">✓ Đã lưu</span>' : ''}</b>
      <div class="meta">${p.duration_secs ? p.duration_secs.toFixed(1) + 's' : ''} ${esc(p.language || '')}</div>
      <audio controls src="data:${esc(p.media_type || 'audio/mpeg')};base64,${p.audio_base_64}"></audio>
      ${saved ? `<div class="meta" style="margin-top:6px">Đang dùng làm giọng “${esc(D.name)}”</div>`
        : `<button class="ghost small" style="margin-top:6px" data-usegen="${esc(p.generated_voice_id)}">↺ Dùng bản này</button>`}
    </div>`;
  }).join('') || '<p class="empty">Không có bản nghe thử.</p>';
}

$('#designBtn').onclick = async () => {
  const name = $('#designName').value.trim();
  const desc = $('#designDesc').value.trim();
  if (!name) return toast('Nhập tên giọng', 'err');
  if (desc.length < 20) return toast('Mô tả cần tối thiểu 20 ký tự', 'err');
  const auto = $('#designAuto').checked, text = $('#designText').value.trim();
  if (!auto && (text.length < 100 || text.length > 1000)) return toast('Câu đọc thử cần 100–1000 ký tự (hoặc tích tự tạo)', 'err');
  const body = { voice_description: desc, auto_generate_text: auto, model_id: $('#designModel').value, loudness: +$('#designLoud').value };
  if (!auto) body.text = text;
  $('#designBtn').disabled = true;
  $('#designStatus').textContent = 'Đang tạo bản nghe thử… (có thể mất 10–30 giây)';
  $('#designPreviews').innerHTML = '';
  try {
    let res;
    try { res = await jsonPost('/v1/text-to-voice/design', body); } catch (e) {
      if (e.status !== 404 && e.status !== 405) throw e;
      res = await jsonPost('/v1/text-to-voice/create-previews', { voice_description: desc, auto_generate_text: auto, ...(auto ? {} : { text }) });
    }
    const j = await res.json();
    Object.assign(D, { desc, name, previews: j.previews || [], savedGid: null, savedVoiceId: null });
    renderDesignPreviews();
    if (!D.previews.length) throw new Error('ElevenLabs không trả về bản nghe thử nào');
    // Tự động lưu bản 1
    $('#designStatus').textContent = 'Đang tự lưu bản 1…';
    D.savedVoiceId = await saveDesigned(D.previews[0].generated_voice_id);
    D.savedGid = D.previews[0].generated_voice_id;
    renderDesignPreviews();
    $('#designStatus').textContent = `✅ Đã lưu bản 1 thành giọng “${name}”` + (j.text ? ` • Câu đọc thử: “${j.text.slice(0, 80)}…”` : '');
    if (D.savedVoiceId) await onVoiceCreated(D.savedVoiceId, name, 'generated'); else await loadVoices();
  } catch (e) {
    $('#designStatus').textContent = '❌ ' + e.message;
    toast(e.message, 'err');
  } finally { $('#designBtn').disabled = false; }
};

$('#designPreviews').onclick = async (e) => {
  const gid = e.target.dataset.usegen;
  if (!gid) return;
  $$('#designPreviews [data-usegen]').forEach((b) => { b.disabled = true; });
  $('#designStatus').textContent = 'Đang thay giọng đã lưu bằng bản mới…';
  try {
    const newId = await saveDesigned(gid);
    const oldId = D.savedVoiceId;
    D.savedGid = gid; D.savedVoiceId = newId;
    if (oldId && oldId !== newId) {
      // xoá bản cũ để không chiếm thêm chỗ giọng trong gói
      try { await xi('/v1/voices/' + oldId, { method: 'DELETE' }); } catch (err) { toast('Không xoá được bản cũ: ' + err.message, 'err'); }
      Object.keys(S.mapping).forEach((k) => { if (S.mapping[k] === oldId && newId) S.mapping[k] = newId; });
      saveMap();
    }
    renderDesignPreviews();
    $('#designStatus').textContent = `✅ Giọng “${D.name}” giờ dùng bản ${D.previews.findIndex((p) => p.generated_voice_id === gid) + 1}`;
    if (newId) await onVoiceCreated(newId, D.name, 'generated'); else await loadVoices();
  } catch (err) {
    $('#designStatus').textContent = '❌ ' + err.message;
    toast(err.message, 'err');
    renderDesignPreviews();
  }
};

/* ================= TAB 4: KỊCH BẢN ================= */
function normChar(raw) {
  return String(raw || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}
const charParts = (key) => key.split(/\s*(?:\+|&|,|\/)\s*/).map((s) => s.trim()).filter(Boolean);
function epFromText(s) {
  const m = String(s || '').match(/(?:tập|tap|ep(?:isode)?)\s*[._-]?\s*(\d+)/i);
  return m ? `Tập ${+m[1]}` : '';
}
const lineEp = (l) => l.ep || $('#defaultEp').value.trim() || 'Chưa rõ tập';
const sayText = (l) => l.tagged || l.text;

function saveScript() {
  try {
    localStorage.setItem('script_v2', JSON.stringify({ lines: S.lines.map(({ status, ...l }) => l), nextId: S.nextId }));
  } catch { /* quá dung lượng – bỏ qua */ }
  localStorage.setItem('extra_chars', JSON.stringify(S.extraChars));
}
function loadScript() {
  try {
    const j = JSON.parse(localStorage.getItem('script_v2') || 'null');
    if (j) { S.lines = j.lines.map((l) => ({ ...l, status: '' })); S.nextId = j.nextId || S.lines.length + 1; }
  } catch { /* ignore */ }
}
function newLine(o = {}) {
  return { id: S.nextId++, ep: '', scene: '', stt: '', rawChar: '', char: '', text: '', tagged: '', status: '', ...o };
}
function nextStt() {
  const nums = S.lines.map((l) => parseInt(l.stt, 10)).filter((n) => !isNaN(n));
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}

$('#defaultEp').value = getPref('defaultEp', '');
$('#defaultEp').onchange = () => { savePref('defaultEp', $('#defaultEp').value.trim()); renderLines(); renderEpFilter(); };

$('#scriptFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (S.lines.length && !confirm('Thay kịch bản hiện tại bằng file mới?')) { e.target.value = ''; return; }
  try {
    S.sheets = /\.xlsx$/i.test(f.name)
      ? await parseXlsx(await f.arrayBuffer())
      : [{ name: f.name, rows: parseDelimited(await f.text(), f.name) }];
    const ep = epFromText(f.name);
    if (ep) { $('#defaultEp').value = ep; savePref('defaultEp', ep); }
    detectColumns();
    $('#scriptInfo').textContent = `📄 ${f.name}`;
  } catch (err) { toast('Đọc file lỗi: ' + err.message, 'err'); }
  e.target.value = '';
};
$('#newScript').onclick = () => {
  if (S.lines.length && !confirm('Xoá kịch bản hiện tại và tạo kịch bản trống?')) return;
  S.lines = [newLine({ stt: '1' })];
  S.sheets = []; $('#columnMap').classList.add('hidden'); $('#scriptInfo').textContent = 'Kịch bản mới';
  afterLinesChanged();
};
$('#clearScript').onclick = () => {
  if (!confirm('Xoá toàn bộ kịch bản đang mở? (Phần gán giọng vẫn được giữ.)')) return;
  S.lines = []; S.sheets = []; S.selected.clear();
  $('#columnMap').classList.add('hidden'); $('#scriptInfo').textContent = '';
  afterLinesChanged();
};

function parseDelimited(text, name) {
  const lines = text.replace(/\r/g, '').split('\n');
  if (/\.txt$/i.test(name) && !lines.some((l) => l.includes('\t'))) {
    const rows = [['STT', 'Nhân Vật', 'Lời Thoại']];
    let n = 0;
    lines.forEach((l) => {
      const m = l.match(/^\s*([^:：]{1,60})[:：]\s*(.+)$/);
      if (m) rows.push([String(++n), m[1].trim(), m[2].trim()]);
    });
    return rows;
  }
  const delim = name.endsWith('.tsv') || lines[0].includes('\t') ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function detectColumns() {
  let best = null;
  S.sheets.forEach((sh, si) => {
    for (let r = 0; r < Math.min(20, sh.rows.length); r++) {
      const row = sh.rows[r].map((c) => String(c).toLowerCase());
      const ci = row.findIndex((c) => /nhân vật|nhan vat|character|speaker|vai/.test(c));
      const ti = row.findIndex((c) => /thoại|thoai|dialogue|line|text|lời/.test(c));
      if (ci >= 0 && ti >= 0 && ci !== ti) {
        const count = sh.rows.length - r - 1;
        if (!best || count > best.count) best = { si, r, count };
        break;
      }
    }
  });
  best ||= { si: 0, r: 0 };
  const head = (S.sheets[best.si].rows[best.r] || []).map((c) => String(c).toLowerCase());
  const find = (re, not) => head.findIndex((c) => re.test(c) && !(not && not.test(c)));
  S.cols = {
    sheet: best.si, header: best.r,
    ep: find(/^tập$|^tap$|^episode$|^ep$/),
    stt: find(/^stt|^#|^no\.?$|số thứ tự/),
    scene: find(/cảnh|canh|scene/),
    char: find(/nhân vật|nhan vat|character|speaker|vai/),
    text: find(/thoại|thoai|dialogue|line|text|lời/, /tag|hướng dẫn|direction/),
    tagged: find(/tag/, /hướng dẫn|direction/),
  };
  renderColumnMap();
  buildLinesFromSheet();
}

function renderColumnMap() {
  const sh = S.sheets[S.cols.sheet];
  const head = sh.rows[S.cols.header] || [];
  const maxCols = Math.max(...sh.rows.map((r) => r.length), 1);
  const opt = (sel) => '<option value="-1">— không dùng —</option>' + Array.from({ length: maxCols }, (_, i) =>
    `<option value="${i}" ${i === sel ? 'selected' : ''}>${String.fromCharCode(65 + i)}: ${esc(String(head[i] || '').slice(0, 30))}</option>`).join('');
  const f = (key, label) => `<div><label>${label}</label><select data-col="${key}">${opt(S.cols[key])}</select></div>`;
  $('#columnMap').innerHTML = `
    <div><label>Sheet</label><select data-col="sheet">${S.sheets.map((s, i) => `<option value="${i}" ${i === S.cols.sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div><label>Dòng tiêu đề</label><input data-col="header" type="number" min="1" value="${S.cols.header + 1}"></div>
    ${f('ep', 'Cột Tập')}${f('stt', 'Cột STT')}${f('scene', 'Cột Cảnh')}${f('char', 'Cột Nhân vật *')}${f('text', 'Cột Lời thoại *')}${f('tagged', 'Cột Lời thoại có tag')}`;
  $('#columnMap').classList.remove('hidden');
  $$('#columnMap [data-col]').forEach((el) => el.onchange = () => {
    const k = el.dataset.col;
    if (k === 'sheet') { S.cols.sheet = +el.value; S.cols.header = 0; renderColumnMap(); }
    else if (k === 'header') S.cols.header = Math.max(0, +el.value - 1);
    else S.cols[k] = +el.value;
    buildLinesFromSheet();
  });
}

function buildLinesFromSheet() {
  const sh = S.sheets[S.cols.sheet], c = S.cols;
  const get = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '');
  S.lines = []; S.nextId = 1; S.selected.clear();
  sh.rows.slice(c.header + 1).forEach((row) => {
    const rawChar = get(row, c.char), text = get(row, c.text), tagged = get(row, c.tagged);
    if (!rawChar || !(text || tagged)) return;
    const scene = get(row, c.scene);
    S.lines.push(newLine({
      ep: get(row, c.ep) ? (epFromText(get(row, c.ep)) || get(row, c.ep)) : epFromText(scene),
      scene, stt: get(row, c.stt) || String(S.lines.length + 1),
      rawChar, char: normChar(rawChar), text, tagged,
    }));
  });
  afterLinesChanged();
}

function afterLinesChanged() {
  saveScript();
  renderLines(); renderChars(); renderEpFilter(); renderGenTable();
}

/* ---- Bảng lời thoại (sửa / thêm / xoá) ---- */
function renderLines() {
  $('#lineCount').textContent = `(${S.lines.length} dòng)`;
  const defEp = $('#defaultEp').value.trim();
  $('#linesTable').innerHTML = `<tr>
      <th><input type="checkbox" id="selAll"></th><th style="width:80px">Tập</th><th style="width:120px">Cảnh</th>
      <th style="width:60px">STT</th><th style="width:170px">Nhân vật</th><th>Lời thoại (gửi tới ElevenLabs)</th><th></th></tr>` +
    S.lines.map((l) => `<tr data-id="${l.id}" class="${S.selected.has(l.id) ? 'sel' : ''}">
      <td><input type="checkbox" data-sel ${S.selected.has(l.id) ? 'checked' : ''}></td>
      <td><input data-f="ep" value="${esc(l.ep)}" placeholder="${esc(defEp)}"></td>
      <td><input data-f="scene" value="${esc(l.scene)}"></td>
      <td><input data-f="stt" value="${esc(l.stt)}"></td>
      <td><input data-f="rawChar" value="${esc(l.rawChar)}" list="charDatalist"></td>
      <td><textarea data-f="say" rows="1">${esc(sayText(l))}</textarea></td>
      <td class="act"><button class="ghost" data-act="ins" title="Chèn dòng bên dưới">＋</button><button class="ghost" data-act="dup" title="Nhân bản">⧉</button><button class="ghost" data-act="del" title="Xoá dòng">🗑</button></td>
    </tr>`).join('');
  $('#charDatalist').innerHTML = charStats().map(([k]) => `<option value="${esc(k)}">`).join('');
  const selAll = $('#selAll');
  selAll.checked = S.lines.length > 0 && S.selected.size === S.lines.length;
  selAll.onchange = () => { S.selected = new Set(selAll.checked ? S.lines.map((l) => l.id) : []); renderLines(); };
}

const linesTable = $('#linesTable');
linesTable.addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const l = S.lines.find((x) => x.id === +tr.dataset.id);
  if (e.target.hasAttribute('data-sel')) {
    e.target.checked ? S.selected.add(l.id) : S.selected.delete(l.id);
    tr.classList.toggle('sel', e.target.checked);
    return;
  }
  const f = e.target.dataset.f, v = e.target.value.trim();
  if (f === 'say') {
    if (l.tagged) { l.tagged = v; l.text = stripTags(v); } else l.text = v;
  } else if (f === 'rawChar') {
    l.rawChar = v; l.char = normChar(v);
    renderChars(); $('#charDatalist').innerHTML = charStats().map(([k]) => `<option value="${esc(k)}">`).join('');
  } else {
    l[f] = f === 'ep' ? (epFromText(v) || v) : v;
    if (f === 'ep') { e.target.value = l.ep; renderEpFilter(); }
  }
  saveScript(); renderGenTable();
});
linesTable.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const idx = S.lines.findIndex((x) => x.id === +b.closest('tr').dataset.id);
  const cur = S.lines[idx];
  if (b.dataset.act === 'del') { S.lines.splice(idx, 1); S.selected.delete(cur.id); }
  if (b.dataset.act === 'ins') S.lines.splice(idx + 1, 0, newLine({ ep: cur.ep, scene: cur.scene, stt: nextStt() }));
  if (b.dataset.act === 'dup') S.lines.splice(idx + 1, 0, newLine({ ep: cur.ep, scene: cur.scene, rawChar: cur.rawChar, char: cur.char, text: cur.text, tagged: cur.tagged, stt: nextStt() }));
  afterLinesChanged();
});
$('#addLine').onclick = () => {
  const last = S.lines[S.lines.length - 1];
  S.lines.push(newLine({ ep: last?.ep || '', scene: last?.scene || '', stt: nextStt() }));
  afterLinesChanged();
  const wrap = $('#linesTable').parentElement;
  wrap.scrollTop = wrap.scrollHeight;
  $('#linesTable tr:last-child [data-f="rawChar"]')?.focus();
};
$('#delSelected').onclick = () => {
  if (!S.selected.size) return toast('Chưa chọn dòng nào (tích ô ở cột đầu)', 'err');
  if (!confirm(`Xoá ${S.selected.size} dòng đã chọn?`)) return;
  S.lines = S.lines.filter((l) => !S.selected.has(l.id));
  S.selected.clear();
  afterLinesChanged();
};

/* ---- Nhân vật & gán giọng ---- */
function charStats() {
  const m = new Map();
  S.lines.forEach((l) => { if (l.char) m.set(l.char, (m.get(l.char) || 0) + 1); });
  S.extraChars.forEach((c) => { if (!m.has(c)) m.set(c, 0); });
  return [...m.entries()];
}
function resolveVoice(charKey) {
  if (!charKey) return '';
  if (S.mapping[charKey]) return S.mapping[charKey];
  for (const p of charParts(charKey)) if (S.mapping[p]) return S.mapping[p];
  return '';
}
const voiceName = (id) => S.voices.find((v) => v.voice_id === id)?.name || id;

function renderChars() {
  const stats = charStats();
  if (!stats.length) { $('#charList').innerHTML = '<p class="empty">Chưa có nhân vật.</p>'; return; }
  $('#charList').innerHTML = stats.map(([k, n]) => {
    const direct = S.mapping[k] || '';
    const inherited = !direct && resolveVoice(k);
    return `<div class="char-row" data-char="${esc(k)}">
      <div class="name">${esc(k)}${inherited ? `<div class="cnt">↳ dùng: ${esc(voiceName(inherited))}</div>` : ''}</div>
      <select>${S.voices.length ? voiceOptions(direct) : `<option value="${esc(direct)}">${direct ? 'ID: ' + esc(direct) : '— kết nối API để chọn giọng —'}</option>`}</select>
      <div class="cnt">${n} câu</div>
      <button class="ghost small" data-test>▶ Thử</button>
      <button class="ghost small" data-delchar title="Xoá nhân vật">🗑</button>
    </div>`;
  }).join('');
}
$('#charList').addEventListener('change', (e) => {
  const row = e.target.closest('[data-char]');
  if (!row || e.target.tagName !== 'SELECT') return;
  const k = row.dataset.char;
  if (e.target.value) S.mapping[k] = e.target.value; else delete S.mapping[k];
  saveMap(); renderChars(); renderGenTable();
});
$('#charList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-char]');
  if (!row) return;
  const k = row.dataset.char;
  if (e.target.hasAttribute('data-test')) testChar(k, e.target);
  if (e.target.hasAttribute('data-delchar')) {
    const n = S.lines.filter((l) => l.char === k).length;
    if (!confirm(n ? `Xoá nhân vật "${k}" cùng ${n} dòng thoại của nhân vật này?` : `Xoá nhân vật "${k}"?`)) return;
    S.lines = S.lines.filter((l) => l.char !== k);
    S.extraChars = S.extraChars.filter((c) => c !== k);
    delete S.mapping[k]; saveMap();
    afterLinesChanged();
  }
});
$('#addChar').onclick = () => {
  const k = normChar($('#newCharName').value);
  if (!k) return toast('Nhập tên nhân vật', 'err');
  if (charStats().some(([c]) => c === k)) return toast('Nhân vật đã tồn tại', 'err');
  S.extraChars.push(k);
  $('#newCharName').value = '';
  saveScript(); renderChars(); renderLines();
};
$('#newCharName').onkeydown = (e) => { if (e.key === 'Enter') $('#addChar').click(); };

$('#autoMatch').onclick = () => {
  const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let n = 0;
  charStats().forEach(([k]) => {
    if (S.mapping[k]) return;
    const kk = strip(k);
    const v = S.voices.find((x) => strip(x.name) === kk)
      || S.voices.filter(ownVoice).find((x) => { const vn = strip(x.name); return vn.startsWith(kk + ' ') || vn.includes(kk); });
    if (v) { S.mapping[k] = v.voice_id; n++; }
  });
  saveMap(); renderChars(); renderGenTable();
  toast(`Đã tự ghép ${n} nhân vật`, n ? 'ok' : '');
};

async function testChar(k, btn) {
  const vid = resolveVoice(k);
  if (!vid) return toast('Chưa gán giọng cho ' + k, 'err');
  const line = S.lines.find((l) => l.char === k);
  btn.disabled = true;
  try {
    const res = await tts(vid, line ? prepText(line) : `Xin chào, tôi là ${k}.`, 'mp3_44100_128', genOpts());
    new Audio(URL.createObjectURL(await res.blob())).play();
  } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
}

/* ================= TAB 5: XUẤT HÀNG LOẠT ================= */
['subMode', 'namePattern', 'formatSelect', 'concurrency', 'genLang'].forEach((id) => {
  const el = $('#' + id);
  el.value = getPref(id, el.value);
  el.onchange = () => { savePref(id, el.value); renderGenTable(); };
});
$('#epFilter').onchange = renderGenTable;
$('#pickFolder').onclick = pickFolder;

function renderEpFilter() {
  const cur = $('#epFilter').value;
  const eps = [...new Set(S.lines.map(lineEp))];
  $('#epFilter').innerHTML = '<option value="">Tất cả</option>' + eps.map((e) => `<option ${e === cur ? 'selected' : ''}>${esc(e)}</option>`).join('');
}

function genOpts() {
  const model = $('#modelSelect').value;
  return { model, vs: readVS('g', model), lang: $('#genLang').value };
}
function prepText(line) {
  const t = ($('#useTagged').checked && line.tagged) ? line.tagged : (line.text || line.tagged);
  return isV3($('#modelSelect').value) ? t : stripTags(t);
}
function sceneTag(scene) {
  const m = String(scene).match(/(?:cảnh|canh|scene)\s*(\d+)/i);
  return m ? 'C' + m[1].padStart(2, '0') : fsSafe(scene);
}
function outName(l) {
  const sttPad = /^\d+$/.test(l.stt) ? l.stt.padStart(3, '0') : l.stt;
  return fsSafe($('#namePattern').value
    .replaceAll('{ep}', lineEp(l))
    .replaceAll('{stt}', sttPad)
    .replaceAll('{scene}', sceneTag(l.scene))
    .replaceAll('{char}', l.char)
    .replaceAll('{text}', stripTags(sayText(l)).slice(0, 40))).replace(/^_+|_+$/g, '') + '.wav';
}
function outSub(l) {
  const parts = { ep: fsSafe(lineEp(l)), scene: sceneTag(l.scene) || 'Khong_canh', char: fsSafe(l.char) };
  const m = $('#subMode').value;
  return m === 'none' ? '' : m.split('/').map((k) => parts[k]).join('/');
}
const genLines = () => S.lines.filter((l) => !$('#epFilter').value || lineEp(l) === $('#epFilter').value);

function renderGenTable() {
  $('#genTable').innerHTML = '<tr><th>Tập</th><th>STT</th><th>Nhân vật</th><th>Giọng</th><th>File</th><th>Trạng thái</th></tr>' +
    genLines().map((l) => {
      const vid = resolveVoice(l.char);
      const sub = outSub(l);
      return `<tr id="g${l.id}"><td>${esc(lineEp(l))}</td><td>${esc(l.stt)}</td><td>${esc(l.rawChar)}</td>
        <td>${vid ? esc(voiceName(vid)) : '⚠ chưa gán'}</td><td>${esc((sub ? sub + '/' : '') + outName(l))}</td>
        <td class="st">${esc(l.status)}</td></tr>`;
    }).join('');
}
function setStatus(l, txt, cls) {
  l.status = txt;
  const td = document.querySelector(`#g${l.id} .st`);
  if (td) { td.textContent = txt; td.className = 'st ' + (cls || ''); td.title = txt; }
}

async function genOne(l, opts) {
  const vid = resolveVoice(l.char);
  if (!vid) { setStatus(l, 'Bỏ qua (chưa gán giọng)', 'st-err'); return 'skip'; }
  if (!sayText(l)) { setStatus(l, 'Bỏ qua (trống)', 'st-err'); return 'skip'; }
  const filename = outName(l), sub = outSub(l);
  if ($('#skipExisting').checked && await fileExists(sub, filename)) { setStatus(l, 'Đã có – bỏ qua', 'st-ok'); return 'ok'; }
  let chain = FORMAT_CHAIN.slice(FORMAT_CHAIN.indexOf(S.workingFormat || $('#formatSelect').value));
  let attempt = 0;
  while (!S.stop) {
    const fmt = chain[0];
    setStatus(l, `Đang tạo (${fmt})…`, 'st-run');
    try {
      const res = await tts(vid, prepText(l), fmt, opts);
      const saved = await writeFile(sub, filename, pcmToWav(await res.arrayBuffer(), +fmt.split('_')[1]));
      S.workingFormat = fmt;
      setStatus(l, `✔ ${fmt.split('_')[1]} Hz → ${saved}`, 'st-ok');
      return 'ok';
    } catch (e) {
      const msg = e.message || '';
      if ((e.status === 403 || e.status === 400 || e.status === 422) && /output_format|format|tier|subscription|pro|plan/i.test(msg) && chain.length > 1) {
        chain = chain.slice(1); S.workingFormat = chain[0]; continue;
      }
      if ((e.status === 429 || e.status >= 500 || !e.status) && attempt < 5) {
        attempt++;
        setStatus(l, `Thử lại ${attempt}/5… (${msg.slice(0, 60)})`, 'st-run');
        await sleep(2000 * attempt);
        continue;
      }
      setStatus(l, '✖ ' + msg, 'st-err');
      if (e.status === 401) S.stop = true;
      return 'err';
    }
  }
  setStatus(l, 'Đã dừng', '');
  return 'stop';
}

$('#startGen').onclick = async () => {
  if (!S.apiKey) return toast('Chưa kết nối API', 'err');
  const lines = genLines();
  if (!lines.length) return toast('Chưa có lời thoại', 'err');
  if (FS_OK) {
    if (!S.dir) return toast('Chọn thư mục xuất trước (📁 Chọn…)', 'err');
    if (!(await ensureDirPermission())) return toast('Chưa được cấp quyền ghi vào thư mục', 'err');
  } else if (!confirm('Trình duyệt này không hỗ trợ ghi vào thư mục — các file WAV sẽ được TẢI XUỐNG từng file. Tiếp tục?')) return;
  const missing = [...new Set(lines.filter((l) => !resolveVoice(l.char)).map((l) => l.char))];
  if (missing.length && !confirm(`Các nhân vật chưa gán giọng sẽ bị bỏ qua:\n${missing.join(', ')}\n\nTiếp tục?`)) return;

  S.stop = false; S.workingFormat = null;
  lines.forEach((l) => { l.status = ''; });
  $('#startGen').disabled = true; $('#stopGen').disabled = false;
  renderGenTable();
  const opts = genOpts();
  const queue = [...lines], total = lines.length;
  let done = 0, ok = 0, err = 0;
  const upd = () => {
    $('#progBar').style.width = (done / total * 100) + '%';
    $('#progText').textContent = `${done}/${total} • thành công ${ok} • lỗi/bỏ qua ${err}` + (S.workingFormat ? ` • WAV ${S.workingFormat.split('_')[1]} Hz` : '');
  };
  upd();
  const worker = async () => {
    while (queue.length && !S.stop) {
      const r = await genOne(queue.shift(), opts);
      done++; if (r === 'ok') ok++; else err++;
      upd();
    }
  };
  await Promise.all(Array.from({ length: +$('#concurrency').value }, worker));
  $('#startGen').disabled = false; $('#stopGen').disabled = true;
  toast(S.stop ? 'Đã dừng' : `Hoàn tất: ${ok}/${total} file WAV`, err ? '' : 'ok');
};
$('#stopGen').onclick = () => { S.stop = true; $('#stopGen').disabled = true; };

/* ================= KHỞI ĐỘNG ================= */
let started = false;
function unlock() {
  if (!isAuthed()) return lock();
  document.body.classList.remove('locked');
  $('#app').hidden = false;
  if (started) return;
  started = true;
  buildVS('t'); buildVS('g');
  $('#fsHint').textContent = FS_OK
    ? 'File WAV được ghi thẳng vào thư mục bạn chọn (trình duyệt sẽ hỏi quyền).'
    : '⚠ Trình duyệt này không hỗ trợ chọn thư mục — file sẽ được tải xuống. Nên dùng Chrome hoặc Edge.';
  if (FS_OK) idb.get('outDir').then((h) => { if (h) { S.dir = h; $('#outFolder').value = h.name; } }).catch(() => {});
  loadScript();
  afterLinesChanged();
  renderHistory();
  if (S.apiKey) connect();
}
if (isAuthed()) unlock(); else { lock(); $('#loginUser').focus(); }
