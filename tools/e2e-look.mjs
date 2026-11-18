// 自检：终端自定义标题 + 单终端独立配色 / 应用到全部
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

// 准备：一个分组、三个终端，深色主题
await ev(`
  const A = __ms.actions, S = __ms.state;
  S.settings.bg = '#0b0f14'; S.settings.fg = '#d7dde5'; S.settings.paneBg = null; S.settings.paneFg = null;
  A.applyTheme();
  for (const g of [...S.groups]) A.closeGroup(g.id);
  const g = A.createGroup({ name: '测试分组' });
  A.addPane(g); A.addPane(g);
  await new Promise(r => setTimeout(r, 1600));
  for (const p of __ms.paneMap.values()) A.fitPane(p);
  return true;
`);

// 1. 双击标题栏可改名
let r = await ev(`
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  pane.el.querySelector('.pane-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  const input = pane.el.querySelector('.pane-title-input');
  if (!input) return { hasInput: false };
  input.value = '数据库迁移';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const titleEl = pane.el.querySelector('.pane-title');
  return {
    hasInput: true,
    custom: !!pane.meta.customTitle,
    title: pane.meta.title,
    dom: titleEl.textContent,
    placeholderGone: !pane.el.querySelector('.pane-title-input'),
    sameName: pane.meta.name !== pane.meta.title,
  };
`);
check('双击标题栏可自定义终端标题', r.hasInput && r.custom && r.dom === '数据库迁移' && r.placeholderGone && r.sameName, r);

// 2. Esc 取消不修改
r = await ev(`
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  pane.el.querySelector('.pane-head').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  const input = pane.el.querySelector('.pane-title-input');
  input.value = '不该生效的名字';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  return { title: pane.meta.title, dom: pane.el.querySelector('.pane-title').textContent, inputGone: !pane.el.querySelector('.pane-title-input') };
`);
check('Esc 取消改名', r.title === '数据库迁移' && r.dom === '数据库迁移' && r.inputGone, r);

// 3. 清空标题 = 恢复自动标题
r = await ev(`
  const A = __ms.actions;
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[1].id);
  A.setPaneTitle(pane, '临时名字');
  const custom = !!pane.meta.customTitle;
  A.setPaneTitle(pane, '');
  return { custom, after: pane.meta.customTitle, auto: pane.meta.title, name: pane.meta.name, dom: pane.el.querySelector('.pane-title').textContent };
`);
check('清空标题恢复自动标题', r.custom === true && r.after === false && r.auto === r.name && r.dom === r.name, r);

// 4. 自定义标题不被 shell 的窗口标题覆盖
r = await ev(`
  const A = __ms.actions;
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const autoPane = __ms.paneMap.get(g.panes[1].id);
  __ms.api.writePty(pane.id, "$Host.UI.RawUI.WindowTitle='SHELL-SAYS-HI'; Write-Host ok\\r");
  __ms.api.writePty(autoPane.id, "$Host.UI.RawUI.WindowTitle='SHELL-SAYS-HI'; Write-Host ok\\r");
  await new Promise(r => setTimeout(r, 1600));
  return { customTitle: pane.meta.title, autoTitle: autoPane.meta.title };
`);
check('自定义标题不被 shell 覆盖（自动标题仍跟随）',
  r.customTitle === '数据库迁移' && r.autoTitle === 'SHELL-SAYS-HI', r);

// 5. 终端外观弹层：只改当前终端
r = await ev(`
  const A = __ms.actions;
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const other = __ms.paneMap.get(g.panes[2].id);
  A.openLook(pane);
  await new Promise(r => setTimeout(r, 200));
  const open = !document.querySelector('#look').hidden && !document.querySelector('#look-mask').hidden;
  document.querySelectorAll('#look-presets .swatch-btn')[7].click();  // 暖白
  await new Promise(r => setTimeout(r, 300));
  const bg = getComputedStyle(pane.el).backgroundColor;
  const otherBg = getComputedStyle(other.el).backgroundColor;
  const theme = pane.term.options.theme;
  const headBg = getComputedStyle(pane.el.querySelector('.pane-head')).backgroundColor;
  const titleColor = getComputedStyle(pane.el.querySelector('.pane-title')).color;
  return { open, own: pane.meta.bg, bg, otherBg, themeBg: theme.background, themeFg: theme.foreground, headBg, titleColor };
`);
check('可只改单个终端背景（其余终端不动）',
  r.open && r.own === '#f7f4ec' && r.bg === 'rgb(247, 244, 236)' && r.otherBg === 'rgb(11, 15, 20)' && r.themeBg === '#f7f4ec', r);

// 6. 浅色底自动换深色字 + 标题栏跟着变浅
r = await ev(`
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  const lum = (str) => {
    let n = str.match(/[\\d.]+/g).map(Number);
    if (n.length > 3) n = n.slice(-3);
    if (n.some(v => v > 1)) n = n.map(v => v / 255);
    return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
  };
  const head = getComputedStyle(pane.el.querySelector('.pane-head')).backgroundColor;
  const title = getComputedStyle(pane.el.querySelector('.pane-title')).color;
  return { head, title, headLum: lum(head), titleLum: lum(title), fg: pane.term.options.theme.foreground };
`);
check('浅底自动配深色文字（标题栏同步变浅）',
  r.headLum > 0.7 && r.titleLum < 0.35 && r.fg === '#1f2328', r);

// 7. 应用到所有终端 + 新终端继承
r = await ev(`
  const A = __ms.actions;
  document.querySelector('#look-apply-all').click();
  await new Promise(r => setTimeout(r, 400));
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const allSame = [...__ms.paneMap.values()].every(p => !p.meta.bg && getComputedStyle(p.el).backgroundColor === 'rgb(247, 244, 236)');
  const defaultBg = __ms.state.settings.paneBg;
  const before = __ms.paneMap.size;
  A.addPane(g);
  await new Promise(r => setTimeout(r, 1400));
  const fresh = [...__ms.paneMap.values()].pop();
  return { allSame, defaultBg, before, after: __ms.paneMap.size, freshBg: getComputedStyle(fresh.el).backgroundColor };
`);
check('一键应用到所有终端（新终端也继承）',
  r.allSame && r.defaultBg === '#f7f4ec' && r.after === r.before + 1 && r.freshBg === 'rgb(247, 244, 236)', r);

// 8. Esc 关闭弹层
r = await ev(`
  const A = __ms.actions;
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  A.openLook(__ms.paneMap.get(g.panes[0].id));
  await new Promise(r => setTimeout(r, 150));
  const opened = !document.querySelector('#look').hidden;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  return { opened, closed: document.querySelector('#look').hidden && document.querySelector('#look-mask').hidden };
`);
check('Esc 关闭终端外观弹层', r.opened && r.closed, r);

// 9. 恢复默认 / 全部跟随窗口
r = await ev(`
  const A = __ms.actions;
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const pane = __ms.paneMap.get(g.panes[0].id);
  A.openLook(pane);
  await new Promise(r => setTimeout(r, 120));
  document.querySelectorAll('#look-presets .swatch-btn')[0].click();  // 默认
  await new Promise(r => setTimeout(r, 250));
  const followed = getComputedStyle(pane.el).backgroundColor === 'rgb(247, 244, 236)';
  A.closeLook();
  A.resetAllPanesToWindow();
  await new Promise(r => setTimeout(r, 350));
  const back = [...__ms.paneMap.values()].every(p => getComputedStyle(p.el).backgroundColor === 'rgb(11, 15, 20)');
  return { followed, back, paneBg: __ms.state.settings.paneBg };
`);
check('恢复默认 / 全部跟随窗口背景', r.followed && r.back && r.paneBg === null, r);

// 10. 重启后标题与配色都能恢复
await ev(`
  const A = __ms.actions;
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  A.setPaneTitle(__ms.paneMap.get(g.panes[0].id), '迁移脚本');
  A.setPaneLook(__ms.paneMap.get(g.panes[1].id), { bg: '#0b1a2b' });
  A.persist();
  await new Promise(r => setTimeout(r, 600));
  return true;
`);
await ev(`setTimeout(() => location.reload(), 60); return true;`);
await sleep(6500);
r = await ev(`
  await new Promise(r => setTimeout(r, 500));
  const g = __ms.state.groups.find(x => x.id === __ms.state.activeId);
  const p0 = __ms.paneMap.get(g.panes[0].id);
  const p1 = __ms.paneMap.get(g.panes[1].id);
  return {
    title: p0.meta.title, custom: !!p0.meta.customTitle,
    dom: p0.el.querySelector('.pane-title').textContent,
    bg: p1.meta.bg, bgNow: getComputedStyle(p1.el).backgroundColor,
    panes: g.panes.length,
  };
`);
check('重启后自定义标题与单终端配色保留',
  r.title === '迁移脚本' && r.custom && r.dom === '迁移脚本' && r.bg === '#0b1a2b' && r.bgNow === 'rgb(11, 26, 43)', r);

console.log('--- runtime errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
ws.close();
if (failed.length) process.exitCode = 1;
