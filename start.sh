#!/bin/bash
# CRB GA Launcher & CLI Wrapper

# ANSI colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# 1. Загрузка переменных из .env (из корня или backend)
ENV_PATH="./backend/.env"
if [ ! -f "$ENV_PATH" ]; then
  ENV_PATH="./.env"
fi

PORT=3000
if [ -f "$ENV_PATH" ]; then
  # Читаем порт из .env
  ENV_PORT=$(grep -E "^PORT=" "$ENV_PATH" | cut -d'=' -f2 | tr -d '\r' | tr -d ' ')
  if [ ! -z "$ENV_PORT" ]; then
    PORT=$ENV_PORT
  fi
fi

# 2. Установка зависимостей
if [ ! -d "./backend/node_modules" ]; then
  echo -e "${YELLOW}Папка node_modules не найдена. Устанавливаем зависимости бэкенда...${NC}"
  cd backend && npm install && cd ..
fi

# 3. Освобождение порта (если доступен lsof).
# Сначала пробуем корректный TERM, и лишь затем KILL. Каждый PID обрабатываем
# отдельно, чтобы несколько результатов lsof не привели к неожиданным убийствам,
# и не падаем, если lsof недоступен или порт уже свободен.
if command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -t -i:"$PORT" 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo -e "${YELLOW}Порт $PORT занят (PID: $PIDS). Освобождаем...${NC}"
    for pid in $PIDS; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
    # Если процесс не завершился штатно — принудительно
    for pid in $PIDS; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi
else
  echo -e "${YELLOW}lsof недоступен — пропускаем освобождение порта $PORT.${NC}"
fi

# 4. Запуск бэкенда в фоновом режиме с записью логов в backend/server.log
LOG_FILE="./backend/server.log"
echo -e "${YELLOW}Запуск сервера на порту $PORT...${NC}"
node backend/server.js > "$LOG_FILE" 2>&1 &

# Даем серверу запуститься
sleep 1.5

# 5. Запуск интерактивного консольного интерфейса
chmod +x ./cli.js
./cli.js
