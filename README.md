# tv-hub

Управление Android TV по ADB из Claude: MCP-сервер для Termux + туннель Cloudflare.
Секретный ключ создаётся на устройстве при установке, в репозитории его нет.

Установка в Termux:

    curl -fsSL https://raw.githubusercontent.com/povarenock141-png/plugins/tv-hub/setup.sh -o ~/tvsetup.sh && bash ~/tvsetup.sh

Обновление сервера (адрес туннеля не меняется):

    curl -fsSL https://raw.githubusercontent.com/povarenock141-png/plugins/tv-hub/update.sh -o ~/tvupdate.sh && bash ~/tvupdate.sh
