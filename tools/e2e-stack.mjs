// 自检：窗口重叠时的层叠顺序与命中测试
// 背景：xterm 内部有 z-index:1/2/5 的绝对定位元素，若 .pane-slot 不建立层叠上下文，
// 它们会逃到舞台层，压住相邻窗口的标题栏 → 点不到、拖不动、激活后"立即失活"。
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

// ---------------------------------------------------------------- 准备
// 三个终端，第三个故意横跨前两个的接缝，标题栏正好压在别人身上
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.paneBg = null; S.settings.paneFg = null;
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5';
  A.applyTheme();
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '层叠自检' });   // createGroup 自带一个终端
  A.addPane(g, { lazy: true }); A.addPane(g, { lazy: true });
  await new Promise(r => setTimeout(r, 900));
  const ps = [...__ms.paneMap.values()].filter(p => p.group.id === g.id);
  const rects = [
    { x: 0,    y: 0,    w: 0.5, h: 0.5 },
    { x: 0.5,  y: 0,    w: 0.5, h: 0.5 },
    { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  ];
  ps.forEach((p, i) => { p.meta.rect = rects[i]; });
  A.syncGroupRects(g);
  await new Promise(r => setTimeout(r, 400));
  window.__g = g;
  window.__ps = ps;
  return ps.length;
`);

// ------------------------------------------- 1. 槽位必须建立层叠上下文
const zs = await ev(`
  return window.__ps.map(p => ({ id: p.id.slice(0, 4), slotZ: getComputedStyle(p.slot).zIndex,
    headZ: getComputedStyle(p.el.querySelector('.pane-head')).zIndex,
    headPos: getComputedStyle(p.el.querySelector('.pane-head')).position }));
`);
check('每个定位槽都有显式 z-index（不建立上下文则 xterm 的正 z-index 会逃逸）',
  zs.every((z) => z.slotZ !== 'auto'), zs);
check('标题栏是 positioned 且叠在 xterm helpers(5) 之上',
  zs.every((z) => z.headPos !== 'static' && Number(z.headZ) > 5), zs);

// ---------------------------------------- 2. 第三个终端压住接缝时的命中
// 焦点先给第一个：此时第三个的标题栏右半段仍应可点（它排在第二个之后，同层时在上）
const seam = await ev(`
  const [a, b, c] = window.__ps;
  a.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  const head = c.el.querySelector('.pane-head');
  const hr = head.getBoundingClientRect();
  const x = hr.left + hr.width * 0.62, y = hr.top + hr.height / 2;  // 中段：避开左侧被遮挡区与右侧按钮
  const hit = document.elementFromPoint(x, y);
  return {
    cursor: getComputedStyle(head).cursor,
    hitSelf: !!(hit && hit.closest('.pane') === c.el),
    hitTag: hit ? hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className.split(' ')[0] : '') : null,
    z: window.__ps.map(p => getComputedStyle(p.slot).zIndex),
  };
`);
check('压在接缝上的终端，标题栏能命中自己（不再穿透到后面的终端）', seam.hitSelf, seam);
check('标题栏光标是可拖动的 grab（不是被覆盖后的默认箭头）', seam.cursor === 'grab', seam);

// ------------------------------------ 3. 点击后只有它被激活，且浮到最前
const clicked = await ev(`
  const [a, b, c] = window.__ps;
  const head = c.el.querySelector('.pane-head');
  const hr = head.getBoundingClientRect();
  const x = hr.left + hr.width * 0.62, y = hr.top + hr.height / 2;
  const hit = document.elementFromPoint(x, y);
  hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
  await new Promise(r => setTimeout(r, 200));
  return {
    focused: [...__ms.paneMap.values()].filter(p => p.el.classList.contains('focused')).map(p => p.id.slice(0, 4)),
    cFocused: c.el.classList.contains('focused'),
    aFocused: a.el.classList.contains('focused'),
    z: window.__ps.map(p => getComputedStyle(p.slot).zIndex),
    cSlotFocused: c.slot.classList.contains('focused'),
  };
`);
check('点击压缝终端后它获得焦点、原焦点终端失活（不再"立即失活"）',
  clicked.cFocused === true && clicked.aFocused === false && clicked.focused.length === 1, clicked);
check('激活的槽位浮到同组最前（z-index 抬升）',
  clicked.cSlotFocused === true && Number(clicked.z[2]) > Number(clicked.z[0]) && Number(clicked.z[2]) > Number(clicked.z[1]), clicked);

// --------------------------------------------- 4. 重叠区命中最上层那个
const overlap = await ev(`
  const [a, b, c] = window.__ps;
  const stage = a.slot.parentElement.getBoundingClientRect();
  // 三个窗的交集中心：此时 c 已激活置顶，应命中 c
  const x = stage.left + stage.width * 0.42;
  const y = stage.top + stage.height * 0.42;
  const hit = document.elementFromPoint(x, y);
  const inPane = hit && hit.closest('.pane');
  return { self: inPane === c.el, which: inPane === a.el ? 'a' : inPane === b.el ? 'b' : inPane === c.el ? 'c' : null };
`);
check('重叠区命中的是视觉上最上层的终端（所见即所点）', overlap.self === true && overlap.which === 'c', overlap);

// ------------------------------------------------ 5. 拖动真的能移动窗口
const drag = await ev(`
  const c = window.__ps[2];
  const head = c.el.querySelector('.pane-head');
  const hr = head.getBoundingClientRect();
  const sx = hr.left + hr.width * 0.62, sy = hr.top + 16;
  const r0 = { ...c.meta.rect };
  const hit = document.elementFromPoint(sx, sy);
  hit.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true, clientX: sx, clientY: sy }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx - 90, clientY: sy - 60 }));
  await new Promise(r => setTimeout(r, 260));   // 别用 rAF：窗口被遮挡时会被节流
  const midZ = getComputedStyle(c.slot).zIndex;
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx - 90, clientY: sy - 60 }));
  await new Promise(r => setTimeout(r, 400));
  return { r0, r1: { ...c.meta.rect }, midZ, afterZ: getComputedStyle(c.slot).zIndex };
`);
check('拖标题栏能移动窗口', drag.r1.x < drag.r0.x && drag.r1.y < drag.r0.y, drag);
check('拖动过程中窗口置于最前，松手后回落到激活层',
  Number(drag.midZ) === 3 && drag.afterZ !== '3', drag);

// ------------------------------------- 6. 已被遮挡的终端仍可从可见区切换
const switchBack = await ev(`
  const [a, b, c] = window.__ps;
  const ar = a.el.getBoundingClientRect();
  const x = ar.left + 20, y = ar.top + 60;   // 左上角，不与 c 重叠
  const hit = document.elementFromPoint(x, y);
  hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
  await new Promise(r => setTimeout(r, 200));
  return {
    hitSelf: !!(hit && hit.closest('.pane') === a.el),
    aFocused: a.el.classList.contains('focused'),
    cFocused: c.el.classList.contains('focused'),
    z: window.__ps.map(p => getComputedStyle(p.slot).zIndex),
  };
`);
check('点另一终端的可见区域能正常切换焦点，且它重新浮到最前',
  switchBack.hitSelf && switchBack.aFocused === true && switchBack.cFocused === false
  && Number(switchBack.z[0]) > Number(switchBack.z[2]), switchBack);

// ------------------------------------- 7. 退出态的覆盖层仍盖在终端之上
const dead = await ev(`
  const c = window.__ps[2];
  c.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));   // 先聚焦，排除被别的窗遮挡
  await new Promise(r => setTimeout(r, 120));
  c.exited = true;
  c.el.classList.add('exited');
  await new Promise(r => setTimeout(r, 150));
  const dr = c.deadEl.getBoundingClientRect();
  const hit = document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2);
  const res = { inDead: !!(hit && c.deadEl.contains(hit)), z: getComputedStyle(c.deadEl).zIndex };
  c.exited = false;
  c.el.classList.remove('exited');
  return res;
`);
check('终端退出后的遮罩层没被 xterm 盖住', dead.inDead, dead);

// ---------------------------------------------------------------- 收尾
await ev(`
  const A = __ms.actions, S = __ms.state;
  for (const g of [...S.groups]) A.closeGroup(g.id);
  return true;
`);

check('过程中没有未捕获异常', errors.length === 0, errors.slice(0, 2));

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
