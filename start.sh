#!/bin/bash
# CRB GA Launcher Script

# ANSI colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}==================================================${NC}"
echo -e "${CYAN}${BOLD}       CRB GA — Запуск гарант-сервиса Telegram     ${NC}"
echo -e "${CYAN}${BOLD}==================================================${NC}"

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
echo -e "\n${YELLOW}📦 Проверка зависимостей...${NC}"
if [ ! -d "./backend/node_modules" ]; then
  echo -e "${YELLOW}Папка node_modules не найдена. Устанавливаем зависимости бэкенда...${NC}"
  cd backend && npm install && cd ..
else
  echo -e "${GREEN}Зависимости уже установлены.${NC}"
fi

# 3. Освобождение порта
echo -e "\n${YELLOW}🔌 Проверка порта $PORT...${NC}"
PID=$(lsof -t -i:$PORT)
if [ ! -z "$PID" ]; then
  echo -e "${YELLOW}Порт $PORT занят процессом (PID: $PID). Освобождаем...${NC}"
  kill -9 $PID
  sleep 1
  echo -e "${GREEN}Порт $PORT успешно освобождён.${NC}"
else
  echo -e "${GREEN}Порт $PORT свободен.${NC}"
fi

# 4. Запуск сервера
echo -e "\n${GREEN}${BOLD}🚀 Запуск бэкенд-сервера...${NC}"
echo -e "${CYAN}--------------------------------------------------${NC}"
echo -e "${BOLD}Адрес Mini App:${NC}      ${GREEN}http://127.0.0.1:$PORT/${NC}"
echo -e "${BOLD}Настройки сервера:${NC}  ${GREEN}http://127.0.0.1:$PORT/settings.html${NC}"
echo -e "${CYAN}--------------------------------------------------${NC}"
echo -e "${YELLOW}Для остановки нажмите Ctrl+C${NC}\n"

cd backend && npm start
