// 自检：点击标题栏 / 工具条 / 侧栏 / 菜单之后，键盘焦点必须落在这个终端的输入区
// 背景：浏览器 mousedown 的默认动作会把焦点交给 body → 窗口看着"激活"了却打不进字。
// 注意：必须用 CDP 的 Input.dispatchMouseEvent（真实输入事件），
//       dispatchEvent(new MouseEvent(...)) 是 untrusted 事件，浏览器不执行默认动作，测不出这个 bug。
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

// ------------------------------------------------------------ 真实鼠标/键盘
const press = async (x, y, clickCount = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
};
const release = async (x, y, clickCount = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
};
const click = async (x, y) => { await press(x, y, 1); await release(x, y, 1); await sleep(220); };
const dblclick = async (x, y) => {
  await press(x, y, 1); await release(x, y, 1);
  await press(x, y, 2); await release(x, y, 2);
  await sleep(260);
};
const moveTo = async (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });

const KEY = { ' ': { code: 'Space', vk: 32 }, '-': { code: 'Minus', vk: 189 }, '_': { code: 'Minus', vk: 189, shift: true } };
const keyOf = (ch) => {
  if (KEY[ch]) return KEY[ch];
  if (/[a-z]/i.test(ch)) return { code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) };
  if (/[0-9]/.test(ch)) return { code: `Digit${ch}`, vk: ch.charCodeAt(0) };
  return { code: 'Unidentified', vk: 0 };
};
const typeText = async (text) => {
  for (const ch of text) {
    const k = keyOf(ch);
    const mods = k.shift ? 8 : 0;
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: k.code,
      windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: mods,
    });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: mods });
  }
  await sleep(260);
};
const enter = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(300);
};
const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(260);
};

// 当前真实焦点落在哪个终端（null = 不在任何终端输入区）
const focusState = () => ev(`
  const ae = document.activeElement;
  const paneOf = (el) => (el && el.closest) ? el.closest('.pane') : null;
  const host = paneOf(ae);
  const visible = [...__ms.paneMap.values()].filter(p => p.el.classList.contains('focused')).map(p => p.id);
  return {
    tag: ae ? ae.tagName : null,
    cls: ae ? String(ae.className || '').slice(0, 32) : null,
    paneId: host ? host.dataset.paneId : null,
    focusedIds: visible,
    isXtermInput: !!(ae && ae.classList && ae.classList.contains('xterm-helper-textarea')),
  };
`);

// ---------------------------------------------------------------- 准备
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.paneBg = null; S.settings.paneFg = null;
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5';
  A.applyTheme();
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '焦点自检' });          // 自带一个终端
  A.addPane(g, {});                                        // 第二个终端
  const g2 = A.createGroup({ name: '旁组' });              // 另建一个分组备用
  g2.panes.forEach(p => { p.name = '旁组终端'; });
  A.activateGroup(g.id);
  await new Promise(r => setTimeout(r, 2600));             // 等两个 PowerShell 起来并把 prompt 画出来
  window.__g = g; window.__g2 = g2;
  window.__ps = [...__ms.paneMap.values()].filter(p => p.group.id === g.id);
  return window.__ps.length;
`);

const geo = () => ev(`
  const [a, b] = window.__ps;
  const pick = (p) => {
    const h = p.el.querySelector('.pane-head').getBoundingClientRect();
    const bd = p.el.querySelector('.pane-body').getBoundingClientRect();
    const grip = p.el.querySelector('.pane-grip.se').getBoundingClientRect();
    return {
      id: p.id,
      head: { x: h.left + h.width * 0.42, y: h.top + h.height / 2 },
      body: { x: bd.left + 24, y: bd.top + 24 },
      grip: { x: grip.left + grip.width / 2, y: grip.top + grip.height / 2 },
    };
  };
  return { a: pick(a), b: pick(b), layout: $('#btn-layout').getBoundingClientRect().toJSON() };
`);
let G = await geo();

// ------------------------------------------------ 1. 点正文 → 焦点在终端
await click(G.a.body.x, G.a.body.y);
let f = await focusState();
check('点终端正文，焦点落在该终端的 xterm 输入区',
  f.isXtermInput && f.paneId === G.a.id, f);

// ------------------------------------------- 2. 点标题栏 → 焦点跟过去
await click(G.b.head.x, G.b.head.y);
f = await focusState();
check('点另一个终端的标题栏，键盘焦点自动交给它（修复前是 body）',
  f.isXtermInput && f.paneId === G.b.id && f.focusedIds.length === 1, f);

await click(G.a.head.x, G.a.head.y);
f = await focusState();
check('再点回第一个终端的标题栏，焦点跟着回来',
  f.isXtermInput && f.paneId === G.a.id && f.focusedIds.length === 1, f);

// --------------------------------------- 3. 点完标题栏就能直接打字
await typeText('echo MAGIC_FOCUS_A');
await enter();
const typed = await ev(`
  const read = (p) => {
    const buf = p.term.buffer.active; let out = '';
    for (let i = 0; i < buf.length; i++) {
      const l = buf.getLine(i); if (l) out += l.translateToString(true) + '\\n';
    }
    return out;
  };
  return { a: read(window.__ps[0]), b: read(window.__ps[1]) };
`);
check('点完标题栏直接敲键盘，字符进了这个终端',
  typed.a.includes('MAGIC_FOCUS_A') && !typed.b.includes('MAGIC_FOCUS_A'), {
    inA: typed.a.includes('MAGIC_FOCUS_A'), inB: typed.b.includes('MAGIC_FOCUS_A'),
  });

// ------------------------------------ 4. 双击标题栏改名 → 焦点在输入框，回车还给终端
await dblclick(G.a.head.x, G.a.head.y);
f = await focusState();
check('双击标题栏进入改名，焦点落在改名输入框', f.cls === 'pane-title-input' || f.tag === 'INPUT', f);

await typeText('FOCUS_RENAMED');
await enter();
const renamed = await ev(`
  const p = window.__ps[0];
  return { title: p.meta.title, hasInput: !!p.el.querySelector('.pane-title-input') };
`);
f = await focusState();
check('改名回车后，焦点回到终端输入区（不是留在 body）',
  f.isXtermInput && f.paneId === G.a.id && !renamed.hasInput, { ...f, renamed });

// -------------------------------------------- 5. 拖标题栏移动后焦点不丢
await click(G.b.head.x, G.b.head.y);        // 先让 B 激活
G = await geo();
const before = await ev(`return { ...window.__ps[1].meta.rect };`);
await press(G.b.head.x, G.b.head.y, 1);
await moveTo(G.b.head.x - 30, G.b.head.y + 24);
await sleep(200);
await moveTo(G.b.head.x - 60, G.b.head.y + 40);
await sleep(200);
await release(G.b.head.x - 60, G.b.head.y + 40, 1);
await sleep(400);
const after = await ev(`return { ...window.__ps[1].meta.rect };`);
f = await focusState();
check('拖动标题栏移动窗口后，焦点仍在该终端',
  f.isXtermInput && f.paneId === G.b.id && (after.x !== before.x || after.y !== before.y),
  { moved: after, before, focusPane: f.paneId === G.b.id });

// ----------------------------------------- 6. 拖边框缩放后焦点也跟上来
G = await geo();
await click(G.a.head.x, G.a.head.y);
G = await geo();
const size0 = await ev(`return { ...window.__ps[0].meta.rect };`);
await press(G.a.grip.x, G.a.grip.y, 1);
await moveTo(G.a.grip.x - 40, G.a.grip.y - 30);
await sleep(200);
await release(G.a.grip.x - 40, G.a.grip.y - 30, 1);
await sleep(300);
const size1 = await ev(`return { ...window.__ps[0].meta.rect };`);
f = await focusState();
check('拖边框缩放后焦点在终端（缩放手柄自己吞了 mousedown）',
  f.isXtermInput && f.paneId === G.a.id && (size1.w !== size0.w || size1.h !== size0.h),
  { size0, size1, focusPane: f.paneId === G.a.id });

// --------------------------------- 7. 工具条/菜单点完，焦点回到终端
const menuItem = async (key) => ev(`
  const el = document.querySelector('#ctx-menu [data-key="' + ${JSON.stringify(key)} + '"]');
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
`);
await click(G.layout.left + G.layout.width / 2, G.layout.top + G.layout.height / 2);
const layoutMenuOpen = await ev(`return !$('#ctx-menu').hidden;`);
let it = await menuItem('layout.cols');
await click(it.x, it.y);
await sleep(300);
f = await focusState();
check('点工具栏布局菜单并选了布局，焦点回到终端',
  layoutMenuOpen && it.found && f.isXtermInput, { layoutMenuOpen, item: it.found, tag: f.tag, paneId: !!f.paneId });

// 「更多」按钮 → 菜单 → 一个不改焦点的动作
G = await geo();
const more = await ev(`
  const p = window.__ps[0];
  const r = p.el.querySelector('[data-act="more"]').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
`);
await click(more.x, more.y);
const moreOpen = await ev(`return !$('#ctx-menu').hidden;`);
it = await menuItem('menu.pane.copySel');
await click(it.x, it.y);
await sleep(300);
f = await focusState();
check('标题栏「更多」菜单里选一项后，焦点回到该终端',
  moreOpen && it.found && f.isXtermInput && f.paneId === G.a.id, { moreOpen, tag: f.tag, cls: f.cls });

// ------------------------------------- 8. 点侧栏另一个分组 → 该组终端接住焦点
const tab = await ev(`
  const items = [...document.querySelectorAll('.group-item')];
  const el = items.find(i => (i.textContent || '').includes('旁组'));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
`);
await click(tab.x, tab.y);
await sleep(400);
const otherFocus = await ev(`
  const ae = document.activeElement;
  const host = ae && ae.closest ? ae.closest('.pane') : null;
  const gid = host ? host.closest('.stage') && __ms.state.activeId : null;
  const p = host ? __ms.paneMap.get(host.dataset.paneId) : null;
  return { isXterm: !!(ae && ae.classList && ae.classList.contains('xterm-helper-textarea')),
           groupOk: !!(p && p.group.id === __ms.state.activeId),
           active: __ms.state.activeId, g2: window.__g2.id };
`);
check('点侧栏切换到另一个分组，焦点落在该分组的终端',
  otherFocus.isXterm && otherFocus.groupOk && otherFocus.active === otherFocus.g2, otherFocus);

// ------------------------ 9. 回到原分组；终端退出遮罩上的按钮点完焦点也在终端
await ev(`__ms.actions.activateGroup(window.__g.id); return true;`);
await sleep(500);
G = await geo();
const dead = await ev(`
  const p = window.__ps[0];
  p.exited = true; p.el.classList.add('exited');
  await new Promise(r => setTimeout(r, 200));
  const r = p.el.querySelector('[data-act="restart"]').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
`);
await click(dead.x, dead.y);
await sleep(1500);
f = await focusState();
const revived = await ev(`
  const p = window.__ps[0];
  return { exited: p.el.classList.contains('exited'), running: !!p.running };
`);
check('点「重新启动」之后焦点落在重启后的终端',
  f.isXtermInput && f.paneId === G.a.id, { ...f, revived });

// ---------------------------------------------------------------- 收尾
await ev(`
  const S = __ms.state, A = __ms.actions;
  for (const g of [...S.groups]) A.closeGroup(g.id);
  return true;
`);

check('过程中没有未捕获异常', errors.length === 0, errors.slice(0, 2));

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
