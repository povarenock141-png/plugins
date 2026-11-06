pkg install -y cloudflared imagemagick procps
mkdir -p ~/tvhub && cd ~/tvhub
[ -s token ] || node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > token
cat > server.js <<'EOF'
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
    run: async () => { const png = await adb(['exec-out', 'screencap', '-p'], true);
      if (!png || png.length < 100) throw new Error('пустой снимок');
      const tin = path.join(os.tmpdir(), 'tvshot.png'), tout = path.join(os.tmpdir(), 'tvshot.jpg');
      fs.writeFileSync(tin, png);
      for (const bin of ['magick', 'convert']) {
        const r = await exec(bin, [tin, '-resize', '1280x1280>', '-quality', '70', tout]);
        if (!r.err && fs.existsSync(tout)) return { content: [{ type: 'image', mimeType: 'image/jpeg', data: fs.readFileSync(tout).toString('base64') }] };
      }
      return { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }; } },
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
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tv-hub', version: '1.0.0' }, instructions: INSTR });
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
EOF
cat > start.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Хаб ТВ: сервер + туннель. Повторный запуск перезапускает оба (адрес туннеля сменится).
cd ~/tvhub || exit 1
termux-wake-lock 2>/dev/null
pkill -f 'tvhub/server.js' 2>/dev/null
pkill -f 'cloudflared tunnel' 2>/dev/null
sleep 1
adb connect 192.168.0.100:5555 >/dev/null 2>&1
nohup node ~/tvhub/server.js > ~/tvhub/node.out 2>&1 &
rm -f ~/tvhub/tunnel.log
nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787 > ~/tvhub/tunnel.log 2>&1 &
echo "Жду туннель (до 45 сек)..."
U=""
for i in $(seq 1 45); do
  U=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' ~/tvhub/tunnel.log 2>/dev/null | grep -v '//api\.' | head -1)
  [ -n "$U" ] && break
  sleep 1
done
sleep 1
T=$(cat ~/tvhub/token)
R=$(curl -s -X POST "http://127.0.0.1:8787/$T/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tv_status","arguments":{}}}')
echo
if echo "$R" | grep -q 'на связи'; then echo "ТВ: на связи"; else echo "ТВ: НЕ ответил -> $R"; fi
if [ -n "$U" ]; then
  echo "$U/$T/mcp" > ~/tvhub/url.txt
  echo
  echo "=== АДРЕС ДЛЯ КОННЕКТОРА ==="
  echo "$U/$T/mcp"
  echo "============================"
else
  echo "Туннель НЕ поднялся:"; tail -5 ~/tvhub/tunnel.log
fi
EOF
bash ~/tvhub/start.sh
