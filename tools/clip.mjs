// 精确裁剪截图：node tools/clip.mjs x y w h scale out [port]
import { writeFileSync } from 'node:fs';

const [x, y, w, h, scale] = process.argv.slice(2, 7).map(Number);
const out = process.argv[7] || '.tmp/clip.png';
const port = process.argv[8] || '9222';

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
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
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x, y, width: w, height: h, scale: scale || 3 },
});
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
ws.close();
