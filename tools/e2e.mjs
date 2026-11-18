// 端到端自检：通过 CDP 驱动渲染进程，验证分组/复制全部/置顶/背景色
// 用法: node tools/e2e.mjs [port]
const port = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

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
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
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
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + JSON.stringify(detail) : ''}`);
  };

  // 1. 单组多终端：并排平铺
  let r = await ev(`
    const A = __ms.actions, S = __ms.state;
    // 清空到只剩一个分组、一个终端
    while (S.groups.length > 1) A.closeGroup(S.groups[S.groups.length - 1].id);
    let g = S.groups[0];
    while (g.panes.length > 1) A.removePane(g.panes[g.panes.length - 1].id, { silent: true });
    // 清掉历史的自定义配色/布局，保证从干净状态开始
    S.settings.paneBg = null; S.settings.paneFg = null;
    for (const p of __ms.paneMap.values()) A.setPaneLook(p, { bg: null, fg: null }, { silent: true });
    A.addPane(g); A.addPane(g);
    A.applyLayoutTo(g, 'auto');
    await new Promise(r => setTimeout(r, 1200));
    const stage = document.querySelector('.stage.active');
    const sBox = stage.getBoundingClientRect();
    const panes = [...stage.querySelectorAll('.pane')];
    const boxes = panes.map(p => p.getBoundingClientRect());
    return {
      count: panes.length,
      layout: g.layout.key,
      inside: boxes.every(b => b.left >= sBox.left - 1 && b.right <= sBox.right + 1 && b.top >= sBox.top - 1 && b.bottom <= sBox.bottom + 1),
      firstWider: boxes[0].width > boxes[1].width + 20,
      visible: panes.filter(p => p.getBoundingClientRect().width > 100).length,
      bodies: panes.map(p => p.querySelector('.pane-body').clientHeight),
      titles: panes.map(p => p.querySelector('.pane-title').textContent),
      rows: [...__ms.paneMap.values()].map(v => v.term.rows),
      running: [...__ms.paneMap.values()].map(v => v.running),
    };
  `);
  check('组内 3 个终端平铺显示（左大右侧两叠）', r.count === 3 && r.layout === 'auto' && r.inside && r.firstWider && r.visible === 3, r);
  check('3 个终端都已启动 PTY', r.running.every(Boolean) && r.rows.every((n) => n > 3), { rows: r.rows, running: r.running });

  // 2. 第二个分组：切换后只显示该组全部终端
  r = await ev(`
    const A = __ms.actions, S = __ms.state;
    const g2 = A.createGroup({ name: '部署组' });
    A.addPane(g2);
    await new Promise(r => setTimeout(r, 900));
    const active = [...document.querySelectorAll('.stage')].filter(s => s.classList.contains('active'));
    const stages = [...document.querySelectorAll('.stage')];
    return {
      activeId: S.activeId === g2.id,
      activeStages: active.length,
      totalStages: stages.length,
      hiddenOther: stages.filter(s => !s.classList.contains('active')).every(s => s.getBoundingClientRect().height === 0),
      activePanes: active[0] ? active[0].querySelectorAll('.pane').length : 0,
      groupName: document.querySelector('#group-name').textContent,
      sidebarActive: document.querySelectorAll('.group-item.active').length,
    };
  `);
  check('点击分组 → 整组终端全部显示', r.activeId && r.activeStages === 1 && r.activePanes === 2 && r.sidebarActive === 1, r);
  check('其他分组隐藏', r.hiddenOther && r.totalStages === 2, { totalStages: r.totalStages });

  // 3. 复制全部文本
  r = await ev(`
    const A = __ms.actions, S = __ms.state;
    const g = S.groups.find(g => g.id === S.activeId);
    const pane = __ms.paneMap.get(g.panes[0].id);
    pane.term.write('hello-magicshell-12345\\r\\n第二行文本\\r\\n');
    await new Promise(r => setTimeout(r, 300));
    const text = __ms.bufferText(pane.term);
    await A.copyAll(pane);
    await new Promise(r => setTimeout(r, 200));
    const clip = await __ms.api.readClipboard();
    return { textLen: text.length, hasMarker: text.includes('hello-magicshell-12345'), clipLen: clip.length, clipSame: clip === text, sample: text.slice(-80) };
  `);
  check('复制全部 = 整段回滚缓冲', r.hasMarker && r.clipSame && r.clipLen > 20, r);

  // 4. 图钉置顶
  r = await ev(`
    const A = __ms.actions, S = __ms.state;
    const gid = S.activeId;
    const before = await __ms.api.isAlwaysOnTop();
    A.setGroupPinned(gid, true);
    await new Promise(r => setTimeout(r, 250));
    const on1 = await __ms.api.isAlwaysOnTop();
    const s1 = __ms.state.groups.find(x => x.id === gid);
    const activeStage = document.querySelector('.stage.active');
    const pins = [...activeStage.querySelectorAll('[data-act="pin"]')];
    const pinBtnOn = pins.length > 0 && pins.every(b => b.classList.contains('pinned'));
    A.setGroupPinned(gid, false);
    await new Promise(r => setTimeout(r, 250));
    const off = await __ms.api.isAlwaysOnTop();
    const pinBtnOff = pins.every(b => !b.classList.contains('pinned'));
    A.setGroupPinned(gid, true);
    await new Promise(r => setTimeout(r, 200));
    const on2 = await __ms.api.isAlwaysOnTop();
    return { before, on1, off, on2, pinnedFlag: s1.pinned, pinBtnOn, pinBtnOff, pinCount: pins.length, sidebarPinned: document.querySelectorAll('.group-item.pinned').length };
  `);
  check('图钉 → 当前组置顶（窗口 alwaysOnTop）', r.on1 === true && r.off === false && r.on2 === true, r);
  check('图钉状态同步到标题栏/侧栏', r.pinBtnOn === true && r.pinBtnOff === true && r.sidebarPinned >= 1, r);

  // 5. 背景色切换（含浅色）
  r = await ev(`
    const A = __ms.actions, S = __ms.state;
    const before = S.settings.bg;
    // 先让所有终端回到跟随窗口背景，避免历史自定义配色干扰
    S.settings.paneBg = null; S.settings.paneFg = null;
    for (const p of __ms.paneMap.values()) A.setPaneLook(p, { bg: null, fg: null }, { silent: true });
    S.settings.bg = '#f7f4ec'; S.settings.fg = '#2b2a26';
    A.applyTheme();
    await new Promise(r => setTimeout(r, 200));
    const cs = getComputedStyle(document.documentElement);
    const pane = [...__ms.paneMap.values()][0];
    const paneBg = getComputedStyle(pane.el).backgroundColor;
    const termTheme = pane.term.options.theme.background;
    const light = { uiPanel: cs.getPropertyValue('--ui-panel').trim(), text: cs.getPropertyValue('--ui-text').trim(), paneBg, termTheme };
    S.settings.bg = '#0b1a2b'; S.settings.fg = '#cdd9e5';
    A.applyTheme();
    await new Promise(r => setTimeout(r, 200));
    const dark = { uiPanel: getComputedStyle(document.documentElement).getPropertyValue('--ui-panel').trim(), termTheme: [...__ms.paneMap.values()][0].term.options.theme.background };
    S.settings.bg = before; S.settings.fg = '#d7dde5';
    A.applyTheme();
    return { before, light, dark };
  `);
  check('背景色可切换（深/浅两套 UI 跟着变）', r.light.termTheme === '#f7f4ec' && r.dark.termTheme === '#0b1a2b' && r.light.uiPanel !== r.dark.uiPanel, r);

  // 6. 关闭分组 / 终端
  r = await ev(`
    const A = __ms.actions, S = __ms.state;
    const before = S.groups.length;
    const g = S.groups.find(g => g.id === S.activeId);
    A.removePane(g.panes[0].id);
    await new Promise(r => setTimeout(r, 400));
    const midPanes = S.groups.find(x => x.id === S.activeId).panes.length;
    A.closeGroup(g.id);
    await new Promise(r => setTimeout(r, 400));
    return { before, after: S.groups.length, midPanes, activeOk: !!S.groups.find(x => x.id === S.activeId), domStages: document.querySelectorAll('.stage').length, domPanes: document.querySelectorAll('.pane').length };
  `);
  check('关闭终端/分组后 DOM 与状态一致', r.after === r.before - 1 && r.domStages === r.after && r.activeOk, r);

  console.log('--- runtime errors ---');
  console.log(errors.length ? errors.join('\n') : '(none)');

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  ws.close();
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
