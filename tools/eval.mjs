// 在渲染进程里执行任意表达式：node tools/eval.mjs "<expr>"
const port = process.argv[3] || '9222';
const expr = process.argv[2] || '1+1';
const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const page = (await res.json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const r = await send('Runtime.evaluate', {
  expression: `(async () => { ${expr} })()`,
  returnByValue: true, awaitPromise: true,
});
if (r.exceptionDetails) console.log('ERR', r.exceptionDetails.exception?.description);
else console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1));
ws.close();
