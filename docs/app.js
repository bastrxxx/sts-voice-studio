/* ElevenLabs Voice Studio – frontend */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const FORMAT_CHAIN = ['pcm_48000', 'pcm_44100', 'pcm_24000', 'pcm_22050', 'pcm_16000'];

const S = {
  base: 'https://api.elevenlabs.io',
  dir: null, // FileSystemDirectoryHandle
  apiKey: localStorage.getItem('xi_key') || '',
  voices: [],
  models: [],
  lines: [],
  sheets: [],
  cols: {},
  mapping: JSON.parse(localStorage.getItem('voice_map') || '{}'),
  workingFormat: null,
  running: false,
  stop: false,
};

/* ---------------- utils ---------------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 't ' + type;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 8000 : 4000);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const saveMap = () => localStorage.setItem('voice_map', JSON.stringify(S.mapping));
const savePref = (k, v) => localStorage.setItem('pref_' + k, v);
const getPref = (k, d) => localStorage.getItem('pref_' + k) ?? d;

async function errText(res) {
  const t = await res.text();
  try {
    const j = JSON.parse(t);
    const d = j.detail;
    if (typeof d === 'string') return d;
    if (d?.message) return (d.status ? d.status + ': ' : '') + d.message;
    if (Array.isArray(d)) return d.map((x) => x.msg).join('; ');
    return t;
  } catch { return t || res.statusText; }
}

async function xi(path, opts = {}) {
  if (!S.apiKey) throw new Error('Chưa nhập API key');
  const doFetch = () => fetch(S.base + path, { ...opts, headers: { 'xi-api-key': S.apiKey, ...(opts.headers || {}) } });
  let res;
  try {
    res = await doFetch();
  } catch (e) {
    // Bị chặn CORS/mạng: nếu đang chạy qua server Ruby cục bộ thì thử đi qua proxy /eleven
    if (S.base !== '/eleven' && /^https?:$/.test(location.protocol) && /localhost|127\.0\.0\.1/.test(location.hostname)) {
      S.base = '/eleven';
      res = await doFetch();
    } else {
      throw new Error('Không gọi được api.elevenlabs.io (mạng hoặc trình duyệt chặn): ' + e.message);
    }
  }
  if (!res.ok) {
    const e = new Error(`[${res.status}] ${await errText(res)}`);
    e.status = res.status;
    throw e;
  }
  return res;
}

/* ---------------- Ghi file vào thư mục (File System Access API) ---------------- */
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

async function targetDir(subfolder) {
  return subfolder ? S.dir.getDirectoryHandle(subfolder, { create: true }) : S.dir;
}

async function fileExists(subfolder, filename) {
  if (!S.dir) return false;
  try {
    const d = subfolder ? await S.dir.getDirectoryHandle(subfolder) : S.dir;
    await d.getFileHandle(filename);
    return true;
  } catch { return false; }
}

async function writeFile(subfolder, filename, blob) {
  if (!S.dir) { // trình duyệt không hỗ trợ chọn thư mục -> tải xuống
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (subfolder ? subfolder + '_' : '') + filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return a.download;
  }
  const d = await targetDir(subfolder);
  const fh = await d.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return `${S.dir.name}/${subfolder ? subfolder + '/' : ''}${filename}`;
}

/* ---------------- PCM -> WAV ---------------- */
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

/* ---------------- Đọc .xlsx ngay trong trình duyệt ---------------- */
async function readZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
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
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    entries[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + nlen + elen + clen;
  }
  return {
    has: (name) => !!entries[name],
    async text(name) {
      const e = entries[name];
      if (!e) return null;
      if (e.method === 0) return dec.decode(e.data);
      const stream = new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
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
      const row = +m[2] - 1;
      const t = c.getAttribute('t');
      const v = tags(c, 'v')[0]?.textContent ?? '';
      const val = t === 's' ? (shared[+v] ?? '') : t === 'inlineStr' ? textOf(c) : v;
      if (val === '') return;
      (rows[row] ||= [])[col] = val;
    });
    sheets.push({ name: el.getAttribute('name'), rows: Array.from(rows, (r) => Array.from(r || [], (x) => x ?? '')) });
  }
  return sheets;
}

function blobToBase64(blob) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = fail;
    r.readAsDataURL(blob);
  });
}

/* ---------------- tabs ---------------- */
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
}));

/* ---------------- TAB 1: API & voices ---------------- */
$('#apiKey').value = S.apiKey;
$('#toggleKey').onclick = () => { const i = $('#apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#connectBtn').onclick = connect;
$('#refreshVoices').onclick = loadVoices;
$('#onlyCloned').onchange = renderVoices;

async function connect() {
  S.apiKey = $('#apiKey').value.trim();
  localStorage.setItem('xi_key', S.apiKey);
  $('#accountInfo').textContent = 'Đang kết nối…';
  try {
    try {
      const sub = await (await xi('/v1/user/subscription')).json();
      $('#accountInfo').innerHTML = `✅ Đã kết nối • Gói: <b>${esc(sub.tier)}</b> • Ký tự: ${(sub.character_count || 0).toLocaleString()} / ${(sub.character_limit || 0).toLocaleString()}`
        + ` • Clone tối đa: ${sub.voice_limit ?? '?'} giọng`;
    } catch (e) {
      // key có thể bị giới hạn quyền user_read – vẫn tiếp tục
      $('#accountInfo').textContent = '✅ Đã kết nối (key không có quyền đọc thông tin gói).';
    }
    await Promise.all([loadVoices(), loadModels()]);
    toast('Kết nối thành công', 'ok');
  } catch (e) {
    $('#accountInfo').textContent = '❌ ' + e.message;
    toast(e.message, 'err');
  }
}

async function loadVoices() {
  try {
    const j = await (await xi('/v1/voices?show_legacy=true')).json();
    S.voices = (j.voices || []).sort((a, b) => a.name.localeCompare(b.name));
    renderVoices();
    renderChars();
  } catch (e) { toast('Tải giọng lỗi: ' + e.message, 'err'); }
}

async function loadModels() {
  try {
    const list = await (await xi('/v1/models')).json();
    S.models = list.filter((m) => m.can_do_text_to_speech);
    const sel = $('#modelSelect');
    sel.innerHTML = S.models.map((m) => `<option value="${esc(m.model_id)}">${esc(m.name)} (${esc(m.model_id)})</option>`).join('');
    const saved = getPref('model', '');
    const ids = S.models.map((m) => m.model_id);
    sel.value = ids.includes(saved) ? saved
      : ids.find((i) => /v4/.test(i)) || ids.find((i) => i === 'eleven_v3') || ids.find((i) => /multilingual_v2/.test(i)) || ids[0];
  } catch (e) { toast('Tải models lỗi: ' + e.message, 'err'); }
}

function ownVoice(v) { return v.category !== 'premade'; }

function renderVoices() {
  const only = $('#onlyCloned').checked;
  const list = S.voices.filter((v) => !only || ownVoice(v));
  if (!list.length) { $('#voiceList').innerHTML = '<p class="muted">Không có giọng nào.</p>'; return; }
  $('#voiceList').innerHTML = list.map((v) => `
    <div class="voice">
      <b>${esc(v.name)}</b>
      <div class="meta"><span class="badge">${esc(v.category)}</span>${esc(v.voice_id)}</div>
      ${v.preview_url ? `<audio controls preload="none" src="${esc(v.preview_url)}"></audio>` : ''}
      <div class="row" style="margin-top:8px">
        <button class="ghost" onclick="navigator.clipboard.writeText('${v.voice_id}');toast('Đã copy ID')">Copy ID</button>
        ${ownVoice(v) ? `<button class="ghost" onclick="deleteVoice('${v.voice_id}','${esc(v.name).replace(/'/g, '')}')">🗑 Xoá</button>` : ''}
      </div>
    </div>`).join('');
}

window.deleteVoice = async (id, name) => {
  if (!confirm(`Xoá giọng "${name}" khỏi tài khoản ElevenLabs? Không thể hoàn tác.`)) return;
  try { await xi('/v1/voices/' + id, { method: 'DELETE' }); toast('Đã xoá', 'ok'); loadVoices(); }
  catch (e) { toast(e.message, 'err'); }
};

/* ---------------- TAB 2: clone ---------------- */
let cloneFiles = [];
const dz = $('#dropZone');
dz.onclick = () => $('#cloneFiles').click();
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); addCloneFiles(e.dataTransfer.files); };
$('#cloneFiles').onchange = (e) => addCloneFiles(e.target.files);

function addCloneFiles(fl) {
  cloneFiles.push(...fl);
  $('#cloneFileList').innerHTML = cloneFiles.map((f, i) =>
    `<li>${esc(f.name)} (${(f.size / 1048576).toFixed(2)} MB) <a href="#" onclick="cloneFiles.splice(${i},1);addCloneFiles([]);return false">✕</a></li>`).join('');
}
window.addCloneFiles = addCloneFiles;
window.cloneFiles = cloneFiles;

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
    $('#cloneStatus').textContent = '✅ Đã tạo: ' + j.voice_id;
    toast(`Clone thành công "${name}"`, 'ok');
    cloneFiles.length = 0; addCloneFiles([]);
    $('#cloneName').value = ''; $('#cloneDesc').value = '';
    await loadVoices();
  } catch (e) {
    $('#cloneStatus').textContent = '❌ ' + e.message;
    toast(e.message, 'err');
  } finally { $('#cloneBtn').disabled = false; }
};

/* ---------------- TAB 3: script ---------------- */
function normChar(raw) {
  return String(raw || '')
    .replace(/\((?:V\.?O\.?|O\.?S\.?|CONT'?D|[^)]*)\)/gi, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
}
function charParts(key) { return key.split(/\s*(?:\+|&|,|\/)\s*/).map((s) => s.trim()).filter(Boolean); }

$('#scriptFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    if (/\.xlsx$/i.test(f.name)) {
      S.sheets = await parseXlsx(await f.arrayBuffer());
    } else {
      const text = await f.text();
      S.sheets = [{ name: f.name, rows: parseDelimited(text, f.name) }];
    }
    detectColumns();
    $('#scriptInfo').textContent = `📄 ${f.name}`;
  } catch (err) { toast('Đọc file lỗi: ' + err.message, 'err'); }
};

function parseDelimited(text, name) {
  const lines = text.replace(/\r/g, '').split('\n');
  // TXT dạng "NHÂN VẬT: lời"
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
  // tìm sheet + dòng tiêu đề có "Nhân vật" và "Thoại"
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
  if (!best) { best = { si: 0, r: 0 }; }
  const sh = S.sheets[best.si];
  const head = (sh.rows[best.r] || []).map((c) => String(c));
  const find = (re, not) => head.findIndex((c) => re.test(c.toLowerCase()) && !(not && not.test(c.toLowerCase())));
  S.cols = {
    sheet: best.si,
    header: best.r,
    stt: find(/^stt|^#|^no\.?$|số thứ tự/),
    scene: find(/cảnh|canh|scene/),
    char: find(/nhân vật|nhan vat|character|speaker|vai/),
    text: find(/thoại|thoai|dialogue|line|text|lời/, /tag|hướng dẫn|direction/),
    tagged: find(/tag/, /hướng dẫn|direction/),
  };
  renderColumnMap();
  buildLines();
}

function renderColumnMap() {
  const sh = S.sheets[S.cols.sheet];
  const head = (sh.rows[S.cols.header] || []);
  const maxCols = Math.max(...sh.rows.map((r) => r.length), 1);
  const opt = (sel) => '<option value="-1">— không dùng —</option>' + Array.from({ length: maxCols }, (_, i) =>
    `<option value="${i}" ${i === sel ? 'selected' : ''}>${String.fromCharCode(65 + i)}: ${esc((head[i] || '').slice(0, 30))}</option>`).join('');
  const f = (key, label) => `<div><label>${label}</label><select data-col="${key}">${opt(S.cols[key])}</select></div>`;
  $('#columnMap').innerHTML = `
    <div><label>Sheet</label><select data-col="sheet">${S.sheets.map((s, i) => `<option value="${i}" ${i === S.cols.sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div><label>Dòng tiêu đề</label><input data-col="header" type="number" min="1" value="${S.cols.header + 1}"></div>
    ${f('stt', 'Cột STT')}${f('scene', 'Cột Cảnh')}${f('char', 'Cột Nhân vật *')}${f('text', 'Cột Lời thoại *')}${f('tagged', 'Cột Lời thoại có tag')}`;
  $('#columnMap').classList.remove('hidden');
  $$('#columnMap [data-col]').forEach((el) => el.onchange = () => {
    const k = el.dataset.col;
    if (k === 'sheet') { S.cols.sheet = +el.value; S.cols.header = 0; renderColumnMap(); }
    else if (k === 'header') S.cols.header = Math.max(0, +el.value - 1);
    else S.cols[k] = +el.value;
    buildLines();
  });
}

function buildLines() {
  const sh = S.sheets[S.cols.sheet];
  const c = S.cols;
  const get = (row, i) => (i >= 0 ? String(row[i] ?? '').trim() : '');
  S.lines = [];
  sh.rows.slice(c.header + 1).forEach((row, i) => {
    const rawChar = get(row, c.char);
    const text = get(row, c.text);
    const tagged = get(row, c.tagged);
    if (!rawChar || !(text || tagged)) return;
    S.lines.push({
      idx: S.lines.length,
      stt: get(row, c.stt) || String(S.lines.length + 1),
      scene: get(row, c.scene),
      rawChar,
      char: normChar(rawChar),
      text,
      tagged,
      status: '',
    });
  });
  $('#lineCount').textContent = `(${S.lines.length} lượt thoại)`;
  $('#linesTable').innerHTML = '<tr><th>STT</th><th>Cảnh</th><th>Nhân vật</th><th>Lời thoại</th></tr>' +
    S.lines.map((l) => `<tr><td>${esc(l.stt)}</td><td>${esc(l.scene)}</td><td>${esc(l.rawChar)}</td><td>${esc(l.tagged || l.text)}</td></tr>`).join('');
  renderChars();
  renderGenTable();
}

function charStats() {
  const m = new Map();
  S.lines.forEach((l) => m.set(l.char, (m.get(l.char) || 0) + 1));
  return [...m.entries()];
}

function resolveVoice(charKey) {
  if (S.mapping[charKey]) return S.mapping[charKey];
  for (const p of charParts(charKey)) if (S.mapping[p]) return S.mapping[p];
  return '';
}

function voiceOptions(sel) {
  const own = S.voices.filter(ownVoice), pre = S.voices.filter((v) => !ownVoice(v));
  const o = (v) => `<option value="${v.voice_id}" ${v.voice_id === sel ? 'selected' : ''}>${esc(v.name)}</option>`;
  return `<option value="">— chưa gán —</option>`
    + (own.length ? `<optgroup label="Giọng clone / của tôi">${own.map(o).join('')}</optgroup>` : '')
    + (pre.length ? `<optgroup label="Giọng có sẵn">${pre.map(o).join('')}</optgroup>` : '');
}

function renderChars() {
  const stats = charStats();
  if (!stats.length) return;
  $('#charList').innerHTML = stats.map(([k, n]) => {
    const direct = S.mapping[k] || '';
    const inherited = !direct && resolveVoice(k);
    const inhName = inherited ? (S.voices.find((v) => v.voice_id === inherited)?.name || '') : '';
    return `<div class="char-row">
      <div class="name">${esc(k)}${inhName ? `<div class="cnt">↳ dùng: ${esc(inhName)}</div>` : ''}</div>
      <select data-char="${esc(k)}">${voiceOptions(direct)}</select>
      <div class="cnt">${n} câu</div>
      <button class="ghost" data-test="${esc(k)}">▶ Thử</button>
    </div>`;
  }).join('');
  $$('#charList select').forEach((s) => s.onchange = () => {
    if (s.value) S.mapping[s.dataset.char] = s.value; else delete S.mapping[s.dataset.char];
    saveMap(); renderChars(); renderGenTable();
  });
  $$('#charList [data-test]').forEach((b) => b.onclick = () => testChar(b.dataset.test, b));
}

$('#autoMatch').onclick = () => {
  const strip = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let n = 0;
  charStats().forEach(([k]) => {
    if (S.mapping[k]) return;
    const kk = strip(k);
    const v = S.voices.find((v) => strip(v.name) === kk)
      || S.voices.filter(ownVoice).find((v) => { const vn = strip(v.name); return vn.startsWith(kk + ' ') || vn.includes(kk); });
    if (v) { S.mapping[k] = v.voice_id; n++; }
  });
  saveMap(); renderChars();
  toast(`Đã tự ghép ${n} nhân vật`, n ? 'ok' : '');
};

async function testChar(k, btn) {
  const vid = resolveVoice(k);
  if (!vid) return toast('Chưa gán giọng cho ' + k, 'err');
  const line = S.lines.find((l) => l.char === k);
  btn.disabled = true;
  try {
    const res = await tts(vid, prepText(line), 'mp3_44100_128');
    new Audio(URL.createObjectURL(await res.blob())).play();
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; }
}

/* ---------------- TAB 4: generate ---------------- */
['vStab', 'vSim', 'vStyle', 'vSpeed'].forEach((id) => {
  const el = $('#' + id);
  el.value = getPref(id, el.value);
  $('#' + id + 'V').textContent = el.value;
  el.oninput = () => { $('#' + id + 'V').textContent = el.value; savePref(id, el.value); };
});
['outFolder', 'subMode', 'namePattern', 'formatSelect', 'concurrency'].filter((id) => id !== 'outFolder').forEach((id) => {
  const el = $('#' + id);
  el.value = getPref(id, el.value);
  el.onchange = () => savePref(id, el.value);
});
$('#modelSelect').onchange = () => savePref('model', $('#modelSelect').value);

$('#pickFolder').onclick = async () => {
  if (!FS_OK) return toast('Trình duyệt không hỗ trợ chọn thư mục. Hãy dùng Chrome hoặc Edge.', 'err');
  try {
    S.dir = await window.showDirectoryPicker({ id: 'voice-out', mode: 'readwrite' });
    $('#outFolder').value = S.dir.name;
    await idb.set('outDir', S.dir);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); }
};

function isV3(model) { return /eleven_v3|v4/.test(model); }

function prepText(line) {
  const model = $('#modelSelect').value;
  let t = ($('#useTagged').checked && line.tagged) ? line.tagged : (line.text || line.tagged);
  if (!isV3(model)) t = t.replace(/\[[^\]]*\]\s*/g, '').trim(); // model cũ không hiểu audio tag
  return t;
}

function voiceSettings() {
  const model = $('#modelSelect').value;
  let stab = +$('#vStab').value;
  if (isV3(model)) stab = [0, 0.5, 1].reduce((a, b) => (Math.abs(b - stab) < Math.abs(a - stab) ? b : a));
  const vs = {
    stability: stab,
    similarity_boost: +$('#vSim').value,
    style: +$('#vStyle').value,
    use_speaker_boost: $('#vBoost').checked,
  };
  if (+$('#vSpeed').value !== 1) vs.speed = +$('#vSpeed').value;
  return vs;
}

function tts(voiceId, text, format) {
  return xi(`/v1/text-to-speech/${voiceId}?output_format=${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/*' },
    body: JSON.stringify({ text, model_id: $('#modelSelect').value, voice_settings: voiceSettings() }),
  });
}

function sceneTag(scene) {
  const m = String(scene).match(/(?:cảnh|canh|scene)\s*(\d+)/i);
  return m ? 'C' + m[1].padStart(2, '0') : scene;
}
const fsSafe = (s) => String(s).replace(/[\/\\:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim();

function outName(l) {
  const sttPad = /^\d+$/.test(l.stt) ? l.stt.padStart(3, '0') : l.stt;
  const raw = l.text || l.tagged.replace(/\[[^\]]*\]\s*/g, '');
  return fsSafe($('#namePattern').value
    .replace('{stt}', sttPad)
    .replace('{scene}', sceneTag(l.scene))
    .replace('{char}', l.char)
    .replace('{text}', raw.slice(0, 40))).replace(/^_+|_+$/g, '') + '.wav';
}
function outSub(l) {
  const m = $('#subMode').value;
  return m === 'character' ? fsSafe(l.char) : m === 'scene' ? fsSafe(sceneTag(l.scene) || 'NoScene') : '';
}

function renderGenTable() {
  $('#genTable').innerHTML = '<tr><th>STT</th><th>Nhân vật</th><th>Giọng</th><th>Lời thoại</th><th>Trạng thái</th></tr>' +
    S.lines.map((l) => {
      const vid = resolveVoice(l.char);
      const vn = S.voices.find((v) => v.voice_id === vid)?.name || (vid ? vid : '⚠ chưa gán');
      return `<tr id="g${l.idx}"><td>${esc(l.stt)}</td><td>${esc(l.rawChar)}</td><td>${esc(vn)}</td><td>${esc((l.tagged || l.text).slice(0, 90))}</td><td class="st">${esc(l.status)}</td></tr>`;
    }).join('');
}
function setStatus(l, txt, cls) {
  l.status = txt;
  const td = document.querySelector(`#g${l.idx} .st`);
  if (td) { td.textContent = txt; td.className = 'st ' + (cls || ''); td.title = txt; }
}

async function genOne(l) {
  const vid = resolveVoice(l.char);
  if (!vid) { setStatus(l, 'Bỏ qua (chưa gán giọng)', 'st-err'); return 'skip'; }
  const filename = outName(l), subfolder = outSub(l);
  if ($('#skipExisting').checked && await fileExists(subfolder, filename)) {
    setStatus(l, 'Đã có – bỏ qua', 'st-ok'); return 'ok';
  }
  const pref = $('#formatSelect').value;
  let chain = FORMAT_CHAIN.slice(FORMAT_CHAIN.indexOf(S.workingFormat || pref));
  let attempt = 0;
  while (!S.stop) {
    const fmt = chain[0];
    setStatus(l, `Đang tạo (${fmt})…`, 'st-run');
    try {
      const res = await tts(vid, prepText(l), fmt);
      const pcm = await res.arrayBuffer();
      const rate = +fmt.split('_')[1];
      const saved = await writeFile(subfolder, filename, pcmToWav(pcm, rate));
      S.workingFormat = fmt;
      setStatus(l, `✔ ${rate} Hz → ${saved}`, 'st-ok');
      return 'ok';
    } catch (e) {
      const msg = e.message || '';
      const formatIssue = (e.status === 403 || e.status === 400 || e.status === 422) && /output_format|format|tier|subscription|pro|plan/i.test(msg);
      if (formatIssue && chain.length > 1) { chain = chain.slice(1); S.workingFormat = chain[0]; continue; }
      if ((e.status === 429 || e.status >= 500 || !e.status) && attempt < 5) {
        attempt++;
        const wait = 2000 * attempt;
        setStatus(l, `Thử lại ${attempt}/5 sau ${wait / 1000}s… (${msg.slice(0, 60)})`, 'st-run');
        await sleep(wait);
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
  if (!S.lines.length) return toast('Chưa tải kịch bản', 'err');
  if (FS_OK) {
    if (!S.dir) return toast('Chọn thư mục xuất trước (📁 Chọn…)', 'err');
    if (!(await ensureDirPermission())) return toast('Chưa được cấp quyền ghi vào thư mục', 'err');
  } else if (!confirm('Trình duyệt này không hỗ trợ ghi vào thư mục — các file WAV sẽ được TẢI XUỐNG từng file. Tiếp tục?')) return;
  const missing = charStats().filter(([k]) => !resolveVoice(k)).map(([k]) => k);
  if (missing.length && !confirm(`Các nhân vật chưa gán giọng sẽ bị bỏ qua:\n${missing.join(', ')}\n\nTiếp tục?`)) return;

  S.running = true; S.stop = false; S.workingFormat = null;
  $('#startGen').disabled = true; $('#stopGen').disabled = false;
  renderGenTable();
  const queue = [...S.lines];
  const total = queue.length;
  let done = 0, ok = 0, err = 0;
  const upd = () => {
    $('#progBar').style.width = (done / total * 100) + '%';
    $('#progText').textContent = `${done}/${total} • thành công ${ok} • lỗi/bỏ qua ${err}` + (S.workingFormat ? ` • định dạng: WAV ${S.workingFormat.replace('pcm_', '')} Hz` : '');
  };
  upd();
  const worker = async () => {
    while (queue.length && !S.stop) {
      const l = queue.shift();
      const r = await genOne(l);
      done++; if (r === 'ok') ok++; else err++;
      upd();
    }
  };
  await Promise.all(Array.from({ length: +$('#concurrency').value }, worker));
  S.running = false;
  $('#startGen').disabled = false; $('#stopGen').disabled = true;
  toast(S.stop ? 'Đã dừng' : `Hoàn tất: ${ok}/${total} file WAV`, err ? '' : 'ok');
};
$('#stopGen').onclick = () => { S.stop = true; $('#stopGen').disabled = true; };

/* ---------------- init ---------------- */
$('#fsHint').textContent = FS_OK
  ? 'File WAV được ghi thẳng vào thư mục bạn chọn (trình duyệt sẽ hỏi quyền).'
  : '⚠ Trình duyệt này không hỗ trợ chọn thư mục — file sẽ được tải xuống. Nên dùng Chrome hoặc Edge.';
if (FS_OK) idb.get('outDir').then((h) => { if (h) { S.dir = h; $('#outFolder').value = h.name; } }).catch(() => {});
if (S.apiKey) connect();
