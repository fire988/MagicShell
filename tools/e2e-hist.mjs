// 自检：目录历史与热键逐级回退（Alt+←/→/↑、菜单历史列表、失败回滚、重启清空）
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
const waitFor = async (expr, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(`return !!(${expr});`)) return true;
    await sleep(250);
  }
  return false;
};

// 真的按一下键盘（走 window 捕获阶段的处理，和用户按键等价）
const key = async (k, mods = 1) => {
  const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39 };
  const base = { key: k, code: k, windowsVirtualKeyCode: codes[k], nativeVirtualKeyCode: codes[k], modifiers: mods };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(120);
};

const DIR = {
  root: 'C:\\Work\\Projects\\Dev',
  sub: 'C:\\Work\\Projects\\Dev\\MagicShell',
  deep: 'C:\\Work\\Projects\\Dev\\MagicShell\\src',
  other: 'C:\\Work\\Projects',
};

// ---------------------------------------------------------------- 准备
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.startDir = null;
  A.persist(true);
  await new Promise(r => setTimeout(r, 300));
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '目录历史自检' });
  const p = A.addPane(g, { cwd: ${JSON.stringify(DIR.root)} });
  window.__p = p;
  return true;
`);
const ready = await waitFor(`window.__p && window.__p.running && window.__p.meta.liveCwd`);
await sleep(1500);
const base = await ev(`
  const p = window.__p;
  return { live: p.meta.liveCwd, list: p.hist.list, idx: p.hist.idx };
`);
check('新终端从启动目录开始记历史', ready && base.live === DIR.root && base.list.length === 1 && base.idx === 0, base);

// ------------------------------------------------- 1. cd 之后历史自动累积
await ev(`
  const p = window.__p;
  const CR = String.fromCharCode(13), ETX = String.fromCharCode(3);
  for (const d of [${JSON.stringify(DIR.sub)}, ${JSON.stringify(DIR.deep)}]) {
    __ms.api.writePty(p.id, ETX);
    await new Promise(r => setTimeout(r, 160));
    __ms.api.writePty(p.id, 'cd "' + d + '"' + CR);
    await new Promise(r => setTimeout(r, 1100));
  }
  return true;
`);
await sleep(400);
const grew = await ev(`
  const p = window.__p;
  return { live: p.meta.liveCwd, list: p.hist.list, idx: p.hist.idx };
`);
check('每次 cd 都进历史，指针停在最后一条',
  grew.live === DIR.deep && grew.list.length === 3 && grew.idx === 2
  && grew.list[0] === DIR.root && grew.list[2] === DIR.deep, grew);

// ------------------------------------------------- 2. Alt+← 逐级回退
await ev(`window.__p.term.focus(); return true;`);
await key('ArrowLeft');
await sleep(1400);
const back1 = await ev(`
  const p = window.__p;
  const t = document.querySelector('#toast');
  return { live: p.meta.liveCwd, len: p.hist.list.length, idx: p.hist.idx, toast: t.textContent };
`);
check('Alt+← 回退一级（且不重复记一条）',
  back1.live === DIR.sub && back1.len === 3 && back1.idx === 1 && /回退/.test(back1.toast), back1);

await key('ArrowLeft');
await sleep(1400);
const back2 = await ev(`
  const p = window.__p;
  return { live: p.meta.liveCwd, idx: p.hist.idx };
`);
check('再按一次退到最开始那个目录', back2.live === DIR.root && back2.idx === 0, back2);

await key('ArrowLeft');
await sleep(500);
const back3 = await ev(`
  const p = window.__p;
  const t = document.querySelector('#toast');
  return { live: p.meta.liveCwd, idx: p.hist.idx, toast: t.textContent };
`);
check('退到头有提示、不乱跳', back3.live === DIR.root && back3.idx === 0 && /最早/.test(back3.toast), back3);

// ------------------------------------------------- 3. Alt+→ 前进
await key('ArrowRight');
await sleep(1400);
const fwd = await ev(`
  const p = window.__p;
  return { live: p.meta.liveCwd, idx: p.hist.idx };
`);
check('Alt+→ 前进一级', fwd.live === DIR.sub && fwd.idx === 1, fwd);

// ------------------------------------------------- 4. Alt+↑ 回到上一级
await key('ArrowUp');
await sleep(1500);
const up = await ev(`
  const p = window.__p;
  return { live: p.meta.liveCwd, idx: p.hist.idx, len: p.hist.list.length };
`);
check('Alt+↑ 回到上一级目录并记入历史',
  up.live === DIR.root && up.idx === 2 && up.len === 3, up);

// ------------------------------------------------- 5. 菜单里的历史列表
const menu = await ev(`
  const A = __ms.actions;
  const p = window.__p;
  A.openPaneMenu(p, 60, 60);
  await new Promise(r => setTimeout(r, 250));
  const rows = [...document.querySelectorAll('.ctx-dirhist .ctx-hist-row')];
  const onIdx = rows.findIndex(r => r.classList.contains('on'));
  const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map(b => b.innerText.replace(/\\s+/g, ' ').trim());
  const backBtn = [...document.querySelectorAll('#ctx-menu .ctx-item')].find(b => /目录历史后退/.test(b.innerText));
  return { rows: rows.length, onIdx, texts: rows.map(r => r.querySelector('.ctx-hist-path').textContent), items, backDisabled: !!(backBtn && backBtn.disabled) };
`);
check('菜单里能列出历史并标出当前位置',
  menu.rows === 3 && menu.onIdx === 2 && menu.backDisabled === false
  && menu.items.some((s) => /回到上一级目录/.test(s))
  && menu.items.some((s) => /目录历史后退/.test(s)), menu);

const pick = await ev(`
  const p = window.__p;
  const rows = [...document.querySelectorAll('.ctx-dirhist .ctx-hist-row')];
  rows[1].click();
  await new Promise(r => setTimeout(r, 1500));
  return { live: p.meta.liveCwd, idx: p.hist.idx, menuHidden: document.querySelector('#ctx-menu').hidden };
`);
check('点历史里的某一条直接切过去，菜单自动关',
  pick.live === DIR.sub && pick.idx === 1 && pick.menuHidden === true, pick);

// ------------------------------------------------- 6. 历史中间改目录 → 前进记录作废
await ev(`
  const p = window.__p;
  document.querySelector('#ctx-menu').hidden = true;
  const CR = String.fromCharCode(13), ETX = String.fromCharCode(3);
  __ms.api.writePty(p.id, ETX);
  await new Promise(r => setTimeout(r, 160));
  __ms.api.writePty(p.id, 'cd "' + ${JSON.stringify(DIR.other)} + '"' + CR);
  await new Promise(r => setTimeout(r, 1300));
  return true;
`);
await sleep(300);
const trunc = await ev(`
  const p = window.__p;
  return { live: p.meta.liveCwd, list: p.hist.list, idx: p.hist.idx };
`);
check('在历史中间换目录，后面的前进记录被截掉',
  trunc.live === DIR.other && trunc.list.length === 3 && trunc.idx === 2 && trunc.list[2] === DIR.other, trunc);

// ------------------------------------------------- 7. 目标目录不存在 → 指针回滚 + 提示
const rollback = await ev(`
  const p = window.__p;
  const h = p.hist;
  h.list = ['C:\\\\__magicshell_gone__', ${JSON.stringify(DIR.other)}];
  h.idx = 1;
  __ms.actions.jumpDir(p, -1);
  await new Promise(r => setTimeout(r, 2200));
  const t = document.querySelector('#toast');
  return { idx: h.idx, live: p.meta.liveCwd, toast: t.textContent, list: h.list };
`);
check('目标目录不存在时回滚指针并提示',
  rollback.idx === 1 && rollback.live === DIR.other && /没能切过去/.test(rollback.toast), rollback);

// ------------------------------------------------- 8. 重启终端 → 历史清空
const restarted = await ev(`
  const A = __ms.actions;
  const p = window.__p;
  await A.restartPane(p);
  await new Promise(r => setTimeout(r, 2000));
  return { len: p.hist.list.length, idx: p.hist.idx, live: p.meta.liveCwd, running: p.running };
`);
check('重启终端后历史重新开始（只有新的启动目录）',
  restarted.len === 1 && restarted.idx === 0 && restarted.live === DIR.root && restarted.running, restarted);

// ------------------------------------------------- 9. 焦点在输入框时热键不抢
const beforeGuard = await ev(`
  const p = window.__p;
  const h = p.hist;
  h.list = [${JSON.stringify(DIR.root)}, ${JSON.stringify(DIR.other)}];
  h.idx = 1;
  document.querySelector('#btn-settings').click();
  await new Promise(r => setTimeout(r, 300));
  const input = document.querySelector('#input-start-dir');
  input.value = 'C:/Work';
  input.focus();
  return { focused: document.activeElement === input, idx: h.idx };
`);
await key('ArrowLeft');
await sleep(700);
const guarded = await ev(`
  const p = window.__p;
  const input = document.querySelector('#input-start-dir');
  return { idx: p.hist.idx, live: p.meta.liveCwd, val: input.value, stillFocused: document.activeElement === input };
`);
check('设置抽屉的输入框聚焦时热键不抢（不动历史、不吞输入）',
  beforeGuard.focused === true && guarded.idx === 1 && guarded.live === DIR.root
  && guarded.val === 'C:/Work' && guarded.stillFocused === true, { beforeGuard, guarded });
await ev(`
  document.querySelector('#btn-close-drawer').click();
  await new Promise(r => setTimeout(r, 250));
  return true;
`);

check('全程无未捕获异常', errors.length === 0, errors);

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
