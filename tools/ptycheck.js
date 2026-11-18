const pty = require('node-pty');
const map = { ps: 'powershell.exe', pwsh: 'pwsh.exe', cmd: 'cmd.exe' };
const shell = map[process.argv[2]] || 'cmd.exe';
const mode = process.argv[3] || 'none';   // none | input | resize | both
console.log('spawning', shell, 'mode', mode);

const COLS = 100, ROWS = 30;
const p = pty.spawn(shell, ['-NoLogo'], {
  cols: COLS, rows: ROWS, cwd: process.env.USERPROFILE, env: process.env, useConpty: true,
});
let got = 0;
p.onData((d) => { got += d.length; process.stdout.write('[' + Date.now() % 100000 + '] ' + JSON.stringify(d).slice(0, 300) + '\n'); });

if (mode === 'input' || mode === 'both') setTimeout(() => { console.log('>>> CR'); p.write('\r'); }, 900);
if (mode === 'resize' || mode === 'both') setTimeout(() => { console.log('>>> resize'); try { p.resize(COLS + 1, ROWS); p.resize(COLS, ROWS); } catch (e) { console.log('resize err', e.message); } }, 900);

setTimeout(() => { console.log('TOTAL_CHARS', got); try { p.kill(); } catch {} process.exit(0); }, 6000);
