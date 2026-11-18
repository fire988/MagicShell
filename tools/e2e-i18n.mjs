// 自检：国际化（zh-CN / en-US）
// 关键断言：切到英文后，除终端内容与语言下拉里的母语名之外，界面上不允许残留任何中文。
// 这条比人眼找漏翻靠谱——新增文案忘了进字典，这里会立刻红。
const port = process.argv[2] || '9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const errors = [];
const warns = [];
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (text.includes('[i18n]')) warns.push(text);
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

// 页内扫描器：只抓元素自己的文本节点 + title/aria/placeholder
const INSTALL_SCAN = `
  window.__scanCjk = (root) => {
    const CJK = /[\\u4e00-\\u9fa5]/;
    // 终端内容、语言下拉里的母语名、用户自己起的名字/标题都不算漏翻
    const skip = (el) => el.closest('.xterm') || el.closest('.pane-body')
      || el.closest('.look-preview') || el.closest('#input-language')
      || el.closest('.group-name') || el.closest('.pane-title') || el.closest('.group-name-input');
    const hits = [];
    const note = (el, text, kind) => {
      const s = String(text || '').replace(/\\s+/g, ' ').trim();
      if (!s || !CJK.test(s)) return;
      const path = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '');
      hits.push(kind + ' ' + path + ' :: ' + s.slice(0, 60));
    };
    for (const el of (root || document.body).querySelectorAll('*')) {
      if (skip(el)) continue;
      for (const node of el.childNodes) if (node.nodeType === 3) note(el, node.nodeValue, 'text');
      if (el.title) note(el, el.title, 'title');
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria) note(el, aria, 'aria');
      if (el.placeholder) note(el, el.placeholder, 'placeholder');
    }
    return hits;
  };
  return true;
`;
const scan = async (rootSel) => ev(`return window.__scanCjk(${rootSel ? `$(${JSON.stringify(rootSel)})` : 'null'});`);
const switchLang = async (val) => ev(`
  const sel = $('#input-language');
  sel.value = ${JSON.stringify(val)};
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 450));
  return { lang: document.documentElement.lang, setting: __ms.state.settings.language };
`);

// ---------------------------------------------------------------- 准备
await ev(`
  const A = __ms.actions, S = __ms.state;
  for (const g of [...S.groups]) A.closeGroup(g.id);
  S.settings.language = 'auto';
  const g = A.createGroup({ name: '自检分组' });          // 用户命名的分组：切语言不能被改
  const g2 = A.createGroup({});                            // 自动命名：切语言要跟着变
  window.__g1 = g; window.__g2 = g2;
  await new Promise(r => setTimeout(r, 1200));
  return true;
`);
await ev(INSTALL_SCAN);

// ------------------------------------------------ 1. 中文（默认）状态
const zh = await ev(`
  const sel = $('#input-language');
  sel.value = 'zh-CN';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return {
    lang: document.documentElement.lang,
    tagline: document.querySelector('.brand-sub').textContent.trim(),
    meta: $('#group-meta').textContent.trim(),
    autoName: window.__g2.name,
    fixedName: window.__g1.name,
  };
`);
check('默认中文：html lang / 品牌副标题 / 终端计数都是中文',
  zh.lang === 'zh-CN' && zh.tagline === '分组式终端工作台' && /个终端$/.test(zh.meta), zh);
check('中文模式下自动命名分组是「分组 2」', zh.autoName === '分组 2', { autoName: zh.autoName });

// ------------------------------------------------------ 2. 切英文
const en = await switchLang('en-US');
check('切到 English：html lang 与设置同步', en.lang === 'en-US' && en.setting === 'en-US', en);

const enUi = await ev(`
  return {
    tagline: document.querySelector('.brand-sub').textContent.trim(),
    meta: $('#group-meta').textContent.trim(),
    copyLabel: (document.querySelector('.tool-btn.copy .tool-label') || {}).textContent,
    paneTip: document.querySelector('.pane-title').title,
    autoName: window.__g2.name,
    fixedName: window.__g1.name,
    drawerTitle: $('#drawer h3').textContent.trim(),
    langValue: $('#input-language').value,
  };
`);
check('静态与动态文案都变英文（品牌副标题/终端计数/复制全部/标题栏提示）',
  enUi.tagline === 'Grouped terminal workspace'
  && /^1 terminal$/.test(enUi.meta)
  && enUi.copyLabel === 'Copy all'
  && /Drag the title bar/.test(enUi.paneTip), enUi);
check('自动命名的分组跟着改成英文，用户改过名的不动',
  enUi.autoName === 'Group 2' && enUi.fixedName === '自检分组', { auto: enUi.autoName, fixed: enUi.fixedName });

// --------------------------------------------------- 3. 全界面无中文残留
const allHits = [];
const collect = async (label, rootSel) => {
  const hits = await scan(rootSel);
  allHits.push(...hits.map((h) => `${label} | ${h}`));
};

await collect('主界面');
await ev(`$('#btn-settings').click(); await new Promise(r=>setTimeout(r,250)); return true;`);
await collect('设置抽屉', '#drawer');
await ev(`$('#btn-close-drawer').click(); await new Promise(r=>setTimeout(r,150)); return true;`);

await ev(`__ms.actions.openCwdDialog([...__ms.paneMap.values()][0]); await new Promise(r=>setTimeout(r,250)); return true;`);
await collect('启动目录', '#cwd');
await ev(`$('#btn-close-cwd').click(); await new Promise(r=>setTimeout(r,150)); return true;`);

await ev(`__ms.actions.openLook([...__ms.paneMap.values()][0]); await new Promise(r=>setTimeout(r,250)); return true;`);
await collect('终端外观', '#look');
await ev(`$('#btn-close-look').click(); await new Promise(r=>setTimeout(r,150)); return true;`);

await ev(`__ms.actions.openPaneMenu([...__ms.paneMap.values()][0], 220, 220); await new Promise(r=>setTimeout(r,220)); return true;`);
await collect('终端菜单', '#ctx-menu');
await ev(`$('#ctx-menu').hidden = true; $('#ctx-menu').innerHTML = ''; return true;`);

await ev(`
  const item = document.querySelector('.group-item');
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 240 }));
  await new Promise(r=>setTimeout(r,220));
  return true;
`);
await collect('分组菜单', '#ctx-menu');
await ev(`$('#ctx-menu').hidden = true; $('#ctx-menu').innerHTML = ''; return true;`);

await ev(`$('#btn-layout').click(); await new Promise(r=>setTimeout(r,220)); return true;`);
await collect('布局菜单', '#ctx-menu');
await ev(`$('#ctx-menu').hidden = true; $('#ctx-menu').innerHTML = ''; return true;`);

await ev(`$('#btn-toggle-sidebar').click(); await new Promise(r=>setTimeout(r,320)); return true;`);
await collect('toast', '#toast');
await ev(`$('#btn-toggle-sidebar').click(); await new Promise(r=>setTimeout(r,320)); return true;`);

check('英文模式下所有界面都没有残留中文（终端内容与语言下拉除外）',
  allHits.length === 0, allHits.slice(0, 12));

// ------------------------------------------------- 4. 菜单按 key 取，不依赖文案
const keys = await ev(`
  __ms.actions.openPaneMenu([...__ms.paneMap.values()][0], 220, 220);
  await new Promise(r => setTimeout(r, 200));
  const list = [...document.querySelectorAll('#ctx-menu .ctx-item')].map(b => b.dataset.key).filter(Boolean);
  const renameText = document.querySelector('#ctx-menu [data-key="menu.pane.rename"]').textContent.trim();
  $('#ctx-menu').hidden = true; $('#ctx-menu').innerHTML = '';
  return { list, renameText };
`);
check('菜单项带 data-key，自检不再按中文文案选',
  keys.list.includes('menu.pane.rename') && keys.list.includes('menu.pane.close') && /Rename terminal/.test(keys.renameText), keys);

// ------------------------------------------------------ 5. 切回中文
const back = await ev(`
  const sel = $('#input-language');
  sel.value = 'zh-CN';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return {
    lang: document.documentElement.lang,
    tagline: document.querySelector('.brand-sub').textContent.trim(),
    autoName: window.__g2.name,
    copyLabel: (document.querySelector('.tool-btn.copy .tool-label') || {}).textContent,
  };
`);
check('切回中文：文案与自动分组名都还原',
  back.lang === 'zh-CN' && back.tagline === '分组式终端工作台'
  && back.autoName === '分组 2' && back.copyLabel === '复制全部', back);

// ------------------------------------------- 6. 语言写进配置，重载后仍在
await switchLang('en-US');
const persisted = await ev(`
  const cfg = await __ms.api.loadConfig();
  return { saved: cfg.settings.language, mem: __ms.state.settings.language };
`);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
await send('Runtime.enable');
await ev(INSTALL_SCAN);
const afterReload = await ev(`
  return {
    lang: document.documentElement.lang,
    tagline: document.querySelector('.brand-sub').textContent.trim(),
    select: $('#input-language').value,
    missing: window.I18n ? I18n.missingKeys() : ['no-i18n'],
  };
`);
check('语言写进配置并落盘', persisted.saved === 'en-US' && persisted.mem === 'en-US', persisted);
check('重载后仍然是英文（不用手动再切）',
  afterReload.lang === 'en-US' && afterReload.tagline === 'Grouped terminal workspace'
  && afterReload.select === 'en-US', afterReload);

// ---------------------------------------------------------------- 收尾
const missKeys = await ev(`return window.I18n ? I18n.missingKeys() : [];`);
await ev(`
  // 收尾：语言回 auto（跟随系统）并落盘，别把测试机留在英文
  const sel = $('#input-language');
  sel.value = 'auto';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  for (const g of [...__ms.state.groups]) __ms.actions.closeGroup(g.id);
  return true;
`);

check('没有缺失的 i18n key（运行期未出现 missing key 警告）',
  missKeys.length === 0 && warns.length === 0, { missKeys, warns });
check('过程中没有未捕获异常', errors.length === 0, errors.slice(0, 2));

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
ws.close();
process.exit(pass === results.length ? 0 : 1);
