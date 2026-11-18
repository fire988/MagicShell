// 交互自检：真实键盘输入 / 复制全部快捷键 / 右键菜单 / 每窗背景色
const port = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const page = (await res.json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const errors = [];
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
const key = async (opts) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...opts });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...opts });
};
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + JSON.stringify(detail) : ''}`);
};

// 确保处于深色默认主题与单组 4 窗
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5';
  A.applyTheme();
  const g = S.groups.find(x => x.id === S.activeId);
  A.fitPane(__ms.paneMap.get(g.panes[0].id));
  __ms.paneMap.get(g.panes[0].id).term.focus();
  await new Promise(r => setTimeout(r, 300));
  return true;
`);

// 1. 真实键盘输入（走 xterm 的 textarea）
await send('Input.insertText', { text: 'echo MAGIC-INPUT-OK' });
await key({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await sleep(1200);
let r = await ev(`
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const text = __ms.bufferText(pane.term);
  return { hasInput: text.includes('echo MAGIC-INPUT-OK'), hasOut: text.includes('MAGIC-INPUT-OK') && text.split('MAGIC-INPUT-OK').length > 2, tail: text.slice(-120) };
`);
check('键盘输入进入终端并执行', r.hasInput && r.hasOut, r);

// 2. Ctrl+Shift+A 复制全部（窗口级快捷键）
await ev(`await __ms.api.writeClipboard('__CLEARED__'); return true;`);
await key({ key: 'A', code: 'KeyA', modifiers: 10 }); // Ctrl(2)+Shift(8)
await sleep(500);
r = await ev(`
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const clip = await __ms.api.readClipboard();
  const text = __ms.bufferText(pane.term);
  return { clipLen: clip.length, same: clip === text, head: clip.slice(0, 60) };
`);
check('Ctrl+Shift+A = 复制全部', r.same && r.clipLen > 10, r);

// 3. 右键菜单（终端区域外 → 空面板区域）
r = await ev(`
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const head = pane.el.querySelector('.pane-head');
  const b = head.getBoundingClientRect();
  head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 40, clientY: b.top + 10 }));
  await new Promise(r => setTimeout(r, 200));
  const menu = document.querySelector('#ctx-menu');
  const keys = [...menu.querySelectorAll('.ctx-item')].map(e => e.dataset.key || '');
  return { visible: !menu.hidden, keys };
`);
check('右键菜单可用（含重命名/终端外观/复制全部/粘贴）',
  r.visible && ['menu.pane.rename', 'menu.pane.look', 'menu.pane.copyAll', 'menu.pane.paste'].every((k) => r.keys.includes(k)), r);

// 4. 单窗口背景色覆盖（走终端外观弹层）
r = await ev(`
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const other = __ms.paneMap.get(g.panes[1].id);
  const item = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(e => e.innerText.includes('终端外观'));
  item.click();
  await new Promise(r => setTimeout(r, 200));
  const open = !document.querySelector('#look').hidden;
  const presets = document.querySelectorAll('#look-presets .swatch-btn');
  presets[4].click();
  await new Promise(r => setTimeout(r, 300));
  const a = getComputedStyle(pane.el).backgroundColor;
  const b = getComputedStyle(other.el).backgroundColor;
  const ta = pane.term.options.theme.background;
  document.querySelector('#look-done').click();
  return { open, presets: presets.length, a, b, ta, differ: a !== b };
`);
check('单个终端可单独设置背景色', r.open && r.presets >= 5 && r.differ && r.ta !== '#0b0f14', r);

// 5. 关闭所有分组 → 空状态
r = await ev(`
  const A = __ms.actions, S = __ms.state;
  for (const g of [...S.groups]) A.closeGroup(g.id);
  await new Promise(r => setTimeout(r, 400));
  return {
    groups: S.groups.length,
    stages: document.querySelectorAll('.stage').length,
    emptyVisible: !document.querySelector('#empty-state').hidden,
    panes: document.querySelectorAll('.pane').length,
  };
`);
check('关闭全部分组后显示空状态', r.groups === 0 && r.stages === 0 && r.panes === 0 && r.emptyVisible, r);

// 6. 空状态新建分组
r = await ev(`
  document.querySelector('#btn-empty-new').click();
  await new Promise(r => setTimeout(r, 1500));
  const S = __ms.state;
  const g = S.groups[0];
  const pane = g ? __ms.paneMap.get(g.panes[0].id) : null;
  return { groups: S.groups.length, panes: g ? g.panes.length : 0, running: pane ? pane.running : false, cols: pane ? pane.term.cols : 0, emptyHidden: document.querySelector('#empty-state').hidden };
`);
check('空状态新建分组后终端正常启动', r.groups === 1 && r.panes === 1 && r.running && r.cols > 20 && r.emptyHidden, r);

// 7. 关闭最后一个终端 → 分组自动关闭
r = await ev(`
  const A = __ms.actions, S = __ms.state;
  const g = S.groups[0];
  A.removePane(g.panes[0].id);
  await new Promise(r => setTimeout(r, 500));
  return { groups: S.groups.length, emptyVisible: !document.querySelector('#empty-state').hidden };
`);
check('关闭最后一个终端 → 分组自动移除', r.groups === 0 && r.emptyVisible, r);

// 复位：重新建一个默认分组
await ev(`
  const A = __ms.actions;
  A.createGroup({ name: '默认分组' });
  await new Promise(r => setTimeout(r, 1200));
  A.persist();
  return true;
`);

console.log('--- runtime errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
ws.close();
if (failed.length) process.exitCode = 1;
