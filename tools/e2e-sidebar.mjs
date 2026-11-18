// 自检：左侧分组栏的收起/展开与宽度调节（拖动、双击复位、上下限、Ctrl+B、重载记忆）
const port = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const errors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (evt) => {
  const m = JSON.parse(evt.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + JSON.stringify(detail) : ''}`);
};

const snap = () => ev(`
  const S = __ms.state;
  const sb = document.querySelector('.sidebar');
  const wk = document.querySelector('.workspace');
  const p = [...__ms.paneMap.values()][0];
  return {
    settingW: S.settings.sidebarWidth,
    collapsed: !!S.settings.sidebarCollapsed,
    cls: document.body.classList.contains('sb-collapsed'),
    cssVar: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim(),
    sideW: Math.round(sb.getBoundingClientRect().width),
    workW: Math.round(wk.getBoundingClientRect().width),
    cols: p ? p.term.cols : null,
    btnTitle: document.querySelector('#btn-toggle-sidebar').title,
  };
`);

const handleX = async () => ev(`
  const r = document.querySelector('#sidebar-resizer').getBoundingClientRect();
  return Math.round(r.left + 3);
`);

// 真的按住手柄拖一把
const drag = async (toX) => {
  const fromX = await handleX();
  const y = 300;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round((fromX + toX) / 2), y, button: 'left', buttons: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: toX, y, button: 'left', buttons: 1 });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0 });
  await sleep(350);
};

const key = async (k, code, vk, mods) => {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(400);
};

// ---------------------------------------------------------------- 准备
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.sidebarWidth = 250;
  S.settings.sidebarCollapsed = false;
  A.applySidebar();
  A.persist(true);
  if (!S.groups.length) {
    const g = A.createGroup({ name: '侧栏自检' });
    A.addPane(g, { cwd: 'C:/Work/Projects/Dev' });
  }
  await new Promise(r => setTimeout(r, 2200));
  return true;
`);
await sleep(600);
const base = await snap();
check('默认宽度 250px，按钮显示「收起」',
  base.sideW === 250 && base.cssVar === '250px' && base.settingW === 250 && /收起/.test(base.btnTitle), base);

// ------------------------------------------------- 1. 拖宽 / 拖窄
await drag(330);
const wide = await snap();
check('拖动右侧手柄可以把侧栏拖宽（终端跟着重排）',
  wide.sideW === 330 && wide.settingW === 330 && wide.cssVar === '330px'
  && wide.workW < base.workW && wide.cols !== base.cols, { base, wide });

await drag(120);
const narrow = await snap();
check('拖到过窄会被下限拦住（180px）', narrow.sideW === 180 && narrow.settingW === 180, narrow);

await drag(900);
const cap = Math.min(460, Math.max(180 + 40, Math.round((await ev('return window.innerWidth;')) * 0.45)));
const wideMax = await snap();
check('拖到过宽会被上限拦住', wideMax.sideW === cap && wideMax.settingW === cap, { cap, wideMax });

// ------------------------------------------------- 2. 双击复位
const hx = await handleX();
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: 300, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: 300, button: 'left', clickCount: 1, buttons: 0 });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: 300, button: 'left', clickCount: 2, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: 300, button: 'left', clickCount: 2, buttons: 0 });
await sleep(300);
const reset = await snap();
check('双击手柄复位到 250px', reset.sideW === 250 && reset.settingW === 250, reset);

// ------------------------------------------------- 3. 收起 / 展开（按钮）
const beforeCollapse = await snap();
await ev(`
  document.querySelector('#btn-toggle-sidebar').click();
  await new Promise(r => setTimeout(r, 500));
  return true;
`);
const collapsed = await snap();
check('点按钮收起：宽度归零、工作区变宽、终端列数变大',
  collapsed.cls === true && collapsed.collapsed === true && collapsed.sideW === 0
  && collapsed.workW > beforeCollapse.workW && collapsed.cols > beforeCollapse.cols
  && /展开/.test(collapsed.btnTitle), { beforeCollapse, collapsed });

// 展开回来，宽度要回到收起前的值（不是 0）
await ev(`
  document.querySelector('#btn-toggle-sidebar').click();
  await new Promise(r => setTimeout(r, 500));
  return true;
`);
const expanded = await snap();
check('再点一次展开，宽度回到原来的值',
  expanded.cls === false && expanded.sideW === beforeCollapse.settingW
  && expanded.workW === beforeCollapse.workW && /收起/.test(expanded.btnTitle), expanded);

// ------------------------------------------------- 4. Ctrl+B 切换
await key('b', 'KeyB', 66, 2);
const byKey = await snap();
check('Ctrl+B 收起侧栏', byKey.cls === true && byKey.sideW === 0, byKey);
await key('b', 'KeyB', 66, 2);
const byKey2 = await snap();
check('再按 Ctrl+B 展开', byKey2.cls === false && byKey2.sideW > 0, byKey2);

// ------------------------------------------------- 5. 重载后记得宽度和收起状态
await ev(`
  __ms.actions.setSidebarWidth(312, { persist: true });
  await new Promise(r => setTimeout(r, 300));
  return true;
`);
await ev(`setTimeout(() => location.reload(), 60); return true;`);
await sleep(7000);
const afterReload = await snap();
check('重载后恢复宽度 312px 且仍是展开的',
  afterReload.sideW === 312 && afterReload.settingW === 312 && afterReload.cls === false, afterReload);

await ev(`
  __ms.actions.setSidebarCollapsed(true);
  await new Promise(r => setTimeout(r, 500));
  return true;
`);
await ev(`setTimeout(() => location.reload(), 60); return true;`);
await sleep(7000);
const afterReload2 = await snap();
check('重载后仍然保持收起状态',
  afterReload2.cls === true && afterReload2.sideW === 0 && afterReload2.settingW === 312, afterReload2);

// 还原成默认，别把测试状态留给别的用例
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.sidebarCollapsed = false;
  A.setSidebarWidth(250, { persist: true });
  A.applySidebar();
  A.persist(true);
  await new Promise(r => setTimeout(r, 400));
  return true;
`);

check('全程无未捕获异常', errors.length === 0, errors);

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
