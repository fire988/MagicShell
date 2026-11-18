// 自检：每个终端的启动脚本（标题栏按钮 → 编辑弹层 → 启动时在提示符之前执行）
// 用法: node tools/e2e-script.mjs [port]
// 重点不是"界面上存住了字符串"，而是新 shell 里真的跑过这段脚本：
//   · 脚本产物出现在第一个提示符之前，且没有像"被输入过"那样回显在屏幕上
//   · dot-source 生效：脚本里设的环境变量、定义的函数在会话里还能用
//   · 停止后重新启动、以及 cmd.exe（/K 批处理）都要走同一条路
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
const typeRun = async (text, wait = 900) => {
  if (text) await send('Input.insertText', { text });
  await sleep(90);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(wait);
};

// 真正会被执行的脚本：改目录、设环境变量、打印标记、定义函数
const SCRIPT_A = [
  'Set-Location C:\\Windows',
  "$env:MS_SCRIPT = 'boot-ok'",
  "Write-Host 'SCRIPT-BOOT'",
  "function msProbe { 'probe-fn' }",
].join('\n');

// ---------------------------------------------------------------- 准备
const setup = await ev(`
  const S = __ms.state, A = __ms.actions, P = __ms.paneMap;
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: 'SCRIPT-A' });
  await new Promise((r) => setTimeout(r, 2800));
  const p = P.get(g.panes[0].id);
  p.term.focus();
  window.__ps = g.id;
  return {
    panes: g.panes.length,
    running: p.running,
    hasBtn: !!p.el.querySelector('[data-act="script"]'),
    cls: p.el.querySelector('[data-act="script"]').className,
    script: p.meta.script,
  };
`);
check('准备：新终端有脚本按钮，默认没有脚本、没点亮',
  setup.running && setup.hasBtn && !/on/.test(setup.cls) && setup.script === '', setup);

// ---------------------------------------------------------------- 打开弹层
const opened = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__ps);
  const p = P.get(g.panes[0].id);
  p.el.querySelector('[data-act="script"]').click();
  const box = document.getElementById('script');
  const input = document.getElementById('script-input');
  return {
    visible: !box.hidden,
    mask: !document.getElementById('script-mask').hidden,
    target: document.getElementById('script-target').textContent,
    value: input.value,
    stat: document.getElementById('script-stat').textContent,
    runDisabled: document.getElementById('script-run').disabled,
    focused: document.activeElement === input,
    chips: document.querySelectorAll('#script-samples .cwd-chip').length,
  };
`);
check('点标题栏脚本按钮能打开弹层（带上终端名、运行按钮因空脚本而禁用）',
  opened.visible && opened.mask && opened.chips === 3 && opened.runDisabled && opened.focused
  && opened.value === '' && /0 行/.test(opened.stat) && opened.target.length > 0, opened);

// ---------------------------------------------------------------- 片段与 Tab
const inserted = await ev(`
  const input = document.getElementById('script-input');
  document.querySelectorAll('#script-samples .cwd-chip')[0].click();
  const afterChip = input.value;
  const before = input.value.length;
  input.selectionStart = input.selectionEnd = before;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  const afterTab = input.value;
  return { afterChip, tabGrew: afterTab.length === afterChip.length + 2, tail: afterTab.slice(-2), stat: document.getElementById('script-stat').textContent };
`);
check('常用片段插到光标处，Tab 在编辑器里缩进两个空格而不是跳走焦点',
  /Set-Location/.test(inserted.afterChip) && inserted.tabGrew && inserted.tail === '  '
  && /行/.test(inserted.stat), inserted);

// ---------------------------------------------------------------- 只保存
const savedOnly = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__ps);
  const p = P.get(g.panes[0].id);
  const input = document.getElementById('script-input');
  input.value = ${JSON.stringify(SCRIPT_A)};
  input.dispatchEvent(new Event('input'));
  document.getElementById('script-save').click();
  await new Promise((r) => setTimeout(r, 700));
  const cfg = await __ms.api.loadConfig();
  const saved = (cfg.groups || []).find((x) => x.id === g.id);
  const btn = p.el.querySelector('[data-act="script"]');
  return {
    closed: document.getElementById('script').hidden,
    script: p.meta.script,
    cls: btn.className,
    title: btn.title,
    toast: document.getElementById('toast').textContent,
    persisted: saved ? saved.panes[0].script : null,
  };
`);
check('保存（不重启）：脚本写进终端、按钮点亮并显示行数、配置落盘、提示下次生效',
  savedOnly.closed && savedOnly.script === SCRIPT_A && /on/.test(savedOnly.cls)
  && /4 行/.test(savedOnly.title) && savedOnly.persisted === SCRIPT_A
  && /重启该终端/.test(savedOnly.toast), savedOnly);

// ---------------------------------------------------------------- 保存并重启
const booted = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__ps);
  const p = P.get(g.panes[0].id);
  p.el.querySelector('[data-act="script"]').click();
  document.getElementById('script-save-restart').click();
  await new Promise((r) => setTimeout(r, 3600));
  const text = __ms.bufferText(p.term);
  const flat = text.replace(/\\r/g, '');
  return {
    running: p.running,
    hasMark: flat.includes('SCRIPT-BOOT'),
    // 脚本是被 dot-source 执行的，不该像"被输入过一遍"那样留在屏幕上
    echoLeak: flat.includes('Set-Location'),
    order: flat.indexOf('SCRIPT-BOOT') < flat.indexOf('PS C:\\\\Windows>'),
    live: p.meta.liveCwd,
    head: flat.split('\\n').filter((l) => l.trim()).slice(0, 4),
  };
`);
check('保存并重启：脚本在第一个提示符之前跑完，屏幕上没有命令回显',
  booted.running && booted.hasMark && !booted.echoLeak && booted.order, booted);
check('脚本里的 Set-Location 生效（OSC 7 报告的新目录就是它改过去的）',
  booted.live === 'C:\\Windows', booted.live);

// dot-source 的意义：脚本里定义的函数、设的变量在会话里还能用
await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__ps);
  P.get(g.panes[0].id).term.focus();
  await new Promise((r) => setTimeout(r, 200));
  return true;
`);
await typeRun('"fn=" + (msProbe) + " env=" + $env:MS_SCRIPT', 1400);
const scoped = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__ps);
  const text = __ms.bufferText(P.get(g.panes[0].id).term);
  return { line: (text.match(/fn=probe-fn env=boot-ok/g) || []).length };
`);
check('脚本在当前作用域执行：定义的函数与环境变量在会话里都还在',
  scoped.line >= 1, scoped);

// ---------------------------------------------------------------- 运行一次
const once = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__ps);
  const p = P.get(g.panes[0].id);
  p.el.querySelector('[data-act="script"]').click();
  const input = document.getElementById('script-input');
  const before = p.meta.script;
  input.value = "Write-Host 'SCRIPT-ONCE'";
  input.dispatchEvent(new Event('input'));
  const enabled = !document.getElementById('script-run').disabled;
  document.getElementById('script-run').click();
  await new Promise((r) => setTimeout(r, 1600));
  const text = __ms.bufferText(p.term);
  return {
    enabled,
    hit: text.includes('SCRIPT-ONCE'),
    unsaved: p.meta.script === before && !p.meta.script.includes('SCRIPT-ONCE'),
    closed: document.getElementById('script').hidden,
    toast: document.getElementById('toast').textContent,
  };
`);
check('「在当前终端运行一次」立刻生效，但不改动已保存的启动脚本',
  once.enabled && once.hit && once.unsaved && once.closed, once);

// ---------------------------------------------------------------- 停止后再启动
const restarted = await ev(`
  const S = __ms.state, P = __ms.paneMap, A = __ms.actions;
  const g = S.groups.find((x) => x.id === window.__ps);
  const p = P.get(g.panes[0].id);
  const before = (__ms.bufferText(p.term).match(/SCRIPT-BOOT/g) || []).length;
  A.stopPane(p);
  await new Promise((r) => setTimeout(r, 600));
  A.startPane(p);
  await new Promise((r) => setTimeout(r, 3400));
  const text = __ms.bufferText(p.term);
  return {
    before,
    // 重新启动会清屏，所以这里看的是"新屏幕里正好有一次"，一不等于 0 就说明脚本没跑
    after: (text.match(/SCRIPT-BOOT/g) || []).length,
    order: text.replace(/\\r/g, '').indexOf('SCRIPT-BOOT') < text.replace(/\\r/g, '').indexOf('PS '),
    running: p.running,
    suspended: p.meta.suspended,
  };
`);
check('停止后再启动，脚本照旧先跑一遍（不是只有"新建终端"才执行）',
  restarted.running && !restarted.suspended && restarted.before === 1
  && restarted.after === 1 && restarted.order, restarted);

// ---------------------------------------------------------------- 清除
const cleared = await ev(`
  const S = __ms.state, P = __ms.paneMap, A = __ms.actions;
  const g = S.groups.find((x) => x.id === window.__ps);
  const p = P.get(g.panes[0].id);
  p.el.querySelector('[data-act="script"]').click();
  document.getElementById('script-clear').click();
  const emptied = document.getElementById('script-input').value === '';
  document.getElementById('script-save').click();
  await new Promise((r) => setTimeout(r, 600));
  const before = (__ms.bufferText(p.term).match(/SCRIPT-BOOT/g) || []).length;
  await A.restartPane(p);
  await new Promise((r) => setTimeout(r, 2600));
  const cfg = await __ms.api.loadConfig();
  const saved = (cfg.groups || []).find((x) => x.id === g.id);
  return {
    emptied,
    script: p.meta.script,
    cls: p.el.querySelector('[data-act="script"]').className,
    toast: document.getElementById('toast').textContent,
    before,
    after: (__ms.bufferText(p.term).match(/SCRIPT-BOOT/g) || []).length,
    persisted: saved ? saved.panes[0].script : undefined,
  };
`);
check('清空后保存：按钮复原、配置里也不留，重启后脚本不再执行',
  cleared.emptied && cleared.script === '' && !/on/.test(cleared.cls)
  && cleared.before === 1 && cleared.after === 0 && !cleared.persisted, cleared);

// ---------------------------------------------------------------- 落盘 / 重载
await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.id === window.__ps);
  const p = P.get(g.panes[0].id);
  p.meta.script = "Write-Host 'SCRIPT-RELOAD'";
  __ms.actions.syncScriptButton(p);
  __ms.actions.persist(true);
  await new Promise((r) => setTimeout(r, 600));
  return true;
`);
await send('Page.reload', { ignoreCache: true });
await sleep(6500);
const reloaded = await ev(`
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.name === 'SCRIPT-A');
  if (!g) return { missing: true };
  const p = P.get(g.panes[0].id);
  return {
    script: p.meta.script,
    cls: p.el.querySelector('[data-act="script"]').className,
    hit: __ms.bufferText(p.term).includes('SCRIPT-RELOAD'),
    menu: (() => { __ms.actions.openPaneMenu(p, 200, 200); const k = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((e) => e.dataset.key || ''); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return k; })(),
  };
`);
check('重载后脚本还在（按钮点亮、菜单里有入口），而且启动时就执行了',
  !reloaded.missing && reloaded.script === "Write-Host 'SCRIPT-RELOAD'" && /on/.test(reloaded.cls)
  && reloaded.hit && reloaded.menu.includes('menu.pane.script'), reloaded);

// ---------------------------------------------------------------- 英文文案
const en = await ev(`
  const sel = document.getElementById('input-language');
  sel.value = 'en-US';
  sel.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 800));
  const S = __ms.state, P = __ms.paneMap;
  const g = S.groups.find((x) => x.name === 'SCRIPT-A');
  const p = P.get(g.panes[0].id);
  const btnTitle = p.el.querySelector('[data-act="script"]').title;
  p.el.querySelector('[data-act="script"]').click();
  await new Promise((r) => setTimeout(r, 300));
  const head = document.querySelector('#script .modal-head h3').textContent;
  const stat = document.getElementById('script-stat').textContent;
  const note = document.getElementById('script-note').textContent;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  sel.value = 'zh-CN';
  sel.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 700));
  const back = p.el.querySelector('[data-act="script"]').title;
  return { btnTitle, head, stat, note, back };
`);
check('切英文后按钮 tooltip 与弹层文案都跟着换，切回来也正常',
  /Startup script/.test(en.btnTitle) && /Startup script/.test(en.head)
  && /line/.test(en.stat) && /scope/.test(en.note) && /启动脚本/.test(en.back), en);

// ---------------------------------------------------------------- cmd.exe 降级
const cmd = await ev(`
  const S = __ms.state, A = __ms.actions, P = __ms.paneMap;
  const old = S.settings.shell;
  S.settings.shell = 'cmd.exe';
  A.persist(true);
  await new Promise((r) => setTimeout(r, 500));
  const g = A.createGroup({ name: 'SCRIPT-CMD' });
  await new Promise((r) => setTimeout(r, 900));
  A.addPane(g, { script: ['echo CMD-BOOT', 'cd /d C:\\\\Windows'].join('\\n') });
  await new Promise((r) => setTimeout(r, 3600));
  const p = P.get(g.panes[g.panes.length - 1].id);
  const text = __ms.bufferText(p.term);
  const res = {
    shell: p.shellPath,
    hasMark: text.includes('CMD-BOOT'),
    // 批处理默认回显每条命令；我们写了 @echo off，屏幕上不该出现 ">echo CMD-BOOT"
    echoLeak: /^[A-Za-z]:\\\\[^\\n]*>echo CMD-BOOT/m.test(text.replace(/\\r/g, '')),
    tail: text.replace(/\\r/g, '').split('\\n').filter((l) => l.trim()).slice(0, 4),
  };
  A.closeGroup(g.id);
  S.settings.shell = old;
  A.persist(true);
  return res;
`);
check('cmd.exe 走 /K 批处理：脚本同样先跑，且 @echo off 让屏幕干净',
  /cmd\.exe/i.test(cmd.shell || '') && cmd.hasMark && !cmd.echoLeak, cmd);

// ---------------------------------------------------------------- 收尾
await ev(`
  const S = __ms.state, A = __ms.actions;
  for (const g of [...S.groups]) A.closeGroup(g.id);
  A.createGroup({ name: '临时' });
  await new Promise((r) => setTimeout(r, 2200));
  return true;
`);

check('过程中没有未捕获异常', errors.length === 0, errors.slice(0, 3));

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
