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
      let out = await sh('monkey -p ' + q(a.package) + ' -c android.intent.category.LEANBACK_LAUNCHER 1 2>&1');
      if (/No activities found|aborted/i.test(out)) out = await sh('monkey -p ' + q(a.package) + ' -c android.intent.category.LAUNCHER 1 2>&1');
      if (/No activities found|aborted/i.test(out)) throw new Error('не удалось открыть ' + a.package);
      return txt('открыто: ' + a.package); } },
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
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tv-hub', version: '1.1.0' }, instructions: INSTR });
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

http.createServer((req, res) => {
  const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
  const byPath = parts.length === 2 && parts[0] === TOKEN && parts[1] === 'mcp';
  const byHeader = parts.length === 1 && parts[0] === 'mcp' && req.headers.authorization === 'Bearer ' + TOKEN;
  if (!byPath && !byHeader) { res.writeHead(404); return res.end(); }
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
    const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
    if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => log('tv-hub listening on', PORT, 'tv', TV));
