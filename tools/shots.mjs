// 生成若干界面截图用于人工验收
import { writeFileSync, mkdirSync } from 'node:fs';
const port = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('.tmp', { recursive: true });

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
await send('Runtime.enable');

const ev = (expr) => send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true });
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`.tmp/${name}.png`, Buffer.from(s.data, 'base64'));
  console.log('saved', name);
};

// 1) 深色 + 设置抽屉
await ev(`document.querySelector('#btn-settings').click(); await new Promise(r=>setTimeout(r,400));`);
await shot('ui-drawer-dark');

// 2) 浅色主题（暖白）
await ev(`
  const A = __ms.actions, S = __ms.state;
  document.querySelector('#drawer-mask').click();
  S.settings.bg = '#f7f4ec'; S.settings.fg = '#2b2a26';
  A.applyTheme(); A.persist();
  await new Promise(r=>setTimeout(r,500));
`);
await shot('ui-light');

// 3) 浅色 + 抽屉
await ev(`document.querySelector('#btn-settings').click(); await new Promise(r=>setTimeout(r,400));`);
await shot('ui-drawer-light');

// 4) 恢复深色，并在组内放 4 个终端看网格
await ev(`
  const A = __ms.actions, S = __ms.state;
  document.querySelector('#drawer-mask').click();
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5';
  A.applyTheme();
  const g = S.groups.find(x => x.id === S.activeId);
  while (g.panes.length < 4) A.addPane(g);
  await new Promise(r=>setTimeout(r,1500));
  A.persist();
`);
await shot('ui-grid4');

// 5) 分组置顶状态
await ev(`
  const A = __ms.actions, S = __ms.state;
  const g = S.groups.find(x => x.id === S.activeId);
  A.setGroupPinned(g.id, true);
  await new Promise(r=>setTimeout(r,400));
`);
await shot('ui-pinned');

// 复位：取消置顶
await ev(`
  const A = __ms.actions, S = __ms.state;
  A.setGroupPinned(S.activeId, false);
`);
ws.close();
