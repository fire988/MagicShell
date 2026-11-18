// 自检：命令块（shell 集成 OSC 133）——退出码 / 耗时 / 徽标 / 跳命令 / 复制单条输出 / 通知判定
// 用法: node tools/e2e-cmd.mjs [port]
// 注意：输入必须用 CDP 真实键盘事件（Input.insertText + Input.dispatchKeyEvent），
//      这样才会走 xterm 的 onData → noteCommandRun，和用户敲键盘完全同一条路径。
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

// 敲一条命令：文本走 insertText，回车走真实 keyDown/keyUp
const run = async (text, wait = 700) => {
  if (text) await send('Input.insertText', { text });
  await sleep(90);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(wait);
};
const hotkey = async (code, vk, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: code, code, windowsVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: code, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(320);
};

// 页内状态读取器（不污染业务代码，只在自检时挂上去）
const probe = async () => ev(`
  const S = __ms.state;
  const g = S.groups.find((x) => x.id === S.activeId);
  const p = __ms.paneMap.get(g.panes[0].id);
  const b = p.term.buffer.active;
  const badge = p.el.querySelector('.cmd-badge');
  return {
    blocks: p.cmd.blocks.length,
    lines: p.cmd.blocks.map((x) => (x.marker && !x.marker.isDisposed ? x.marker.line : null)),
    last: p.cmd.last ? { exit: p.cmd.last.exit, ms: Math.round(p.cmd.last.ms), text: p.cmd.last.text } : null,
    badge: { hidden: badge.hidden, text: badge.textContent, cls: badge.className, title: badge.title },
    viewportY: b.viewportY,
    baseY: b.baseY,
    cursorLine: b.baseY + b.cursorY,
  };
`);

// ------------------------------------------------------------ 准备一个干净终端
const setup = await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5';
  S.settings.paneBg = null; S.settings.paneFg = null;
  S.settings.notifyOnDone = true;
  S.settings.shell = 'auto';          // 上一次跑残留的 shell 设置会影响结果
  A.applyTheme();
  A.persist(true);
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '命令块自检' });
  await new Promise((r) => setTimeout(r, 2400));
  const p = __ms.paneMap.get(g.panes[0].id);
  p.term.focus();
  return { paneId: p.id, promptText: p.cmd ? p.cmd.promptText : '', blocks: p.cmd ? p.cmd.blocks.length : -1 };
`);
check('终端起来后拿到了提示符、且还没有命令块',
  setup.blocks === 0 && /PS |\$\s*$|>\s*$/.test(setup.promptText || ''), setup);

// ------------------------------------------------------------------ 成功 / 失败
await run('echo CMD-OK');
let s = await probe();
check('成功的命令记一条块：退出码 0、耗时 > 0',
  s.blocks === 1 && s.last.exit === 0 && s.last.ms >= 0 && s.last.text === 'echo CMD-OK', s.last);
check('快命令（<300ms）不显示徽标，避免刷屏',
  s.badge.hidden === true && s.badge.text === '', s.badge);

await run('Get-Item C:\\__ms_nope__');
s = await probe();
check('cmdlet 报错：退出码 1、徽标变红并带退出码',
  s.blocks === 2 && s.last.exit === 1 && s.badge.hidden === false
  && s.badge.cls.includes('fail') && s.badge.text.startsWith('✗ 1'), s.badge);

await run('cmd /c exit 3');
s = await probe();
check('原生命令保留真实退出码（cmd /c exit 3 → 3）',
  s.blocks === 3 && s.last.exit === 3, s.last);

await run('');
s = await probe();
check('空回车（没敲任何东西）不产生命令块', s.blocks === 3, { blocks: s.blocks });

// ----------------------------------------------------------------- 慢命令徽标
await run('Start-Sleep -Milliseconds 700', 1400);
s = await probe();
check('慢命令成功率 ≥ 300ms 时显示绿色徽标与耗时',
  s.blocks === 4 && s.last.exit === 0 && s.last.ms >= 600
  && s.badge.hidden === false && s.badge.cls.includes('ok') && /^✓ \d/.test(s.badge.text), s.badge);
check('徽标 tooltip 是中文说明（语言切换时也会跟着换）',
  /上一条命令成功/.test(s.badge.title || ''), { title: s.badge.title });

// ------------------------------------------------------- 造点回滚内容再试跳转
await run('1..40 | ForEach-Object { "L$_" }', 1200);
s = await probe();
const beforeJump = s;
check('长输出命令也照常记块', s.blocks === 5 && s.viewportY === s.baseY, { blocks: s.blocks });

await hotkey('ArrowUp', 38, 2);   // Ctrl+↑
s = await probe();
check('Ctrl+↑ 跳到上一条命令所在行（视野顶对齐那条命令）',
  s.viewportY === beforeJump.lines[s.lines.length - 1] && s.viewportY < s.baseY,
  { viewportY: s.viewportY, target: beforeJump.lines[beforeJump.lines.length - 1] });

await hotkey('ArrowUp', 38, 2);
const up2 = await probe();
check('再按一次 Ctrl+↑ 继续往上一条', up2.viewportY === beforeJump.lines[beforeJump.lines.length - 2],
  { viewportY: up2.viewportY, target: beforeJump.lines[beforeJump.lines.length - 2] });

await hotkey('ArrowDown', 40, 2);
await hotkey('ArrowDown', 40, 2);
await hotkey('ArrowDown', 40, 2);
const back = await probe();
check('Ctrl+↓ 一路回到最新（视野回到底部）', back.viewportY === back.baseY, { viewportY: back.viewportY, baseY: back.baseY });

// -------------------------------------------------------------- 复制单条输出
const copied = await ev(`
  const S = __ms.state;
  const p = __ms.paneMap.get(S.groups.find((x) => x.id === S.activeId).panes[0].id);
  await __ms.api.writeClipboard('__EMPTY__');
  __ms.actions.copyCommandOutput(p);
  await new Promise((r) => setTimeout(r, 250));
  const clip = await __ms.api.readClipboard();
  return { lines: clip.split('\\r\\n'), head: clip.slice(0, 20) };
`);
check('复制这条命令的输出：只有输出、不含提示符、正好 40 行',
  copied.lines.length === 40 && copied.lines[0] === 'L1' && copied.lines[39] === 'L40'
  && !/PS C:/.test(copied.head), { n: copied.lines.length, head: copied.head, tail: copied.lines[copied.lines.length - 1] });

// --------------------------------------------------------------- 通知判定逻辑
const notify = await ev(`
  const A = __ms.actions, S = __ms.state;
  const was = S.settings.notifyOnDone;
  S.settings.notifyOnDone = true;
  const on = {
    longBackground: A.shouldNotify(4000, { focused: false }),
    longFocused: A.shouldNotify(4000, { focused: true }),
    short: A.shouldNotify(500, { focused: false }),
    boundary: A.shouldNotify(3000, { focused: false }),
  };
  S.settings.notifyOnDone = false;
  const off = A.shouldNotify(4000, { focused: false });
  S.settings.notifyOnDone = was;
  return { on, off };
`);
check('只有「超过 3 秒 + 窗口不在前台 + 开关打开」才提醒',
  notify.on.longBackground === true && notify.on.longFocused === false
  && notify.on.short === false && notify.on.boundary === true && notify.off === false, notify);

// ------------------------------------------------------- 重启终端：命令块清零
const restarted = await ev(`
  const S = __ms.state, A = __ms.actions;
  const p = __ms.paneMap.get(S.groups.find((x) => x.id === S.activeId).panes[0].id);
  const before = p.cmd.blocks.length;
  await A.restartPane(p);
  await new Promise((r) => setTimeout(r, 2400));
  const after = __ms.paneMap.get(p.id);
  return { before, blocks: after.cmd.blocks.length, badgeHidden: after.el.querySelector('.cmd-badge').hidden };
`);
check('重启终端后命令块与徽标清空', restarted.before > 0 && restarted.blocks === 0 && restarted.badgeHidden, restarted);

// ------------------------------------------------------ cmd.exe 下优雅降级（0 块）
const cmdShell = await ev(`
  const S = __ms.state, A = __ms.actions;
  const prev = S.settings.shell;
  S.settings.shell = 'cmd';
  A.persist(true);
  await new Promise((r) => setTimeout(r, 700));
  const g = A.createGroup({ name: 'cmd 降级' });
  await new Promise((r) => setTimeout(r, 2200));
  const p = __ms.paneMap.get(g.panes[0].id);
  p.term.focus();
  window.__cmdGroup = g.id;
  window.__cmdPrevShell = prev;
  const info = await __ms.api.appInfo();
  return { shell: info.shell, blocks: p.cmd.blocks.length };
`);
await run('echo CMD-SHELL', 1200);
const cmdAfter = await ev(`
  const S = __ms.state;
  const g = S.groups.find((x) => x.id === window.__cmdGroup);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const text = __ms.bufferText(pane.term);
  return { blocks: pane.cmd.blocks.length, ran: text.includes('CMD-SHELL') && text.split('CMD-SHELL').length > 2 };
`);
check('cmd.exe 没有 shell 集成：命令照跑但一条块都不记（不报错）',
  /cmd/i.test(String(cmdShell.shell)) && cmdAfter.ran && cmdAfter.blocks === 0, { ...cmdShell, ...cmdAfter });

// 收尾：关掉 cmd 组、把 shell 设置还原
await ev(`
  const S = __ms.state, A = __ms.actions;
  A.closeGroup(window.__cmdGroup);
  S.settings.shell = window.__cmdPrevShell || 'auto';
  A.persist(true);
  await new Promise((r) => setTimeout(r, 400));
  return true;
`);

check('过程中没有未捕获异常', errors.length === 0, errors.slice(0, 3));

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
