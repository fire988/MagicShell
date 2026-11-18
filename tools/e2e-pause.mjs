// 自检：停止 / 启动终端（留窗口、省内存）+ 侧栏整组启停
// 用法: node tools/e2e-pause.mjs [port]
// 断言里既看前端标志位，也看主进程真实的 PTY 会话数（pty:stats），
// 避免"界面显示停了、进程还在跑"这种假通过。
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
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
const run = async (text, wait = 700) => {
  if (text) await send('Input.insertText', { text });
  await sleep(90);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(wait);
};

// ---------------------------------------------------------------- 准备
const setup = await ev(`
  const S = __ms.state, A = __ms.actions;
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g1 = A.createGroup({ name: 'PAUSE-A' });
  await new Promise((r) => setTimeout(r, 2600));
  A.addPane(g1);
  await new Promise((r) => setTimeout(r, 2400));
  const g2 = A.createGroup({ name: 'PAUSE-B' });
  await new Promise((r) => setTimeout(r, 2400));
  A.activateGroup(g1.id);
  await new Promise((r) => setTimeout(r, 900));
  window.__pa = g1.id;
  window.__pb = g2.id;
  return {
    panes: g1.panes.length,
    running: g1.panes.map((m) => __ms.paneMap.get(m.id).running),
    stats: (await __ms.api.ptyStats()).count,
  };
`);
check('准备：A 组 2 个终端、B 组 1 个终端，会话数对得上',
  setup.panes === 2 && setup.running.every(Boolean) && setup.stats === 3, setup);

// 先跑一条命令，让这个终端有"命令块"，用它验证停止后块被清掉
await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  P.get(g.panes[0].id).term.focus();
  return true;
`);
await run('Start-Sleep -Milliseconds 450; echo PAUSE-BLOCK', 1200);
const withBlock = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  const p = P.get(g.panes[0].id);
  return { blocks: p.cmd.blocks.length, badgeHidden: p.el.querySelector('.cmd-badge')?.hidden };
`);
check('准备：敲一条慢命令后有命令块和徽标', withBlock.blocks >= 1 && withBlock.badgeHidden === false, withBlock);

// ---------------------------------------------------------------- 停单个
const stopped = await ev(`
  const S = __ms.state, A = __ms.actions, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  const p = P.get(g.panes[0].id);
  const before = (await __ms.api.ptyStats()).count;
  A.stopPane(p);
  await new Promise((r) => setTimeout(r, 700));
  return {
    before,
    stats: (await __ms.api.ptyStats()).count,
    running: p.running,
    suspended: p.meta.suspended,
    cls: p.el.className,
    paneStillThere: !!document.querySelector('[data-pane-id="' + p.id + '"]'),
    banner: p.el.querySelector('.pane-stopped').offsetHeight > 0,
    bannerText: p.el.querySelector('.stopped-text').textContent,
  };
`);
check('停止单个终端：进程真的被回收（会话数 -1），窗口还留着',
  stopped.stats === stopped.before - 1 && !stopped.running && stopped.suspended
  && stopped.paneStillThere && stopped.banner, stopped);
check('停止后的横幅写着「已停止」，不是「终端已退出」',
  /已停止/.test(stopped.bannerText) && !/已退出/.test(stopped.bannerText) && !/exited/.test(stopped.cls), stopped);

const afterStopMeta = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  const p = P.get(g.panes[0].id);
  const item = [...document.querySelectorAll('.group-item')].find((e) => e.querySelector('.group-name').textContent === 'PAUSE-A');
  return {
    blocks: p.cmd.blocks.length,
    badgeHidden: p.el.querySelector('.cmd-badge').hidden,
    groupBadge: item.querySelector('.group-badge').textContent,
    power: item.querySelector('.group-power').dataset.state,
    powerTitle: item.querySelector('.group-power').title,
  };
`);
check('停止会清掉没跑完的命令块，徽标跟着消失',
  afterStopMeta.blocks === 0 && afterStopMeta.badgeHidden === true, afterStopMeta);
check('侧栏徽标变成 运行/总数，电源按钮切换成「启动整组」',
  afterStopMeta.groupBadge === '1/2' && afterStopMeta.power === 'start' && /启动/.test(afterStopMeta.powerTitle), afterStopMeta);

// ---------------------------------------------------------------- 切组不复活
const switching = await ev(`
  const S = __ms.state, A = __ms.actions, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  const p = P.get(g.panes[0].id);
  A.activateGroup(window.__pb);
  await new Promise((r) => setTimeout(r, 900));
  const inB = (await __ms.api.ptyStats()).count;
  A.activateGroup(g.id);
  await new Promise((r) => setTimeout(r, 1400));
  return { inB, back: (await __ms.api.ptyStats()).count, running: p.running, cls: p.el.className };
`);
check('切到别的分组再切回来，停掉的终端不会自动复活',
  !switching.running && switching.inB === switching.back && /stopped/.test(switching.cls), switching);

// ---------------------------------------------------------------- 组按钮启停
const byButton = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  const pick = () => [...document.querySelectorAll('.group-item')].find((e) => e.querySelector('.group-name').textContent === 'PAUSE-A');
  pick().querySelector('.group-power').click();          // 有停着的 → 启动整组
  await new Promise((r) => setTimeout(r, 3200));
  const item = pick();   // renderSidebar 会重建节点，必须重新取
  return {
    running: g.panes.map((m) => P.get(m.id).running),
    stats: (await __ms.api.ptyStats()).count,
    groupBadge: item.querySelector('.group-badge').textContent,
    power: item.querySelector('.group-power').dataset.state,
    active: S.activeId === g.id,
  };
`);
check('点侧栏组上的按钮能启动整组（并切到该组）',
  byButton.running.every(Boolean) && byButton.stats === 3 && byButton.groupBadge === '2'
  && byButton.power === 'stop' && byButton.active === true, byButton);

const stopAll = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  const pick = () => [...document.querySelectorAll('.group-item')].find((e) => e.querySelector('.group-name').textContent === 'PAUSE-A');
  pick().querySelector('.group-power').click();          // 全在跑 → 停止整组
  await new Promise((r) => setTimeout(r, 1100));
  const item = pick();
  return {
    running: g.panes.map((m) => P.get(m.id).running),
    stats: (await __ms.api.ptyStats()).count,
    groupBadge: item.querySelector('.group-badge').textContent,
    power: item.querySelector('.group-power').dataset.state,
    toast: (document.querySelector('#toast') || {}).textContent || '',
  };
`);
check('再点一次按钮可以停止整组，全部窗口都保留',
  stopAll.running.every((v) => v === false) && stopAll.stats === 1
  && stopAll.groupBadge === '0/2' && stopAll.power === 'start', stopAll);

// ---------------------------------------------------------------- 打字自动启动
await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  P.get(g.panes[0].id).term.focus();
  await new Promise((r) => setTimeout(r, 250));
  return true;
`);
await run('echo PAUSE-RESUME', 2400);
const resumed = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__pa);
  const p = P.get(g.panes[0].id);
  const text = __ms.bufferText(p.term);
  return { running: p.running, suspended: p.meta.suspended, cls: p.el.className, hit: (text.match(/PAUSE-RESUME/g) || []).length };
`);
check('在停止的终端里直接打字：自动启动，而且这一下按键真的执行了',
  resumed.running && !resumed.suspended && resumed.hit >= 2 && !/stopped/.test(resumed.cls), resumed);

// ---------------------------------------------------------------- 菜单入口
const paneMenu = await ev(`
  const S = __ms.actions, P = __ms.paneMap, St = __ms.state;
  const g = St.groups.find((x) => x.id === window.__pa);
  const p = P.get(g.panes[0].id);
  S.openPaneMenu(p, 200, 200);
  await new Promise((r) => setTimeout(r, 120));
  const keys1 = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((e) => e.dataset.key || '');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  __ms.actions.stopPane(p);
  await new Promise((r) => setTimeout(r, 500));
  S.openPaneMenu(p, 200, 200);
  await new Promise((r) => setTimeout(r, 120));
  const keys2 = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((e) => e.dataset.key || '');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  return { running: keys1.includes('menu.pane.stop'), stopped: keys2.includes('menu.pane.start') };
`);
check('右键菜单：在跑时是「停止此终端」，停着时换成「启动此终端」',
  paneMenu.running && paneMenu.stopped, paneMenu);

const groupMenu = await ev(`
  const St = __ms.state, A = __ms.actions;
  const g = St.groups.find((x) => x.id === window.__pa);
  A.openGroupMenu(g, 200, 200);
  await new Promise((r) => setTimeout(r, 120));
  const keys = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((e) => e.dataset.key || '');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  return { start: keys.includes('group.startAll'), stop: keys.includes('group.stopAll') };
`);
check('分组右键菜单里有「启动整组 / 停止整组」', groupMenu.start && groupMenu.stop, groupMenu);

// ---------------------------------------------------------------- 落盘
const persisted = await ev(`
  const St = __ms.state, A = __ms.actions, P = __ms.paneMap;
  const g = St.groups.find((x) => x.id === window.__pa);
  if (g.panes.some((m) => !m.suspended)) A.stopGroup(g);
  A.persist(true);
  await new Promise((r) => setTimeout(r, 700));
  const cfg = await __ms.api.loadConfig();
  const saved = (cfg.groups || []).find((x) => x.id === window.__pa);
  return { suspended: saved ? saved.panes.map((p) => !!p.suspended) : null };
`);
check('停止状态写进配置文件', Array.isArray(persisted.suspended) && persisted.suspended.every(Boolean), persisted);

// ---------------------------------------------------------------- 重载后保持
await send('Page.reload', { ignoreCache: true });
await sleep(6000);
const afterReload = await ev(`
  const St = __ms.state, P = __ms.paneMap;
  const g = St.groups.find((x) => x.name === 'PAUSE-A');
  if (!g) return { missing: true };
  const item = [...document.querySelectorAll('.group-item')].find((e) => e.querySelector('.group-name').textContent === 'PAUSE-A');
  return {
    suspended: g.panes.map((m) => !!m.suspended),
    running: g.panes.map((m) => P.get(m.id).running),
    cls: g.panes.map((m) => P.get(m.id).el.className),
    stats: (await __ms.api.ptyStats()).count,
    groupBadge: item.querySelector('.group-badge').textContent,
  };
`);
check('重载/重启后仍然保持停止，不会自己起一堆 shell',
  afterReload.suspended && afterReload.suspended.every(Boolean)
  && afterReload.running.every((v) => v === false) && afterReload.stats === 0
  && afterReload.groupBadge === '0/2', afterReload);

// ---------------------------------------------------------------- 英文文案
const en = await ev(`
  const St = __ms.state, P = __ms.paneMap;
  const g = St.groups.find((x) => x.name === 'PAUSE-A');
  const p = P.get(g.panes[0].id);
  document.getElementById('input-language').value = 'en-US';
  document.getElementById('input-language').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 900));
  const txt = p.el.querySelector('.stopped-text').textContent;
  const btn = p.el.querySelector('.pane-stopped [data-act="start"]').textContent;
  document.getElementById('input-language').value = 'zh-CN';
  document.getElementById('input-language').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 700));
  const back = p.el.querySelector('.stopped-text').textContent;
  return { txt, btn, back };
`);
check('切到英文后横幅与按钮文案跟着换，切回来也正常',
  /Stopped/.test(en.txt) && /Start/.test(en.btn) && /已停止/.test(en.back), en);

// ---------------------------------------------------------------- 收尾
await ev(`
  const St = __ms.state, A = __ms.actions;
  for (const g of [...St.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '临时' });
  await new Promise((r) => setTimeout(r, 2400));
  return true;
`);

check('过程中没有未捕获异常', errors.length === 0, errors.slice(0, 3));

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
