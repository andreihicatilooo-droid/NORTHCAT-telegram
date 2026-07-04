const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const app = express();
app.use(express.json());

// Serve static files from the root directory so it can serve launcher.html
app.use(express.static(__dirname));

const LAUNCHER_PORT = 8000;
const MAIN_PORT = 3000;
const LOG_FILE = path.join(__dirname, 'backend', 'server.log');
const ENV_FILE = path.join(__dirname, 'backend', '.env');
const SERVER_JS = path.join(__dirname, 'backend', 'server.js');

function getMainPID() {
  try {
    const output = execSync(`lsof -t -i:${MAIN_PORT}`, { stdio: ['pipe', 'pipe', 'ignore'] });
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
    if (parts.length >= 2) return { cpu: parts[0], mem: parts[1] };
  } catch (e) {}
  return { cpu: '0.0', mem: '0.0' };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'launcher.html'));
});

// 1. Status API
app.get('/api/status', (req, res) => {
  const pid = getMainPID();
  const stats = getPIDStats(pid);
  res.json({
    running: !!pid,
    pid: pid,
    cpu: stats.cpu,
    mem: stats.mem,
    port: MAIN_PORT
  });
});

// 1.1 Stats API
const DB_FILE = path.join(__dirname, 'backend', 'deals.json');
app.get('/api/stats', (req, res) => {
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
  res.json({ totalDeals, activeDeals, disputeDeals, completedDeals, volume });
});

// 2. Logs API
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json({ logs: '' });
    // Get last 100 lines
    const output = execSync(`tail -n 100 ${LOG_FILE}`, { encoding: 'utf8' });
    res.json({ logs: output });
  } catch (e) {
    res.json({ logs: 'Ошибка чтения логов: ' + e.message });
  }
});

// 3. Clear Logs API
app.post('/api/logs/clear', (req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 4. Start Server
app.post('/api/start', (req, res) => {
  const pid = getMainPID();
  if (pid) return res.json({ ok: false, error: 'Сервер уже запущен (PID: ' + pid + ')' });
  
  const { variant } = req.body || {}; // e.g., 'normal', 'reset_db'
  
  if (variant === 'reset_db') {
    const dbFile = path.join(__dirname, 'backend', 'deals.json');
    if (fs.existsSync(dbFile)) {
      fs.unlinkSync(dbFile);
      fs.appendFileSync(LOG_FILE, '\n[LAUNCHER] База данных deals.json была удалена перед запуском.\n');
    }
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');
  
  fs.appendFileSync(LOG_FILE, `\n[LAUNCHER] Запуск сервера (Вариант: ${variant || 'normal'})...\n`);
  
  const server = spawn('node', [SERVER_JS], {
    detached: true,
    stdio: ['ignore', out, err]
  });
  server.unref();

  setTimeout(() => {
    const newPid = getMainPID();
    if (newPid) {
      res.json({ ok: true, pid: newPid });
    } else {
      res.json({ ok: false, error: 'Процесс завершился сразу после запуска. Проверьте логи.' });
    }
  }, 1500);
});

// 5. Stop Server
app.post('/api/stop', (req, res) => {
  const pid = getMainPID();
  if (!pid) return res.json({ ok: false, error: 'Сервер не запущен' });
  
  try {
    execSync(`kill -9 ${pid}`);
    fs.appendFileSync(LOG_FILE, `\n[LAUNCHER] Сервер остановлен (PID: ${pid}).\n`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 6. Templates / Presets API
const PRESETS = {
  'empty': '',
  'dev_local': 'PORT=3000\nFEE_PERCENT=0\nPUBLIC_URL=http://127.0.0.1:3000\nBOT_NAME=CRB GA (Dev)\n',
  'production': 'PORT=3000\nFEE_PERCENT=5\nPUBLIC_URL=https://your-domain.com\nBOT_NAME=CRB GA\n'
};

app.get('/api/env', (req, res) => {
  const content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  res.json({ content });
});

app.post('/api/env', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'Неверный формат' });
  fs.writeFileSync(ENV_FILE, content);
  res.json({ ok: true });
});

app.post('/api/env/preset', (req, res) => {
  const { preset } = req.body;
  if (!PRESETS[preset]) return res.status(400).json({ error: 'Неизвестный шаблон' });
  fs.writeFileSync(ENV_FILE, PRESETS[preset]);
  res.json({ ok: true, content: PRESETS[preset] });
});

// 7. Open CLI Menu in a new terminal
app.post('/api/cli', (req, res) => {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  
  try {
    if (isWin) {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'node cli.js'], { detached: true });
    } else if (isMac) {
      execSync(`osascript -e 'tell application "Terminal" to do script "cd \\"${__dirname}\\" && node cli.js"'`);
    } else {
      // Linux
      const terms = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'lxterminal', 'xterm'];
      let launched = false;
      for (const term of terms) {
        try {
          const termPath = execSync(`which ${term}`).toString().trim();
          if (termPath) {
            if (term === 'gnome-terminal') {
              spawn(termPath, ['--', 'node', 'cli.js'], { detached: true });
            } else if (term === 'xterm') {
              spawn(termPath, ['-e', 'node cli.js'], { detached: true });
            } else {
              spawn(termPath, ['-e', 'node cli.js'], { detached: true });
            }
            launched = true;
            break;
          }
        } catch(e) {}
      }
      
      if (!launched) {
        return res.json({ ok: false, error: 'Не найден эмулятор терминала (gnome-terminal, xterm, и т.д.)' });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 8. Create Tunnel (Cloudflare Tunnel)
let tunnelProcess = null;
app.post('/api/tunnel', (req, res) => {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
  
  const portMatch = (fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '').match(/PORT=(\d+)/);
  const port = portMatch ? portMatch[1] : 3000;
  
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  tunnelProcess = spawn(cmd, ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`]);
  
  let urlFound = false;
  let tunnelUrl = "";
  
  const parseData = (data) => {
    const output = data.toString();
    const match = output.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match && !urlFound) {
      urlFound = true;
      tunnelUrl = match[1];
      
      let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
      if (env.includes("PUBLIC_URL=")) env = env.replace(/PUBLIC_URL=.*/, `PUBLIC_URL=${tunnelUrl}`);
      else env += `\nPUBLIC_URL=${tunnelUrl}`;
      
      if (env.includes("BOT_MENU_BUTTON_URL=")) env = env.replace(/BOT_MENU_BUTTON_URL=.*/, `BOT_MENU_BUTTON_URL=${tunnelUrl}`);
      else env += `\nBOT_MENU_BUTTON_URL=${tunnelUrl}`;
      
      fs.writeFileSync(ENV_FILE, env);

      // Auto-restart server if running to apply new tunnel URL
      const pid = getMainPID();
      if (pid) {
        try {
          execSync(`kill -9 ${pid}`);
          const out = fs.openSync(LOG_FILE, 'a');
          const err = fs.openSync(LOG_FILE, 'a');
          fs.appendFileSync(LOG_FILE, `\n[LAUNCHER] Авто-перезапуск сервера после обновления туннеля Cloudflare...\n`);
          const server = spawn('node', [SERVER_JS], {
            detached: true,
            stdio: ['ignore', out, err]
          });
          server.unref();
        } catch (e) {
          console.error("Auto-restart failed:", e.message);
        }
      }
    }
  };

  tunnelProcess.stdout.on('data', parseData);
  tunnelProcess.stderr.on('data', parseData);

  setTimeout(() => {
    if (urlFound) res.json({ ok: true, url: tunnelUrl });
    else res.json({ ok: false, error: 'Таймаут получения URL туннеля (возможно, cloudflared временно недоступен)' });
  }, 6500);
});

app.listen(LAUNCHER_PORT, () => {
  console.log(`Web Launcher запущен на порту ${LAUNCHER_PORT}`);
  console.log(`Откройте http://127.0.0.1:${LAUNCHER_PORT}/launcher.html`);
});
