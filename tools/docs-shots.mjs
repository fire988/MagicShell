// 生成文档用截图
import { writeFileSync, mkdirSync } from 'node:fs';
const port = process.argv[2] || '9222';
const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const page = (await res.json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
mkdirSync('docs', { recursive: true });

// 文档截图固定中文：否则上次跑用例留下的 en-US 会让整套截图变成英文
await ev(`
  const sel = document.getElementById('input-language');
  if (sel && sel.value !== 'zh-CN') {
    sel.value = 'zh-CN';
    sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
  }
  return true;
`);

const shot = async (file) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(s.data, 'base64'));
  console.log('saved', file);
};

// 深色窗口：三个终端，各自有标题和底色
await ev(`
  const A = __ms.actions, S = __ms.state;
  // 先关掉可能残留的菜单，避免截图里多出一个下拉
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5'; S.settings.paneBg = null; S.settings.paneFg = null;
  A.applyTheme();
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g1 = A.createGroup({ name: '日常运维' });
  A.addPane(g1, { lazy: false });
  A.addPane(g1, { lazy: false });
  await new Promise(r => setTimeout(r, 2800));
  const ps = g1.panes.map((m) => __ms.paneMap.get(m.id));
  A.setPaneTitle(ps[0], '构建日志');
  A.setPaneTitle(ps[1], '数据库备份');
  A.setPaneTitle(ps[2], '线上排障');
  A.setPaneLook(ps[1], { bg: '#0b1a2b' });
  A.setPaneLook(ps[2], { bg: '#f7f4ec' });
  for (const p of ps) A.fitPane(p);
  await new Promise(r => setTimeout(r, 500));
  __ms.api.writePty(ps[0].id, 'cls; Get-Date -Format "yyyy-MM-dd HH:mm"; $PSVersionTable.PSVersion\\r');
  __ms.api.writePty(ps[1].id, 'cls; Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name,CPU\\r');
  __ms.api.writePty(ps[2].id, 'cls; Get-ChildItem C:\\\\Work\\\\Projects\\\\Dev | Select-Object -First 4 Mode,Name\\r');
  const g2 = A.createGroup({ name: '构建 & 部署' });
  A.addPane(g2, { lazy: true });
  A.addPane(g2, { lazy: true });
  A.activateGroup(g1.id);
  A.applyLayoutTo(g1, 'main-left');
  A.persist();
  await new Promise(r => setTimeout(r, 2200));
  return true;
`);
await shot('docs/screenshot-dark.png');

// 自动排列下拉
await ev(`
  document.querySelector('#btn-layout').click();
  await new Promise(r => setTimeout(r, 400));
  return true;
`);
await shot('docs/screenshot-layout.png');
await ev(`
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  return true;
`);

// 终端外观弹层
await ev(`
  const g = __ms.state.groups.find((x) => x.id === __ms.state.activeId);
  __ms.actions.openLook(__ms.paneMap.get(g.panes[2].id));
  await new Promise(r => setTimeout(r, 500));
  return true;
`);
await shot('docs/screenshot-look.png');
await ev(`__ms.actions.closeLook(); await new Promise(r => setTimeout(r, 300)); return true;`);

// 启动目录弹层
await ev(`
  const A = __ms.actions, S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  S.settings.startDir = 'C:\\\\Work\\\\Projects\\\\Dev';
  S.settings.recentDirs = ['C:\\\\Work\\\\Projects\\\\Dev\\\\MagicShell', 'C:\\\\Users\\\\firew\\\\Documents'];
  const p = __ms.paneMap.get(g.panes[0].id);
  A.setPaneCwd(p, 'C:\\\\Work\\\\Projects\\\\Dev\\\\MagicShell');
  A.openCwdDialog(p);
  await new Promise(r => setTimeout(r, 900));
  return true;
`);
await shot('docs/screenshot-cwd.png');
await ev(`__ms.actions.closeCwdDialog(); await new Promise(r => setTimeout(r, 300)); return true;`);

// 目录历史：一个终端里连着 cd 几次，再从菜单里逐级回退
await ev(`
  const A = __ms.actions, S = __ms.state;
  window.__prevGroup = S.activeId;
  const g = A.createGroup({ name: '目录历史' });
  const p = A.addPane(g, { cwd: 'C:\\\\Work\\\\Projects\\\\Dev' });
  await new Promise(r => setTimeout(r, 2200));
  const CR = String.fromCharCode(13), ETX = String.fromCharCode(3);
  for (const d of ['C:/Work/Projects/Dev/MagicShell', 'C:/Work/Projects/Dev/MagicShell/src', 'C:/Work/Projects/Dev/MagicShell/src/renderer']) {
    __ms.api.writePty(p.id, ETX);
    await new Promise(r => setTimeout(r, 140));
    __ms.api.writePty(p.id, 'cd "' + d + '"' + CR);
    await new Promise(r => setTimeout(r, 900));
  }
  __ms.api.writePty(p.id, 'cls' + CR);
  await new Promise(r => setTimeout(r, 2200));
  A.openPaneMenu(p, 380, 132);
  await new Promise(r => setTimeout(r, 400));
  window.__histGroup = g.id;
  return true;
`);
await shot('docs/screenshot-history.png');
await ev(`
  const A = __ms.actions;
  document.querySelector('#ctx-menu').hidden = true;
  A.closeGroup(window.__histGroup);
  A.activateGroup(window.__prevGroup);
  await new Promise(r => setTimeout(r, 700));
  return true;
`);

// 浅色窗口：同一布局，终端保持自己的底色
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.bg = '#f7f4ec'; S.settings.fg = '#2b2a26';
  A.applyTheme(); A.persist();
  await new Promise(r => setTimeout(r, 900));
  return true;
`);
await shot('docs/screenshot-light.png');

// 设置抽屉
await ev(`document.querySelector('#btn-settings').click(); await new Promise(r=>setTimeout(r,500)); return true;`);
await shot('docs/screenshot-settings.png');

// 复位为深色并关闭抽屉
await ev(`
  const A = __ms.actions, S = __ms.state;
  document.querySelector('#drawer-mask').click();
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5';
  A.applyTheme(); A.persist();
  await new Promise(r=>setTimeout(r,600));
  return true;
`);
// 侧边栏收起后的样子（工作区占满）
await ev(`
  const A = __ms.actions;
  A.setSidebarCollapsed(true);
  await new Promise(r => setTimeout(r, 800));
  return true;
`);
await shot('docs/screenshot-sidebar.png');

// 命令块：真敲两条命令（一个失败标红、一个慢命令标耗时），徽标才出得来。
// term.input() 不会触发 onData，必须用 CDP 的真实键盘事件。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const typeLine = async (text) => {
  await send('Input.insertText', { text });
  await sleep(80);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(700);
};
await send('Page.bringToFront');
await sleep(400);
await ev(`
  __ms.actions.setSidebarCollapsed(false);
  await new Promise((r) => setTimeout(r, 700));
  const S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  __ms.paneMap.get(g.panes[0].id).term.focus();
  return document.hasFocus();
`);
await typeLine('Get-Item C:\\__magicshell_no_such_dir__');
await ev(`
  const S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  __ms.paneMap.get(g.panes[1].id).term.focus();
  return true;
`);
await typeLine('Start-Sleep -Milliseconds 900');
await sleep(600);
await shot('docs/screenshot-cmd.png');

// 停止 / 启动：停掉右边那个（屏幕上还留着刚才的输出与「已停止」横幅），
// 左边继续跑，侧栏的分组徽标变 2/3、电源按钮变 ▶
await ev(`
  const A = __ms.actions, S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  A.stopPane(__ms.paneMap.get(g.panes[1].id));
  await new Promise((r) => setTimeout(r, 1000));
  return true;
`);
await shot('docs/screenshot-pause.png');
await ev(`
  const A = __ms.actions, S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  A.startPane(__ms.paneMap.get(g.panes[1].id));
  await new Promise((r) => setTimeout(r, 2800));
  return true;
`);

// 启动脚本弹层：左边那个终端带一段"切目录 + 设环境变量"的脚本
await ev(`
  const A = __ms.actions, S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  const p = __ms.paneMap.get(g.panes[0].id);
  p.meta.script = [
    '# 每次开这个终端：切到项目、把环境摆好',
    'Set-Location C:\\\\Work\\\\Projects\\\\Dev\\\\MagicShell',
    "$env:NODE_ENV = 'development'",
    "$env:MS_PROFILE = 'magicshell'",
    "Write-Host \\"MagicShell dev shell ready\\" -ForegroundColor DarkGray",
  ].join('\\n');
  A.syncScriptButton(p);
  A.openScriptDialog(p);
  document.getElementById('script-input').value = p.meta.script;
  document.getElementById('script-input').dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 700));
  return true;
`);
await shot('docs/screenshot-script.png');
await ev(`
  const S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  const p = __ms.paneMap.get(g.panes[0].id);
  p.meta.script = '';
  __ms.actions.syncScriptButton(p);
  __ms.actions.closeScriptDialog();
  await new Promise((r) => setTimeout(r, 300));
  return true;
`);

// 英文界面：切语言立刻生效、不重启；顺手开个右键菜单看菜单项也跟着变
await ev(`
  const sel = document.getElementById('input-language');
  sel.value = 'en-US';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 2800)); // 等「Language switched to English」提示自己消失，截图更干净
  const A = __ms.actions, S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  A.openPaneMenu(__ms.paneMap.get(g.panes[0].id), 372, 120);
  await new Promise(r => setTimeout(r, 400));
  return true;
`);
await shot('docs/screenshot-i18n.png');

// 复位：中文 + 侧栏展开
await ev(`
  const menu = document.querySelector('#ctx-menu');
  if (menu) menu.hidden = true;
  const sel = document.getElementById('input-language');
  sel.value = 'zh-CN';
  sel.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 600));
  __ms.actions.setSidebarCollapsed(false);
  await new Promise(r => setTimeout(r, 700));
  return true;
`);
ws.close();
