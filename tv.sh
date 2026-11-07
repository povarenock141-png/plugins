#!/data/data/com.termux/files/usr/bin/bash
# Установка хаба на ТВ. Запуск: bash tv.sh <токен>
T="$1"
[ -n "$T" ] || { echo "NO TOKEN"; exit 1; }
B=https://raw.githubusercontent.com/povarenock141-png/plugins/tv-hub
mkdir -p $PREFIX/etc/apt/apt.conf.d
printf 'Dpkg::Options {"--force-confdef";"--force-confold";};\nAPT::Get::Assume-Yes "true";\n' > $PREFIX/etc/apt/apt.conf.d/99tvhub
echo "== packages =="
pkg install -y android-tools nodejs cloudflared procps || { echo "PKG FAILED"; exit 1; }
echo "== files =="
mkdir -p ~/tvhub && cd ~/tvhub
echo "$T" > token
curl -fsSL $B/server.js -o server.js && curl -fsSL $B/start-tv.sh -o start.sh || { echo "DOWNLOAD FAILED"; exit 1; }
node --check server.js || { echo "SERVER BROKEN"; exit 1; }
mkdir -p ~/.termux/boot
printf '#!/data/data/com.termux/files/usr/bin/bash\ntermux-wake-lock\nbash ~/tvhub/start.sh\n' > ~/.termux/boot/tvhub.sh
chmod +x ~/.termux/boot/tvhub.sh
echo "== start =="
bash ~/tvhub/start.sh
