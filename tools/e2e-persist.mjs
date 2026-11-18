// 自检：布局记忆（跨进程重启）
//   node tools/e2e-persist.mjs 9222 stamp    → 摆一套自定义布局并立刻落盘，把期望值写到 .tmp/expected-layout.json
//   node tools/e2e-persist.mjs 9222 verify   → 重启后比对内存状态 / DOM / 磁盘配置是否与期望一致
import fs from 'node:fs';
import path from 'node:path';

const port = process.argv[2] || '9222';
const mode = process.argv[3] || 'stamp';
const expectedFile = path.resolve('.tmp/expected-layout.json');

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const errors = [];
let id = 0;
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
const finish = () => {
  console.log('');
  const pass = results.filter((r) => r.ok).length;
  console.log(`${pass}/${results.length} 通过`);
  if (errors.length) console.log('页面异常：', errors.slice(0, 3));
  if (pass !== results.length) process.exitCode = 1;
  ws.close();
};

const snapshot = () => ev(`
  const S = __ms.state;
  return {
    activeId: S.activeId,
    groups: S.groups.map((g) => ({
      name: g.name,
      layout: { key: g.layout.key, custom: !!g.layout.custom },
      rects: g.panes.map((m) => m.rect),
      dom: g.panes.map((m) => {
        const p = __ms.paneMap.get(m.id);
        return p && p.slot ? [p.slot.style.left, p.slot.style.top, p.slot.style.width, p.slot.style.height] : null;
      }),
    })),
  };
`);

if (mode === 'stamp') {
  // 摆一套"手动拖过"的布局：3 个终端 + 拖动 + 缩放
  await ev(`
    const A = __ms.actions, S = __ms.state;
    S.settings.paneBg = null; S.settings.paneFg = null;
    for (const g of [...S.groups]) A.closeGroup(g.id);
    const g = A.createGroup({ name: '布局记忆自检' });
    A.addPane(g); A.addPane(g); A.addPane(g);
    await new Promise(r => setTimeout(r, 1800));

    const panes = g.panes.map(m => __ms.paneMap.get(m.id));
    const head = panes[1].el.querySelector('.pane-head');
    const b = head.getBoundingClientRect();
    const sx = b.left + 90, sy = b.top + 16;
    head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: sx, clientY: sy, pointerId: 41 }));
    for (let i = 1; i <= 4; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx - 70, clientY: sy + 60, pointerId: 41 }));
      await new Promise(r => requestAnimationFrame(() => r()));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx - 70, clientY: sy + 60, pointerId: 41 }));
    await new Promise(r => setTimeout(r, 400));

    const grip = panes[2].el.querySelector('.pane-grip.se');
    const gb = grip.getBoundingClientRect();
    const gx = gb.left + 4, gy = gb.top + 4;
    grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: gx, clientY: gy, pointerId: 42 }));
    for (let i = 1; i <= 4; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: gx - 80, clientY: gy - 70, pointerId: 42 }));
      await new Promise(r => requestAnimationFrame(() => r()));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: gx - 80, clientY: gy - 70, pointerId: 42 }));
    await new Promise(r => setTimeout(r, 500));
    A.persist(true);
    await new Promise(r => setTimeout(r, 600));
    return true;
  `);

  const snap = await snapshot();
  fs.mkdirSync(path.dirname(expectedFile), { recursive: true });
  fs.writeFileSync(expectedFile, JSON.stringify(snap, null, 2), 'utf8');
  const disk = await ev('return JSON.stringify(await __ms.api.loadConfig());');
  const cfg = JSON.parse(disk);
  check('拖动/缩放后的位置已写入内存布局', snap.groups[0].layout.custom === true);
  check('配置里每个终端都带 rect', (cfg.groups || []).every((g) => g.panes.every((p) => p.rect && typeof p.rect.w === 'number')));
  check('配置里记录了布局类型', !!(cfg.groups && cfg.groups[0].layout));
  console.log('期望值已写入', expectedFile);
  finish();
} else {
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  const snap = await snapshot();
  const cfg = JSON.parse(await ev('return JSON.stringify(await __ms.api.loadConfig());'));

  check('重启后分组数量一致', snap.groups.length === expected.groups.length,
    { now: snap.groups.length, want: expected.groups.length });
  check('重启后分组名一致', snap.groups[0].name === expected.groups[0].name,
    { now: snap.groups[0].name, want: expected.groups[0].name });
  check('重启后仍是自定义布局', snap.groups[0].layout.custom === expected.groups[0].layout.custom,
    snap.groups[0].layout);

  const near = (a, b) => Math.abs(a - b) < 0.004;
  const rectsOk = snap.groups[0].rects.length === expected.groups[0].rects.length
    && snap.groups[0].rects.every((r, i) => {
      const e = expected.groups[0].rects[i];
      return e && near(r.x, e.x) && near(r.y, e.y) && near(r.w, e.w) && near(r.h, e.h);
    });
  check('重启后每个终端的位置/大小与关闭前一致', rectsOk,
    { now: snap.groups[0].rects, want: expected.groups[0].rects });

  const pct = (v) => `${+(v * 100).toFixed(3)}%`;
  const domOk = snap.groups[0].dom.every((d, i) => {
    const r = snap.groups[0].rects[i];
    return d && d[0] === pct(r.x) && d[1] === pct(r.y) && d[2] === pct(r.w) && d[3] === pct(r.h);
  });
  check('DOM 上的定位百分比与 rect 对应（真的画在记忆的位置）', domOk, snap.groups[0].dom);

  check('磁盘配置仍是自定义布局', !!cfg.groups && !!cfg.groups[0].layout && cfg.groups[0].layout.custom === true, cfg.groups && cfg.groups[0].layout);
  check('磁盘配置里读回的 rect 与内存一致', (cfg.groups[0].panes || []).every((p, i) => {
    const r = snap.groups[0].rects[i];
    return p.rect && near(p.rect.x, r.x) && near(p.rect.y, r.y) && near(p.rect.w, r.w) && near(p.rect.h, r.h);
  }));

  const win = cfg.window || {};
  check('窗口尺寸也记住了（含最大化标记）',
    typeof win.width === 'number' && typeof win.height === 'number' && 'maximized' in win, win);

  const activeOk = !!snap.activeId && snap.activeId === expected.activeId;
  check('重启后回到上次激活的分组', activeOk, { now: snap.activeId, want: expected.activeId });

  finish();
}
