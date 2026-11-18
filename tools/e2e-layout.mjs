// 自检：自动排列预设 + 拖动移动 / 拖边框缩放 + 菜单内连续换色
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
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5'; S.settings.paneBg = null; S.settings.paneFg = null;
  A.applyTheme();
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '布局自检' });
  A.addPane(g); A.addPane(g); A.addPane(g);
  await new Promise(r => setTimeout(r, 1600));
  window.__g = g;
  return true;
`);

// ------------------------------------------------- 1. 排列预设（4 窗）
const layouts = ['auto', 'cols', 'rows', 'grid2', 'grid3', 'main-left', 'main-top'];
let bad = [];
for (const key of layouts) {
  const r = await ev(`
    const A = __ms.actions, S = __ms.state, g = window.__g;
    A.applyLayoutTo(g, '${key}');
    await new Promise(r => setTimeout(r, 120));
    const stage = document.querySelector('.stage.active').getBoundingClientRect();
    const rects = [...__ms.paneMap.values()].map(p => p.meta.rect);
    const px = [...__ms.paneMap.values()].map(p => p.el.getBoundingClientRect());
    const inside = px.every(b => b.left >= stage.left - 1 && b.right <= stage.right + 1 && b.top >= stage.top - 1 && b.bottom <= stage.bottom + 1);
    const overlap = px.some((a, i) => px.some((b, j) => i < j && a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2));
    const cover = rects.reduce((s, r) => s + r.w * r.h, 0);
    return { key: '${key}', n: rects.length, inside, overlap, cover: +cover.toFixed(2), layout: g.layout };
  `);
  if (!(r.inside && !r.overlap && r.n === 4 && Math.abs(r.cover - 1) < 0.01)) bad.push(r);
}
check('7 种排列预设：全部落在舞台内、互不重叠、铺满', bad.length === 0, bad);

// ------------------------------------------------- 2. 拖动标题栏移动
const drag = await ev(`
  const g = window.__g, A = __ms.actions;
  A.applyLayoutTo(g, 'grid2');
  await new Promise(r => setTimeout(r, 200));
  const p = [...__ms.paneMap.values()][0];
  const before = { ...p.meta.rect };
  const head = p.el.querySelector('.pane-head');
  const b = head.getBoundingClientRect();
  const sx = b.left + 50, sy = b.top + 16;
  head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: sx, clientY: sy, pointerId: 11 }));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx + i * 30, clientY: sy + i * 18, pointerId: 11 }));
    await new Promise(r => requestAnimationFrame(() => r()));
  }
  const during = { dragging: document.querySelector('.stage.active').classList.contains('dragging'), cursor: document.body.style.cursor };
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx + 180, clientY: sy + 108, pointerId: 11 }));
  await new Promise(r => setTimeout(r, 250));
  return { before, after: p.meta.rect, during, custom: g.layout.custom };
`);
check('拖标题栏可移动（位置改变、进入自定义布局）',
  drag.after.x > drag.before.x + 0.05 && drag.after.y > drag.before.y + 0.03 && drag.custom
  && drag.during.dragging && drag.during.cursor === 'grabbing', drag);

// ------------------------------------------------- 3. 拖出边界被夹住
const clampTest = await ev(`
  const p = [...__ms.paneMap.values()][0];
  const head = p.el.querySelector('.pane-head');
  const b = head.getBoundingClientRect();
  const sx = b.left + 40, sy = b.top + 16;
  head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: sx, clientY: sy, pointerId: 12 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx + 4000, clientY: sy + 4000, pointerId: 12 }));
  await new Promise(r => requestAnimationFrame(() => r()));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx + 4000, clientY: sy + 4000, pointerId: 12 }));
  await new Promise(r => setTimeout(r, 150));
  return p.meta.rect;
`);
check('拖出舞台会被夹在边界内',
  clampTest.x + clampTest.w <= 1.001 && clampTest.y + clampTest.h <= 1.001, clampTest);

// ------------------------------------------------- 4. 拖边框缩放
const resize = await ev(`
  const p = [...__ms.paneMap.values()][1];
  const before = { ...p.meta.rect };
  const grip = p.el.querySelector('.pane-grip.se');
  const b = grip.getBoundingClientRect();
  const sx = b.left + 4, sy = b.top + 4;
  grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: sx, clientY: sy, pointerId: 13 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx - 130, clientY: sy - 90, pointerId: 13 }));
  await new Promise(r => requestAnimationFrame(() => r()));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx - 130, clientY: sy - 90, pointerId: 13 }));
  await new Promise(r => setTimeout(r, 200));
  const termBox = p.term && p.term.element ? p.term.element.querySelector('.xterm-screen').getBoundingClientRect() : null;
  return { before, after: p.meta.rect, termW: termBox ? Math.round(termBox.width) : 0, cols: p.term.cols };
`);
check('拖右下角可缩放（宽高都变小，终端同步重排）',
  resize.after.w < resize.before.w - 0.03 && resize.after.h < resize.before.h - 0.03 && resize.cols > 0, resize);

// ------------------------------------------------- 5. 最小尺寸保护
const minSize = await ev(`
  const p = [...__ms.paneMap.values()][2];
  const grip = p.el.querySelector('.pane-grip.e');
  const b = grip.getBoundingClientRect();
  const sx = b.left + 2, sy = b.top + 30;
  grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: sx, clientY: sy, pointerId: 14 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx - 3000, clientY: sy, pointerId: 14 }));
  await new Promise(r => requestAnimationFrame(() => r()));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx - 3000, clientY: sy, pointerId: 14 }));
  await new Promise(r => setTimeout(r, 200));
  return { rect: p.meta.rect, px: Math.round(p.el.getBoundingClientRect().width) };
`);
check('缩到最小宽度会被挡住（不会压成一条线）', minSize.px >= 140, minSize);

// ------------------------------------------------- 6. 自定义布局下新增终端
const addTest = await ev(`
  const g = window.__g, A = __ms.actions;
  const before = [...__ms.paneMap.values()].map(p => ({ id: p.id, rect: { ...p.meta.rect } }));
  const np = A.addPane(g);
  await new Promise(r => setTimeout(r, 700));
  const after = [...__ms.paneMap.values()].map(p => ({ id: p.id, rect: { ...p.meta.rect } }));
  const untouched = before.filter(b => b.id !== before[0].id && b.id !== before[1].id)
    .every(b => { const a = after.find(x => x.id === b.id); return a && Math.abs(a.rect.x - b.rect.x) < 0.001 && Math.abs(a.rect.w - b.rect.w) < 0.001; });
  return { count: after.length, untouched, newRect: np.meta.rect, custom: g.layout.custom };
`);
check('自定义布局下新开终端：劈开最大窗、其余窗口位置不变',
  addTest.count === 5 && addTest.untouched && addTest.newRect.w > 0.02, addTest);

// ------------------------------------------------- 7. 菜单里连续换色不关菜单
const swatch = await ev(`
  const A = __ms.actions, g = window.__g;
  A.applyLayoutTo(g, 'cols');
  await new Promise(r => setTimeout(r, 200));
  const p = [...__ms.paneMap.values()][0];
  p.el.querySelector('[data-act="more"]').click();
  await new Promise(r => setTimeout(r, 200));
  const menu = document.querySelector('#ctx-menu');
  const hit = (el) => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.click(); };
  const sw = [...menu.querySelectorAll('.ctx-swatch')];
  hit(sw[2]);
  await new Promise(r => setTimeout(r, 150));
  const a = { open: !menu.hidden, bg: getComputedStyle(p.el).backgroundColor, ring: sw.findIndex(b => b.classList.contains('on')) };
  hit(sw[5]);
  await new Promise(r => setTimeout(r, 150));
  const b = { open: !menu.hidden, bg: getComputedStyle(p.el).backgroundColor, ring: sw.findIndex(x => x.classList.contains('on')) };
  return { count: sw.length, a, b };
`);
check('菜单里点背景色不关闭菜单，可以连续换色',
  swatch.count >= 8 && swatch.a.open && swatch.b.open
  && swatch.a.ring === 2 && swatch.b.ring === 5 && swatch.a.bg !== swatch.b.bg, swatch);

// ------------------------------------------------- 8. 两种入口都能打开排列菜单
const entries = await ev(`
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  document.querySelector('#btn-layout').click();
  await new Promise(r => setTimeout(r, 200));
  const menu = document.querySelector('#ctx-menu');
  const rows = [...menu.querySelectorAll('.ctx-layout .lay-name')].map(e => e.textContent);
  const active = menu.querySelector('.ctx-layout.on .lay-name');
  const thumbs = menu.querySelectorAll('.ctx-layout .lay-thumb svg').length;
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  return { open: !menu.hidden || rows.length > 0, rows, active: active && active.textContent, thumbs };
`);
check('工具栏「排列」下拉：7 个预设 + 图标 + 当前项标记',
  entries.rows.length === 7 && entries.thumbs === 7 && entries.active === '左右并排', entries);

// ------------------------------------------------- 9. 点击预设立即生效
const applyViaMenu = await ev(`
  const g = window.__g;
  document.querySelector('#btn-layout').click();
  await new Promise(r => setTimeout(r, 150));
  const rows = [...document.querySelectorAll('#ctx-menu .ctx-layout')];
  rows.find(r => r.dataset.key === 'layout.grid2').click();
  await new Promise(r => setTimeout(r, 300));
  return { key: g.layout.key, custom: g.layout.custom, n: [...__ms.paneMap.values()].filter(p => Math.abs(p.meta.rect.w - 0.5) < 0.02).length };
`);
check('点下拉里的预设立即重排并清掉自定义标记',
  applyViaMenu.key === 'grid2' && applyViaMenu.custom === false && applyViaMenu.n >= 4, applyViaMenu);

// ------------------------------------------------- 10. 重载后位置与布局都在
const persisted = await ev(`
  const g = window.__g;
  const p = [...__ms.paneMap.values()][0];
  const before = { rect: { ...p.meta.rect }, key: g.layout.key, gid: g.id };
  __ms.actions.persist();
  await new Promise(r => setTimeout(r, 600));
  const cfg = await __ms.api.loadConfig();
  const saved = cfg.groups.find(x => x.id === before.gid);
  return { before, savedLayout: saved.layout, savedRect: saved.panes[0].rect, paneCount: saved.panes.length };
`);
check('布局与位置写入配置（重启可还原）',
  persisted.savedLayout && persisted.savedLayout.key === 'grid2'
  && persisted.savedRect && Math.abs(persisted.savedRect.w - 0.5) < 0.02, persisted);

console.log('');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
if (errors.length) console.log('页面异常：', errors.slice(0, 3));
ws.close();
if (pass !== results.length) process.exitCode = 1;
