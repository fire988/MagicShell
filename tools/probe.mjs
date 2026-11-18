// 开发期自检脚本：通过 CDP 读取渲染进程状态并截图
// 用法: node tools/probe.mjs [outfile] [port]
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || '.tmp/shot.png';
const port = process.argv[3] || '9222';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let targets = [];
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* retry */ }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO_PAGE'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  const logs = [];

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
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exception] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Log.entryAdded') {
      logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
    }
  });

  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');

  await sleep(2500);

  const evalExpr = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  const report = await evalExpr(`(() => {
    const panes = [...document.querySelectorAll('.pane')];
    return {
      title: document.title,
      groups: [...document.querySelectorAll('.group-item')].map(e => e.innerText.replace(/\\s+/g,' ').trim()),
      paneCount: panes.length,
      panes: panes.map(p => ({
        title: p.querySelector('.pane-title')?.textContent,
        xterm: !!p.querySelector('.canvas, .xterm-screen canvas'),
        rows: p.querySelector('.xterm-rows')?.children.length || 0,
        focused: p.classList.contains('focused'),
        exited: p.classList.contains('exited'),
        deadText: p.querySelector('.dead-text')?.textContent,
        bodySize: [p.querySelector('.pane-body')?.clientWidth, p.querySelector('.pane-body')?.clientHeight],
      })),
      stage: (() => { const s = document.querySelector('.stage.active'); return s ? { cols: getComputedStyle(s).gridTemplateColumns, rows: getComputedStyle(s).gridTemplateRows } : null; })(),
      text: panes[0] ? panes[0].innerText.slice(0, 300) : null,
    };
  })()`);

  console.log(JSON.stringify(report, null, 2));
  console.log('--- logs ---');
  console.log(logs.join('\n') || '(none)');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('screenshot ->', out);
  ws.close();
}

main().catch((e) => { console.error('PROBE ERROR', e); process.exit(1); });
