#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, exec, spawn } = require('child_process');

const PORT_FILE = path.join(__dirname, 'backend', 'port.tmp');
const DB_FILE = path.join(__dirname, 'backend', 'deals.json');
const RUNTIME_SETTINGS_FILE = path.join(__dirname, 'backend', 'runtime_settings.json');
const LOG_FILE = path.join(__dirname, 'backend', 'server.log');

// ANSI color escapes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  
  fgBlack: '\x1b[30m',
  fgRed: '\x1b[31m',
  fgGreen: '\x1b[32m',
  fgYellow: '\x1b[33m',
  fgBlue: '\x1b[34m',
  fgMagenta: '\x1b[35m',
  fgCyan: '\x1b[36m',
  fgWhite: '\x1b[37m',
  
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function getPIDByPort(port) {
  try {
    const output = execSync(`lsof -t -i:${port}`, { stdio: ['pipe', 'pipe', 'ignore'] });
    return output.toString().trim().split('\n')[0];
  } catch (e) {
    return null;
  }
}

function getPIDStats(pid) {
  if (!pid) return { cpu: '0.0', mem: '0.0' };
  try {
    const output = execSync(`ps -p ${pid} -o %cpu,%mem --no-headers`, { stdio: ['pipe', 'pipe', 'ignore'] });
    const parts = output.toString().trim().split(/\s+/);
    if (parts.length >= 2) {
      return { cpu: parts[0], mem: parts[1] };
    }
  } catch (e) {}
  return { cpu: '0.0', mem: '0.0' };
}

function loadConfig() {
  let port = 3000;
  let botToken = 'Не задан';
  let botUsername = 'Не инициализирован';

  // Читаем .env
  const envPath = path.join(__dirname, 'backend', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const portMatch = content.match(/^PORT\s*=\s*(.*)$/m);
    if (portMatch) port = portMatch[1].trim();
  }

  // Читаем runtime settings
  if (fs.existsSync(RUNTIME_SETTINGS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(RUNTIME_SETTINGS_FILE, 'utf8'));
      if (data.botToken) botToken = 'Настроен (в рантайме)';
      if (data.botProfile && data.botProfile.username) {
        botUsername = '@' + data.botProfile.username;
      }
    } catch (e) {}
  }

  return { port, botToken, botUsername };
}

function getStats() {
  let totalDeals = 0;
  let activeDeals = 0;
  let disputeDeals = 0;
  let completedDeals = 0;
  let volume = 0;

  if (fs.existsSync(DB_FILE)) {
    try {
      const deals = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      totalDeals = deals.length;
      deals.forEach(d => {
        if (d.status === 'completed') {
          completedDeals++;
          volume += parseFloat(d.amount) || 0;
        } else if (d.status === 'dispute') {
          disputeDeals++;
          activeDeals++;
        } else if (['new', 'paid', 'fulfilled'].includes(d.status)) {
          activeDeals++;
        }
      });
    } catch (e) {}
  }

  return { totalDeals, activeDeals, disputeDeals, completedDeals, volume };
}

function printHeader() {
  console.log(`${colors.fgCyan}${colors.bright}┌────────────────────────────────────────────────────────┐`);
  console.log(`│               NORTHCAT Telegram Escrow CLI             │`);
  console.log(`└────────────────────────────────────────────────────────┘${colors.reset}\n`);
}

function renderDashboard() {
  clearScreen();
  printHeader();

  const cfg = loadConfig();
  const stats = getStats();
  const pid = getPIDByPort(cfg.port);
  const statusStr = pid 
    ? `${colors.fgGreen}${colors.bright}РАБОТАЕТ (PID: ${pid})${colors.reset}` 
    : `${colors.fgRed}${colors.bright}ОСТАНОВЛЕН${colors.reset}`;
  
  const pidStats = getPIDStats(pid);

  console.log(`${colors.bright}--- СТАТУС СЕРВЕРА ---${colors.reset}`);
  console.log(`Статус:        ${statusStr}`);
  if (pid) {
    console.log(`Нагрузка:      CPU: ${colors.fgYellow}${pidStats.cpu}%${colors.reset} | RAM: ${colors.fgYellow}${pidStats.mem}%${colors.reset}`);
  }
  console.log(`Порт:          ${colors.fgCyan}${cfg.port}${colors.reset}`);
  console.log(`URL Mini App:  ${colors.fgCyan}http://127.0.0.1:${cfg.port}/${colors.reset}`);
  console.log(`Настройки:     ${colors.fgCyan}http://127.0.0.1:${cfg.port}/settings.html${colors.reset}`);
  console.log(`Бот в сети:    ${colors.fgYellow}${cfg.botUsername}${colors.reset}`);
  console.log('');

  console.log(`${colors.bright}--- СТАТИСТИКА СДЕЛОК ---${colors.reset}`);
  console.log(`Всего сделок:    ${colors.bright}${stats.totalDeals}${colors.reset}`);
  console.log(`Активных сделок: ${colors.fgGreen}${stats.activeDeals}${colors.reset}`);
  console.log(`Открытых споров: ${colors.fgRed}${stats.disputeDeals}${colors.reset}`);
  console.log(`Оборот (Escrow): ${colors.fgGreen}${stats.volume.toFixed(2)} USDT${colors.reset}`);
  console.log('\n--------------------------------------------------------');
}

function showLogs() {
  clearScreen();
  printHeader();
  console.log(`${colors.fgYellow}Логи сервера (нажмите Ctrl+C для выхода из режима логов):${colors.reset}\n`);

  if (!fs.existsSync(LOG_FILE)) {
    console.log('Файл логов пуст или ещё не создан.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nНажмите Enter для возврата в меню...', () => {
      rl.close();
      mainMenu();
    });
    return;
  }

  // Запуск tail -f
  const tail = spawn('tail', ['-n', '30', '-f', LOG_FILE]);
  tail.stdout.on('data', (data) => {
    process.stdout.write(data.toString());
  });

  tail.stderr.on('data', (data) => {
    process.stdout.write(data.toString());
  });

  // setRawMode доступен только в интерактивном терминале: в CI/при запуске
  // через pipe process.stdin.isTTY отсутствует и вызов бросил бы исключение.
  const canRaw = !!(process.stdin.isTTY && process.stdin.setRawMode);

  const cleanExit = () => {
    tail.kill();
    process.stdin.removeListener('data', onKey);
    if (canRaw) process.stdin.setRawMode(false);
    mainMenu();
  };

  const onKey = (key) => {
    if (key.toString() === '\u0003' || key.toString() === '\r' || key.toString() === '\n') { // Ctrl+C or Enter
      cleanExit();
    }
  };

  if (canRaw) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
}

function listDeals() {
  clearScreen();
  printHeader();
  console.log(`${colors.bright}--- СПИСОК СДЕЛОК (ПОСЛЕДНИЕ 15) ---${colors.reset}\n`);

  if (fs.existsSync(DB_FILE)) {
    try {
      const deals = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (deals.length === 0) {
        console.log('Сделок пока нет.');
      } else {
        const sorted = deals.sort((a, b) => b.createdAt - a.createdAt).slice(0, 15);
        sorted.forEach(d => {
          let statusColor = colors.fgYellow;
          if (d.status === 'completed') statusColor = colors.fgGreen;
          if (d.status === 'dispute') statusColor = colors.fgRed;
          if (d.status === 'cancelled') statusColor = colors.dim;

          console.log(`[${d.id}] ${colors.bright}${d.title}${colors.reset}`);
          console.log(`  Сумма:   ${d.amount} ${d.currency} (Через: ${d.method})`);
          console.log(`  Статус:  ${statusColor}${d.status.toUpperCase()}${colors.reset}`);
          console.log(`  Участники: Продавец: ${d.ownerUsername || 'ID ' + d.ownerId} | Покупатель: ${d.counterparty}`);
          console.log('  ------------------------------------------------');
        });
      }
    } catch (e) {
      console.log('Ошибка чтения базы данных сделок.');
    }
  } else {
    console.log('База данных сделок отсутствует.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('\nНажмите Enter для возврата в меню...', () => {
    rl.close();
    mainMenu();
  });
}

function restartServer() {
  clearScreen();
  printHeader();
  console.log(`${colors.fgYellow}Перезапуск сервера...${colors.reset}\n`);

  const cfg = loadConfig();
  const pid = getPIDByPort(cfg.port);
  if (pid) {
    console.log(`Завершаем процесс ${pid}...`);
    try {
      execSync(`kill -9 ${pid}`);
    } catch (e) {}
  }

  console.log('Запуск сервера в фоновом режиме...');
  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');
  
  const server = spawn('node', [path.join(__dirname, 'backend', 'server.js')], {
    detached: true,
    stdio: ['ignore', out, err]
  });
  server.unref();

  setTimeout(() => {
    console.log(`${colors.fgGreen}Сервер успешно перезапущен!${colors.reset}`);
    setTimeout(() => {
      mainMenu();
    }, 1000);
  }, 1500);
}

function stopServerAndExit() {
  const cfg = loadConfig();
  const pid = getPIDByPort(cfg.port);
  if (pid) {
    console.log(`Завершаем фоновый процесс сервера (${pid})...`);
    try {
      execSync(`kill -9 ${pid}`);
    } catch (e) {}
  }
  console.log('Выход из приложения.');
  process.exit(0);
}

function clearLogs() {
  clearScreen();
  printHeader();
  if (fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, '');
    console.log(`${colors.fgGreen}Файл логов успешно очищен!${colors.reset}`);
  } else {
    console.log('Файл логов не существует.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('\nНажмите Enter для возврата в меню...', () => {
    rl.close();
    mainMenu();
  });
}

function liveDashboard() {
  const interval = setInterval(() => {
    renderDashboard();
    console.log(`\n${colors.dim}Режим Live-мониторинга. Обновление каждую секунду... Нажмите Enter для выхода.${colors.reset}`);
  }, 1000);
  
  // Вызываем сразу, чтобы не ждать секунду
  renderDashboard();
  console.log(`\n${colors.dim}Режим Live-мониторинга. Обновление каждую секунду... Нажмите Enter для выхода.${colors.reset}`);

  const cleanExit = () => {
    clearInterval(interval);
    process.stdin.removeListener('data', onKey);
    process.stdin.setRawMode(false);
    mainMenu();
  };

  const onKey = (key) => {
    if (key.toString() === '\u0003' || key.toString() === '\r' || key.toString() === '\n') { // Ctrl+C or Enter
      cleanExit();
    }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
}

function openInBrowser(urlPath) {
  const cfg = loadConfig();
  const url = `http://127.0.0.1:${cfg.port}${urlPath}`;
  console.log(`\nОткрываем в браузере: ${url}`);
  try {
    if (process.platform === 'win32') execSync(`start "" "${url}"`);
    else if (process.platform === 'darwin') execSync(`open "${url}"`);
    else execSync(`xdg-open "${url}" > /dev/null 2>&1`);
  } catch (e) {
    console.log(`${colors.fgRed}Не удалось автоматически открыть браузер. Перейдите по ссылке вручную:${colors.reset} ${url}`);
  }
  setTimeout(mainMenu, 2000);
}

function createTunnelCLI() {
  const cfg = loadConfig();
  console.log(`\n${colors.fgYellow}Запускаем Cloudflare Tunnel на порту ${cfg.port}...${colors.reset}`);
  console.log(`Пожалуйста, подождите, получаем URL...`);
  
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const lt = spawn(cmd, ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${cfg.port}`]);
  
  let urlFound = false;
  
  const parseData = (data) => {
    const output = data.toString();
    const match = output.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match && !urlFound) {
      urlFound = true;
      const url = match[1];
      console.log(`${colors.fgGreen}✅ Туннель успешно создан: ${colors.bright}${url}${colors.reset}`);
      
      const envPath = path.join(__dirname, 'backend', '.env');
      let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      if (env.includes("PUBLIC_URL=")) env = env.replace(/PUBLIC_URL=.*/, `PUBLIC_URL=${url}`);
      else env += `\nPUBLIC_URL=${url}`;
      
      if (env.includes("BOT_MENU_BUTTON_URL=")) env = env.replace(/BOT_MENU_BUTTON_URL=.*/, `BOT_MENU_BUTTON_URL=${url}`);
      else env += `\nBOT_MENU_BUTTON_URL=${url}`;
      
      fs.writeFileSync(envPath, env);
      console.log(`${colors.fgGreen}Файл .env обновлен (PUBLIC_URL и BOT_MENU_BUTTON_URL).${colors.reset}`);
      
      const pid = getPIDByPort(cfg.port);
      if (pid) {
        console.log(`${colors.fgYellow}Авто-перезапуск сервера для применения нового туннеля Cloudflare...${colors.reset}`);
        try {
          execSync(`kill -9 ${pid}`);
          const logStream = fs.openSync(LOG_FILE, 'a');
          fs.appendFileSync(LOG_FILE, `\n[CLI] Авто-перезапуск сервера после обновления туннеля Cloudflare...\n`);
          const server = spawn('node', [path.join(__dirname, 'backend', 'server.js')], {
            detached: true,
            stdio: ['ignore', logStream, logStream]
          });
          server.unref();
          console.log(`${colors.fgGreen}Сервер успешно перезапущен с новым туннелем!${colors.reset}`);
        } catch (e) {
          console.log(`${colors.fgRed}Не удалось автоматически перезапустить сервер: ${e.message}${colors.reset}`);
        }
      } else {
        console.log(`${colors.fgYellow}Сервер не запущен. Новый туннель применится при следующем запуске.${colors.reset}`);
      }
      console.log('');
      
      lt.unref();
      waitForInput();
    }
  };

  lt.stdout.on('data', parseData);
  lt.stderr.on('data', parseData);

  setTimeout(() => {
    if (!urlFound) {
      console.log(`${colors.fgRed}Таймаут получения URL туннеля.${colors.reset}\n`);
      lt.kill();
      waitForInput();
    }
  }, 7000);
}

function waitForInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Нажмите Enter для возврата в главное меню...', () => {
    rl.close();
    mainMenu();
  });
}

function mainMenu() {
  renderDashboard();

  console.log(`${colors.bright}Выберите действие:${colors.reset}`);
  console.log(`[1] Показать live-логи бэкенда и бота`);
  console.log(`[2] Показать список сделок`);
  console.log(`[3] Перезапустить сервер`);
  console.log(`[4] Остановить сервер и выйти`);
  console.log(`[5] Очистить логи сервера`);
  console.log(`[6] Live-мониторинг (автообновление)`);
  console.log(`[7] 📱 Открыть Mini App в браузере`);
  console.log(`[8] ⚙️ Открыть Настройки в браузере`);
  console.log(`[9] 🔗 Создать Публичный Туннель (localtunnel)`);
  console.log(`[0] Выйти из консоли (оставив сервер в фоне)`);
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question(`${colors.bright}>> ${colors.reset}`, (answer) => {
    rl.close();
    switch (answer.trim()) {
      case '1':
        showLogs();
        break;
      case '2':
        listDeals();
        break;
      case '3':
        restartServer();
        break;
      case '4':
        stopServerAndExit();
        break;
      case '5':
        clearLogs();
        break;
      case '6':
        liveDashboard();
        break;
      case '7':
        openInBrowser('/');
        break;
      case '8':
        openInBrowser('/settings.html');
        break;
      case '9':
        createTunnelCLI();
        break;
      case '0':
        clearScreen();
        console.log('Консольное меню закрыто. Сервер продолжает работу в фоновом режиме.');
        process.exit(0);
        break;
      default:
        mainMenu();
        break;
    }
  });
}

mainMenu();
