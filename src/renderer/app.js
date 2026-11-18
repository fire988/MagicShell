'use strict';

/* ============================================================================
   MagicShell 渲染进程
   - 分组：每个分组是一块舞台，组内终端并排平铺，点分组即整组显示
   - 图钉：点任意终端标题栏的图钉 = 把当前分组（整个窗口）置顶
   - 复制全部：Ctrl+Shift+A 或标题栏按钮，一次取回整段回滚缓冲
   ========================================================================== */

const api = window.ms;
const TerminalCtor = window.Terminal;
const FitCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;

/* ------------------------------------------------------------------ 常量 */
const PRESETS = [
  { nameKey: 'palette.deepSpace', bg: '#0b0f14', fg: '#d7dde5' },
  { nameKey: 'palette.pureBlack', bg: '#000000', fg: '#e8e8e8' },
  { nameKey: 'palette.midnight', bg: '#0b1a2b', fg: '#cdd9e5' },
  { nameKey: 'palette.inkGreen', bg: '#071a12', fg: '#cfe6d8' },
  { nameKey: 'palette.charcoal', bg: '#1b1d21', fg: '#dcdfe4' },
  { nameKey: 'palette.violetNight', bg: '#14101f', fg: '#ded7f0' },
  { nameKey: 'palette.warmWhite', bg: '#f7f4ec', fg: '#2b2a26' },
  { nameKey: 'palette.paper', bg: '#ffffff', fg: '#1f2328' },
  { nameKey: 'palette.sky', bg: '#eaf2f8', fg: '#1d2b36' },
];

const DEFAULT_SETTINGS = {
  bg: '#0b0f14',
  fg: '#d7dde5',
  paneBg: null,     // 所有终端的默认背景（null = 跟随窗口背景）
  paneFg: null,     // 所有终端的默认文字色（null = 自动对比）
  accent: '#3b82f6',
  fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
  fontSize: 14,
  cursorBlink: true,
  shell: 'auto',
  startDir: null,        // 全局默认启动目录（null = 用户主目录）
  recentDirs: [],        // 最近用过的启动目录
  sidebarWidth: 250,     // 左侧分组栏宽度（px）
  sidebarCollapsed: false,
  restoreSessions: true,
  notifyOnDone: true,    // 长命令跑完（窗口不在前台）弹通知 + 闪任务栏
  activeGroupId: null,
  language: 'auto',      // auto = 跟随系统；zh-CN / en-US 手动指定
};

// 终端 ANSI 调色板：深色底用亮色系，浅色底换成深色系，避免白底白字
const ANSI_DARK = {
  black: '#1f2430', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
  brightBlack: '#5c6370', brightRed: '#ef7a86', brightGreen: '#b3d89c',
  brightYellow: '#f0d197', brightBlue: '#82c4f5', brightMagenta: '#d99ae3',
  brightCyan: '#7ed0da', brightWhite: '#ffffff',
};
const ANSI_LIGHT = {
  black: '#24292f', red: '#b31d28', green: '#1a7f37', yellow: '#8a6100',
  blue: '#0550ae', magenta: '#8250df', cyan: '#0f6d78', white: '#6e7781',
  brightBlack: '#4b535c', brightRed: '#8d1a24', brightGreen: '#116329',
  brightYellow: '#6f4d00', brightBlue: '#003f8a', brightMagenta: '#6639ba',
  brightCyan: '#0b5760', brightWhite: '#3d444d',
};
const ansiPaletteFor = (bg) => (relLum(bg) > 0.42 ? ANSI_LIGHT : ANSI_DARK);

/* ------------------------------------------------------------------- 状态 */
const state = {
  settings: { ...DEFAULT_SETTINGS },
  groups: [],       // { id, name, pinned, panes: [{ id, name, bg, running, exited }] }
  activeId: null,
  systemLocale: '',  // app.getLocale()，settings.language === 'auto' 时用它
};

const paneMap = new Map();  // paneId -> pane 运行时对象
const groupEls = new Map(); // groupId -> { stage, item }

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const GENERIC_TITLES = new Set(['pwsh', 'powershell', 'cmd', 'conhost', 'openconsole', 'windows terminal', 'windowsterminal']);

/* -------------------------------------------------------------- 国际化 */
const I18n = window.I18n;
const t = (key, vars) => (I18n ? I18n.t(key, vars) : key);
let currentLocale = 'zh-CN';

// 静态文案写在 index.html 的 data-i18n* 属性上，这里一次性刷
function applyI18nDom(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of scope.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of scope.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of scope.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
}

// setting: 'auto' | 'zh-CN' | 'en-US'
function applyLanguage(setting, systemLocale) {
  currentLocale = I18n
    ? I18n.setLocale(I18n.resolveLocale(setting, systemLocale))
    : 'zh-CN';
  document.documentElement.lang = currentLocale;
  applyI18nDom();
  return currentLocale;
}

// 换语言之后：静态文案之外，所有 JS 拼出来的界面也要重建（菜单是打开时现拼，不用管）
function rerenderForLanguage() {
  applyI18nDom();
  renameAutoGroups();
  renderSidebar();
  const group = activeGroup();
  if (group) {
    $('#group-name').textContent = group.name;
    $('#group-meta').textContent = t('group.paneCount', { n: group.panes.length });
    document.title = `${group.name} — MagicShell`;
  }
  syncPinUI();
  applySidebar();
  markPresets();
  syncSettingsInputs();
  if (group) updateGroupMeta(group);
  if (!$('#cwd').hidden) syncCwdDialog();
  if (!$('#look').hidden) { syncLookInputs(); markLookPresets(); renderLookPreview(); }
  for (const pane of paneMap.values()) syncPaneChrome(pane);
  updateEmptyState();
}

/* ------------------------------------------------------------- 颜色工具 */
function normHex(hex) {
  let h = String(hex || '').trim();
  if (!h.startsWith('#')) h = '#' + h;
  if (/^#[0-9a-f]{3}$/i.test(h)) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : null;
}
function hexToRgb(hex) {
  const n = parseInt(normHex(hex).slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}
function lum(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
function withAlpha(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
// WCAG 相对亮度：判断"这个底色上该用深字还是浅字"更准
function relLum(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const x = relLum(a) || 0;
  const y = relLum(b) || 0;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ------------------------------------------------------------- 路径工具 */
// OSC 7 的标准形式是 file://主机/路径。Windows 上会收到
// file://HOST/C:/Work/Dev、file:///C:/Work/Dev、file://C:\Work\Dev 几种写法。
function osc7ToPath(data) {
  let s = String(data || '').trim();
  if (!/^file:\/\//i.test(s)) return null;
  s = s.slice('file://'.length);
  try { s = decodeURI(s); } catch { /* 保留原样 */ }
  let p;
  if (/^[a-z]:[\\/]/i.test(s)) {
    p = s;                                   // file://C:/Work/Dev
  } else {
    const i = s.indexOf('/');
    p = i >= 0 ? s.slice(i) : s;             // 去掉主机名
    p = p.replace(/^\/+/, '');
    if (!/^[a-z]:/i.test(p)) p = '/' + p;    // file:///C:/ → C:/；其它按根路径处理
  }
  p = p.replace(/\//g, '\\').replace(/\\+$/, '');
  if (/^\\?[a-z]:/i.test(p)) p = p.replace(/^\\/, '');
  return p || null;
}

// 太长的路径中间省略，菜单/标题里不至于撑爆
function shortenPath(p, max = 42) {
  const s = String(p || '');
  if (s.length <= max) return s;
  const parts = s.split('\\');
  if (parts.length < 3) return `…${s.slice(-max + 1)}`;
  return `${parts[0]}\\…\\${parts.slice(-2).join('\\')}`;
}

// 终端当前的目录：追踪到的实时目录 > 用户指定的启动目录 > 全局默认
function paneCwd(pane) {
  if (!pane) return state.settings.startDir || '';
  return pane.meta.liveCwd || pane.meta.cwd || state.settings.startDir || '';
}

// 上级目录（只用于显示提示；真正跳转交给 shell 的 cd ..）
function parentDirPath(p) {
  const s = normDirPath(p);
  if (!s) return null;
  const parts = s.split('\\');
  if (parts.length <= 1) return null;
  parts.pop();
  let up = parts.join('\\');
  if (/^[a-z]:$/i.test(up)) up += '\\';
  return up || null;
}

/* ------------------------------------------------- 目录历史（cd 逐级回退） */
// 每个终端自己维护一份访问过的目录栈，指针指向"当前所在"那一条。
// 用 OSC 7 报告的真实目录来记，所以用户在 shell 里敲 cd、按 Tab 补全、
// 甚至跑脚本换了目录，都能进历史。
const DIR_HIST_MAX = 80;
const CTRL_C = String.fromCharCode(3);

const dirKey = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();

function dirHist(pane) {
  if (!pane) return null;
  if (!pane.hist) pane.hist = { list: [], idx: -1, expect: null, from: -1, timer: 0 };
  return pane.hist;
}

function resetDirHistory(pane) {
  if (!pane) return;
  if (pane.hist) clearTimeout(pane.hist.timer);
  pane.hist = { list: [], idx: -1, expect: null, from: -1, timer: 0 };
}

// shell 报告了新目录 → 记一笔
function noteDirVisit(pane, dirRaw) {
  const dir = normDirPath(dirRaw);
  const h = dirHist(pane);
  if (!h || !dir) return;

  if (h.expect) {
    // 正在等我们发出去的那次 cd 生效：这期间 shell 可能先把旧目录的
    // prompt 重新画一遍（Ctrl+C 会触发），一律忽略，别当成用户换了目录
    if (dirKey(dir) === dirKey(h.expect)) {
      clearTimeout(h.timer);
      h.expect = null;
      h.from = -1;
      h.timer = 0;
    }
    return;
  }

  if (h.idx >= 0 && dirKey(h.list[h.idx]) === dirKey(dir)) return;

  // 在历史中间改了目录 → 后面的"前进"记录作废
  h.list = h.list.slice(0, h.idx + 1);
  h.list.push(dir);
  if (h.list.length > DIR_HIST_MAX) h.list.shift();
  h.idx = h.list.length - 1;
}

// 往终端里送一条 cd：先 Ctrl+C 清掉可能已经敲了一半的命令行
function sendCd(pane, dir) {
  if (!pane || !pane.running) return false;
  const isCmd = /(^|\\)cmd(\.exe)?$/i.test(pane.shellPath || '');
  const line = isCmd ? `cd /d "${dir}"` : `cd "${dir}"`;
  try { pane.term.focus(); } catch { /* ignore */ }
  try { api.writePty(pane.id, CTRL_C); } catch { /* ignore */ }
  setTimeout(() => {
    try { api.writePty(pane.id, line + '\r'); } catch { /* ignore */ }
  }, 70);
  return true;
}

function goToHistIndex(pane, next) {
  const h = dirHist(pane);
  if (!h || !h.list.length || h.idx < 0) {
    toast(t('hist.empty'), 1800);
    return false;
  }
  if (next < 0) { toast(t('hist.oldest'), 1500); return false; }
  if (next >= h.list.length) { toast(t('hist.newest'), 1500); return false; }
  if (next === h.idx) return false;

  const target = h.list[next];
  const from = h.idx;
  h.idx = next;
  h.expect = target;
  h.from = from;
  clearTimeout(h.timer);
  h.timer = setTimeout(() => {
    if (!h.expect) return;
    // shell 没报告回来：多半是目录已经不存在，指针退回去
    h.expect = null;
    h.timer = 0;
    const live = normDirPath(pane.meta.liveCwd);
    const found = live ? h.list.findIndex((d) => dirKey(d) === dirKey(live)) : -1;
    h.idx = found >= 0 ? found : (h.from >= 0 && h.from < h.list.length ? h.from : h.list.length - 1);
    h.from = -1;
    toast(t('hist.failed'), 2600);
  }, 1600);

  sendCd(pane, target);
  toast(next < from
    ? t('hist.back', { path: shortenPath(target, 32) })
    : t('hist.forward', { path: shortenPath(target, 32) }), 1700);
  return true;
}

function jumpDir(pane, delta) {
  if (!pane) return false;
  if (!pane.running) { toast(t('hist.notRunning'), 1500); return false; }
  const h = dirHist(pane);
  if (!h || !h.list.length) {
    toast(t('hist.untracked'), 2400);
    return false;
  }
  return goToHistIndex(pane, h.idx + delta);
}

// 回到上一级目录：交给 shell 自己算，盘符根目录、UNC 路径都不会算错
function goParentDir(pane) {
  if (!pane) return false;
  if (!pane.running) { toast(t('hist.notRunning'), 1500); return false; }
  const cur = pane.meta.liveCwd || pane.meta.cwd || '';
  const up = cur ? parentDirPath(cur) : null;
  if (cur && !up) { toast(t('hist.atRoot'), 1500); return false; }
  try { pane.term.focus(); } catch { /* ignore */ }
  try { api.writePty(pane.id, CTRL_C); } catch { /* ignore */ }
  setTimeout(() => {
    try { api.writePty(pane.id, 'cd ..\r'); } catch { /* ignore */ }
  }, 70);
  toast(up ? t('hist.parent', { path: shortenPath(up, 32) }) : t('hist.parentOnly'), 1600);
  return true;
}

// 跟着焦点走的终端：优先"被聚焦的那个"，否则当前分组的第一个
function targetPane() {
  const focused = [...paneMap.values()].find((p) => p.el.classList.contains('focused'));
  if (focused) return focused;
  const g = activeGroup();
  return g && g.panes[0] ? paneMap.get(g.panes[0].id) || null : null;
}

/* ------------------------------------------------------------------ 主题 */
function applyTheme() {
  const s = state.settings;
  const light = lum(s.bg) > 0.55;
  const root = document.documentElement.style;

  const uiBg = light ? mix(s.bg, '#000000', 0.04) : mix(s.bg, '#000000', 0.18);
  const uiPanel = light ? mix(s.bg, '#000000', 0.07) : mix(s.bg, '#ffffff', 0.045);
  const uiElev = light ? mix(s.bg, '#000000', 0.12) : mix(s.bg, '#ffffff', 0.085);
  const dim = light ? mix(s.fg, s.bg, 0.42) : mix(s.fg, s.bg, 0.42);

  root.setProperty('--term-bg', s.bg);
  root.setProperty('--term-fg', s.fg);
  root.setProperty('--accent', s.accent);
  root.setProperty('--accent-soft', withAlpha(s.accent, light ? 0.14 : 0.18));
  root.setProperty('--ui-bg', uiBg);
  root.setProperty('--ui-panel', uiPanel);
  root.setProperty('--ui-elev', uiElev);
  root.setProperty('--ui-border', light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.085)');
  root.setProperty('--ui-hover', light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.07)');
  root.setProperty('--ui-text', s.fg);
  root.setProperty('--ui-dim', dim);
  // 命令块徽标：深色底用亮一点的红绿，浅色底压深，保证两种主题都看得清
  root.setProperty('--cmd-ok', light ? '#3b6d11' : '#8fce5a');
  root.setProperty('--cmd-bad', light ? '#a32d2d' : '#ef8a92');
  root.setProperty('--cmd-ok-bg', light ? 'rgba(59,109,17,0.12)' : 'rgba(143,206,90,0.14)');
  root.setProperty('--cmd-bad-bg', light ? 'rgba(163,45,45,0.12)' : 'rgba(239,138,146,0.15)');
  root.setProperty('--shadow', light ? '0 18px 44px rgba(15,23,42,0.16)' : '0 18px 44px rgba(0,0,0,0.45)');
  // 舞台底色与终端底色要区分开，自由摆放/重叠时窗口边界才看得出来
  root.setProperty('--stage-bg', light ? mix(s.bg, '#000000', 0.07) : mix(s.bg, '#ffffff', 0.07));
  root.setProperty('--pane-shadow', light ? '0 2px 7px rgba(15,23,42,0.10)' : '0 2px 9px rgba(0,0,0,0.34)');

  document.body.style.background = s.bg;
  $('#bg-swatch').style.background = s.bg;

  for (const pane of paneMap.values()) syncPaneTheme(pane);
  api.syncSystemTheme(s.bg);
}

function paneBg(pane) {
  return normHex(pane.meta && pane.meta.bg) || normHex(state.settings.paneBg) || normHex(state.settings.bg);
}
function paneFg(pane) {
  const bg = paneBg(pane);
  const pref = normHex(pane.meta && pane.meta.fg) || normHex(state.settings.paneFg) || normHex(state.settings.fg);
  // 自定义底色后原文字色可能看不清，这里按对比度自动纠正
  if (pref && contrast(bg, pref) >= 3.2) return pref;
  return relLum(bg) > 0.42 ? '#1f2328' : '#e6edf3';
}

function syncPaneTheme(pane) {
  const s = state.settings;
  const bg = paneBg(pane);
  const fg = paneFg(pane);
  const own = normHex(bg) !== normHex(s.bg) || normHex(fg) !== normHex(s.fg) ||
    !!(pane.meta && (pane.meta.bg || pane.meta.fg));

  pane.el.style.background = bg;

  // 自己的底色会让标题栏/按钮沿用全局配色而糊掉，这里在终端范围内重算 UI 变量
  const st = pane.el.style;
  const keys = ['--term-bg', '--term-fg', '--ui-text', '--ui-dim', '--ui-elev',
    '--ui-panel', '--ui-bg', '--ui-border', '--ui-hover'];
  if (own) {
    const light = relLum(bg) > 0.42;
    st.setProperty('--term-bg', bg);
    st.setProperty('--term-fg', fg);
    st.setProperty('--ui-text', fg);
    st.setProperty('--ui-dim', mix(fg, bg, 0.42));
    st.setProperty('--ui-elev', light ? mix(bg, '#000000', 0.09) : mix(bg, '#ffffff', 0.075));
    st.setProperty('--ui-panel', light ? mix(bg, '#000000', 0.06) : mix(bg, '#ffffff', 0.05));
    st.setProperty('--ui-bg', light ? mix(bg, '#000000', 0.03) : mix(bg, '#000000', 0.2));
    st.setProperty('--ui-border', light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.10)');
    st.setProperty('--ui-hover', light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)');
  } else {
    for (const k of keys) st.removeProperty(k);
  }

  if (pane.term) {
    pane.term.options.theme = {
      background: bg,
      foreground: fg,
      cursor: fg,
      cursorAccent: bg,
      selectionBackground: withAlpha(fg, 0.28),
      ...ansiPaletteFor(bg),
    };
    pane.term.options.fontSize = s.fontSize;
    pane.term.options.fontFamily = s.fontFamily;
    pane.term.options.cursorBlink = !!s.cursorBlink;
  }
}

/* ------------------------------------------------------------- 分组模型 */
function activeGroup() {
  return state.groups.find((g) => g.id === state.activeId) || null;
}
function findGroup(id) {
  return state.groups.find((g) => g.id === id) || null;
}

function createGroup(opts = {}) {
  // 自动命名的分组记下「用哪个 key + 第几个」，切换语言时才能跟着改；
  // 用户自己改过名的（autoNameKey 被清掉）永远不动。
  const autoNameKey = opts.autoNameKey || (opts.name ? null : 'group.auto');
  const autoNameNum = autoNameKey === 'group.auto' ? state.groups.length + 1 : null;
  const group = {
    id: opts.id || uid(),
    name: opts.name || (autoNameKey === 'group.default' ? t('group.default') : t('group.auto', { n: autoNameNum })),
    autoNameKey,
    autoNameNum,
    pinned: !!opts.pinned,
    panes: [],
    layout: { key: (opts.layout && opts.layout.key) || 'auto', custom: !!(opts.layout && opts.layout.custom) },
  };
  state.groups.push(group);

  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.dataset.groupId = group.id;
  $('#stages').appendChild(stage);

  groupEls.set(group.id, { stage });
  renderSidebar();

  const paneSeeds = opts.panes && opts.panes.length ? opts.panes : [{}];
  const lazy = !!opts.lazy;
  activateGroup(group.id);
  paneSeeds.forEach((seed) => addPane(group, { ...seed, lazy, focus: false }));

  const first = group.panes[0];
  if (first) focusPane(first.id);
  persist();
  return group;
}

// 语言切换时，把自动命名的分组名跟着改（用户改过名的不动）
function renameAutoGroups() {
  let changed = false;
  for (const g of state.groups) {
    if (!g.autoNameKey) continue;
    const next = g.autoNameKey === 'group.auto'
      ? t('group.auto', { n: g.autoNameNum || 1 })
      : t(g.autoNameKey);
    if (next && next !== g.name) { g.name = next; changed = true; }
  }
  if (changed) persist();
}

function activateGroup(id) {
  const group = findGroup(id);
  if (!group) return;
  state.activeId = id;
  for (const [gid, els] of groupEls) {
    els.stage.classList.toggle('active', gid === id);
  }
  renderSidebar();
  $('#group-name').textContent = group.name;
  $('#group-meta').textContent = t('group.paneCount', { n: group.panes.length });
  document.title = `${group.name} — MagicShell`;
  syncPinUI();

  // 进入分组时：把本组还没启动的终端拉起来（懒加载，避免一次开一堆 PowerShell）
  // 但用户主动停掉的终端不在此列 —— 否则切一次组就自动复活，等于白停
  for (const meta of group.panes) {
    const pane = paneMap.get(meta.id);
    if (pane && !pane.running && !pane.exited && !meta.suspended) ensureSpawn(pane);
  }
  syncGroupRects(group);
  requestAnimationFrame(() => refitGroup(group));
  api.setAlwaysOnTop(!!group.pinned);
  persist();
}

/* -------------------------------------------------- 布局：矩形百分比模型 */
// 每个终端在分组舞台上占一块矩形，x/y/w/h 都是 0~1 的比例，
// 窗口缩放时自动等比跟随；拖动/缩放/自动排列改的都只是这组数字。
const MIN_PANE_W = 150;   // px，缩放时的最小宽高，防止把终端挤没
const MIN_PANE_H = 80;

const LAYOUTS = [
  { key: 'auto', nameKey: 'layout.auto' },
  { key: 'cols', nameKey: 'layout.cols' },
  { key: 'rows', nameKey: 'layout.rows' },
  { key: 'grid2', nameKey: 'layout.grid2' },
  { key: 'grid3', nameKey: 'layout.grid3' },
  { key: 'main-left', nameKey: 'layout.mainLeft' },
  { key: 'main-top', nameKey: 'layout.mainTop' },
];
const layoutName = (key) => t((LAYOUTS.find((l) => l.key === key) || LAYOUTS[0]).nameKey);

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roundRect = (r) => ({
  x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4),
});
const validRect = (r) => !!r && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && isFinite(r[k]))
  && r.w > 0.02 && r.h > 0.02;

// 网格布局：最后一行不足时自动拉宽填满，不留空格子
function gridRects(n, cols) {
  const rows = Math.ceil(n / cols);
  const out = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    const count = Math.min(cols, n - i);
    const w = 1 / count;
    const h = 1 / rows;
    for (let c = 0; c < count; c++) out.push({ x: c * w, y: r * h, w, h });
    i += count;
  }
  return out;
}

function computeLayout(key, n) {
  n = Math.max(1, n);
  const full = [{ x: 0, y: 0, w: 1, h: 1 }];
  switch (key) {
    case 'cols':
      return Array.from({ length: n }, (_, i) => ({ x: i / n, y: 0, w: 1 / n, h: 1 }));
    case 'rows':
      return Array.from({ length: n }, (_, i) => ({ x: 0, y: i / n, w: 1, h: 1 / n }));
    case 'grid2':
      return gridRects(n, 2);
    case 'grid3':
      return gridRects(n, 3);
    case 'main-left': {
      if (n === 1) return full;
      const lw = 0.62;
      const rest = n - 1;
      const h = 1 / rest;
      return [{ x: 0, y: 0, w: lw, h: 1 },
        ...Array.from({ length: rest }, (_, i) => ({ x: lw, y: i * h, w: 1 - lw, h }))];
    }
    case 'main-top': {
      if (n === 1) return full;
      const th = 0.62;
      const rest = n - 1;
      const w = 1 / rest;
      return [{ x: 0, y: 0, w: 1, h: th },
        ...Array.from({ length: rest }, (_, i) => ({ x: i * w, y: th, w, h: 1 - th }))];
    }
    default: {
      if (n === 1) return full;
      if (n === 2) return computeLayout('cols', 2);
      if (n === 3) return computeLayout('main-left', 3);
      return gridRects(n, Math.ceil(Math.sqrt(n)));
    }
  }
}

function setPaneRect(pane, rect, opts = {}) {
  if (!pane || !pane.slot) return;
  const r = roundRect(rect);
  pane.meta.rect = r;
  const s = pane.slot.style;
  s.left = `${(r.x * 100).toFixed(3)}%`;
  s.top = `${(r.y * 100).toFixed(3)}%`;
  s.width = `${(r.w * 100).toFixed(3)}%`;
  s.height = `${(r.h * 100).toFixed(3)}%`;
  if (opts.fit !== false) scheduleFit(pane);
}

// 按指定预设重排组内所有终端（同时标记为"非自定义"，后续增减终端会跟着重排）
function applyLayoutRects(group, key) {
  const rects = computeLayout(key, group.panes.length);
  group.layout = { key, custom: false };
  group.panes.forEach((meta, i) => {
    const pane = paneMap.get(meta.id);
    const r = rects[i] || { x: 0, y: 0, w: 1, h: 1 };
    meta.rect = roundRect(r);
    if (pane) setPaneRect(pane, meta.rect);
  });
}

// 只把已有比例写回 DOM；个别终端缺位置时尽量只补它，别推翻整组已记住的布局
function syncGroupRects(group) {
  const missing = group.panes.filter((m) => !validRect(m.rect));
  if (missing.length) {
    const anyValid = group.panes.some((m) => validRect(m.rect));
    const stage = (groupEls.get(group.id) || {}).stage;
    const box = stage ? stage.getBoundingClientRect() : null;
    const measurable = box && box.width > 40 && box.height > 40;
    if (!(anyValid && group.layout.custom && measurable)) {
      applyLayoutRects(group, (group.layout && group.layout.key) || 'auto');
      return;
    }
    // 自定义布局下补位：把面积最大的那块窗对半分给它
    for (const meta of missing) {
      meta.rect = roundRect(carveRectForNew(group));
      const pane = paneMap.get(meta.id);
      if (pane) setPaneRect(pane, meta.rect, { fit: false });
    }
  }
  for (const meta of group.panes) {
    const pane = paneMap.get(meta.id);
    if (pane) setPaneRect(pane, meta.rect, { fit: false });
  }
}

// 自定义布局下新增终端：把面积最大的那块对半分，给它腾位置
function carveRectForNew(group) {
  const box = groupEls.get(group.id).stage.getBoundingClientRect();
  const bw = box.width || 1;
  const bh = box.height || 1;
  let target = null;
  for (const m of group.panes) {
    if (!validRect(m.rect)) continue;
    if (!target || m.rect.w * m.rect.h > target.rect.w * target.rect.h) target = m;
  }
  if (!target) return { x: 0, y: 0, w: 1, h: 1 };

  const r = target.rect;
  const horizontal = r.w * bw >= r.h * bh;
  const half = horizontal
    ? { x: r.x, y: r.y, w: r.w / 2, h: r.h }
    : { x: r.x, y: r.y, w: r.w, h: r.h / 2 };
  const rest = horizontal
    ? { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h }
    : { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 };

  target.rect = roundRect(half);
  const host = paneMap.get(target.id);
  if (host) setPaneRect(host, target.rect);
  return roundRect(rest);
}

/* ------------------------------------------------- 拖动移动 / 拖边缩放 */
function snapTo(v, list, tol) {
  let best = v;
  let bestD = tol;
  for (const c of list) {
    const d = Math.abs(c - v);
    if (d <= bestD) { bestD = d; best = c; }
  }
  return best;
}

function startPaneDrag(pane, e, kind, dir) {
  if (!paneMap.has(pane.id)) return;
  const group = pane.group;
  if (state.activeId !== group.id) activateGroup(group.id);

  const stage = groupEls.get(group.id).stage;
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) return;

  const start = { ...(pane.meta.rect || { x: 0, y: 0, w: 1, h: 1 }) };
  const sx = e.clientX;
  const sy = e.clientY;
  const tolX = 8 / box.width;
  const tolY = 8 / box.height;
  const minW = Math.min(0.9, MIN_PANE_W / box.width);
  const minH = Math.min(0.9, MIN_PANE_H / box.height);
  const others = group.panes
    .filter((m) => m.id !== pane.id && validRect(m.rect))
    .map((m) => m.rect);

  let active = false;
  let rafId = 0;
  let pending = null;
  const busyCursor = kind === 'move'
    ? 'grabbing'
    : ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
         nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }[dir] || 'nwse-resize');

  const flush = () => {
    rafId = 0;
    if (!pending) return;
    setPaneRect(pane, pending);
    pending = null;
  };

  const onMove = (ev) => {
    const dx = (ev.clientX - sx) / box.width;
    const dy = (ev.clientY - sy) / box.height;
    if (!active) {
      if (Math.abs(ev.clientX - sx) < 3 && Math.abs(ev.clientY - sy) < 3) return;
      active = true;
      stage.classList.add('dragging');
      pane.el.classList.add('dragging');
      if (pane.slot) pane.slot.classList.add('dragging');
      document.body.style.cursor = busyCursor;
    }

    let r;
    if (kind === 'move') {
      const xs = [0, 1 - start.w];
      const ys = [0, 1 - start.h];
      for (const o of others) {
        xs.push(o.x, o.x + o.w, o.x - start.w, o.x + o.w - start.w);
        ys.push(o.y, o.y + o.h, o.y - start.h, o.y + o.h - start.h);
      }
      r = {
        x: clamp(snapTo(start.x + dx, xs, tolX), 0, 1 - start.w),
        y: clamp(snapTo(start.y + dy, ys, tolY), 0, 1 - start.h),
        w: start.w,
        h: start.h,
      };
    } else {
      const d = dir || 'se';
      let x1 = start.x;
      let y1 = start.y;
      let x2 = start.x + start.w;
      let y2 = start.y + start.h;
      const xs = [0, 1];
      const ys = [0, 1];
      for (const o of others) { xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h); }

      if (d.includes('w')) x1 = clamp(snapTo(start.x + dx, xs, tolX), 0, x2 - minW);
      if (d.includes('e')) x2 = clamp(snapTo(start.x + start.w + dx, xs, tolX), x1 + minW, 1);
      if (d.includes('n')) y1 = clamp(snapTo(start.y + dy, ys, tolY), 0, y2 - minH);
      if (d.includes('s')) y2 = clamp(snapTo(start.y + start.h + dy, ys, tolY), y1 + minH, 1);
      r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    group.layout.custom = true;
    pending = roundRect(r);
    if (!rafId) rafId = requestAnimationFrame(flush);
  };

  const finish = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (pending) { setPaneRect(pane, pending); pending = null; }
    stage.classList.remove('dragging');
    pane.el.classList.remove('dragging');
    if (pane.slot) pane.slot.classList.remove('dragging');
    document.body.style.cursor = '';
    if (active) {
      persist(true);   // 松手即落盘，别等防抖计时器
      fitPane(pane);
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

function refitGroup(group) {
  for (const meta of group.panes) {
    const pane = paneMap.get(meta.id);
    if (pane) fitPane(pane);
  }
}

function removePane(paneId, opts = {}) {
  const group = state.groups.find((g) => g.panes.some((p) => p.id === paneId));
  if (!group) return;
  const idx = group.panes.findIndex((p) => p.id === paneId);
  group.panes.splice(idx, 1);

  const pane = paneMap.get(paneId);
  if (pane) {
    try { api.killPty(paneId); } catch { /* ignore */ }
    resetCmdState(pane);
    try { pane.term.dispose(); } catch { /* ignore */ }
    if (pane.observer) pane.observer.disconnect();
    if (pane.slot) pane.slot.remove(); else pane.el.remove();
    paneMap.delete(paneId);
  }

  if (!group.panes.length) {
    closeGroup(group.id);
    return;
  }
  // 自定义布局保留原有位置（留出空白），自动布局则重新铺满
  if (!group.layout.custom) applyLayoutRects(group, group.layout.key || 'auto');
  refitGroup(group);
  if (!opts.silent) {
    const next = group.panes[Math.min(idx, group.panes.length - 1)];
    if (next) focusPane(next.id);
  }
  persist();
}

function closeGroup(groupId) {
  const group = findGroup(groupId);
  if (!group) return;
  for (const meta of [...group.panes]) removePaneQuiet(meta.id);
  group.panes.length = 0;

  const els = groupEls.get(groupId);
  if (els) { els.stage.remove(); groupEls.delete(groupId); }

  state.groups = state.groups.filter((g) => g.id !== groupId);

  if (state.activeId === groupId) {
    state.activeId = null;
    const next = state.groups[0];
    if (next) activateGroup(next.id);
    else {
      $('#group-name').textContent = t('app.ungrouped');
      $('#group-meta').textContent = '';
      document.title = 'MagicShell';
      api.setAlwaysOnTop(false);
    }
  }
  renderSidebar();
  updateEmptyState();
  persist();
}

function removePaneQuiet(paneId) {
  const pane = paneMap.get(paneId);
  if (!pane) return;
  try { api.killPty(paneId); } catch { /* ignore */ }
  resetCmdState(pane);
  try { pane.term.dispose(); } catch { /* ignore */ }
  if (pane.observer) pane.observer.disconnect();
  if (pane.slot) pane.slot.remove(); else pane.el.remove();
  paneMap.delete(paneId);
}

/* --------------------------------------------------------------- 侧边栏 */
function renderSidebar() {
  const list = $('#group-list');
  list.innerHTML = '';
  for (const group of state.groups) {
    const item = document.createElement('div');
    item.className = 'group-item' + (group.id === state.activeId ? ' active' : '') + (group.pinned ? ' pinned' : '');
    item.dataset.groupId = group.id;
    item.innerHTML = `
      <div class="group-glyph">
        <svg viewBox="0 0 16 16" width="12" height="12"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.4 6.6l2 1.9-2 1.9M8.6 10.6h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="group-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</div>
      <svg class="group-pin" viewBox="0 0 16 16" width="12" height="12"><path d="M9.6 1.6l4.8 4.8-2 .6-3 3 .4 2.4-3.6 3.6-.7-.7-3.2-3.2-.7-.7 3.6-3.6 2.4.4 3-3 .6-2z" fill="currentColor"/></svg>
      <button class="group-power" type="button"></button>
      <span class="group-badge">${group.panes.length}</span>`;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.group-name-input')) return;
      activateGroup(group.id);
      focusActivePane();   // 切组顺手把键盘焦点交给该组的终端，点完就能直接打字
    });
    const power = item.querySelector('.group-power');
    // 点电源按钮只启停，不切组；要切的话下面自己会切
    power.addEventListener('mousedown', (e) => e.stopPropagation());
    power.addEventListener('click', (e) => {
      e.stopPropagation();
      const st = groupRunState(group);
      if (st.running < st.total) {
        if (group.id !== state.activeId) activateGroup(group.id);
        startGroup(group);
      } else {
        stopGroup(group);
      }
    });
    item.addEventListener('dblclick', (e) => {
      if (e.target.closest('.group-name-input')) return;
      startRenameGroup(group, item);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openGroupMenu(group, e.clientX, e.clientY);
    });
    list.appendChild(item);
    const els = groupEls.get(group.id);
    if (els) els.item = item;
    updateGroupMeta(group);   // 徽标「运行/总数」与电源按钮的图标
  }
  updateEmptyState();
}

function startRenameGroup(group, item) {
  const nameEl = item.querySelector('.group-name');
  const input = document.createElement('input');
  input.className = 'group-name-input';
  input.value = group.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (save && next) {
      group.name = next;
      group.autoNameKey = null;   // 手动改过名：以后切语言就别再动它
      group.autoNameNum = null;
      if (group.id === state.activeId) {
        $('#group-name').textContent = next;
        document.title = `${next} — MagicShell`;
      }
      persist();
    }
    renderSidebar();
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
}

function updateEmptyState() {
  $('#empty-state').hidden = state.groups.length > 0;
}

/* ------------------------------------------------------------------ 终端 */
function addPane(group, opts = {}) {
  const seq = opts.seq || nextPaneSeq(group);
  const meta = {
    id: opts.id || uid(),
    name: null,
    seq,
    title: null,
    bg: normHex(opts.bg) || null,
    fg: normHex(opts.fg) || null,
    cwd: normDirPath(opts.cwd) || null,
    liveCwd: null,
    customTitle: !!opts.customTitle,
    running: false,
    exited: false,
    suspended: !!opts.suspended,   // 用户主动停止：不自动启动，重启应用后也保持停止
  };
  group.panes.push(meta);

  meta.name = opts.name || `${shellShortName()} ${seq}`;
  meta.title = meta.customTitle && opts.title ? opts.title : meta.name;

  const el = document.createElement('section');
  el.className = 'pane';
  el.dataset.paneId = meta.id;
  el.innerHTML = `
    <header class="pane-head">
      <span class="dot"></span>
      <span class="pane-title" title="${escapeHtml(t('pane.renameTip'))}">${escapeHtml(meta.title)}</span>
      <span class="cmd-badge" hidden></span>
      <div class="pane-tools">
        <button class="tool-btn copy" data-act="copy" title="${escapeHtml(t('pane.copyAllTitle'))}">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 2h6a2 2 0 0 1 2 2v6M4 6h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          <span class="tool-label">${escapeHtml(t('pane.copyAll'))}</span>
        </button>
        <button class="tool-btn pin" data-act="pin" title="${escapeHtml(t('pane.pinTitle'))}">
          <svg viewBox="0 0 16 16" width="13" height="13"><path d="M9.6 1.6l4.8 4.8-2 .6-3 3 .4 2.4-3.6 3.6-.7-.7-3.2-3.2-.7-.7 3.6-3.6 2.4.4 3-3 .6-2z" fill="currentColor"/></svg>
        </button>
        <button class="tool-btn" data-act="more" title="${escapeHtml(t('pane.more'))}">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>
        </button>
      </div>
    </header>
    <div class="pane-body"></div>
    <div class="pane-dead">
      <div class="pane-dead-inner">
        <span class="dead-text">${escapeHtml(t('pane.exited'))}</span>
        <div class="dead-actions">
          <button class="ghost-btn" data-act="restart">${escapeHtml(t('pane.restart'))}</button>
          <button class="ghost-btn" data-act="close">${escapeHtml(t('pane.close'))}</button>
        </div>
      </div>
    </div>
    <div class="pane-stopped">
      <span class="stopped-text" title="${escapeHtml(t('pane.stoppedHint'))}">${escapeHtml(t('pane.stopped'))}</span>
      <button class="ghost-btn" data-act="start">${escapeHtml(t('pane.startBtn'))}</button>
      <button class="ghost-btn" data-act="close">${escapeHtml(t('pane.close'))}</button>
    </div>
    <div class="pane-grip n" data-dir="n"></div>
    <div class="pane-grip s" data-dir="s"></div>
    <div class="pane-grip w" data-dir="w"></div>
    <div class="pane-grip e" data-dir="e"></div>
    <div class="pane-grip nw" data-dir="nw"></div>
    <div class="pane-grip ne" data-dir="ne"></div>
    <div class="pane-grip sw" data-dir="sw"></div>
    <div class="pane-grip se" data-dir="se"></div>`;
  // 每个终端套一层定位槽：槽决定位置/大小，终端本体向内缩出间距
  const slot = document.createElement('div');
  slot.className = 'pane-slot';
  slot.appendChild(el);
  groupEls.get(group.id).stage.appendChild(slot);

  const term = new TerminalCtor({
    fontFamily: state.settings.fontFamily,
    fontSize: state.settings.fontSize,
    cursorBlink: state.settings.cursorBlink,
    lineHeight: 1.2,
    letterSpacing: 0,
    scrollback: 10000,
    allowTransparency: false,
    // registerDecoration（跳命令时闪一下那条命令）属于 proposed API，需要显式解锁。
    // 本项目把 xterm 版本钉死在 package.json 里，不用考虑版本漂移。
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    windowsPty: { backend: 'conpty' },
  });
  const fit = new FitCtor();
  term.loadAddon(fit);
  term.open(el.querySelector('.pane-body'));

  // 有 GPU 就用 WebGL 渲染（大量输出时不卡），失败则退回 DOM 渲染
  let webgl = null;
  const WebglCtor = window.WebglAddon && (window.WebglAddon.WebglAddon || window.WebglAddon);
  if (WebglCtor) {
    try {
      webgl = new WebglCtor();
      term.loadAddon(webgl);
    } catch {
      webgl = null;
    }
  }

  const pane = {
    id: meta.id,
    meta,
    group,
    term,
    fit,
    el,
    slot,
    bodyEl: el.querySelector('.pane-body'),
    deadEl: el.querySelector('.pane-dead'),
    running: false,
    exited: false,
    error: null,
    resumeCwd: null,   // 停止时所在的目录，重新启动优先回到这里
  };
  paneMap.set(meta.id, pane);

  // PowerShell 的 prompt 钩子会发 OSC 7，这里接住它 → 实时记录该终端所在目录
  try {
    term.parser.registerOscHandler(7, (data) => {
      const dir = osc7ToPath(data);
      if (dir) {
        meta.liveCwd = dir;
        noteDirVisit(pane, dir);
        if (cwdPane === pane) syncCwdDialog();
      }
      return true;
    });
  } catch { /* 老版本 xterm 没有这个 API 就只用手动设置的目录 */ }

  // 同一个钩子还发 OSC 133 → 命令边界与退出码，用来画"命令块"
  try {
    term.parser.registerOscHandler(133, (data) => {
      const s = String(data || '');
      if (s.charAt(0) === 'D') {
        const code = Number(s.split(';')[1]);
        finishCommand(pane, Number.isFinite(code) ? code : 0);
      } else if (s.charAt(0) === 'B') {
        notePromptText(pane);
      }
      return true;
    });
  } catch { /* 没有这个 API 就退化成"只有耗时统计不到" */ }
  ensureCmdState(pane);

  // 位置：恢复的旧位置 > 自定义布局下劈开最大窗 > 自动排列
  if (validRect(opts.rect)) {
    meta.rect = roundRect(opts.rect);
    setPaneRect(pane, meta.rect, { fit: false });
  } else if (group.layout.custom && group.panes.length > 1) {
    meta.rect = roundRect(carveRectForNew(group));
    setPaneRect(pane, meta.rect, { fit: false });
  } else {
    applyLayoutRects(group, group.layout.key || 'auto');
  }

  term.onData((data) => {
    // 停止状态下直接打字 = 顺手启动，并把这一下按键送进去
    if (pane.meta.suspended) { startPane(pane, { firstData: data }); return; }
    api.writePty(pane.id, data);
    if (data.indexOf('\r') >= 0) noteCommandRun(pane);   // 回一条命令，开始计时
  });
  term.onTitleChange((t) => {
    if (meta.customTitle) return; // 用户自己起的名字不被 shell 标题覆盖
    const pretty = prettyTitle(t);
    if (!pretty || GENERIC_TITLES.has(pretty.toLowerCase())) return;
    meta.title = pretty;
    renderPaneTitle(pane);
  });

  // 点终端正文以外的地方（标题栏、工具条、退出遮罩…）：
  // 浏览器 mousedown 的默认动作会把焦点交给 body，于是窗口虽然"点亮"了却收不到键盘输入。
  // 这里拦掉默认动作，再把焦点明确交给这个终端。
  el.addEventListener('mousedown', (e) => {
    if (state.activeId !== group.id) activateGroup(group.id);
    if (e.target.closest('.xterm') || e.target.closest('.pane-title-input')) {
      setFocusedPane(pane.id);   // 终端自己会聚焦；重命名输入框的焦点别抢
      return;
    }
    e.preventDefault();
    focusPane(pane.id);
  });
  const head = el.querySelector('.pane-head');
  // 拖标题栏移动、拖边框调整大小
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tool-btn') || e.target.closest('.pane-title-input')) return;
    startPaneDrag(pane, e, 'move', null);
  });
  for (const grip of el.querySelectorAll('.pane-grip')) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startPaneDrag(pane, e, 'resize', grip.dataset.dir);
      focusPane(pane.id);   // pointerdown 的 preventDefault 把 mousedown 也压掉了，这里自己补焦点
    });
  }
  // 双击标题栏 = 给这个终端起名字
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('.tool-btn') || e.target.closest('.pane-title-input')) return;
    startRenamePane(pane);
  });

  el.querySelector('[data-act="copy"]').addEventListener('click', (e) => {
    e.stopPropagation();
    copyAll(pane);
  });
  el.querySelector('[data-act="pin"]').addEventListener('click', (e) => {
    e.stopPropagation();
    setGroupPinned(group.id, !group.pinned);
  });
  el.querySelector('[data-act="more"]').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    openPaneMenu(pane, r.left - 150, r.bottom + 4);
  });
  el.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.xterm')) return; // 交给终端自己的右键行为
    e.preventDefault();
    openPaneMenu(pane, e.clientX, e.clientY);
  });
  el.querySelector('[data-act="restart"]').addEventListener('click', () => restartPane(pane));
  const deadClose = el.querySelector('.pane-dead [data-act="close"]');
  if (deadClose) deadClose.addEventListener('click', () => removePane(pane.id));
  el.querySelector('.pane-stopped [data-act="start"]').addEventListener('click', () => startPane(pane));
  el.querySelector('.pane-stopped [data-act="close"]').addEventListener('click', () => removePane(pane.id));

  const ro = new ResizeObserver(() => scheduleFit(pane));
  ro.observe(pane.bodyEl);
  pane.observer = ro;

  syncPaneTheme(pane);
  renderPaneTitle(pane);
  if (group.id === state.activeId) setFocusedPane(pane.id, true);

  requestAnimationFrame(() => refitGroup(group));

  if (meta.suspended) markPaneStopped(pane, null);   // 恢复出来就是停止态：只画横幅，不拉 shell

  if (!opts.lazy) {
    // 直接把 shell 拉起来，不要塞进 requestAnimationFrame：
    // 窗口被遮挡/最小化时 rAF 会被节流，新终端会迟迟不启动（尺寸随后由 fit 补上）
    requestAnimationFrame(() => fitPane(pane));
    ensureSpawn(pane);
  }
  updateGroupMeta(group);
  return pane;
}

function shellShortName() {
  const s = state.settings.shell;
  if (s === 'cmd.exe') return 'cmd';
  if (s === 'pwsh.exe') return 'pwsh';
  if (s === 'powershell.exe') return 'PowerShell';
  return 'PowerShell';
}

function nextPaneSeq(group) {
  let max = 0;
  for (const p of group.panes) {
    const m = / (\d+)$/.exec(String(p.name || ''));
    if (m) max = Math.max(max, Number(m[1]));
    if (typeof p.seq === 'number') max = Math.max(max, p.seq);
  }
  return Math.max(max + 1, group.panes.length + 1);
}

function updateGroupMeta(group) {
  const els = groupEls.get(group.id);
  const st = groupRunState(group);
  if (els && els.item) {
    const badge = els.item.querySelector('.group-badge');
    if (badge) {
      // 全部在跑只显示总数；有停着的显示「运行/总数」
      badge.textContent = st.total && st.running !== st.total ? `${st.running}/${st.total}` : String(st.total);
      badge.classList.toggle('paused', st.total > 0 && st.running === 0);
    }
    syncGroupPower(group, els.item);
  }
  if (group.id !== state.activeId) return;
  $('#group-meta').textContent = t('group.paneCount', { n: group.panes.length });
}

// 侧栏组行右侧那个电源按钮：全在跑 = 停止整组，有停着的 = 启动整组
function syncGroupPower(group, item) {
  const btn = item && item.querySelector('.group-power');
  if (!btn) return;
  const st = groupRunState(group);
  const canStart = st.total > 0 && st.running < st.total;
  btn.dataset.state = canStart ? 'start' : 'stop';
  btn.title = canStart ? t('group.startAllTitle') : t('group.stopAllTitle');
  btn.setAttribute('aria-label', canStart ? t('group.startAll') : t('group.stopAll'));
  btn.hidden = st.total === 0;
  btn.innerHTML = canStart
    ? '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M5.2 3.1l7.2 4.9-7.2 4.9z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4" fill="currentColor"/></svg>';
}

async function ensureSpawn(pane, opts = {}) {
  if (pane.running || !paneMap.has(pane.id)) return;
  if (!opts.force && pane.meta.suspended) return;   // 用户停掉的终端不自动拉起
  pane.exited = false;
  pane.el.classList.remove('exited');

  let box = { cols: pane.term.cols, rows: pane.term.rows };
  try {
    pane.fit.fit();
    box = { cols: pane.term.cols, rows: pane.term.rows };
  } catch { /* ignore */ }

  const res = await api.createPty({
    id: pane.id,
    cols: box.cols,
    rows: box.rows,
    cwd: opts.cwd || pane.meta.cwd || state.settings.startDir || null,
  });
  if (!res.ok) {
    pane.exited = true;
    pane.error = res.error;
    showPaneDead(pane, res.error);
    return;
  }
  if (pane.meta.suspended && !opts.force) {
    // 等待创建期间用户点了停止：立刻回收，别留下野进程
    try { api.killPty(pane.id); } catch { /* ignore */ }
    return;
  }
  pane.running = true;
  pane.ptySid = res.sid;
  updateGroupMeta(pane.group);   // 徽标/电源按钮跟着运行数走
  pane.shellPath = res.shell;
  // 新会话 = 新的目录历史，从它的启动目录开始记
  resetDirHistory(pane);
  if (res.cwd) {
    pane.meta.liveCwd = res.cwd;
    noteDirVisit(pane, res.cwd);
  }
  if (res.cwdFallback) {
    const bad = res.requestedPath || pane.meta.cwd || state.settings.startDir;
    toast(t('pane.startDirBad', { bad: shortenPath(bad, 36), cwd: shortenPath(res.cwd, 30) }), 3400);
  }
  const pretty = prettyTitle(res.shell);
  const meta = pane.meta;
  if (!meta.customTitle && pretty && /^PowerShell \d+$/.test(String(meta.title || ''))) {
    meta.name = `${pretty} ${meta.seq}`;
    meta.title = meta.name;
    renderPaneTitle(pane);
  }
  // 在停止的终端上顺手敲的第一个字，等进程起来再送进去
  if (opts.firstData) { try { api.writePty(pane.id, opts.firstData); } catch { /* ignore */ } }
}

/* ------------------------------------------------- 命令块（shell 集成 OSC 133） */
// PowerShell 的 prompt 钩子会发 OSC 133（Windows Terminal / VS Code 同款）：
//   D;<退出码>  上一条命令结束
//   A           提示符开始
//   B           提示符结束（用户开始输入的位置）
// 渲染层在回车时开一个 marker 并开始计时，收到 D 就收尾成一条"命令块"：
// 退出码、耗时、以及这行在回滚缓冲里的位置（marker 会跟着滚动走，跳转/复制都靠它）。
const CMD_BADGE_MIN_MS = 300;    // 成功的命令短于这个时长就不占标题栏（失败的总是显示）
const CMD_NOTIFY_MIN_MS = 3000;  // 超过这个时长的命令跑完才提醒
const CMD_KEEP = 400;            // 每个终端最多记这么多条，再老的就丢掉 marker

function fmtDur(ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 10000) return `${(v / 1000).toFixed(2)}s`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60000);
  const s = Math.round((v % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

function ensureCmdState(pane) {
  if (!pane.cmd) pane.cmd = { blocks: [], pending: null, last: null, seq: 0, promptText: '', longTimer: null, progress: false };
  return pane.cmd;
}

function bufferLineText(pane, row) {
  try {
    const line = pane.term.buffer.active.getLine(row);
    return line ? line.translateToString(true) : '';
  } catch { return ''; }
}

// 提示符画完（133;B）时记下它的文本，用来判断"这次回车是不是空命令"
function notePromptText(pane) {
  const c = ensureCmdState(pane);
  try {
    const buf = pane.term.buffer.active;
    c.promptText = bufferLineText(pane, buf.baseY + buf.cursorY);
  } catch { c.promptText = ''; }
}

function startCmdLongTimer(pane) {
  const c = ensureCmdState(pane);
  if (c.longTimer) clearTimeout(c.longTimer);
  c.longTimer = setTimeout(() => {
    c.longTimer = null;
    // 跑得久又不看着它 → 任务栏挂个不确定进度条，切回来就知道"还有活没完"
    if (c.pending && !document.hasFocus() && !c.progress) {
      c.progress = true;
      api.setProgress(2);
    }
  }, CMD_NOTIFY_MIN_MS);
}

function stopCmdLongTimer(pane) {
  const c = pane && pane.cmd;
  if (!c) return;
  if (c.longTimer) { clearTimeout(c.longTimer); c.longTimer = null; }
  if (c.progress) { c.progress = false; api.setProgress(-1); }
}

// 回车 → 一条命令开始：在当前行打个 marker（输出滚走以后还能找回来）
function noteCommandRun(pane) {
  if (!pane || !pane.term) return;
  const c = ensureCmdState(pane);
  const buf = pane.term.buffer.active;
  const text = bufferLineText(pane, buf.baseY + buf.cursorY);
  const prompt = c.promptText || '';
  const typed = prompt && text.startsWith(prompt) ? text.slice(prompt.length) : text;
  let marker = null;
  try { marker = pane.term.registerMarker(0); } catch { marker = null; }
  c.pending = {
    t0: performance.now(),
    marker,
    text: typed.trim().slice(0, 120),
    blank: prompt ? !typed.trim() : !text.trim(),
  };
  startCmdLongTimer(pane);
}

function finishCommand(pane, exit) {
  if (!pane || !pane.cmd) return;
  const c = pane.cmd;
  const p = c.pending;
  stopCmdLongTimer(pane);
  c.pending = null;
  if (!p) return;                          // 启动时的第一个提示符：没敲过命令
  if (p.blank) { if (p.marker) p.marker.dispose(); return; }
  const ms = Math.max(0, performance.now() - p.t0);
  const block = { id: ++c.seq, marker: p.marker, exit: Number.isFinite(exit) ? exit : 0, ms, text: p.text };
  c.blocks.push(block);
  c.last = block;
  while (c.blocks.length > CMD_KEEP) {
    const old = c.blocks.shift();
    if (old.marker && !old.marker.isDisposed) old.marker.dispose();
  }
  renderCmdBadge(pane);
  maybeNotifyDone(pane, block);
}

function renderCmdBadge(pane) {
  const el = pane && pane.el && pane.el.querySelector('.cmd-badge');
  if (!el) return;
  const last = pane.cmd && pane.cmd.last;
  const hide = () => { el.hidden = true; el.textContent = ''; el.className = 'cmd-badge'; el.removeAttribute('title'); };
  if (!last) return hide();
  const ok = last.exit === 0;
  if (ok && last.ms < CMD_BADGE_MIN_MS) return hide();
  el.hidden = false;
  el.className = `cmd-badge ${ok ? 'ok' : 'fail'}`;
  el.textContent = ok ? `✓ ${fmtDur(last.ms)}` : `✗ ${last.exit} · ${fmtDur(last.ms)}`;
  el.title = ok
    ? t('cmd.okTitle', { time: fmtDur(last.ms) })
    : t('cmd.failTitle', { code: last.exit, time: fmtDur(last.ms) });
}

function resetCmdState(pane) {
  const c = pane && pane.cmd;
  if (!c) return;
  stopCmdLongTimer(pane);
  for (const b of c.blocks) if (b.marker && !b.marker.isDisposed) b.marker.dispose();
  c.blocks = [];
  c.last = null;
  c.pending = null;
  c.promptText = '';
  renderCmdBadge(pane);
}

function liveCmdBlocks(pane) {
  const c = pane && pane.cmd;
  if (!c) return [];
  return c.blocks.filter((b) => b.marker && !b.marker.isDisposed);
}

// 视野的"基准行"：滚到底就看光标行，翻上去就看视野第一行
function cmdAnchorLine(term) {
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY ? buf.baseY + buf.cursorY : buf.viewportY;
}

function jumpCommand(pane, delta) {
  const term = pane && pane.term;
  if (!term) return;
  const list = liveCmdBlocks(pane);
  if (!list.length) { toast(t('cmd.noCommands'), 1600); return; }
  const anchor = cmdAnchorLine(term);
  let target = null;
  if (delta < 0) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].marker.line < anchor) { target = list[i]; break; }
    if (!target) { toast(t('cmd.jumpFirst'), 1400); return; }
  } else {
    for (const b of list) if (b.marker.line > anchor) { target = b; break; }
    if (!target) { term.scrollToBottom(); toast(t('cmd.jumpLast'), 1400); return; }
  }
  term.scrollToLine(Math.max(0, target.marker.line));
  flashCommandLine(pane, target);
}

// 跳过去的那一行闪一下（装饰层只活 1.1 秒，闪完自己销毁）
// 注意：decoration 的 backgroundColor 不吃 rgba 透明度，只能用"提前混好的实色"，
// 所以按当前主题把背景和强调色混一下，深浅两套主题都不会把文字冲掉。
function flashCommandLine(pane, block) {
  const term = pane && pane.term;
  if (!term || !block || !block.marker || block.marker.isDisposed) return;
  const s = state.settings;
  const tint = mix(s.bg, s.accent || '#3b82f6', 0.24);
  let deco = null;
  try {
    deco = term.registerDecoration({
      marker: block.marker, x: 0, width: term.cols, layer: 'top', backgroundColor: tint,
    });
  } catch { deco = null; }
  if (!deco) return;
  setTimeout(() => { try { deco.dispose(); } catch { /* 已经滚出缓冲 */ } }, 1100);
}

function copyCommandOutput(pane) {
  if (!pane || !pane.term) return;
  const list = liveCmdBlocks(pane);
  if (!list.length) { toast(t('cmd.noCommands'), 1600); return; }
  const buf = pane.term.buffer.active;
  const anchor = cmdAnchorLine(pane.term);
  // 取"视野内最后一条已经结束的命令"；一条都没在视野内就用最近的一条
  let idx = -1;
  for (let i = 0; i < list.length; i++) if (list[i].marker.line <= anchor) idx = i;
  if (idx < 0) idx = list.length - 1;
  const startLine = list[idx].marker.line + 1;
  const next = pane.cmd.blocks[pane.cmd.blocks.indexOf(list[idx]) + 1];
  const endLine = next && next.marker && !next.marker.isDisposed
    ? next.marker.line - 1
    : buf.baseY + buf.cursorY;
  const lines = [];
  for (let y = startLine; y <= endLine; y++) lines.push(bufferLineText(pane, y));
  // 尾部可能跟着"下一条命令的提示符"（最后一条命令没有下一条，只能靠这个认出来）
  const promptTail = (pane.cmd.promptText || '').trim();
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last || (promptTail && last === promptTail)) lines.pop();
    else break;
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) { toast(t('cmd.copyEmpty'), 1600); return; }
  api.writeClipboard(lines.join('\r\n'));
  toast(t('cmd.copyDone', { lines: lines.length }), 1800);
}

// 通知判定单独抽出来，方便自检直接喂假数据
function shouldNotify(ms, opts = {}) {
  const on = state.settings.notifyOnDone !== false;
  const focused = opts.focused === undefined ? document.hasFocus() : !!opts.focused;
  return on && ms >= CMD_NOTIFY_MIN_MS && !focused;
}

function maybeNotifyDone(pane, block) {
  if (!shouldNotify(block.ms)) return;
  api.notifyDone({
    title: t('notify.doneTitle'),
    body: t('notify.doneBody', {
      title: pane.meta.title || pane.meta.name || '',
      exit: block.exit,
      time: fmtDur(block.ms),
    }),
  });
}

/* ------------------------------------------------------- 终端标题（可自定义） */
function renderPaneTitle(pane) {
  const el = pane && pane.el && pane.el.querySelector('.pane-title');
  if (!el) return;
  el.textContent = pane.meta.title || pane.meta.name || '';
  const tips = [];
  if (pane.meta.cwd) tips.push(t('pane.startDir', { dir: pane.meta.cwd }));
  tips.push(t('pane.dragHint'), t('pane.dblRenameHint'));
  el.title = tips.join(' · ');
}

// 换语言时刷新终端标题栏与退出遮罩上的文案（结构不变，只换字）
function syncPaneChrome(pane) {
  const el = pane && pane.el;
  if (!el) return;
  const copy = el.querySelector('[data-act="copy"]');
  if (copy) {
    copy.title = t('pane.copyAllTitle');
    const label = copy.querySelector('.tool-label');
    if (label) label.textContent = t('pane.copyAll');
  }
  const pin = el.querySelector('[data-act="pin"]');
  if (pin) pin.title = t('pane.pinTitle');
  const more = el.querySelector('[data-act="more"]');
  if (more) more.title = t('pane.more');
  const dead = el.querySelector('.dead-text');
  if (dead && !pane.exited) dead.textContent = t('pane.exited');
  const restart = el.querySelector('[data-act="restart"]');
  if (restart) restart.textContent = t('pane.restart');
  const close = el.querySelector('[data-act="close"]');
  if (close) close.textContent = t('pane.close');
  // 已停止横幅（换语言时保留原来的停止时刻）
  const sText = el.querySelector('.pane-stopped .stopped-text');
  if (sText) {
    sText.textContent = t('pane.stoppedBanner', pane.stoppedAt ? { time: pane.stoppedAt } : undefined);
    sText.title = t('pane.stoppedHint');
  }
  const sStart = el.querySelector('.pane-stopped [data-act="start"]');
  if (sStart) sStart.textContent = t('pane.startBtn');
  const sClose = el.querySelector('.pane-stopped [data-act="close"]');
  if (sClose) sClose.textContent = t('pane.close');
  renderCmdBadge(pane);   // 徽标的 tooltip 也要跟着换语言
  renderPaneTitle(pane);
}

function setPaneTitle(pane, text, opts = {}) {
  const next = String(text || '').trim().slice(0, 80);
  if (next) {
    pane.meta.customTitle = true;
    pane.meta.title = next;
  } else {
    pane.meta.customTitle = false;
    pane.meta.title = pane.meta.name || `${shellShortName()} ${pane.meta.seq || 1}`;
  }
  renderPaneTitle(pane);
  if (!opts.silent) persist();
  return next;
}

function startRenamePane(pane) {
  if (!pane || !paneMap.has(pane.id)) return;
  if (state.activeId !== pane.group.id) activateGroup(pane.group.id);
  setFocusedPane(pane.id, true);
  const titleEl = pane.el.querySelector('.pane-title');
  if (!titleEl || pane.el.querySelector('.pane-title-input')) return;

  const input = document.createElement('input');
  input.className = 'pane-title-input';
  input.spellcheck = false;
  input.value = pane.meta.title || '';
  titleEl.style.display = 'none';
  titleEl.after(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save, refocus) => {
    if (done) return;
    done = true;
    const val = input.value;
    input.remove();
    titleEl.style.display = '';
    if (save) {
      const trimmed = val.trim();
      const current = String(pane.meta.title || '').trim();
      if (trimmed !== current) {
        setPaneTitle(pane, trimmed);
        toast(trimmed ? t('pane.renamed', { title: trimmed }) : t('pane.renameReset'));
      }
    }
    if (refocus) {
      try { pane.term.focus(); } catch { /* ignore */ }
    }
  };
  input.addEventListener('blur', () => finish(true, false));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true, true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false, true); }
  });
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

function prettyTitle(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  if (t.includes('\\') || t.includes('/')) t = t.split(/[\\/]/).filter(Boolean).pop() || t;
  t = t.replace(/\.exe$/i, '');
  return t.slice(0, 80);
}

function showPaneDead(pane, reason) {
  pane.el.classList.add('exited');
  const text = pane.deadEl.querySelector('.dead-text');
  text.textContent = reason ? t('pane.startFailed', { reason }) : t('pane.exited');
  text.title = reason || '';

  if (!pane.term.buffer.active.length) {
    pane.term.write(
      `\r\n\x1b[38;5;203m${reason || t('pane.deadLine')}\x1b[0m\r\n`
    );
  }
}

async function restartPane(pane) {
  if (!pane || !paneMap.has(pane.id)) return;
  if (pane.running) {
    // 换目录要真正重开进程：先杀掉旧的，等 ConPTY 释放后再拉新的
    try { api.killPty(pane.id); } catch { /* ignore */ }
    pane.running = false;
    pane.ptySid = null;
    await new Promise((r) => setTimeout(r, 180));
    if (!paneMap.has(pane.id)) return;
  }
  pane.error = null;
  pane.exited = false;
  pane.meta.suspended = false;          // 「重新启动」也算一次启动，别再被停止状态挡住
  pane.el.classList.remove('exited', 'stopped');
  resetCmdState(pane);          // 新 shell 的命令块从头记
  try { pane.term.reset(); } catch { /* ignore */ }
  ensureSpawn(pane);
  focusPane(pane.id);
}

/* ------------------------------------------------ 停止 / 启动（留窗口、省内存） */
// 「停止」= 杀掉 PTY 进程，窗口与布局原样保留。状态会写进配置：
// 重启应用后你停掉的那几组仍然是停的，不用每次开机再点一遍。
function clockNow() {
  try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

function markPaneStopped(pane, time) {
  if (!pane || !pane.el) return;
  if (time) pane.stoppedAt = time;
  pane.el.classList.add('stopped');
  pane.el.classList.remove('exited');
  const span = pane.el.querySelector('.pane-stopped .stopped-text');
  if (span) {
    span.textContent = t('pane.stoppedBanner', pane.stoppedAt ? { time: pane.stoppedAt } : undefined);
    span.title = t('pane.stoppedHint');
  }
}

function groupRunState(group) {
  let running = 0;
  for (const m of group.panes) {
    const p = paneMap.get(m.id);
    if (p && p.running) running++;
  }
  return { running, total: group.panes.length };
}

// 返回 true 表示这次确实杀掉了进程
function stopPane(pane, opts = {}) {
  if (!pane || !paneMap.has(pane.id)) return false;
  const wasRunning = pane.running;
  pane.meta.suspended = true;
  if (wasRunning) {
    pane.resumeCwd = pane.meta.liveCwd || null;   // 停止时在哪，重新启动就回哪
    try { api.killPty(pane.id); } catch { /* 进程可能已经没了 */ }
    pane.running = false;
    pane.ptySid = null;
  }
  resetCmdState(pane);        // 计时中的命令块作废，别记出一条假的长耗时
  pane.exited = false;
  pane.error = null;
  markPaneStopped(pane, opts.time || clockNow());
  syncPaneChrome(pane);
  updateGroupMeta(pane.group);
  renderSidebar();
  if (!opts.silent) persist();
  return wasRunning;
}

function startPane(pane, opts = {}) {
  if (!pane || !paneMap.has(pane.id)) return;
  pane.meta.suspended = false;
  if (pane.running) { pane.el.classList.remove('stopped'); updateGroupMeta(pane.group); return; }
  pane.el.classList.remove('stopped', 'exited');
  pane.exited = false;
  pane.error = null;
  resetCmdState(pane);
  try { pane.term.reset(); } catch { /* ignore */ }
  const cwd = pane.resumeCwd || null;
  pane.resumeCwd = null;
  ensureSpawn(pane, { force: true, cwd, firstData: opts.firstData });
  syncPaneChrome(pane);
  updateGroupMeta(pane.group);
  renderSidebar();
  if (!opts.silent) { focusPane(pane.id); persist(); }
}

// 整组：全停 / 全起。批量启动要错开，否则 8 个 PowerShell 同时冷启动会卡一下
function stopGroup(group, opts = {}) {
  if (!group) return 0;
  let n = 0;
  for (const m of group.panes) {
    const p = paneMap.get(m.id);
    if (p && p.running) { stopPane(p, { silent: true, time: opts.time }); n++; }
  }
  updateGroupMeta(group);
  renderSidebar();
  persist();
  toast(n ? t('group.stoppedToast', { n }) : t('group.alreadyStopped'), n ? 2200 : 1500);
  return n;
}

function startGroup(group, opts = {}) {
  if (!group) return 0;
  const need = [];
  for (const m of group.panes) {
    const p = paneMap.get(m.id);
    if (p && !p.running) need.push(p);
  }
  need.forEach((p, i) => {
    if (i === 0) { startPane(p, { silent: true }); return; }
    setTimeout(() => { if (paneMap.has(p.id)) startPane(p, { silent: true }); }, i * 120);
  });
  updateGroupMeta(group);
  renderSidebar();
  persist();
  if (need.length) toast(t('group.startedToast', { n: need.length }), 1700);
  if (group.id === state.activeId && !opts.noFocus) setTimeout(() => focusActivePane(), 280);
  return need.length;
}

function setFocusedPane(paneId, silent) {
  for (const [id, p] of paneMap) {
    const on = id === paneId;
    p.el.classList.toggle('focused', on);
    // 槽位同步：激活的窗口要浮到同组最前，否则被别的窗口压着时点不到
    if (p.slot) p.slot.classList.toggle('focused', on);
    if (on && !silent) {
      try { p.term.focus(); } catch { /* ignore */ }
    }
  }
}
function focusPane(paneId) {
  const pane = paneMap.get(paneId);
  if (!pane) return;
  if (state.activeId !== pane.group.id) activateGroup(pane.group.id);
  setFocusedPane(paneId);
}

function focusActivePane() {
  const group = activeGroup();
  if (!group || !group.panes.length) return;
  const focused = [...paneMap.values()].find((p) => p.el.classList.contains('focused') && p.group.id === group.id);
  const target = focused || paneMap.get(group.panes[0].id);
  if (target) focusPane(target.id);   // 走 focusPane，视觉高亮和真实焦点一起同步
}

// 菜单、工具条这类"按钮"点完之后，焦点常常留在 body 或已经隐藏的按钮上，
// 于是终端看得见却打不进字。下一拍把焦点还给终端；若动作本身弹了输入框/对话框就别抢。
function restorePaneFocus(pane) {
  setTimeout(() => {
    const p = pane && paneMap.has(pane.id) ? pane : targetPane();
    if (!p || !paneMap.has(p.id)) return;
    if (state.activeId !== p.group.id) return;
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae.isConnected) {
      const tag = ae.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable) return;
      if (ae.closest && ae.closest('.ctx-menu, .modal, .dialog, [role="dialog"]')) return;
    }
    try { p.term.focus(); } catch { /* ignore */ }
  }, 0);
}

/* ------------------------------------------------------------ 尺寸/适配 */
const fitTimers = new WeakMap();
function scheduleFit(pane) {
  clearTimeout(fitTimers.get(pane));
  fitTimers.set(pane, setTimeout(() => fitPane(pane), 70));
}

function fitPane(pane) {
  if (!paneMap.has(pane.id)) return;
  if (!pane.bodyEl.clientWidth || !pane.bodyEl.clientHeight) return;
  try {
    pane.fit.fit();
    api.resizePty(pane.id, pane.term.cols, pane.term.rows);
  } catch { /* ignore */ }
}

function refitAll() {
  for (const pane of paneMap.values()) fitPane(pane);
  const group = activeGroup();
  if (group) syncGroupRects(group);
}

/* --------------------------------------------------------- 复制 / 粘贴 */
function bufferText(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\r\n');
}

async function copyAll(pane) {
  if (!pane) return;
  const text = bufferText(pane.term);
  if (!text) { toast(t('pane.copyEmpty')); return; }
  await api.writeClipboard(text);
  const lines = text.split('\r\n').length;
  toast(t('pane.copyDone', { lines, chars: text.length }));
  pane.term.focus();
}

async function copySelection(pane) {
  if (!pane || !pane.term.hasSelection()) return false;
  const sel = pane.term.getSelection();
  await api.writeClipboard(sel);
  pane.term.clearSelection();
  toast(t('pane.copySelDone'));
  return true;
}

async function pasteInto(pane) {
  if (!pane) return;
  const text = await api.readClipboard();
  if (!text) return;
  pane.term.paste(text);
  pane.term.focus();
}

/* ---------------------------------------------------------------- 置顶 */
function setGroupPinned(groupId, pinned) {
  const group = findGroup(groupId);
  if (!group) return;
  group.pinned = !!pinned;
  renderSidebar();
  syncPinUI();
  if (group.id === state.activeId) {
    api.setAlwaysOnTop(group.pinned);
    toast(group.pinned ? t('group.pinnedToast') : t('group.unpinnedToast'));
  }
  persist();
}

function syncPinUI() {
  const group = activeGroup();
  const pinned = !!(group && group.pinned);
  const btn = $('#btn-pin-group');
  btn.classList.toggle('on', pinned);
  btn.querySelector('.pin-label').textContent = pinned ? t('toolbar.pinned') : t('toolbar.pin');
  for (const pane of paneMap.values()) {
    const on = !!pane.group.pinned;
    pane.el.querySelector('[data-act="pin"]').classList.toggle('pinned', on);
  }
}

/* -------------------------------------------------------------- 右键菜单 */
function closeCtxMenu() {
  const m = $('#ctx-menu');
  m.hidden = true;
  m.innerHTML = '';
}

// restoreFocus: 传终端则动作完成后把焦点还给这个终端；传 true 则还给当前激活的终端
let menuRestoreHandler = null;
function openMenu(x, y, items, restoreFocus) {
  const menu = $('#ctx-menu');
  menu.innerHTML = '';

  // 不管是普通项还是 render 自定义项（布局缩略图、色块、目录历史…），点完都把焦点还给终端。
  // 用菜单容器上的冒泡监听，一次点击只还一次；下次开菜单先摘掉上次的监听。
  if (menuRestoreHandler) {
    menu.removeEventListener('click', menuRestoreHandler);
    menuRestoreHandler = null;
  }
  if (restoreFocus) {
    menuRestoreHandler = () => {
      menu.removeEventListener('click', menuRestoreHandler);
      menuRestoreHandler = null;
      restorePaneFocus(restoreFocus === true ? null : restoreFocus);
    };
    menu.addEventListener('click', menuRestoreHandler);
  }

  for (const item of items) {
    if (item === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    if (item.render) { menu.appendChild(item.render()); continue; }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' is-off' : '');
    if (item.key) b.dataset.key = item.key;   // 自动化/自检按 key 选，不受界面语言影响
    if (item.title) b.title = item.title;
    if (item.disabled) b.disabled = true;
    b.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.hint ? `<span class="sc">${escapeHtml(item.hint)}</span>` : ''}`;
    b.addEventListener('click', () => {
      if (item.disabled) return;
      closeCtxMenu();
      item.action();
    });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

/* --------------------------------------------------- 菜单内的背景色选择器 */
// 点色块只换色、不关菜单，这样可以连着试几个颜色
function renderPaneBgPicker(pane) {
  const wrap = document.createElement('div');
  wrap.className = 'ctx-colors';

  const head = document.createElement('div');
  head.className = 'ctx-colors-head';
  head.innerHTML = `<span>${escapeHtml(t('menu.pane.bg'))}</span>`;
  const reset = document.createElement('button');
  reset.className = 'ctx-link';
  reset.type = 'button';
  reset.textContent = t('menu.pane.bgFollow');
  head.appendChild(reset);

  const grid = document.createElement('div');
  grid.className = 'ctx-swatch-grid';

  const paint = () => {
    const cur = normHex(paneBg(pane));
    const own = !!pane.meta.bg;
    reset.classList.toggle('on', !own);
    for (const b of grid.children) {
      b.classList.toggle('on', !!b.dataset.bg && normHex(b.dataset.bg) === cur);
    }
  };
  const pick = (bg, label) => {
    setPaneLook(pane, { bg });
    paint();
    toast(bg ? t('menu.pane.bgSet', { label }) : t('menu.pane.bgReset'));
  };

  reset.addEventListener('click', (e) => {
    e.stopPropagation();
    pick(null, '');
  });
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-swatch';
    b.dataset.bg = p.bg;
    b.title = t(p.nameKey);
    b.style.background = p.bg;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      pick(p.bg, t(p.nameKey));
    });
    grid.appendChild(b);
  }
  paint();

  wrap.append(head, grid);
  return wrap;
}

function canHist(pane, delta) {
  const h = pane && pane.hist;
  if (!h || !h.list.length || h.idx < 0) return false;
  const next = h.idx + delta;
  return next >= 0 && next < h.list.length;
}

// 菜单里的目录历史列表：点哪条就切到哪条，当前位置标出来
function renderDirHistList(pane) {
  const h = pane && pane.hist;
  const wrap = document.createElement('div');
  wrap.className = 'ctx-colors ctx-dirhist';

  const head = document.createElement('div');
  head.className = 'ctx-colors-head';
  head.innerHTML = `<span>${escapeHtml(t('hist.header'))}</span><span>Alt+← / →</span>`;
  wrap.appendChild(head);

  if (!h || !h.list.length) {
    const empty = document.createElement('div');
    empty.className = 'ctx-empty';
    empty.textContent = pane && pane.meta.liveCwd ? t('hist.none') : t('hist.cmdNoHook');
    wrap.appendChild(empty);
    return wrap;
  }

  const from = Math.max(0, h.idx - 6);
  const to = Math.min(h.list.length - 1, h.idx + 4);
  for (let i = from; i <= to; i++) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ctx-hist-row' + (i === h.idx ? ' on' : '');
    const mark = document.createElement('span');
    mark.className = 'ctx-hist-mark';
    mark.textContent = i === h.idx ? '●' : '';
    const path = document.createElement('span');
    path.className = 'ctx-hist-path';
    path.textContent = shortenPath(h.list[i], 30);
    row.append(mark, path);
    row.title = h.list[i];
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (i === h.idx) { closeCtxMenu(); return; }
      goToHistIndex(pane, i);
      closeCtxMenu();
    });
    wrap.appendChild(row);
  }
  return wrap;
}

function openPaneMenu(pane, x, y) {
  const items = [
    { key: 'menu.pane.rename', label: t('menu.pane.rename'), hint: t('menu.pane.renameHint'), action: () => startRenamePane(pane) },
  ];
  if (pane.meta.customTitle) {
    items.push({ key: 'menu.pane.restoreTitle', label: t('menu.pane.restoreTitle'), action: () => { setPaneTitle(pane, ''); toast(t('pane.renameReset')); } });
  }
  // 停止 / 启动：只有真的在跑才有「停止」，停止态给「启动」
  const power = pane.meta.suspended
    ? [{ key: 'menu.pane.start', label: t('pane.start'), action: () => startPane(pane) }]
    : (pane.running ? [{ key: 'menu.pane.stop', label: t('pane.stop'), action: () => stopPane(pane) }] : []);
  items.push(
    '-',
    {
      key: 'menu.pane.startDir',
      label: t('menu.pane.startDir'),
      hint: pane.meta.cwd ? shortenPath(pane.meta.cwd, 24) : t('menu.pane.startDirDefault'),
      action: () => openCwdDialog(pane),
    },
    {
      key: 'menu.pane.newHere',
      label: t('menu.pane.newHere'),
      action: () => {
        const dir = paneCwd(pane) || null;
        const group = pane.group;
        if (!group) return;
        activateGroup(group.id);
        const np = addPane(group, { cwd: dir });
        if (np) focusPane(np.id);
      },
    },
    '-',
    {
      key: 'menu.pane.parent',
      label: t('menu.pane.parent'),
      hint: 'Alt+↑',
      title: t('menu.pane.parentTitle'),
      action: () => goParentDir(pane),
    },
    {
      key: 'menu.pane.histBack',
      label: t('menu.pane.histBack'),
      hint: 'Alt+←',
      title: t('menu.pane.histBackTitle'),
      disabled: !canHist(pane, -1),
      action: () => jumpDir(pane, -1),
    },
    {
      key: 'menu.pane.histForward',
      label: t('menu.pane.histForward'),
      hint: 'Alt+→',
      title: t('menu.pane.histForwardTitle'),
      disabled: !canHist(pane, 1),
      action: () => jumpDir(pane, 1),
    },
    { render: () => renderDirHistList(pane) },
    '-',
    { render: () => renderPaneBgPicker(pane) },
    { key: 'menu.pane.look', label: t('menu.pane.look'), hint: t('menu.pane.lookHint'), action: () => openLook(pane) },
    '-',
    { key: 'menu.pane.copyAll', label: t('menu.pane.copyAll'), hint: 'Ctrl+Shift+A', action: () => copyAll(pane) },
    { key: 'menu.pane.copyOutput', label: t('menu.pane.copyOutput'), action: () => copyCommandOutput(pane) },
    { key: 'menu.pane.copySel', label: t('menu.pane.copySel'), hint: 'Ctrl+Shift+C', action: () => copySelection(pane) },
    { key: 'menu.pane.paste', label: t('menu.pane.paste'), hint: 'Ctrl+Shift+V', action: () => pasteInto(pane) },
    '-',
    { key: 'menu.pane.jumpPrev', label: t('menu.pane.jumpPrev'), hint: 'Ctrl+↑', action: () => jumpCommand(pane, -1) },
    { key: 'menu.pane.jumpNext', label: t('menu.pane.jumpNext'), hint: 'Ctrl+↓', action: () => jumpCommand(pane, 1) },
    '-',
    ...power,
    { key: 'menu.pane.clear', label: t('menu.pane.clear'), hint: 'Ctrl+L', action: () => { pane.term.clear(); pane.term.focus(); } },
    { key: 'menu.pane.restart', label: t('menu.pane.restart'), action: () => restartPane(pane) },
    '-',
    { key: 'menu.pane.close', label: t('menu.pane.close'), danger: true, hint: 'Ctrl+Shift+W', action: () => removePane(pane.id) },
  );
  openMenu(x, y, items, pane);
}

/* ------------------------------------------------------- 终端外观（独立配色） */
let lookPane = null;

function setPaneLook(pane, patch, opts = {}) {
  if (!pane) return;
  if ('bg' in patch) {
    const h = patch.bg ? normHex(patch.bg) : null;
    const def = normHex(state.settings.paneBg) || normHex(state.settings.bg);
    // 选到跟默认背景一样的颜色，就等同于"跟随默认"，避免多存一份配置
    pane.meta.bg = h && h !== def ? h : null;
  }
  if ('fg' in patch) pane.meta.fg = patch.fg ? normHex(patch.fg) : null;
  syncPaneTheme(pane);
  if (!opts.silent) persist();
}

// 把当前终端的配色推广到所有终端，并作为新终端的默认
function applyLookToAll(pane) {
  if (!pane) return;
  const bg = paneBg(pane);
  const fg = pane.meta.fg || state.settings.paneFg || null;
  state.settings.paneBg = normHex(bg) === normHex(state.settings.bg) ? null : bg;
  state.settings.paneFg = fg;
  for (const p of paneMap.values()) {
    p.meta.bg = null;
    p.meta.fg = null;
    syncPaneTheme(p);
  }
  persist();
  const n = paneMap.size;
  toast(t('look.appliedAll', { n }));
  if (lookPane) { syncLookInputs(); markLookPresets(); renderLookPreview(); }
}

// 所有终端回到跟随窗口背景
function resetAllPanesToWindow() {
  const before = state.settings.paneBg || state.settings.paneFg;
  state.settings.paneBg = null;
  state.settings.paneFg = null;
  for (const p of paneMap.values()) {
    p.meta.bg = null;
    p.meta.fg = null;
    syncPaneTheme(p);
  }
  persist();
  if (before) toast(t('look.followWindow'));
  if (lookPane) { syncLookInputs(); markLookPresets(); renderLookPreview(); }
}

function openLook(pane) {
  if (!pane) return;
  lookPane = pane;
  $('#look-target').textContent = pane.meta.title || pane.meta.name || '';
  $('#look').hidden = false;
  $('#look-mask').hidden = false;
  mountLookPresets();
  syncLookInputs();
  renderLookPreview();
}

function closeLook() {
  if ($('#look').hidden) return;
  $('#look').hidden = true;
  $('#look-mask').hidden = true;
  lookPane = null;
  focusActivePane();
}

function syncLookInputs() {
  if (!lookPane) return;
  const bg = paneBg(lookPane);
  const fg = paneFg(lookPane);
  $('#look-target').textContent = lookPane.meta.title || lookPane.meta.name || '';
  $('#look-bg').value = normHex(bg) || '#000000';
  $('#look-bg-hex').value = bg;
  $('#look-fg').value = normHex(fg) || '#ffffff';
  $('#look-fg-hex').value = fg;
  const auto = !lookPane.meta.fg && !state.settings.paneFg;
  $('#look-fg-mode').textContent = auto ? t('look.autoContrast') : t('look.custom');
  $('#look-fg-auto').classList.toggle('on', auto);
  markLookPresets();
}

function mountLookPresets() {
  const box = $('#look-presets');
  box.innerHTML = '';
  const mk = (label, bg, isReset) => {
    const b = document.createElement('button');
    b.className = 'swatch-btn' + (isReset ? ' reset' : '');
    b.dataset.bg = isReset ? '' : bg;
    b.title = label;
    if (!isReset) b.style.background = bg;
    b.textContent = isReset ? t('look.default') : '';
    b.addEventListener('click', () => {
      setPaneLook(lookPane, { bg: isReset ? null : bg, fg: null });
      syncLookInputs();
      renderLookPreview();
      toast(isReset ? t('menu.pane.bgReset') : t('menu.pane.bgSet', { label }));
    });
    box.appendChild(b);
  };
  mk(t('menu.pane.bgFollow'), null, true);
  for (const p of PRESETS) mk(t(p.nameKey), p.bg, false);
}

function markLookPresets() {
  if (!lookPane) return;
  const cur = normHex(paneBg(lookPane));
  const own = !!(lookPane.meta.bg);
  for (const b of $('#look-presets').children) {
    const val = b.dataset.bg;
    const on = val ? normHex(val) === cur : !own;
    b.classList.toggle('on', on);
  }
}

function renderLookPreview() {
  if (!lookPane) return;
  const box = $('#look-preview');
  const bg = paneBg(lookPane);
  const fg = paneFg(lookPane);
  const pal = ansiPaletteFor(bg);
  box.style.background = bg;
  box.style.color = fg;
  box.innerHTML = [
    `<div><span style="color:${pal.green}">PS C:\\Work\\Dev&gt;</span> git status -sb</div>`,
    `<div>On branch <span style="color:${pal.cyan}">main</span></div>`,
    `<div><span style="color:${pal.yellow}"> M</span> src/renderer/app.js</div>`,
    `<div><span style="color:${pal.magenta}">??</span> dist/   <span style="opacity:.6">${escapeHtml(t('look.previewTag'))}</span></div>`,
  ].join('');
}

function bindLook() {
  $('#look-mask').addEventListener('click', closeLook);
  $('#btn-close-look').addEventListener('click', closeLook);
  $('#look-done').addEventListener('click', closeLook);
  $('#look-bg').addEventListener('input', (e) => {
    setPaneLook(lookPane, { bg: e.target.value, fg: lookPane && lookPane.meta.fg });
    syncLookInputs();
    renderLookPreview();
  });
  $('#look-bg-hex').addEventListener('change', (e) => {
    const hex = normHex(e.target.value);
    if (!hex) { syncLookInputs(); return; }
    setPaneLook(lookPane, { bg: hex, fg: lookPane && lookPane.meta.fg });
    syncLookInputs();
    renderLookPreview();
  });
  $('#look-fg').addEventListener('input', (e) => {
    setPaneLook(lookPane, { fg: e.target.value });
    syncLookInputs();
    renderLookPreview();
  });
  $('#look-fg-hex').addEventListener('change', (e) => {
    const hex = normHex(e.target.value);
    if (!hex) { syncLookInputs(); return; }
    setPaneLook(lookPane, { fg: hex });
    syncLookInputs();
    renderLookPreview();
  });
  $('#look-fg-auto').addEventListener('click', () => {
    setPaneLook(lookPane, { fg: null });
    syncLookInputs();
    renderLookPreview();
  });
  $('#look-apply-all').addEventListener('click', () => applyLookToAll(lookPane));
}

/* ------------------------------------------------------- 启动目录（每终端） */
let cwdPane = null;
let cwdCheckToken = 0;
let cwdTypingTimer = null;

function setPaneCwd(pane, dir) {
  if (!pane) return;
  const next = normDirPath(dir);
  pane.meta.cwd = next || null;
  if (next) addRecentDir(next);
  persist(true);
}

// 统一成 Windows 习惯的反斜杠，去掉尾部多余分隔符（C:\ 这种盘根保留）
function normDirPath(p) {
  let s = String(p == null ? '' : p).trim().replace(/^"(.*)"$/, '$1').trim();
  if (!s) return '';
  if (/^[a-z]:/i.test(s)) s = s.replace(/\//g, '\\');
  if (/^[a-z]:\\$/i.test(s)) return s;
  return s.replace(/\\+$/, '');
}

function addRecentDir(dir) {
  const d = normDirPath(dir);
  if (!d) return;
  const list = Array.isArray(state.settings.recentDirs) ? state.settings.recentDirs.slice() : [];
  const key = d.toLowerCase();
  // 只比路径本身，别因为 C:/x 和 C:\x 写法不同就存两份
  const rest = list.filter((x) => normDirPath(x).toLowerCase() !== key);
  rest.unshift(d);
  state.settings.recentDirs = rest.slice(0, 8);
}

async function openCwdDialog(pane) {
  if (!pane) return;
  cwdPane = pane;
  $('#cwd-target').textContent = pane.meta.title || pane.meta.name || '';
  $('#cwd-input').value = pane.meta.cwd || '';
  $('#cwd').hidden = false;
  $('#cwd-mask').hidden = false;
  renderCwdRecent();
  syncCwdDialog();
  checkCwdInput();
  const input = $('#cwd-input');
  input.focus();
  input.select();
}

function closeCwdDialog() {
  if ($('#cwd').hidden) return;
  $('#cwd').hidden = true;
  $('#cwd-mask').hidden = true;
  cwdPane = null;
  focusActivePane();
}

function syncCwdDialog() {
  if (!cwdPane) return;
  const live = normDirPath(cwdPane.meta.liveCwd);
  $('#cwd-live').textContent = live || t('cwd.livePending');
  $('#cwd-live').title = live || '';
  $('#cwd-use-live').disabled = !live;
}

function renderCwdRecent() {
  const box = $('#cwd-recent');
  box.innerHTML = '';
  const items = [];
  const push = (p, label) => {
    const dir = normDirPath(p);
    if (!dir) return;
    if (items.some((it) => it.path.toLowerCase() === dir.toLowerCase())) return;
    items.push({ path: dir, label });
  };
  if (state.homeDir) push(state.homeDir, t('cwd.home'));
  push(state.settings.startDir, t('cwd.defaultDir'));
  for (const d of state.settings.recentDirs || []) push(d, '');
  if (!items.length) {
    const empty = document.createElement('span');
    empty.className = 'cwd-empty';
    empty.textContent = t('cwd.noRecent');
    box.appendChild(empty);
    return;
  }
  for (const it of items.slice(0, 8)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cwd-chip';
    b.title = it.path;
    b.innerHTML = it.label
      ? `<span class="chip-k">${escapeHtml(it.label)}</span>${escapeHtml(shortenPath(it.path, 26))}`
      : escapeHtml(shortenPath(it.path, 30));
    b.addEventListener('click', () => {
      $('#cwd-input').value = it.path;
      checkCwdInput();
    });
    box.appendChild(b);
  }
}

async function checkCwdInput() {
  const raw = $('#cwd-input').value.trim();
  const st = $('#cwd-status');
  const token = ++cwdCheckToken;
  if (!raw) {
    const def = state.settings.startDir;
    st.className = 'field-note';
    st.textContent = def ? t('cwd.placeholder', { dir: def }) : t('cwd.placeholderHome');
    return { ok: true, empty: true };
  }
  const r = await api.checkDir(raw);
  if (token !== cwdCheckToken) return r; // 输入太快，只认最后一次
  if (r.ok) {
    st.className = 'field-note ok';
    st.textContent = t('cwd.ok', { path: r.path });
  } else {
    st.className = 'field-note bad';
    st.textContent = r.exists ? t('cwd.notFolder') : t('cwd.notExist');
  }
  return r;
}

async function saveCwdDialog(restart) {
  const pane = cwdPane;
  if (!pane) return;
  const raw = $('#cwd-input').value.trim();
  if (raw) {
    const r = await api.checkDir(raw);
    if (!r.ok) {
      toast(r.exists ? t('cwd.pickNotFolder') : t('cwd.pickNotExist'), 2600);
      return;
    }
    setPaneCwd(pane, r.path);
  } else {
    setPaneCwd(pane, null);
  }
  closeCwdDialog();
  if (restart) {
    await restartPane(pane);
    toast(`${t('cwd.restarted')}${pane.meta.cwd ? ` · ${shortenPath(pane.meta.cwd, 30)}` : ''}`, 2400);
  } else if (pane.running) {
    toast(t('cwd.savedPending'), 2800);
  } else {
    toast(t('cwd.saved'));
  }
  renderPaneTitle(pane);
}

function bindCwdDialog() {
  $('#cwd-mask').addEventListener('click', closeCwdDialog);
  $('#btn-close-cwd').addEventListener('click', closeCwdDialog);
  $('#cwd-save').addEventListener('click', () => saveCwdDialog(false));
  $('#cwd-save-restart').addEventListener('click', () => saveCwdDialog(true));
  $('#cwd-reset').addEventListener('click', async () => {
    if (!cwdPane) return;
    setPaneCwd(cwdPane, null);
    $('#cwd-input').value = '';
    checkCwdInput();
    toast(t('cwd.resetDone'));
  });
  $('#cwd-use-live').addEventListener('click', () => {
    if (!cwdPane || !cwdPane.meta.liveCwd) return;
    $('#cwd-input').value = normDirPath(cwdPane.meta.liveCwd);
    checkCwdInput();
  });
  $('#cwd-input').addEventListener('input', () => {
    clearTimeout(cwdTypingTimer);
    cwdTypingTimer = setTimeout(checkCwdInput, 220);
  });
  $('#cwd-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCwdDialog(false); }
  });
  $('#cwd-browse').addEventListener('click', async () => {
    const res = await api.pickDir($('#cwd-input').value.trim() || undefined);
    if (res && !res.canceled && res.path) {
      $('#cwd-input').value = res.path;
      checkCwdInput();
    }
  });
}

/* ---------------------------------------------------------- 自动排列菜单 */
function thumbSvg(rects) {
  const W = 20;
  const H = 15;
  let body = '';
  for (const r of rects) {
    body += `<rect x="${(r.x * W + 0.5).toFixed(2)}" y="${(r.y * H + 0.5).toFixed(2)}" `
      + `width="${Math.max(1, r.w * W - 1).toFixed(2)}" height="${Math.max(1, r.h * H - 1).toFixed(2)}" `
      + `rx="1.3" fill="currentColor" opacity="0.55"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
}

function layoutThumb(key) {
  return thumbSvg(computeLayout(key === 'auto' ? 'grid2' : key, 4));
}

function applyLayoutTo(group, key) {
  if (!group || !group.panes.length) return;
  applyLayoutRects(group, key);
  if (group.id === state.activeId) refitGroup(group);
  else for (const meta of group.panes) { const p = paneMap.get(meta.id); if (p) scheduleFit(p); }
  persist();
  toast(t('layout.applied', { n: group.panes.length, name: layoutName(key) }));
}

function applyLayoutToAll(key) {
  let count = 0;
  for (const group of state.groups) {
    if (!group.panes.length) continue;
    applyLayoutRects(group, key);
    count += group.panes.length;
  }
  for (const p of paneMap.values()) scheduleFit(p);
  persist();
  toast(t('layout.appliedAll', { n: count, name: layoutName(key) }));
}

function openLayoutMenu(anchor) {
  const group = activeGroup();
  const custom = !!(group && group.layout && group.layout.custom);
  const cur = (group && group.layout && group.layout.key) || 'auto';
  const box = anchor.getBoundingClientRect();
  const items = [];

  // 手动摆过的分组：把当前真实位置画成缩略图，避免下拉里误标成"自动"
  if (custom && group.panes.length) {
    items.push({
      render: () => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ctx-item ctx-layout on';
        b.dataset.key = 'layout.custom';
        b.innerHTML = `<span class="lay-thumb">${thumbSvg(group.panes.map((m) => (validRect(m.rect) ? m.rect : { x: 0, y: 0, w: 1, h: 1 })))}</span>`
          + `<span class="lay-name">${escapeHtml(t('layout.custom'))}</span>`
          + '<span class="lay-check">✓</span>';
        b.addEventListener('click', () => {
          closeCtxMenu();
          toast(t('layout.customToast'));
        });
        return b;
      },
    });
    items.push('-');
  }

  for (const l of LAYOUTS) {
    items.push({
      render: () => {
        const b = document.createElement('button');
        b.type = 'button';
        const on = !custom && l.key === cur;
        b.className = 'ctx-item ctx-layout' + (on ? ' on' : '');
        b.dataset.key = 'layout.' + l.key;
        b.innerHTML = `<span class="lay-thumb">${layoutThumb(l.key)}</span>`
          + `<span class="lay-name">${escapeHtml(t(l.nameKey))}</span>`
          + `<span class="lay-check">${on ? '✓' : ''}</span>`;
        b.addEventListener('click', () => {
          closeCtxMenu();
          const g = activeGroup();
          if (g) applyLayoutTo(g, l.key);
        });
        return b;
      },
    });
  }

  items.push('-');
  items.push({
    key: 'layout.restoreAuto',
    label: t('layout.restoreAuto'),
    action: () => { const g = activeGroup(); if (g) applyLayoutTo(g, 'auto'); },
  });
  items.push({
    // 手动摆放的布局没法按比例照搬给别的分组（终端数量可能不同），所以这里是"都回自动"
    key: 'layout.applyAll',
    label: custom ? t('layout.allAuto') : t('layout.applyAll'),
    hint: custom ? t('layout.customOnly') : layoutName(cur),
    action: () => applyLayoutToAll(custom ? 'auto' : cur),
  });
  items.push('-');
  items.push({
    render: () => {
      const note = document.createElement('div');
      note.className = 'ctx-note';
      note.textContent = t('layout.note');
      return note;
    },
  });

  openMenu(box.left, box.bottom + 6, items, true);
}

function openGroupMenu(group, x, y) {
  openMenu(x, y, [
    { key: 'group.menu.newPane', label: t('group.menu.newPane'), action: () => { activateGroup(group.id); addPane(group); } },
    { key: 'group.startAll', label: t('group.startAll'), action: () => {
        if (group.id !== state.activeId) activateGroup(group.id);
        startGroup(group);
      } },
    { key: 'group.stopAll', label: t('group.stopAll'), action: () => stopGroup(group) },
    { key: 'group.menu.pin', label: group.pinned ? t('group.unpin') : t('group.pin'), action: () => setGroupPinned(group.id, !group.pinned) },
    { key: 'group.rename', label: t('group.rename'), action: () => {
        activateGroup(group.id);
        const els = groupEls.get(group.id);
        if (els && els.item) startRenameGroup(group, els.item);
      } },
    { key: 'group.copyAll', label: t('group.copyAll'), action: () => copyGroup(group) },
    '-',
    { key: 'group.close', label: t('group.close'), danger: true, action: () => closeGroup(group.id) },
  ], true);
}

async function copyGroup(group) {
  const chunks = [];
  for (const meta of group.panes) {
    const pane = paneMap.get(meta.id);
    if (!pane) continue;
    const text = bufferText(pane.term);
    chunks.push(`===== ${meta.title || meta.name} =====\r\n${text}`);
  }
  if (!chunks.length) { toast(t('group.copyEmpty')); return; }
  await api.writeClipboard(chunks.join('\r\n\r\n'));
  toast(t('group.copyDone', { n: group.panes.length }));
}

/* ----------------------------------------------------------------- toast */
let toastTimer = null;
function toast(msg, ms = 1900) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ 设置 */
function markPresets() {
  const box = $('#preset-swatches');
  box.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'swatch-btn' + (normHex(p.bg) === normHex(state.settings.bg) ? ' on' : '');
    b.style.background = p.bg;
    b.title = t(p.nameKey);
    b.addEventListener('click', () => {
      state.settings.bg = p.bg;
      state.settings.fg = p.fg;
      applyTheme();
      syncSettingsInputs();
      markPresets();
      persist();
      if (state.settings.paneBg) toast(t('drawer.paneBgLeft'));
    });
    box.appendChild(b);
  }
}

function syncSettingsInputs() {
  const s = state.settings;
  $('#input-bg').value = normHex(s.bg) || '#000000';
  $('#input-bg-hex').value = s.bg;
  $('#input-fg').value = normHex(s.fg) || '#ffffff';
  $('#input-fg-hex').value = s.fg;
  $('#input-font-size').value = s.fontSize;
  $('#font-size-val').textContent = `${s.fontSize}px`;
  $('#input-font-family').value = s.fontFamily;
  $('#input-shell').value = s.shell;
  $('#input-start-dir').value = s.startDir || '';
  $('#input-cursor').checked = !!s.cursorBlink;
  $('#input-restore').checked = s.restoreSessions !== false;
  const notifyBox = $('#input-notify');
  if (notifyBox) notifyBox.checked = s.notifyOnDone !== false;
  const langSel = $('#input-language');
  if (langSel) langSel.value = s.language || 'auto';
}

function openDrawer() {
  $('#drawer').hidden = false;
  $('#drawer-mask').hidden = false;
  syncSettingsInputs();
  markPresets();
}
function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-mask').hidden = true;
}

function bindSettings() {
  $('#btn-settings').addEventListener('click', openDrawer);
  $('#btn-close-drawer').addEventListener('click', closeDrawer);
  $('#drawer-mask').addEventListener('click', closeDrawer);

  const setBg = (val) => {
    const hex = normHex(val);
    if (!hex) return;
    state.settings.bg = hex;
    applyTheme();
    syncSettingsInputs();
    markPresets();
    persist();
  };
  $('#input-bg').addEventListener('input', (e) => setBg(e.target.value));
  $('#input-bg-hex').addEventListener('change', (e) => setBg(e.target.value));

  const setFg = (val) => {
    const hex = normHex(val);
    if (!hex) return;
    state.settings.fg = hex;
    applyTheme();
    syncSettingsInputs();
    persist();
  };
  $('#input-fg').addEventListener('input', (e) => setFg(e.target.value));
  $('#input-fg-hex').addEventListener('change', (e) => setFg(e.target.value));

  $('#input-font-size').addEventListener('input', (e) => {
    state.settings.fontSize = Number(e.target.value);
    $('#font-size-val').textContent = `${state.settings.fontSize}px`;
    applyTheme();
    refitAll();
    persist();
  });

  $('#input-font-family').addEventListener('change', (e) => {
    state.settings.fontFamily = e.target.value;
    applyTheme();
    refitAll();
    persist();
  });

  $('#input-shell').addEventListener('change', (e) => {
    state.settings.shell = e.target.value;
    persist();
    toast(t('drawer.shellUpdated'));
  });

  // 界面语言：auto 跟随系统；切换后不用重启，整屏文案立刻重建
  const langSel = $('#input-language');
  if (langSel) {
    langSel.addEventListener('change', (e) => {
      const val = e.target.value;
      state.settings.language = val;
      applyLanguage(val, state.systemLocale);
      rerenderForLanguage();
      persist();
      const name = val === 'auto' ? t('drawer.langAuto') : val === 'zh-CN' ? '简体中文' : 'English';
      toast(t('drawer.langToast', { name }));
    });
  }

  // 全局默认启动目录
  const applyStartDir = async (raw, silent) => {
    const val = String(raw || '').trim();
    if (!val) {
      state.settings.startDir = null;
      syncSettingsInputs();
      persist();
      if (!silent) toast(t('drawer.startDirHome'));
      return true;
    }
    const r = await api.checkDir(val);
    if (!r.ok) {
      if (!silent) toast(t('drawer.startDirBad'), 2600);
      syncSettingsInputs();
      return false;
    }
    state.settings.startDir = r.path;
    addRecentDir(r.path);
    syncSettingsInputs();
    persist();
    if (!silent) toast(t('drawer.startDirSet', { path: shortenPath(r.path, 32) }), 2600);
    return true;
  };
  $('#input-start-dir').addEventListener('change', (e) => applyStartDir(e.target.value));
  $('#btn-pick-start-dir').addEventListener('click', async () => {
    const res = await api.pickDir($('#input-start-dir').value.trim() || undefined);
    if (res && !res.canceled && res.path) applyStartDir(res.path);
  });
  $('#btn-clear-start-dir').addEventListener('click', () => applyStartDir('', true));

  $('#input-cursor').addEventListener('change', (e) => {
    state.settings.cursorBlink = e.target.checked;
    applyTheme();
    persist();
  });

  $('#input-restore').addEventListener('change', (e) => {
    state.settings.restoreSessions = e.target.checked;
    persist();
  });

  const notifyBox = $('#input-notify');
  if (notifyBox) {
    notifyBox.addEventListener('change', (e) => {
      state.settings.notifyOnDone = e.target.checked;
      persist();
    });
  }

  $('#btn-reset').addEventListener('click', () => {
    state.settings = { ...DEFAULT_SETTINGS, activeGroupId: state.settings.activeGroupId };
    applyTheme();
    applySidebar();
    syncSettingsInputs();
    markPresets();
    refitAll();
    persist();
    toast(t('look.resetDone'));
  });

  $('#btn-bg').addEventListener('click', () => openDrawer());
  $('#btn-layout').addEventListener('click', (e) => { e.stopPropagation(); openLayoutMenu(e.currentTarget); });
  $('#btn-pane-follow').addEventListener('click', () => resetAllPanesToWindow());
  bindLook();
  $('#btn-pin-group').addEventListener('click', () => {
    const g = activeGroup();
    if (g) setGroupPinned(g.id, !g.pinned);
  });
  $('#btn-add-pane').addEventListener('click', () => {
    const g = activeGroup() || createGroup();
    addPane(g);
  });
  $('#btn-new-group').addEventListener('click', () => createGroup());
  $('#btn-empty-new').addEventListener('click', () => createGroup());
  $('#btn-new-shell').addEventListener('click', () => {
    const g = activeGroup() || createGroup();
    addPane(g);
  });
}

/* -------------------------------------------------------------- 持久化 */
let persistTimer = null;
// immediate = true 时立刻落盘（拖完窗口、退出前这类"必须记住"的时机）
function persist(immediate) {
  clearTimeout(persistTimer);
  if (immediate) { doPersist(); return; }
  persistTimer = setTimeout(doPersist, 320);
}
function doPersist() {
  clearTimeout(persistTimer);
  const payload = {
    settings: { ...state.settings, activeGroupId: state.activeId },
    groups: state.groups.map((g) => ({
      id: g.id,
      name: g.name,
      autoNameKey: g.autoNameKey || null,
      autoNameNum: g.autoNameNum || null,
      pinned: g.pinned,
      layout: { key: (g.layout && g.layout.key) || 'auto', custom: !!(g.layout && g.layout.custom) },
      panes: g.panes.map((p) => ({
        id: p.id,
        bg: p.bg || null,
        fg: p.fg || null,
        cwd: p.cwd || null,
        name: p.name || null,
        seq: p.seq || null,
        title: p.title || null,
        custom: !!p.customTitle,
        suspended: !!p.suspended,
        rect: validRect(p.rect) ? roundRect(p.rect) : null,
      })),
    })),
  };
  api.saveConfig(payload);
}

/* -------------------------------------------------------------- 快捷键 */
function onKeyDown(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const code = e.code;

  if (e.key === 'Escape') {
    closeCtxMenu();
    if (!$('#cwd').hidden) { closeCwdDialog(); return; }
    if (!$('#look').hidden) { closeLook(); return; }
    if (!$('#drawer').hidden) closeDrawer();
    return;
  }

  // Alt+← / Alt+→：在目录历史里逐级回退 / 前进；Alt+↑：回到上一级目录
  if (e.altKey && !ctrl && !e.shiftKey) {
    const delta = code === 'ArrowLeft' ? -1 : code === 'ArrowRight' ? 1 : 0;
    if (delta || code === 'ArrowUp') {
      const t = e.target;
      const inField = t && typeof t.closest === 'function'
        && t.closest('input, textarea, select, [contenteditable="true"]')
        && !t.classList.contains('xterm-helper-textarea');
      if (!inField) {
        e.preventDefault();
        e.stopPropagation();
        const pane = targetPane();
        if (delta) jumpDir(pane, delta);
        else goParentDir(pane);
        return;
      }
    }
  }

  if (!ctrl) return;

  // Ctrl+↑ / Ctrl+↓：在"命令块"之间跳（Warp / iTerm 的 command jump 同款）
  if (!e.shiftKey && !e.altKey && (code === 'ArrowUp' || code === 'ArrowDown')) {
    const el = e.target;
    const inField = el && typeof el.closest === 'function'
      && el.closest('input, textarea, select, [contenteditable="true"]')
      && !el.classList.contains('xterm-helper-textarea');
    if (!inField) {
      e.preventDefault();
      e.stopPropagation();
      jumpCommand(targetPane(), code === 'ArrowUp' ? -1 : 1);
      return;
    }
  }

  const active = activeGroup();
  const focused = [...paneMap.values()].find((p) => p.el.classList.contains('focused'));

  // Ctrl+Shift+A：复制当前终端全部文本
  if (e.shiftKey && code === 'KeyA') {
    e.preventDefault(); e.stopPropagation();
    const pane = (focused && focused.group.id === (active && active.id)) ? focused : (active && active.panes[0] ? paneMap.get(active.panes[0].id) : null);
    copyAll(pane);
    return;
  }
  // Ctrl+Shift+C：复制选中内容
  if (e.shiftKey && code === 'KeyC') {
    if (focused && focused.term.hasSelection()) {
      e.preventDefault(); e.stopPropagation();
      copySelection(focused);
      return;
    }
  }
  // Ctrl+Shift+V：粘贴
  if (e.shiftKey && code === 'KeyV') {
    e.preventDefault(); e.stopPropagation();
    pasteInto(focused || (active && active.panes[0] ? paneMap.get(active.panes[0].id) : null));
    return;
  }
  // Ctrl+Shift+T：新建分组
  if (e.shiftKey && code === 'KeyT') {
    e.preventDefault(); e.stopPropagation();
    createGroup();
    return;
  }
  // Ctrl+T：新建终端
  if (!e.shiftKey && code === 'KeyT') {
    e.preventDefault(); e.stopPropagation();
    const g = activeGroup() || createGroup();
    addPane(g);
    return;
  }
  // Ctrl+Shift+W：关闭当前终端
  if (e.shiftKey && code === 'KeyW') {
    e.preventDefault(); e.stopPropagation();
    if (focused) removePane(focused.id);
    return;
  }
  // Ctrl+B：收起 / 展开左侧分组栏
  if (!e.shiftKey && code === 'KeyB') {
    e.preventDefault(); e.stopPropagation();
    toggleSidebar();
    return;
  }
  // Ctrl+Shift+P：置顶当前分组
  if (e.shiftKey && code === 'KeyP') {
    e.preventDefault(); e.stopPropagation();
    const g = activeGroup();
    if (g) setGroupPinned(g.id, !g.pinned);
    return;
  }
  // Ctrl+`：切换下一个分组
  if (code === 'Backquote') {
    e.preventDefault(); e.stopPropagation();
    if (state.groups.length > 1) {
      const i = state.groups.findIndex((g) => g.id === state.activeId);
      const next = state.groups[(i + 1) % state.groups.length];
      activateGroup(next.id);
      focusActivePane();
    }
    return;
  }
  // Ctrl+1..9：跳转到第 N 个分组
  if (/^Digit[1-9]$/.test(code)) {
    const idx = Number(code.slice(5)) - 1;
    if (state.groups[idx]) {
      e.preventDefault(); e.stopPropagation();
      activateGroup(state.groups[idx].id);
      focusActivePane();
    }
    return;
  }
  // Ctrl+= / Ctrl+-：字号
  if (code === 'Equal' || code === 'NumpadAdd') {
    e.preventDefault(); e.stopPropagation();
    setFontSize(state.settings.fontSize + 1);
    return;
  }
  if (code === 'Minus' || code === 'NumpadSubtract') {
    e.preventDefault(); e.stopPropagation();
    setFontSize(state.settings.fontSize - 1);
    return;
  }
  if (code === 'Digit0') {
    e.preventDefault(); e.stopPropagation();
    setFontSize(DEFAULT_SETTINGS.fontSize);
  }
}

function setFontSize(size) {
  const next = Math.max(10, Math.min(26, size));
  if (next === state.settings.fontSize) return;
  state.settings.fontSize = next;
  applyTheme();
  refitAll();
  syncSettingsInputs();
  persist();
  toast(t('drawer.fontSizeToast', { n: next }));
}

/* ------------------------------------------------------ 侧边栏宽度 / 收起 */
const SB_MIN = 180;
const SB_MAX = 460;
const SB_DEFAULT = 250;
let sbAnimTimer = 0;
let sbDrag = null;

function clampSidebarWidth(w) {
  // 窗口本身很窄的时候别让侧栏把工作区挤没
  const cap = Math.min(SB_MAX, Math.max(SB_MIN + 40, Math.round(window.innerWidth * 0.45)));
  return Math.round(Math.min(cap, Math.max(SB_MIN, Number(w) || SB_DEFAULT)));
}

function applySidebar() {
  const s = state.settings;
  const w = clampSidebarWidth(s.sidebarWidth);
  s.sidebarWidth = w;
  document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  document.body.classList.toggle('sb-collapsed', !!s.sidebarCollapsed);

  const btn = $('#btn-toggle-sidebar');
  if (!btn) return;
  const open = !s.sidebarCollapsed;
  btn.title = open ? t('toolbar.collapseTitle') : t('toolbar.expandTitle');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? t('toolbar.collapse') : t('toolbar.expand'));
  btn.classList.toggle('on', !open);
}

function setSidebarWidth(w, opts = {}) {
  const next = clampSidebarWidth(w);
  if (state.settings.sidebarWidth === next) return next;
  state.settings.sidebarWidth = next;
  document.documentElement.style.setProperty('--sidebar-w', `${next}px`);
  if (opts.persist) persist(true);
  return next;
}

function setSidebarCollapsed(flag, opts = {}) {
  const next = !!flag;
  if (!!state.settings.sidebarCollapsed === next) return;
  state.settings.sidebarCollapsed = next;
  document.body.classList.add('sb-anim');
  applySidebar();
  clearTimeout(sbAnimTimer);
  // 等宽度动画走完再重新 fit，否则终端会按动画中间态的尺寸去算行列
  sbAnimTimer = setTimeout(() => {
    document.body.classList.remove('sb-anim');
    refitAll();
  }, 210);
  if (!opts.silent) {
    persist();
    toast(next ? t('sidebar.collapsedToast') : t('sidebar.expandedToast'), 1600);
  }
}

function toggleSidebar() {
  setSidebarCollapsed(!state.settings.sidebarCollapsed);
}

function bindSidebar() {
  applySidebar();
  const bar = $('#sidebar-resizer');
  const btn = $('#btn-toggle-sidebar');
  if (btn) btn.addEventListener('click', toggleSidebar);
  if (!bar) return;

  const onMove = (e) => {
    if (!sbDrag) return;
    // 侧栏贴着窗口左边，所以指针的 clientX 就是要的宽度
    setSidebarWidth(e.clientX);
    const now = performance.now();
    if (now - sbDrag.lastFit > 90) {
      sbDrag.lastFit = now;
      refitAll();   // 拖动过程中别每帧都重排，不然一卡一卡的
    }
  };

  const stop = () => {
    if (!sbDrag) return;
    sbDrag = null;
    document.body.classList.remove('sb-resizing');
    refitAll();
    persist(true);
  };

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state.settings.sidebarCollapsed) return;
    e.preventDefault();
    sbDrag = { lastFit: 0 };
    document.body.classList.add('sb-resizing');
  });
  // 挂在 window 上：手柄会跟着宽度一起移动，光靠手柄自己容易跟丢
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  bar.addEventListener('dblclick', () => {
    setSidebarWidth(SB_DEFAULT, { persist: true });
    refitAll();
    toast(t('sidebar.widthReset'), 1400);
  });
}

/* ------------------------------------------------------------------ 启动 */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function boot() {
  if (!TerminalCtor || !FitCtor) {
    document.body.innerHTML = `<div style="padding:40px;font:14px sans-serif;color:#f87171">${escapeHtml(t('boot.xtermMissing'))}</div>`;
    return;
  }

  const cfg = await api.loadConfig();
  state.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  // 老配置里可能存成 C:/Work 这种写法，统一成反斜杠再参与显示与比较
  state.settings.startDir = normDirPath(state.settings.startDir) || null;
  state.settings.recentDirs = (Array.isArray(state.settings.recentDirs) ? state.settings.recentDirs : [])
    .map(normDirPath).filter(Boolean).slice(0, 8);
  // 语言要在建任何界面之前定下来，否则会先闪一屏中文
  let info = { ptyReady: true, electron: '-', locale: '' };
  try { info = { ...info, ...(await api.appInfo()) }; } catch { /* 老版本没有 app:info 就按默认来 */ }
  state.systemLocale = info.locale || '';
  applyLanguage(state.settings.language, state.systemLocale);
  state.homeDir = await api.homeDir();
  applyTheme();
  bindSettings();
  bindCwdDialog();
  bindSidebar();
  syncSettingsInputs();   // 让抽屉里的语言/字号等控件一开始就和配置一致

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', () => { applySidebar(); refitAll(); });
  // 关窗、切到后台、页面被隐藏时都把待写的布局立刻落盘，别丢最后一下拖动
  window.addEventListener('beforeunload', () => doPersist());
  window.addEventListener('pagehide', () => doPersist());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') doPersist();
  });
  window.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctx-menu')) closeCtxMenu();
  });
  window.addEventListener('blur', () => closeCtxMenu());

  api.onPtyData(({ id, data, sid }) => {
    const pane = paneMap.get(id);
    if (!pane) return;
    if (sid && pane.ptySid && sid !== pane.ptySid) return; // 上一个进程的残留输出
    pane.term.write(data);
  });

  api.onPtyExit(({ id, exitCode, sid }) => {
    const pane = paneMap.get(id);
    if (!pane) return;
    if (sid && pane.ptySid && sid !== pane.ptySid) return; // 重启前的旧进程退出通知
    if (pane.meta.suspended) return;  // 是我们主动停的，别把它变成「终端已退出」
    pane.running = false;
    pane.exited = true;
    pane.el.classList.add('exited');
    const text = pane.deadEl.querySelector('.dead-text');
    text.textContent = exitCode === 0 ? t('pane.exited') : t('pane.exitedCode', { code: exitCode });
    pane.term.write(`\r\n\x1b[38;5;244m${t('pane.deadLineCode', { code: exitCode })}\x1b[0m\r\n`);
  });

  const restore = state.settings.restoreSessions !== false && Array.isArray(cfg.groups) && cfg.groups.length;

  if (restore) {
    for (const g of cfg.groups) {
      const group = {
        id: g.id || uid(),
        name: g.name || t('group.auto', { n: state.groups.length + 1 }),
        autoNameKey: g.autoNameKey || null,
        autoNameNum: g.autoNameNum || null,
        pinned: !!g.pinned,
        panes: [],
        layout: { key: (g.layout && g.layout.key) || 'auto', custom: !!(g.layout && g.layout.custom) },
      };
      state.groups.push(group);
      const stage = document.createElement('div');
      stage.className = 'stage';
      stage.dataset.groupId = group.id;
      $('#stages').appendChild(stage);
      groupEls.set(group.id, { stage });
      renderSidebar();
      const seeds = (g.panes && g.panes.length ? g.panes : [{}]);
      // 恢复时先只还原结构，激活分组时再真正拉起 shell
      for (const seed of seeds) {
        addPane(group, {
          id: seed.id,
          bg: seed.bg,
          fg: seed.fg,
          cwd: seed.cwd,
          name: seed.name || (seed.custom ? null : seed.title),
          seq: seed.seq,
          title: seed.title,
          customTitle: !!seed.custom,
          suspended: !!seed.suspended,
          rect: seed.rect,
          lazy: true,
        });
      }
    }
    const targetId = cfg.settings && cfg.settings.activeGroupId;
    const first = state.groups.find((g) => g.id === targetId) || state.groups[0];
    // 恢复出来的分组名可能是别的语言，自动命名的按当前语言重写一遍
    renameAutoGroups();
    activateGroup(first.id);
  } else {
    state.groups = [];
    createGroup({ autoNameKey: 'group.default' });
  }

  $('#env-info').textContent = info.ptyReady ? `Electron ${info.electron}` : t('pane.ptyDead');
  if (!info.ptyReady) {
    toast(t('pane.ptyDeadNote'));
  }

  refitAll();
  focusActivePane();

  if (restore) {
    const paneCount = state.groups.reduce((n, g) => n + g.panes.length, 0);
    toast(t('boot.restored', { groups: state.groups.length, panes: paneCount }), 3200);
  }

  // 调试/自动化入口（仅本机可用）
  window.__ms = {
    state,
    paneMap,
    api,
    actions: {
      createGroup, addPane, activateGroup, removePane, closeGroup,
      setGroupPinned, copyAll, copyGroup, applyTheme, setFontSize, persist, fitPane,
      startRenamePane, setPaneTitle, openLook, closeLook, setPaneLook,
      applyLookToAll, resetAllPanesToWindow,
      openCwdDialog, closeCwdDialog, setPaneCwd, saveCwdDialog, paneCwd, restartPane,
      jumpDir, goParentDir, goToHistIndex, resetDirHistory, noteDirVisit, openPaneMenu,
      toggleSidebar, setSidebarCollapsed, setSidebarWidth, applySidebar,
      computeLayout, applyLayoutRects, applyLayoutTo, applyLayoutToAll, syncGroupRects,
      startPaneDrag, openLayoutMenu,
      jumpCommand, copyCommandOutput, shouldNotify, resetCmdState, fmtDur,
      stopPane, startPane, stopGroup, startGroup, groupRunState, openGroupMenu,
    },
    bufferText,
  };
}

boot();
