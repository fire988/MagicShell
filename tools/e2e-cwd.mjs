// 自检：每个终端的启动目录（指定 / 全局默认 / 无效回退 / 重启生效 / 持久化 / 对话框）
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
// 等一个条件成立（PTY 启动、IPC 校验都有真实耗时，写死 sleep 容易误报）
const waitFor = async (expr, ms = 9000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(`return !!(${expr});`)) return true;
    await sleep(250);
  }
  return false;
};

const DIR_A = 'C:\\Work\\Projects\\Dev';
const DIR_B = 'C:\\Work\\Projects\\Dev\\MagicShell';
const DIR_BAD = 'C:\\__magicshell_no_such_dir__';

// ---------------------------------------------------------------- 准备
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.startDir = null;
  S.settings.recentDirs = [];
  // 主进程按自己内存里的配置决定 cwd，必须先落盘再新建终端
  A.persist(true);
  await new Promise(r => setTimeout(r, 300));
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '目录自检' });
  A.addPane(g);
  A.addPane(g);
  await new Promise(r => setTimeout(r, 300));
  window.__g = g;
  return true;
`);
await waitFor(`[...__ms.paneMap.values()].every(p => p.running && p.meta.liveCwd)`);
await sleep(600);

// ------------------------------------------------- 1. 无配置时用用户主目录
const base = await ev(`
  const home = await __ms.api.homeDir();
  const p = [...__ms.paneMap.values()][0];
  return { home, live: p.meta.liveCwd, cwd: p.meta.cwd };
`);
check('未配置时终端落在用户主目录', base.live && base.live.toLowerCase() === base.home.toLowerCase(), base);

// ------------------------------------------------- 2. 全局默认目录 → 新终端
const globalNew = await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.startDir = ${JSON.stringify(DIR_A)};
  const p = A.addPane(window.__g, {});
  window.__p = p;
  return { id: p.id };
`);
await waitFor(`(() => { const p = [...__ms.paneMap.values()].find(x => x.id === ${JSON.stringify(globalNew.id)}); return p && p.running && p.meta.liveCwd; })()`);
const globalNewState = await ev(`
  const p = [...__ms.paneMap.values()].find(x => x.id === ${JSON.stringify(globalNew.id)});
  return { cwd: p.meta.cwd, live: p.meta.liveCwd, running: p.running };
`);
check('全局默认目录作用于新终端', globalNewState.live === DIR_A && globalNewState.running, globalNewState);

// ------------------------------------------------- 3. 单终端启动目录 + 重启生效
const paneId0 = await ev(`
  const A = __ms.actions;
  const p = [...__ms.paneMap.values()][0];
  A.setPaneCwd(p, ${JSON.stringify(DIR_B)});
  A.restartPane(p);
  return p.id;
`);
await waitFor(`(() => { const p = __ms.paneMap.get(${JSON.stringify(paneId0)}); return p && p.running && p.meta.liveCwd === ${JSON.stringify(DIR_B)}; })()`);
const paneCwd = await ev(`
  const p = __ms.paneMap.get(${JSON.stringify(paneId0)});
  const lines = [];
  for (let i = 0; i < 3; i++) lines.push(p.term.buffer.active.getLine(i)?.translateToString(true));
  return { cwd: p.meta.cwd, live: p.meta.liveCwd, lines };
`);
check('单终端启动目录：重启后真的进到该目录', paneCwd.cwd === DIR_B && paneCwd.live === DIR_B, paneCwd);

// ------------------------------------------------- 4. cd 之后 OSC 7 能跟上
const tracked = await ev(`
  const p = __ms.paneMap.get(${JSON.stringify(paneId0)});
  const CR = String.fromCharCode(13);
  __ms.api.writePty(p.id, 'cd ' + ${JSON.stringify(DIR_A)} + CR);
  await new Promise(r => setTimeout(r, 1800));
  return { live: p.meta.liveCwd, cwd: p.meta.cwd };
`);
check('cd 之后能实时跟踪当前目录（OSC 7）', tracked.live === DIR_A && tracked.cwd === DIR_B, tracked);

// ------------------------------------------------- 5. 恢复默认（跟随全局）
const followGlobal = await ev(`
  const A = __ms.actions;
  const p = __ms.paneMap.get(${JSON.stringify(paneId0)});
  A.setPaneCwd(p, null);
  A.restartPane(p);
  return { cwd: p.meta.cwd };
`);
await waitFor(`(() => { const p = __ms.paneMap.get(${JSON.stringify(paneId0)}); return p && p.running && p.meta.liveCwd === ${JSON.stringify(DIR_A)}; })()`);
const followState = await ev(`
  const p = __ms.paneMap.get(${JSON.stringify(paneId0)});
  return { cwd: p.meta.cwd, live: p.meta.liveCwd };
`);
check('清除单终端目录后跟随全局默认', followState.cwd === null && followState.live === DIR_A, followState);

// ------------------------------------------------- 6. 无效目录回退 + 提示
const badDir = await ev(`
  const A = __ms.actions;
  const p = [...__ms.paneMap.values()][1];
  A.setPaneCwd(p, ${JSON.stringify(DIR_BAD)});
  A.restartPane(p);
  let toast = '';
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    toast = document.querySelector('#toast').textContent;
    if (/启动目录不存在/.test(toast)) break;
  }
  const t = document.querySelector('#toast');
  return { live: p.meta.liveCwd, running: p.running, toast, shown: !t.hidden };
`);
check('目录不存在：回退到全局默认并提示', badDir.running && badDir.live === DIR_A
  && /启动目录不存在/.test(badDir.toast) && badDir.shown, badDir);

// ------------------------------------------------- 7. 落盘
const saved = await ev(`
  const A = __ms.actions;
  A.persist(true);
  await new Promise(r => setTimeout(r, 400));
  const cfg = await __ms.api.loadConfig();
  const panes = cfg.groups.flatMap(g => g.panes);
  const p = [...__ms.paneMap.values()][1];
  const target = panes.find(x => x.id === p.id);
  return { cwd: target && target.cwd, startDir: cfg.settings.startDir,
           recent: cfg.settings.recentDirs };
`);
check('启动目录写进配置文件（pane 与全局）',
  saved.cwd === DIR_BAD && saved.startDir === DIR_A && Array.isArray(saved.recent) && saved.recent.includes(DIR_B), saved);

// ------------------------------------------------- 8. 菜单项
const menu = await ev(`
  const A = __ms.actions;
  const p = [...__ms.paneMap.values()][0];
  A.openCwdDialog(p);
  await new Promise(r => setTimeout(r, 300));
  const opened = !document.querySelector('#cwd').hidden;
  A.closeCwdDialog();
  const p2 = [...__ms.paneMap.values()][1];
  const r = p2.el.querySelector('[data-act="more"]').getBoundingClientRect();
  p2.el.querySelector('[data-act="more"]').click();
  await new Promise(r => setTimeout(r, 250));
  const labels = [...document.querySelectorAll('#ctx-menu .ctx-item')].map(b => b.innerText.replace(/\\s+/g, ' ').trim());
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return { opened, labels };
`);
check('「⋯」菜单里有启动目录入口', menu.opened
  && menu.labels.some((l) => /^启动目录/.test(l))
  && menu.labels.some((l) => /在此目录新开终端/.test(l)), menu.labels);

// ------------------------------------------------- 9. 对话框：预填 / 校验 / 用当前目录
const dialog = await ev(`
  const A = __ms.actions;
  const p = __ms.paneMap.get(${JSON.stringify(paneId0)});
  p.meta.liveCwd = ${JSON.stringify(DIR_B)};
  A.openCwdDialog(p);
  await new Promise(r => setTimeout(r, 300));
  const input = document.querySelector('#cwd-input');
  const prefill = input.value;
  input.value = ${JSON.stringify(DIR_BAD)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  let badStatus = '';
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 250));
    badStatus = document.querySelector('#cwd-status').textContent;
    if (/不存在/.test(badStatus)) break;
  }
  document.querySelector('#cwd-use-live').click();
  let okStatus = '';
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 250));
    okStatus = document.querySelector('#cwd-status').textContent;
    if (/目录存在/.test(okStatus)) break;
  }
  const liveFilled = document.querySelector('#cwd-input').value;
  return { prefill, badStatus, liveFilled, okStatus, chips: document.querySelectorAll('.cwd-chip').length };
`);
check('对话框：预填当前配置 / 坏路径报错 / 「用这个」填实时目录',
  dialog.prefill === '' && /不存在/.test(dialog.badStatus)
  && dialog.liveFilled === DIR_B && /目录存在/.test(dialog.okStatus) && dialog.chips > 0, dialog);

// ------------------------------------------------- 10. 保存后写入 + 在此目录新开终端
const saveAndSpawn = await ev(`
  const A = __ms.actions;
  const p = __ms.paneMap.get(${JSON.stringify(paneId0)});
  A.openCwdDialog(p);
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('#cwd-input').value = ${JSON.stringify(DIR_B)};
  await A.saveCwdDialog(false);
  await new Promise(r => setTimeout(r, 300));
  const savedCwd = p.meta.cwd;
  window.__newPaneId = null;

  p.el.querySelector('[data-act="more"]').click();
  await new Promise(r => setTimeout(r, 250));
  const item = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(b => /在此目录新开终端/.test(b.innerText));
  item.click();
  await new Promise(r => setTimeout(r, 200));
  const all = [...__ms.paneMap.values()];
  window.__newPaneId = all[all.length - 1].id;
  return { savedCwd, newId: window.__newPaneId, total: all.length };
`);
await waitFor(`(() => { const p = __ms.paneMap.get(${JSON.stringify(saveAndSpawn.newId)}); return p && p.running && p.meta.liveCwd; })()`);
const newPane = await ev(`
  const p = __ms.paneMap.get(${JSON.stringify(saveAndSpawn.newId)});
  return { cwd: p.meta.cwd, live: p.meta.liveCwd, running: p.running };
`);
check('保存生效 + 「在此目录新开终端」继承目录',
  saveAndSpawn.savedCwd === DIR_B && newPane.cwd === DIR_B && newPane.live === DIR_B, { ...saveAndSpawn, ...newPane });

// ------------------------------------------------- 11. 设置抽屉里的全局默认目录
const drawer = await ev(`
  const S = __ms.state;
  document.querySelector('#btn-settings').click();
  await new Promise(r => setTimeout(r, 250));
  const input = document.querySelector('#input-start-dir');
  const shown = input.value;
  input.value = ${JSON.stringify(DIR_B)};
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 16; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (S.settings.startDir === ${JSON.stringify(DIR_B)}) break;
  }
  const afterOk = S.settings.startDir;
  input.value = ${JSON.stringify(DIR_BAD)};
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  const afterBad = S.settings.startDir;
  document.querySelector('#btn-clear-start-dir').click();
  await new Promise(r => setTimeout(r, 500));
  const afterClear = S.settings.startDir;
  document.querySelector('#btn-close-drawer').click();
  return { shown, afterOk, afterBad, afterClear };
`);
check('设置里能改/清除全局默认目录，坏路径不写入',
  drawer.shown === DIR_A && drawer.afterOk === DIR_B && drawer.afterBad === DIR_B && drawer.afterClear === null, drawer);

// ------------------------------------------------- 12. 收尾后不报错
const noErr = errors.filter((e) => !/ResizeObserver/.test(e));
check('渲染进程无未捕获异常', noErr.length === 0, noErr.slice(0, 3));

// 清理：把状态还原成"未配置"
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.startDir = null;
  S.settings.recentDirs = [];
  for (const p of [...__ms.paneMap.values()]) p.meta.cwd = null;
  A.persist(true);
  return true;
`);

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} passed`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
