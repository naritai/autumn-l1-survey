#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  print 'Для запуска нужен Node.js 24 или новее. Установите его и откройте этот файл снова.'
  read 'reply?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
export DATA_DIR="$PWD/data-pilot"
print 'Локальная проверка. Остановка: Ctrl+C. Ответы сохраняются в data-pilot.'
node server.mjs
result=$?
if [ "$result" -ne 0 ]; then
  print 'Сервер не запустился. Если порт занят, сначала остановите предыдущий запуск.'
fi
read 'reply?Нажмите Enter, чтобы закрыть окно.'
exit "$result"
