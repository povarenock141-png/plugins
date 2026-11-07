#!/data/data/com.termux/files/usr/bin/bash
# Хаб на самом ТВ: сервер управляет ТВ через ADB на себя (127.0.0.1:5555) + туннель.
export TV_ADDR=127.0.0.1:5555
cd ~/tvhub || exit 1
termux-wake-lock 2>/dev/null
pkill -f 'tvhub/server.js' 2>/dev/null
pkill -f 'cloudflared tunnel' 2>/dev/null
sleep 1
adb connect $TV_ADDR >/dev/null 2>&1
nohup node ~/tvhub/server.js > ~/tvhub/node.out 2>&1 &
rm -f ~/tvhub/tunnel.log
nohup cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787 > ~/tvhub/tunnel.log 2>&1 &
echo "Жду туннель (до 60 сек)..."
U=""
for i in $(seq 1 60); do
  U=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' ~/tvhub/tunnel.log 2>/dev/null | grep -v '//api\.' | head -1)
  [ -n "$U" ] && break
  sleep 1
done
adb devices
if [ -n "$U" ]; then
  echo "$U" > ~/tvhub/url.txt
  H=${U#https://}; H=${H%.trycloudflare.com}
  echo; echo "#################################"
  echo "HOST:  $H"
  echo "#################################"
else
  echo "TUNNEL FAILED:"; tail -5 ~/tvhub/tunnel.log
fi
