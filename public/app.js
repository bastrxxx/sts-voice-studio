/* ElevenLabs Voice Studio – frontend */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const API = '/eleven';
const FORMAT_CHAIN = ['pcm_48000', 'pcm_44100', 'pcm_24000', 'pcm_22050', 'pcm_16000'];

const S = {
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
  const res = await fetch(API + path, { ...opts, headers: { 'xi-api-key': S.apiKey, ...(opts.headers || {}) } });
  if (!res.ok) {
    const e = new Error(`[${res.status}] ${await errText(res)}`);
    e.status = res.status;
    throw e;
  }
  return res;
}

async function local(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await res.json();
  if (!j.ok && !j.cancelled) throw new Error(j.error || 'Lỗi server');
  return j;
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
      const b64 = await blobToBase64(f);
      const j = await local('/api/parse-xlsx', { data: b64 });
      S.sheets = j.sheets;
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
['outFolder', 'subMode', 'namePattern', 'formatSelect', 'concurrency'].forEach((id) => {
  const el = $('#' + id);
  el.value = getPref(id, el.value);
  el.onchange = () => savePref(id, el.value);
});
$('#modelSelect').onchange = () => savePref('model', $('#modelSelect').value);

$('#pickFolder').onclick = async () => {
  const j = await local('/api/pick-folder');
  if (j.folder) { $('#outFolder').value = j.folder; savePref('outFolder', j.folder); }
};
$('#openFolder').onclick = () => local('/api/open-folder', { folder: $('#outFolder').value });

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
  const filename = outName(l), subfolder = outSub(l), folder = $('#outFolder').value.trim();
  if ($('#skipExisting').checked) {
    const ex = await local('/api/exists', { folder, subfolder, filename });
    if (ex.exists) { setStatus(l, 'Đã có – bỏ qua', 'st-ok'); return 'ok'; }
  }
  const pref = $('#formatSelect').value;
  let chain = FORMAT_CHAIN.slice(FORMAT_CHAIN.indexOf(S.workingFormat || pref));
  let attempt = 0;
  while (!S.stop) {
    const fmt = chain[0];
    setStatus(l, `Đang tạo (${fmt})…`, 'st-run');
    try {
      const res = await tts(vid, prepText(l), fmt);
      const blob = await res.blob();
      const b64 = await blobToBase64(blob);
      const j = await local('/api/save-wav', { folder, subfolder, filename, audio_base64: b64, source_format: fmt });
      S.workingFormat = fmt;
      setStatus(l, `✔ ${fmt.replace('pcm_', '')} Hz → ${j.path.split('/').slice(-2).join('/')}`, 'st-ok');
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
fetch('/api/status').then((r) => r.json()).then((j) => {
  $('#outFolder').placeholder = 'Mặc định: ' + j.default_output_dir;
}).catch(() => {});
if (S.apiKey) connect();
