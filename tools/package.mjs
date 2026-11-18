// 手工组装免安装版：dist/MagicShell/MagicShell.exe
// 不依赖 electron-builder 下载额外二进制（本机网络代理会 502）
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.resolve(root, process.argv[2] || 'dist/MagicShell');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function rmDir(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

console.log('清理', path.relative(root, outDir));
rmDir(outDir);
fs.mkdirSync(outDir, { recursive: true });

console.log('复制 Electron 运行时…');
fs.cpSync(electronDist, outDir, { recursive: true });

// 默认示例应用去掉，换成我们的
const resources = path.join(outDir, 'resources');
rmDir(path.join(resources, 'default_app.asar'));

const appDir = path.join(resources, 'app');
fs.mkdirSync(appDir, { recursive: true });

console.log('复制应用代码…');
fs.cpSync(path.join(root, 'src'), path.join(appDir, 'src'), { recursive: true });

const appPkg = {
  name: pkg.name,
  productName: 'MagicShell',
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  main: 'src/main.js',
  private: true,
  dependencies: pkg.dependencies,
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2));

// MIT 要求分发二进制时一并附上版权与许可声明
const licFrom = path.join(root, 'LICENSE');
if (fs.existsSync(licFrom)) {
  fs.copyFileSync(licFrom, path.join(outDir, 'LICENSE.txt'));
  console.log('  + LICENSE.txt');
}

console.log('复制运行时依赖…');
const keepMods = ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl', 'node-pty'];
for (const rel of keepMods) {
  const from = path.join(root, 'node_modules', ...rel.split('/'));
  const to = path.join(appDir, 'node_modules', ...rel.split('/'));
  if (!fs.existsSync(from)) { console.warn('  缺少依赖:', rel); continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log('  +', rel);
}

// 图标/名字：把 electron.exe 改名为 MagicShell.exe
const exeFrom = path.join(outDir, 'electron.exe');
const exeTo = path.join(outDir, 'MagicShell.exe');
if (fs.existsSync(exeFrom)) fs.renameSync(exeFrom, exeTo);

// 启动脚本：方便命令行启动
fs.writeFileSync(path.join(outDir, '启动 MagicShell.bat'), '@echo off\r\nstart "" "%~dp0MagicShell.exe"\r\n');

const size = (dir) => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += size(p);
    else total += fs.statSync(p).size;
  }
  return total;
};
const mb = (size(outDir) / 1024 / 1024).toFixed(0);
console.log(`\n完成 → ${path.relative(root, exeTo)}  (${mb} MB)`);
console.log('双击 MagicShell.exe 即可运行，可整个文件夹拷到任意位置。');
