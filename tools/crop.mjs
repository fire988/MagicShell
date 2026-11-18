// 局部放大截图: node tools/crop.mjs <x> <y> <w> <h> <scale> <out>
import { writeFileSync } from 'node:fs';
const [x, y, w, h, scale, out] = process.argv.slice(2);
const port = '9222';
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
const s = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: Number(x), y: Number(y), width: Number(w), height: Number(h), scale: Number(scale) },
});
writeFileSync(out || '.tmp/crop.png', Buffer.from(s.data, 'base64'));
console.log('saved', out || '.tmp/crop.png');
ws.close();
