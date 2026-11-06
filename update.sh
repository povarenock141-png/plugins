#!/data/data/com.termux/files/usr/bin/bash
# Обновить сервер ТВ без смены адреса туннеля.
set -e
cd ~/tvhub
curl -fsSL https://raw.githubusercontent.com/povarenock141-png/plugins/tv-hub/server.js -o server.new.js
node --check server.new.js
mv server.new.js server.js
pkill -f 'tvhub/server.js' 2>/dev/null || true
sleep 1
nohup node ~/tvhub/server.js > ~/tvhub/node.out 2>&1 &
sleep 2
T=$(cat token)
R=$(curl -s -X POST "http://127.0.0.1:8787/$T/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
echo "$R" | grep -o '"version":"[^"]*"' || echo "сервер НЕ ответил: $R"
if pgrep -f 'cloudflared tunnel' >/dev/null; then echo "туннель: работает, адрес прежний"; else echo "туннель НЕ работает — запусти: bash ~/tvhub/start.sh"; fi
