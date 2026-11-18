'use strict';

const { app, BrowserWindow, ipcMain, Menu, nativeTheme, clipboard, screen, dialog, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { t, setLocale, resolveLocale } = require('./shared/i18n');

// ---------------------------------------------------------------- pty loader
// node-pty 是原生模块。优先用官方包，其次用带预编译产物的分支版本。
function loadPty() {
  const candidates = ['node-pty', '@homebridge/node-pty-prebuilt-multiarch'];
  const errors = [];
  for (const name of candidates) {
    try {
      const mod = require(name);
      if (mod && typeof mod.spawn === 'function') return mod;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  console.error('[MagicShell] 无法加载 pty 模块\n' + errors.join('\n'));
  return null;
}

const ptyLib = loadPty();

// ------------------------------------------------------------------- config
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'magicshell-config.json');

const DEFAULT_SETTINGS = {
  bg: '#0b0f14',
  fg: '#d7dde5',
  paneBg: null,
  paneFg: null,
  accent: '#3b82f6',
  fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
  fontSize: 14,
  lineHeight: 1.2,
  cursorBlink: true,
  shell: 'auto',
  startDir: null,        // 全局默认启动目录（null = 用户主目录）
  recentDirs: [],        // 最近用过的启动目录
  sidebarWidth: 250,     // 左侧分组栏宽度
  sidebarCollapsed: false,
  uiScale: 1,
  restoreSessions: true,
  notifyOnDone: true,    // 长命令跑完（窗口不在前台）弹通知 + 闪任务栏
  activeGroupId: null,
  language: 'auto',      // auto = 跟随系统；zh-CN / en-US 手动指定
};

const CONFIG_BAK = () => path.join(app.getPath('userData'), 'magicshell-config.bak.json');

// 内存里只保留一份配置，所有写入都基于它合并。
// 这样「窗口位置」和「分组/布局」两个写入方不会互相覆盖（以前就是各读各写，有概率丢布局）。
let configCache = null;

function parseConfig(raw) {
  const parsed = raw && typeof raw === 'object' ? raw : {};
  return {
    settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
    groups: Array.isArray(parsed.groups) ? parsed.groups : null,
    window: parsed.window && typeof parsed.window === 'object' ? parsed.window : null,
  };
}

function readConfig() {
  if (configCache) return configCache;
  for (const file of [CONFIG_FILE(), CONFIG_BAK()]) {
    try {
      configCache = parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
      return configCache;
    } catch { /* 主文件坏了就用备份，都没有则用默认值 */ }
  }
  configCache = parseConfig(null);
  return configCache;
}

function writeConfig(cfg) {
  configCache = cfg;
  const file = CONFIG_FILE();
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(cfg, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写临时文件再原子替换：写到一半被杀掉也不会留下半个 JSON 导致全部配置丢失
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, CONFIG_BAK());
      fs.renameSync(tmp, file);
    } catch {
      fs.writeFileSync(file, text, 'utf8');
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    return true;
  } catch (err) {
    console.error('[MagicShell] 配置写入失败', err);
    return false;
  }
}

// 只改某个字段：基于当前内存配置合并，绝不拿旧的读结果盖掉别的写入方
function patchConfig(patch) {
  const cur = readConfig();
  return writeConfig({ ...cur, ...patch });
}

// -------------------------------------------------------------- shell lookup
function existsOnPath(exe) {
  if (!exe) return null;
  if (path.isAbsolute(exe)) return fs.existsSync(exe) ? exe : null;
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const direct = path.join(dir, exe);
    try {
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
    } catch { /* ignore */ }
    for (const ext of exts) {
      const withExt = path.join(dir, exe + ext.toLowerCase());
      try {
        if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function resolveShell(preferred) {
  const known = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ];
  if (preferred && preferred !== 'auto') {
    const found = existsOnPath(preferred);
    if (found) return { file: found, args: ['-NoLogo'] };
  }
  const pwsh = existsOnPath('pwsh.exe') || known.find((p) => fs.existsSync(p) && p.includes('pwsh'));
  if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
  const ps = known.find((p) => fs.existsSync(p)) || existsOnPath('powershell.exe');
  if (ps) return { file: ps, args: ['-NoLogo'] };
  return { file: process.env.ComSpec || 'cmd.exe', args: [] };
}

// ------------------------------------------------------------ 启动目录处理
const homeDir = () => process.env.USERPROFILE || process.env.HOME || process.cwd();

// 把一个用户输入的路径规范化：去引号、展开 ~、要求确实是个存在的目录
function normalizeDir(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/^"(.*)"$/, '$1').trim();
  if (s === '~') s = homeDir();
  else if (/^~[\\/]/.test(s)) s = path.join(homeDir(), s.slice(2));
  try {
    // 相对路径按用户主目录解析，避免跟着应用自己的 cwd 跑；
    // path.resolve 顺手把 / 统一成 \，配置里只存一种写法
    const abs = path.resolve(path.isAbsolute(s) ? s : path.join(homeDir(), s));
    return fs.statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

// 让 PowerShell 通过 OSC 7 报告当前目录（VS Code 等终端用的也是这招）。
// 包装而不是覆盖用户的 prompt：先调原 prompt，再把 ESC]7;file://…BEL 拼在最前面。
//
// 顺便发一条 shell integration 的最小实现（Windows Terminal / VS Code 的 OSC 133 同款）：
//   133;D;<退出码>  上一条命令结束，带退出码 → 渲染层据此标绿/标红、算耗时
//   133;A           提示符开始
//   133;B           提示符结束（用户开始输入的位置）
// 退出码：$? 为真就是 0；为假时优先用 $LASTEXITCODE（原生命令的真实退出码），
// 但 $LASTEXITCODE 在 cmdlet 报错时不会更新，所以拿上一次看到的值比一下，一样就当成陈旧的 → 记 1。
const OSC_HOOK_PS = `
try {
  $global:__msOrigPrompt = $function:prompt;
  if (-not $global:__msOrigPrompt) {
    $global:__msOrigPrompt = { "PS $($PWD.ProviderPath)> " };
  }
  if ($null -eq $global:__msLastCode) { $global:__msLastCode = 0 }
  function global:prompt {
    $msOk = $?
    $msCode = $global:LASTEXITCODE
    $msText = & $global:__msOrigPrompt;
    try {
      if ($msOk) { $msExit = 0 }
      elseif ($msCode -is [int] -and $msCode -ne 0 -and $msCode -ne $global:__msLastCode) { $msExit = $msCode }
      else { $msExit = 1 }
      $global:__msLastCode = $msCode
      $msOut = "$([char]27)]133;D;$msExit$([char]7)"
      $msOut += "$([char]27)]133;A$([char]7)"
      $msDir = $PWD.ProviderPath;
      if ($msDir) {
        $msUri = 'file://' + $env:COMPUTERNAME + '/' + ($msDir -replace '\\\\', '/');
        $msOut += "$([char]27)]7;$msUri$([char]7)";
      }
      $msOut += $msText;
      $msOut += "$([char]27)]133;B$([char]7)";
      return $msOut;
    } catch { }
    return $msText;
  }
} catch { }
`;
const OSC_HOOK_ARGV = ['-NoExit', '-EncodedCommand', Buffer.from(OSC_HOOK_PS, 'utf16le').toString('base64')];

function isPowerShell(file) {
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(String(file || ''));
}

// -------------------------------------------------------------------- window
let mainWindow = null;
const sessions = new Map(); // id -> { pty, sid }
let sessionSeq = 0;         // 用来丢弃"旧进程"迟到的输出/退出事件（重启终端时会撞上）

function luminanceOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// 上次保存的窗口位置可能已经不在任何一块屏幕上（拔掉副屏、改分辨率），
// 这种情况丢掉坐标让系统居中，尺寸仍然沿用。
function sanitizeBounds(saved) {
  const out = {
    width: Math.max(860, Math.min(12000, Number(saved && saved.width) || 1280)),
    height: Math.max(520, Math.min(12000, Number(saved && saved.height) || 820)),
  };
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    try {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return saved.x + out.width > a.x + 80 && saved.x < a.x + a.width - 80
          && saved.y + 40 > a.y && saved.y < a.y + a.height - 40;
      });
      if (visible) {
        out.x = Math.round(saved.x);
        out.y = Math.round(saved.y);
      }
    } catch { /* ignore */ }
  }
  return out;
}

function createWindow() {
  const cfg = readConfig();
  const saved = cfg.window || {};
  const bounds = sanitizeBounds(saved);
  const light = luminanceOf(cfg.settings.bg) > 0.55;
  nativeTheme.themeSource = light ? 'light' : 'dark';

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: cfg.settings.bg,
    show: false,
    autoHideMenuBar: true,
    title: 'MagicShell',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    // 先把最大化/全屏还原，再显示，避免先闪一下小窗口
    if (saved.fullscreen) mainWindow.setFullScreen(true);
    if (saved.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  // F12 / Ctrl+Shift+I 打开调试面板
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isDevTools =
      input.key === 'F12' ||
      (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (isDevTools && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // 记住窗口大小/位置/最大化状态 —— 只 patch window 字段，不碰分组与布局
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    let b;
    try { b = mainWindow.getNormalBounds(); } catch { b = mainWindow.getBounds(); }
    patchConfig({
      window: {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        maximized: mainWindow.isMaximized(),
        fullscreen: mainWindow.isFullScreen(),
      },
    });
  };
  const saveBoundsSoon = debounce(saveBounds, 350);
  mainWindow.on('resize', saveBoundsSoon);
  mainWindow.on('move', saveBoundsSoon);
  // 最大化这类状态变化不会被 resize 稳定捕获，单独立刻记一次
  mainWindow.on('maximize', saveBounds);
  mainWindow.on('unmaximize', saveBounds);
  mainWindow.on('enter-full-screen', saveBounds);
  mainWindow.on('leave-full-screen', saveBounds);
  mainWindow.on('close', saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// 主进程的界面语言：和渲染层共用 src/shared/i18n.js，切语言后原生对话框也跟着变
function syncLocale() {
  let setting = 'auto';
  try { setting = (readConfig().settings || {}).language || 'auto'; } catch { /* 配置读不到就按系统语言 */ }
  return setLocale(resolveLocale(setting, app.getLocale()));
}

// ----------------------------------------------------------------------- ipc
function registerIpc() {
  ipcMain.handle('config:load', () => readConfig());
  ipcMain.handle('config:save', (_e, cfg) => {
    const cur = readConfig();
    const next = {
      ...cur,
      settings: { ...DEFAULT_SETTINGS, ...((cfg && cfg.settings) || {}) },
      groups: cfg && Array.isArray(cfg.groups) ? cfg.groups : cur.groups,
      window: (cfg && cfg.window) || cur.window,
    };
    const ok = writeConfig(next);
    syncLocale();   // 设置里换了语言，主进程的原生对话框也要跟着换
    return ok;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    ptyReady: !!ptyLib,
    shell: resolveShell(readConfig().settings.shell).file,
    locale: app.getLocale(),                 // 系统语言，供 settings.language === 'auto' 时解析
    locales: app.getPreferredSystemLanguages ? app.getPreferredSystemLanguages() : [],
  }));

  ipcMain.handle('win:always-on-top', (_e, flag) => {
    if (!mainWindow) return false;
    mainWindow.setAlwaysOnTop(!!flag, 'floating');
    return mainWindow.isAlwaysOnTop();
  });

  ipcMain.handle('win:is-always-on-top', () => (mainWindow ? mainWindow.isAlwaysOnTop() : false));

  // 任务栏进度条：传 2 = 不确定态（有长命令在跑），传 -1 = 清掉
  ipcMain.handle('win:progress', (_e, value) => {
    if (!mainWindow) return false;
    mainWindow.setProgressBar(Number(value));
    return true;
  });

  // 命令跑完的提醒：任务栏闪烁 + 系统通知（只在窗口没在看的时候用，避免打扰）
  ipcMain.handle('notify:done', (_e, payload = {}) => {
    if (!mainWindow) return false;
    const body = String(payload.body || '');
    const title = String(payload.title || t('notify.doneTitle'));
    try { mainWindow.flashFrame(true); } catch { /* 个别窗口样式不支持闪烁 */ }
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title, body, silent: false });
        n.on('click', () => {
          if (!mainWindow) return;
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        });
        n.show();
      }
    } catch { /* 系统关了通知权限就只闪任务栏 */ }
    return true;
  });

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());

  // 目录选择器：默认定位到当前输入框里的路径
  ipcMain.handle('dir:pick', async (_e, defaultPath) => {
    const start = normalizeDir(defaultPath) || normalizeDir(readConfig().settings.startDir) || homeDir();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: t('main.pickDirTitle'),
      defaultPath: start,
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
      buttonLabel: t('main.pickDirButton'),
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  });

  // 校验路径（供输入框实时提示，不弹任何东西）
  ipcMain.handle('dir:check', (_e, p) => {
    const raw = String(p ?? '').trim();
    if (!raw) return { empty: true };
    const dir = normalizeDir(raw);
    if (dir) return { ok: true, path: dir, name: path.basename(dir) || dir };
    try {
      const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(homeDir(), raw));
      return { ok: false, path: abs, exists: fs.existsSync(abs) };
    } catch {
      return { ok: false, path: raw, exists: false };
    }
  });

  ipcMain.handle('dir:home', () => homeDir());

  ipcMain.handle('system:theme', (_e, bg) => {
    const light = luminanceOf(bg) > 0.55;
    nativeTheme.themeSource = light ? 'light' : 'dark';
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  });

  ipcMain.handle('pty:create', (_e, opts = {}) => {
    if (!ptyLib) {
      return { ok: false, error: t('main.ptyLoadFailed') };
    }
    const id = String(opts.id || '');
    if (!id) return { ok: false, error: 'invalid id' };
    if (sessions.has(id)) {
      const cur = sessions.get(id);
      return { ok: true, pid: cur.pty.pid, sid: cur.sid };
    }

    const settings = readConfig().settings;
    const shell = resolveShell(opts.shell || settings.shell);
    // 目录优先级：终端自己的设置 > 全局默认 > 用户主目录
    const paneDir = normalizeDir(opts.cwd);
    const globalDir = normalizeDir(settings.startDir);
    const requested = paneDir || globalDir || null;
    const cwd = requested || homeDir();
    // 用户确实填了路径却用不了 → 告诉渲染层别静默降级
    const cwdFallback = (!!opts.cwd && !paneDir) || (!opts.cwd && !!settings.startDir && !globalDir);
    const cols = Math.max(2, Number(opts.cols) || 100);
    const rows = Math.max(2, Number(opts.rows) || 30);

    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'MagicShell',
    };

    // PowerShell 额外挂一个 prompt 钩子：实时目录（OSC 7）+ 命令边界与退出码（OSC 133）
    const args = isPowerShell(shell.file) && opts.trackCwd !== false
      ? [...shell.args, ...OSC_HOOK_ARGV]
      : shell.args;

    let proc;
    try {
      proc = ptyLib.spawn(shell.file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: true,
      });
    } catch (err) {
      try {
        proc = ptyLib.spawn(shell.file, args, { name: 'xterm-256color', cols, rows, cwd, env });
      } catch (err2) {
        return { ok: false, error: t('main.spawnFailed', { shell: shell.file, reason: err2.message }) };
      }
    }

    const sid = ++sessionSeq;
    sessions.set(id, { pty: proc, sid });

    proc.onData((data) => {
      const cur = sessions.get(id);
      if (cur && cur.sid !== sid) return; // 已被新会话顶替，旧输出丢掉
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { id, data, sid });
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      const cur = sessions.get(id);
      if (cur && cur.sid === sid) sessions.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', { id, exitCode, signal, sid });
      }
    });

    return { ok: true, pid: proc.pid, sid, shell: shell.file, cwd, cwdFallback, requestedPath: opts.cwd || settings.startDir || null };
  });

  ipcMain.on('pty:input', (_e, { id, data }) => {
    const s = sessions.get(id);
    if (s) { try { s.pty.write(data); } catch { /* ignore */ } }
  });

  ipcMain.on('pty:resize', (_e, { id, cols, rows }) => {
    const s = sessions.get(id);
    if (!s) return;
    try { s.pty.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* ignore */ }
  });

  ipcMain.on('pty:kill', (_e, { id }) => {
    const s = sessions.get(id);
    if (!s) return;
    try { s.pty.kill(); } catch { /* ignore */ }
    sessions.delete(id);
  });
}

// ---------------------------------------------------------------- app wiring
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    syncLocale();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    for (const [, s] of sessions) { try { s.pty.kill(); } catch { /* ignore */ } }
    sessions.clear();
    app.quit();
  });

  app.on('before-quit', () => {
    for (const [, s] of sessions) { try { s.pty.kill(); } catch { /* ignore */ } }
    sessions.clear();
  });
}
