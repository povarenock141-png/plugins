'use strict';
// TV hub: MCP-сервер для управления ТВ по ADB. Без зависимостей.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');
const PORT = +(process.env.PORT || 8787);
const TV = process.env.TV_ADDR || '192.168.0.100:5555';
const ADB = process.env.ADB_BIN || 'adb';
const TOKEN = fs.readFileSync(path.join(__dirname, 'token'), 'utf8').trim();
const LOG = path.join(__dirname, 'hub.log');
const log = (...a) => { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch (e) {} };

const exec = (bin, args, binary = false, timeout = 20000) => new Promise(r =>
  execFile(bin, args, { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 << 20, timeout },
    (err, stdout, stderr) => r({ err, stdout, stderr: String(stderr || '') })));
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

async function connected() {
  const r = await exec(ADB, ['devices']);
  return String(r.stdout).split('\n').some(l => { const p = l.trim().split(/\s+/); return p[0] === TV && p[1] === 'device'; });
}
async function ensure() {
  if (await connected()) return;
  await exec(ADB, ['disconnect', TV]);
  const c = await exec(ADB, ['connect', TV]);
  log('reconnect', String(c.stdout).trim());
  if (!(await connected())) throw new Error('ТВ ' + TV + ' не отвечает по ADB (выключен или вне сети)');
}
async function adb(args, binary = false) {
  await ensure();
  const r = await exec(ADB, ['-s', TV, ...args], binary);
  if (r.err) throw new Error((r.stderr || r.err.message || 'adb error').trim());
  return r.stdout;
}
const sh = cmd => adb(['shell', cmd]).then(String);

const KEYS = { home: 'HOME', back: 'BACK', up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT',
  ok: 'DPAD_CENTER', enter: 'ENTER', play_pause: 'MEDIA_PLAY_PAUSE', play: 'MEDIA_PLAY', pause: 'MEDIA_PAUSE',
  stop: 'MEDIA_STOP', next: 'MEDIA_NEXT', previous: 'MEDIA_PREVIOUS', rewind: 'MEDIA_REWIND',
  fast_forward: 'MEDIA_FAST_FORWARD', volume_up: 'VOLUME_UP', volume_down: 'VOLUME_DOWN', mute: 'VOLUME_MUTE',
  menu: 'MENU', settings: 'SETTINGS', search: 'SEARCH', wakeup: 'WAKEUP', delete: 'DEL',
  channel_up: 'CHANNEL_UP', channel_down: 'CHANNEL_DOWN' };
const PKG = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const txt = t => ({ content: [{ type: 'text', text: String(t).trim() || 'OK' }] });

let magick = null;
const hasMagick = async () => magick !== null ? magick : (magick = !(await exec('magick', ['-version'])).err);
const zlib = require('zlib');
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4);
  l.writeUInt32BE(data.length); c.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
// Сырой кадр screencap (без -p) -> уменьшенный PNG. Без внешних программ; мусор Hisense перед заголовком пропускается.
function rawShotPng(raw) {
  let o = -1, w = 0, h = 0, hl = 0, f = 1;
  for (let i = 0; i <= Math.min(2048, raw.length - 16) && o < 0; i++) {
    const W = raw.readUInt32LE(i), H = raw.readUInt32LE(i + 4), F = raw.readUInt32LE(i + 8);
    if (W < 16 || W > 8192 || H < 16 || H > 8192 || F < 1 || F > 5) continue;
    for (const L of [12, 16]) if (raw.length - i === L + W * H * 4) { o = i; w = W; h = H; hl = L; f = F; break; }
  }
  if (o < 0) throw new Error('не удалось разобрать снимок ТВ');
  const px = raw.subarray(o + hl), s = Math.max(1, Math.ceil(w / 1280)), W2 = Math.floor(w / s), H2 = Math.floor(h / s);
  const [ri, bi] = f === 5 ? [2, 0] : [0, 2], row = 1 + W2 * 3, out = Buffer.alloc(row * H2), n = s * s;
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const p = ((y * s + dy) * w + x * s + dx) * 4; r += px[p + ri]; g += px[p + 1]; b += px[p + bi]; }
    const q = y * row + 1 + x * 3; out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W2, 0); ihdr.writeUInt32BE(H2, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(out, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const TOOLS = [
  { name: 'tv_key', description: 'Нажать кнопку пульта ТВ. Кнопки выключения нет намеренно: полное выключение роняет ТВ из сети.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', enum: Object.keys(KEYS) },
      repeat: { type: 'integer', minimum: 1, maximum: 30, description: 'Сколько раз нажать (по умолчанию 1)' } }, required: ['key'] },
    run: async a => { const k = KEYS[a.key]; if (!k) throw new Error('нет такой кнопки');
      const n = Math.min(Math.max(+a.repeat || 1, 1), 30);
      await sh('input keyevent ' + Array(n).fill('KEYCODE_' + k).join(' ')); return txt(a.key + ' ×' + n); } },
  { name: 'tv_list_apps', description: 'Список установленных на ТВ приложений (имена пакетов).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => txt((await sh('pm list packages -3')).replace(/package:/g, '').split('\n').map(s => s.trim()).filter(Boolean).sort().join('\n')) },
  { name: 'tv_open_app', description: 'Открыть приложение на ТВ по имени пакета (из tv_list_apps). Например org.smarttube.stable — SmartTube.',
    inputSchema: { type: 'object', properties: { package: { type: 'string' } }, required: ['package'] },
    run: async a => { if (!PKG.test(a.package || '')) throw new Error('неверное имя пакета');
      for (const cat of ['LEANBACK_LAUNCHER', 'LAUNCHER']) {
        let out; try { out = await sh('monkey -p ' + q(a.package) + ' -c android.intent.category.' + cat + ' 1 2>&1'); }
        catch (e) { out = String(e.message); }
        if (/Events injected: 1/.test(out)) return txt('открыто: ' + a.package);
      }
      throw new Error('не удалось открыть ' + a.package); } },
  { name: 'tv_open_url', description: 'Открыть ссылку на ТВ (видео VK, YouTube и т.п.). Можно указать пакет приложения, в котором открыть.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, package: { type: 'string' } }, required: ['url'] },
    run: async a => { const u = String(a.url || '');
      if (!/^https?:\/\/\S{3,2000}$/.test(u)) throw new Error('нужна ссылка http(s)');
      if (a.package && !PKG.test(a.package)) throw new Error('неверное имя пакета');
      const out = await sh('am start -a android.intent.action.VIEW -d ' + q(u) + (a.package ? ' -p ' + q(a.package) : '') + ' 2>&1');
      if (/Error|Exception/.test(out)) throw new Error(out.trim()); return txt('открыта ссылка'); } },
  { name: 'tv_type_text', description: 'Ввести текст в активное поле на ТВ (только латиница, цифры и знаки; кириллицу ADB не вводит).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async a => { const t = String(a.text || '');
      if (!/^[\x20-\x7E]{1,200}$/.test(t)) throw new Error('только латиница/цифры, до 200 символов');
      await sh('input text ' + q(t.replace(/ /g, '%s'))); return txt('введено'); } },
  { name: 'tv_status', description: 'Состояние ТВ: на связи ли, что открыто на экране, проснут ли.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => { const f = await sh("dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp' | head -2");
      const p = await sh("dumpsys power | grep -E 'mWakefulness=' | head -1");
      return txt('ТВ ' + TV + ' на связи\n' + f + '\n' + p); } },
  { name: 'tv_screenshot', description: 'Снимок экрана ТВ. Видео с защитой (DRM) может выйти чёрным.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      if (await hasMagick()) {
        let png = await adb(['exec-out', 'screencap', '-p'], true);
        const at = png ? png.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])) : -1; // Hisense пишет мусор перед PNG
        if (at >= 0) {
          png = png.subarray(at);
          const tin = path.join(os.tmpdir(), 'tvshot.png'), tout = path.join(os.tmpdir(), 'tvshot.jpg');
          fs.writeFileSync(tin, png);
          for (const bin of ['magick', 'convert']) {
            const r = await exec(bin, [tin, '-resize', '1280x1280>', '-quality', '70', tout]);
            if (!r.err && fs.existsSync(tout)) return { content: [{ type: 'image', mimeType: 'image/jpeg', data: fs.readFileSync(tout).toString('base64') }] };
          }
        }
      }
      return { content: [{ type: 'image', mimeType: 'image/png', data: rawShotPng(await adb(['exec-out', 'screencap'], true)).toString('base64') }] }; } },
];

const INSTR = 'Управление телевизором Toshiba 65U7950 (Android TV 9) у Макса дома через ADB. ' +
  'Полностью ТВ не выключать. После действия при необходимости проверяй результат через tv_screenshot.';

async function handle(m) {
  const id = m.id, isReq = id !== undefined && id !== null;
  const ok = result => isReq ? { jsonrpc: '2.0', id, result } : null;
  const fail = (code, message) => isReq ? { jsonrpc: '2.0', id, error: { code, message } } : null;
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(-32600, 'Invalid Request');
  const p = m.params || {};
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tv-hub', version: '1.2.0' }, instructions: INSTR });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const t = TOOLS.find(x => x.name === p.name);
      if (!t) return fail(-32602, 'Unknown tool: ' + p.name);
      try { const r = await t.run(p.arguments || {}); log('call', p.name, JSON.stringify(p.arguments || {}), 'ok'); return ok(r); }
      catch (e) { log('call', p.name, JSON.stringify(p.arguments || {}), 'ERR', e.message);
        return ok({ content: [{ type: 'text', text: 'Ошибка: ' + e.message }], isError: true }); }
    }
    default: return m.method.startsWith('notifications/') ? null : fail(-32601, 'Method not found: ' + m.method);
  }
}

// --- Упрощённый OAuth для коннектора Claude: всё одобряется автоматически. Доступ к ТВ всё равно
// только по секретному ключу в адресе (/<ключ>/mcp), выданные OAuth-токены сами по себе ничего не открывают.
const crypto = require('crypto');
const rnd = () => crypto.randomBytes(24).toString('hex');
const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const codes = new Map();
const OK_REDIRECT = /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claude\.com|anthropic\.com)(\/|$)/i;
const sendJson = (res, code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => r(b)); });
const parseBody = (b, type) => { try { return /json/.test(type || '') ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b)); } catch (e) { return {}; } };
async function oauth(req, res, parts, base) {
  const p = '/' + parts.join('/');
  if (p === '/.well-known/oauth-protected-resource/' + TOKEN + '/mcp') // только с ключом в пути: ключ не утекает
    return sendJson(res, 200, { resource: base + '/' + TOKEN + '/mcp', authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['tv'] }), true;
  if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')
    return sendJson(res, 200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token',
      registration_endpoint: base + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['tv'] }), true;
  if (p === '/register' && req.method === 'POST') {
    const b = parseBody(await readBody(req), req.headers['content-type']);
    return sendJson(res, 201, { client_id: rnd(), client_id_issued_at: Math.floor(Date.now() / 1000), client_name: b.client_name || 'claude',
      redirect_uris: b.redirect_uris || [], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none' }), true;
  }
  if (p === '/authorize' && req.method === 'GET') {
    const q = new URL(req.url, base).searchParams, ru = q.get('redirect_uri') || '';
    if (!OK_REDIRECT.test(ru)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('redirect_uri not allowed'); return true; }
    const code = rnd(); codes.set(code, { ch: q.get('code_challenge'), m: q.get('code_challenge_method') || 'plain', exp: Date.now() + 300000 });
    const loc = new URL(ru); loc.searchParams.set('code', code); if (q.get('state')) loc.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: loc.toString() }); res.end(); return true;
  }
  if (p === '/token' && req.method === 'POST') {
    const b = parseBody(await readBody(req), req.headers['content-type']);
    if (b.grant_type === 'authorization_code') {
      const c = codes.get(b.code); codes.delete(b.code);
      if (!c || c.exp < Date.now()) return sendJson(res, 400, { error: 'invalid_grant' }), true;
      if (c.ch) { const v = String(b.code_verifier || ''); const calc = c.m === 'S256' ? b64u(crypto.createHash('sha256').update(v).digest()) : v;
        if (calc !== c.ch) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE' }), true; }
    } else if (b.grant_type !== 'refresh_token') return sendJson(res, 400, { error: 'unsupported_grant_type' }), true;
    return sendJson(res, 200, { access_token: rnd(), token_type: 'Bearer', expires_in: 31536000, refresh_token: rnd(), scope: 'tv' }), true;
  }
  return false;
}

const reqLog = [];
http.createServer(async (req, res) => {
  const t0 = Date.now(), masked = String(req.url).split(TOKEN).join('***');
  let rpc = '';
  res.on('finish', () => {
    const line = new Date().toISOString() + ' ' + req.method + ' ' + masked + ' ' + rpc + ' -> ' + res.statusCode + ' ' +
      (Date.now() - t0) + 'ms ua=' + String(req.headers['user-agent'] || '-').slice(0, 60) + ' accept=' + String(req.headers.accept || '-').slice(0, 50);
    reqLog.push(line); if (reqLog.length > 200) reqLog.shift(); log('req', line);
  });
  const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && parts.length === 2 && parts[0] === TOKEN && parts[1] === 'log') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(reqLog.slice(-80).join('\n') + '\n'); }
  const byPath = parts.length === 2 && parts[0] === TOKEN && parts[1] === 'mcp';
  const byHeader = parts.length === 1 && parts[0] === 'mcp' && req.headers.authorization === 'Bearer ' + TOKEN;
  if (!byPath && !byHeader) {
    const base = 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
    try { if (await oauth(req, res, parts, base)) return; } catch (e) { log('oauth ERR', e.message); }
    res.writeHead(404); return res.end();
  }
  if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let msg;
    try { msg = JSON.parse(body); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }
    rpc = [].concat(msg).map(m => (m && m.method) || '?').join(',') + ([].concat(msg)[0] && [].concat(msg)[0].params && [].concat(msg)[0].params.protocolVersion ? '(' + [].concat(msg)[0].params.protocolVersion + ')' : '');
    const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
    if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => log('tv-hub listening on', PORT, 'tv', TV));
