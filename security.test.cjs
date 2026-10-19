const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');

function background({ active = [{ id: 7, url: 'https://www.youtube.com/watch?v=test' }], after,
  config = {}, response = { ok: true, json: async () => ({}), text: async () => '{"status":"success"}' } } = {}) {
  let listener, queries = 0;
  const calls = [];
  const context = vm.createContext({ URL, AbortSignal, FormData, Blob, Uint8Array, atob, console,
    fetch: async (url, options) => { calls.push({ url, options }); return response; },
    chrome: {
      runtime: { id: 'self', onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: { get(_keys, cb) { cb(config); }, set() {} } },
      tabs: { query(_query, cb) { cb(queries++ && after ? after : active); },
        captureVisibleTab(windowId, options, cb) { calls.push({ capture: true, windowId }); cb('data:image/png;base64,AA=='); } }
    }
  });
  vm.runInContext(source('background.js'), context);
  const sender = { id: 'self', frameId: 0, url: 'https://www.youtube.com/watch?v=test', tab: { id: 7, windowId: 3 } };
  return { context, calls, sender, send: (request, from = sender) =>
    new Promise(resolve => listener(request, from, resolve)) };
}

function gas(extra = {}) {
  const context = vm.createContext({ console, ...extra });
  vm.runInContext(source('apps_script.gs'), context);
  return context;
}

function popup() {
  // Configuration validation is pure; popup initialization needs a real extension DOM.
  const context = vm.createContext({ URL });
  vm.runInContext(source('popup.js').slice(source('popup.js').indexOf('function validateImportedConfig(')), context);
  return context;
}

function content(document = {}) {
  const context = vm.createContext({ window: { fbsHasRun: true }, document,
    location: { origin: 'https://www.youtube.com' }, console });
  vm.runInContext(source('content.js'), context);
  return context;
}

test('all JavaScript and Apps Script parse; manifest uses local assets', () => {
  for (const name of ['background.js', 'content.js', 'popup.js', 'apps_script.gs']) new vm.Script(source(name));
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(!manifest.permissions.includes('scripting'));
  for (const name of [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.content_scripts.flatMap(s => [...s.js, ...s.css])]) assert.ok(fs.existsSync(path.join(root, name)));
});

test('reject external, unsupported-domain, lookalike-domain and subframe senders', async () => {
  const b = background();
  for (const from of [{ ...b.sender, id: 'other' }, { ...b.sender, frameId: 2 },
    { ...b.sender, url: 'https://youtube.com.attacker.test/' },
    { ...b.sender, url: 'http://www.youtube.com/' }, { ...b.sender, tab: undefined }]) {
    assert.equal((await b.send({ action: 'captureTab' }, from)).success, false);
  }
  assert.equal(b.calls.length, 0);
});

test('reject unknown actions and malformed OCR/audio/translation messages', async () => {
  const b = background();
  for (const request of [null, [], { action: 'unknown' }, { action: 'translateText', text: {} },
    { action: 'translateText', text: 'x'.repeat(50001) },
    { action: 'recognizeText', imageBase64: 'https://localhost/private' },
    { action: 'transcribeAudio', audioBase64: 'data:text/html;base64,AA==' }]) {
    assert.equal((await b.send(request)).success, false);
  }
  assert.equal(b.calls.length, 0);
});

test('audio validator accepts MediaRecorder webm codecs parameter', () => {
  const b = background();
  assert.equal(b.context.validRequest({ action: 'transcribeAudio', audioBase64: 'data:audio/webm;codecs=opus;base64,AA==' }), true);
});

test('capture rejects inactive requesting tab before any capture', async () => {
  const b = background({ active: [{ id: 8, url: 'https://private.example/' }] });
  assert.equal((await b.send({ action: 'captureTab' })).success, false);
  assert.equal(b.calls.length, 0);
});

test('capture targets requesting window and rejects tab switch after capture', async () => {
  const b = background({ after: [{ id: 8, url: 'https://private.example/' }] });
  const result = await b.send({ action: 'captureTab' });
  assert.equal(result.success, false);
  assert.equal(result.dataUrl, undefined);
  assert.equal(b.calls[0].windowId, 3);
});

test('capture succeeds for the same foreground page', async () => {
  const b = background();
  assert.equal((await b.send({ action: 'captureTab' })).success, true);
});

const gasUrl = 'https://script.google.com/macros/s/DEPLOYMENT_TEST/exec';
test('GAS proxy rejects arbitrary destinations, credentials, query and mismatched deployment', async () => {
  const b = background({ config: { gasUrl } });
  for (const url of ['http://127.0.0.1/admin', 'https://script.google.com.attacker.test/macros/s/x/exec',
    'https://user:password@script.google.com/macros/s/x/exec', gasUrl + '?target=x',
    gasUrl.replace('DEPLOYMENT_TEST', 'OTHER')]) {
    const result = await b.send({ action: 'uploadToGAS', gasUrl: url, payload: {} });
    assert.equal(result.status, 'error');
  }
  assert.equal(b.calls.length, 0);
});

test('GAS upload uses locally configured target resources', async () => {
  const b = background({ config: { gasUrl, sheetId: 'configured-sheet', folderId: 'configured-folder' } });
  assert.equal((await b.send({ action: 'uploadToGAS', gasUrl,
    payload: { sheetId: 'injected-sheet', folderId: 'injected-folder' } })).status, 'success');
  const body = JSON.parse(b.calls[0].options.body);
  assert.equal(body.sheetId, 'configured-sheet');
  assert.equal(body.folderId, 'configured-folder');
  assert.equal(b.calls[0].options.credentials, 'omit');
  assert.ok(b.calls[0].options.signal);
});

test('API keys come from background storage, never request parameters or configuration response', async () => {
  const b = background({ config: { groqKey: 'LOCAL_TEST_KEY' },
    response: { ok: true, json: async () => ({ choices: [{ message: { content: '翻译' } }] }) } });
  const config = await b.send({ action: 'getAIConfig' });
  assert.equal(config.hasGroqKey, true);
  assert.equal(config.groqKey, undefined);
  assert.equal((await b.send({ action: 'translateText', text: 'hello', groqKey: 'ATTACKER_TEST_KEY' })).success, true);
  assert.equal(b.calls[0].options.headers.Authorization, 'Bearer LOCAL_TEST_KEY');
  assert.equal(JSON.parse(b.calls[0].options.body).model, 'openai/gpt-oss-20b');
  assert.equal(JSON.parse(b.calls[0].options.body).max_completion_tokens, 2048);
  assert.equal(JSON.parse(b.calls[0].options.body).include_reasoning, false);
});

test('Groq translation HTTP failure still falls back to Google translation', async () => {
  const b = background({ config: { groqKey: 'LOCAL_TEST_KEY' } });
  b.context.fetch = async (url, options) => {
    b.calls.push({ url, options });
    if (url.startsWith('https://api.groq.com/')) return { ok: false, status: 503 };
    return { ok: true, json: async () => [[['中文结果', 'hello']]] };
  };
  const result = await b.send({ action: 'translateText', text: 'hello' });
  assert.equal(result.success, true);
  assert.equal(result.zh, '中文结果');
  assert.equal(b.calls.length, 2);
  assert.equal(JSON.parse(b.calls[0].options.body).model, 'openai/gpt-oss-20b');
  assert.ok(b.calls[1].url.startsWith('https://translate.googleapis.com/translate_a/single?'));
  assert.equal(b.calls[1].options.headers, undefined);
});

test('OCR uses background key and never logs extracted text', async () => {
  const b = background({ config: { visionKey: 'LOCAL_OCR_TEST' },
    response: { ok: true, json: async () => ({ IsErroredOnProcessing: true, ErrorMessage: ['test error'] }) } });
  assert.equal((await b.send({ action: 'recognizeText', imageBase64: 'AA==', apiKey: 'INJECTED' })).success, false);
  assert.equal(b.calls[0].options.headers.apikey, 'LOCAL_OCR_TEST');
  assert.ok(!/console\.log\([^\n]*JSON\.stringify\(data\)/.test(source('background.js')));
});

test('GAS proxy hides raw non-JSON response and HTTP failure body', async () => {
  for (const response of [{ ok: true, text: async () => 'PRIVATE_SERVER_RESPONSE' },
    { ok: false, status: 403, text: async () => 'PRIVATE_SERVER_RESPONSE' }]) {
    const b = background({ config: { gasUrl }, response });
    const result = await b.send({ action: 'uploadToGAS', gasUrl, payload: {} });
    assert.equal(result.status, 'error');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SERVER_RESPONSE'));
  }
});

const upload = () => ({ sheetId: 'test-sheet', folderId: 'test-folder', imgBase64: 'data:image/jpeg;base64,/9j/AA==',
  date: '2026-10-19', category: '素材', videoUrl: 'https://www.youtube.com/watch?v=test', notes: 'normal' });
test('GAS upload validation rejects malformed types, category delimiters, non-HTTP links and oversized text', () => {
  const g = gas();
  g.validateUpload(upload());
  for (const changes of [{ category: 'a|2\nadmin|3' }, { category: [] }, { videoUrl: 'javascript:alert(1)' },
    { date: '=IMPORTXML("https://example.test", "//a")' }, { notes: 'x'.repeat(40001) },
    { imgBase64: 'data:text/html;base64,AA==' }, { optUrl: 'false' }]) {
    assert.throws(() => g.validateUpload({ ...upload(), ...changes }));
  }
});

test('sheet text cannot be interpreted as a formula', () => {
  const g = gas();
  for (const text of ['=IMPORTXML("https://example.test", "//a")', '  =1+1', '+1', '-1', '@sum']) {
    assert.equal(g.sheetText(text), "'" + text);
  }
  assert.equal(g.sheetText('正常备注'), '正常备注');
});

function parseFormulaStrings(formula) {
  const values = [];
  for (let i = 0; i < formula.length; i++) {
    if (formula[i] !== '"') continue;
    let value = '';
    for (i++; i < formula.length; i++) {
      if (formula[i] === '"') {
        if (formula[i + 1] === '"') { value += '"'; i++; } else break;
      } else value += formula[i];
    }
    values.push(value);
  }
  return values;
}

for (const method of ['writeCard', 'writeRow']) {
  test(method + ' keeps a quote-based formula injection inside the URL string and escapes notes', () => {
    const writes = [];
    const cell = { setValue(v) { writes.push({ value: v }); return this; },
      setFormula(f) { writes.push({ formula: f }); return this; }, setFontWeight() { return this; } };
    const sheet = { getRange() { return cell; } };
    const url = 'https://example.test/",IMPORTXML("https://attacker.test","//a"),"';
    const g = gas();
    g[method](sheet, 2, 4, '2026-10-19', url, 'https://drive.google.com/thumbnail?id=TEST',
      'https://drive.google.com/download', 'https://drive.google.com/folder', '=1+1', true, true, true, true);
    const formulas = writes.filter(w => w.formula).map(w => w.formula);
    assert.equal(formulas.length, 4);
    assert.equal(parseFormulaStrings(formulas[0])[0], url);
    assert.equal(parseFormulaStrings(formulas[3])[0], url);
    assert.equal(parseFormulaStrings(formulas[3]).length, 2);
    assert.ok(writes.some(w => w.value === "'=1+1"));
  });
}

test('GAS rejects malformed request without revealing exception details', () => {
  const g = gas({ ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) {
    return { text, setMimeType() { return this; } };
  } } });
  const result = JSON.parse(g.doPost({ postData: { contents: '{SECRET_ERROR_DETAIL' } }).text);
  assert.equal(result.status, 'error');
  assert.ok(!result.message.includes('SECRET_ERROR_DETAIL'));
});

test('GAS lock failure prevents all Drive/Sheet side effects', () => {
  let touches = 0;
  const g = gas({ LockService: { getScriptLock: () => ({ tryLock: () => false }) },
    DriveApp: { getFolderById() { touches++; } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) { return { text, setMimeType() { return this; } }; } } });
  assert.equal(JSON.parse(g.doPost({ postData: { contents: JSON.stringify(upload()) } }).text).status, 'error');
  assert.equal(touches, 0);
});

test('category names inherited from Object.prototype are handled as ordinary new categories', () => {
  const g = gas();
  for (const category of ['constructor', '__proto__', 'toString']) {
    let insertedExisting = false;
    const cell = { getValue: () => '', setValue() { return this; }, setFontWeight() { return this; },
      setFontColor() { return this; }, setFontSize() { return this; }, insertCells() { insertedExisting = true; } };
    const sheet = { getRange: () => cell, setRowHeight() {} };
    g.writeCard = () => {};
    g.writeHorizontal(sheet, category, '2026-10-19', '', '', '', '', '', false, false, false, false);
    assert.equal(insertedExisting, false);
  }
});

test('configuration import rejects wrong types and non-GAS destinations', () => {
  const p = popup();
  for (const config of [null, [], { categories: 'wrong' }, { categories: ['bad|2'] },
    { gasUrl: 'https://attacker.test/exec' }, { sheetId: {} }, { layoutMode: '__proto__' }, { optUrl: 'true' }]) {
    assert.throws(() => p.validateImportedConfig(config));
  }
  const valid = p.validateImportedConfig({ gasUrl, categories: ['默认'], groqKey: 'DO_NOT_IMPORT', optUrl: true });
  assert.equal(valid.gasUrl, gasUrl);
  assert.equal(valid.groqKey, undefined);
});

test('speech text and translation render as text; language is escaped in HTML template', () => {
  const elements = new Map();
  const node = () => ({ innerHTML: '', textContent: '', querySelector(id) {
    if (!elements.has(id)) elements.set(id, node()); return elements.get(id);
  }, remove() {} });
  let modal;
  const doc = { createElement: node, getElementById(id) { return elements.get('#' + id); },
    body: { appendChild(element) {
      modal = element;
      for (const match of element.innerHTML.matchAll(/id="([^"]+)"/g)) {
        if (!elements.has('#' + match[1])) elements.set('#' + match[1], node());
      }
    } } };
  const c = content(doc);
  const payload = '<img src="https://attacker.test/pixel" onerror="alert(1)">';
  c.showSpeechModal({ text: payload, zh: payload, language: payload }, false);
  assert.ok(!modal.innerHTML.includes('<img'));
  assert.ok(modal.innerHTML.includes('&lt;img'));
  assert.ok(elements.get('#fbs-speech-text-box').textContent.includes(payload));
});

test('speech cache keys separate identical video IDs across platform origins', () => {
  const c = content();
  c.window.location = { href: 'https://www.youtube.com/watch?v=same' };
  const first = c.getVideoSpeechKey();
  c.location.origin = 'https://www.facebook.com';
  c.window.location.href = 'https://www.facebook.com/watch?v=same';
  assert.notEqual(c.getVideoSpeechKey(), first);
});

for (const layoutMode of ['horizontal', 'vertical']) {
  test('GAS simulated upload completes ' + layoutMode + ' layout and releases its lock', () => {
    const operations = [], writes = [];
    const cell = { getValue: () => '', getValues: () => [['']],
      setValue(v) { writes.push({ value: v }); return this; },
      setFormula(v) { writes.push({ formula: v }); return this; },
      setFontWeight() { return this; }, setFontColor() { return this; }, setFontSize() { return this; } };
    const sheet = { getRange: () => cell, getLastColumn: () => 1, setRowHeight() {}, setColumnWidth() {} };
    const folder = { getFoldersByName: () => ({ hasNext: () => false }),
      createFolder() { operations.push('createFolder'); return folder; }, getId: () => 'TEST_FOLDER',
      createFile() { operations.push('createFile'); return { getId: () => 'TEST_IMAGE',
        setSharing(access) { operations.push(access); } }; } };
    const g = gas({
      ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) { return { text, setMimeType() { return this; } }; } },
      LockService: { getScriptLock: () => ({ tryLock() { operations.push('lock'); return true; },
        releaseLock() { operations.push('unlock'); } }) },
      DriveApp: { getFolderById: () => folder, Access: { ANYONE_WITH_LINK: 'public-link' }, Permission: { VIEW: 'view' } },
      Utilities: { base64Decode: () => [], newBlob: () => ({}), formatDate: () => '10-00-00' },
      SpreadsheetApp: { openById: () => ({ getSheets: () => [sheet] }) }
    });
    const result = JSON.parse(g.doPost({ postData: { contents: JSON.stringify({ ...upload(), layoutMode, notes: '=1+1' }) } }).text);
    assert.equal(result.status, 'success');
    assert.equal(operations[0], 'lock');
    assert.equal(operations.at(-1), 'unlock');
    assert.ok(operations.includes('createFile'));
    // Public-link sharing is intentionally preserved by the user's decision.
    assert.ok(operations.includes('public-link'));
    assert.ok(writes.some(write => write.value === "'=1+1"));
    assert.equal(writes.filter(write => write.formula).length, 4);
  });
}

test('synthetic toolbar click cannot initiate capture or recording', () => {
  let click, called = 0;
  const node = () => ({ appendChild() {}, addEventListener(name, fn) { if (name === 'click') click = fn; } });
  const c = content({ createElement: node });
  c.createBarBtn('test', 'test', () => called++);
  click({ isTrusted: false });
  assert.equal(called, 0);
  click({ isTrusted: true });
  assert.equal(called, 1);
});

function recorderFixture(startFails) {
  let audioStops = 0, videoStops = 0, stop;
  const audio = { stop() { audioStops++; } }, videoTrack = { stop() { videoStops++; } };
  const capture = { getAudioTracks: () => [audio], getTracks: () => [audio, videoTrack] };
  const video = { muted: false, volume: 0.8, playbackRate: 1, paused: false,
    captureStream: () => capture, addEventListener() {}, removeEventListener() {} };
  const c = content();
  c.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } };
  c.MediaRecorder = class {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() { if (startFails) throw new Error('recording start failure'); this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop(); }
  };
  c.Blob = Blob;
  c.setInterval = () => 1;
  c.clearInterval = () => {};
  const result = c.recordVideoAudio(video, 60, null, fn => { stop = fn; });
  return { result, video, stop: () => stop(), counts: () => [audioStops, videoStops] };
}

test('recording startup failure stops all capture tracks and restores video state', async () => {
  const fixture = recorderFixture(true);
  await assert.rejects(fixture.result, /recording start failure/);
  assert.deepEqual(fixture.counts(), [1, 1]);
  assert.equal(fixture.video.muted, false);
  assert.equal(fixture.video.volume, 0.8);
  assert.equal(fixture.video.playbackRate, 1);
});

test('normal recording stop releases audio and video capture tracks', async () => {
  const fixture = recorderFixture(false);
  fixture.stop();
  assert.equal((await fixture.result).type, 'audio/webm');
  assert.deepEqual(fixture.counts(), [1, 1]);
  assert.equal(fixture.video.playbackRate, 1);
});
