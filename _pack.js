// 一键出包：把 坤坤日报本地测试环境/（开发工作副本）复制到干净临时目录（剔个人数据）→ 7zr 压成单包 → 自检
// 用法：node _pack.js
// 产出：dist/kunkun-daily-<version>.7z
// 注意：LOCAL_TEST_ENV 标记、测试版 exe 名、测试版窗口标题都会在打包时自动还原成正式版。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, '坤坤日报本地测试环境');
const DIST = path.join(ROOT, 'dist');
const SEVEN = path.join(APP_DIR, 'resources', 'app', '7zr.exe');

// 绝不能进包的东西
const EXCLUDE_FILES = new Set(['todo-data.json', 'todo-data.json.bak', 'error.log', 'LOCAL_TEST_ENV']);
const EXCLUDE_DIRS = new Set(['backups']);

function isExcluded(name, isDir) {
  if (isDir && EXCLUDE_DIRS.has(name)) return true;
  if (!isDir && EXCLUDE_FILES.has(name)) return true;
  if (!isDir && /\.bak$/i.test(name)) return true;
  if (!isDir && /^_\d+\.(js|html|css)$/i.test(name)) return true; // 临时调试残留
  return false;
}

function copyClean(src, dst, stat) {
  if (!stat) stat = { files: 0, bytes: 0 };
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      if (isExcluded(name, true)) continue;
      copyClean(s, d, stat);
    } else {
      if (isExcluded(name, false)) continue;
      fs.copyFileSync(s, d);
      stat.files++;
      stat.bytes += st.size;
    }
  }
  return stat;
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'resources', 'app', 'package.json'), 'utf8'));
  const ver = pkg.version;
  console.log('版本:', ver);

  if (!fs.existsSync(SEVEN)) { console.error('缺少 7zr.exe'); process.exit(1); }
  fs.mkdirSync(DIST, { recursive: true });

  const stage = path.join(os.tmpdir(), 'kk-pack-' + Date.now());
  const stageApp = path.join(stage, '坤坤日报');
  console.log('暂存目录:', stage);

  const stat = copyClean(APP_DIR, stageApp);
  console.log('已复制', stat.files, '个文件，', mb(stat.bytes));

  // 还原测试痕迹：测试环境的 exe 名和窗口标题都带「本地测试」，发版必须改回正式的样子。
  // LOCAL_TEST_ENV 标记已在 EXCLUDE_FILES 里剔除，代码里的隔离逻辑自然失活。
  const testExe = path.join(stageApp, '坤坤日报本地测试.exe');
  const realExe = path.join(stageApp, '坤坤日报.exe');
  if (!fs.existsSync(realExe)) {
    if (!fs.existsSync(testExe)) { console.error('自检失败：暂存区没有 exe'); process.exit(1); }
    fs.renameSync(testExe, realExe);
    console.log('exe 已改回：坤坤日报.exe');
  }
  const idxFile = path.join(stageApp, 'resources', 'app', 'index.html');
  let idx = fs.readFileSync(idxFile, 'utf8');
  if (idx.includes('<title>坤坤日报 · 本地测试</title>')) {
    idx = idx.replace('<title>坤坤日报 · 本地测试</title>', '<title>坤坤日报</title>');
    fs.writeFileSync(idxFile, idx, 'utf8');
    console.log('窗口标题已还原：坤坤日报');
  }

  // 自检 1：暂存区里的个人数据必须为零，且不能带测试环境标记
  let leak = 0;
  (function scan(dir) {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (n === 'backups') leak++; scan(p); }
      else if (/^todo-data\.json/.test(n) || n === 'error.log') leak++;
      else if (n === 'LOCAL_TEST_ENV') leak++;
    }
  })(stageApp);
  if (leak) { console.error('自检失败：暂存区含个人数据或测试标记', leak); process.exit(1); }

  const out = path.join(DIST, 'kunkun-daily-' + ver + '.7z');
  if (fs.existsSync(out)) fs.unlinkSync(out);

  console.log('压缩中（-mx=7，约需 1-3 分钟）…');
  const t0 = Date.now();
  execFileSync(SEVEN, ['a', '-t7z', '-mx=7', '-mmt=4', '-bd', out, stageApp], { stdio: 'inherit' });
  console.log('压缩完成，用时', ((Date.now() - t0) / 1000).toFixed(1), 's');

  // 自检 2：包里不能有任何个人数据
  const list = execFileSync(SEVEN, ['l', '-slt', out], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const hits = list.split('\n').filter(l => /todo-data|backups|error\.log/i.test(l) && /^Path = /.test(l));
  if (hits.length) { console.error('自检失败：包内含个人数据\n' + hits.join('\n')); process.exit(1); }

  const fileCount = (list.match(/^Path = /gm) || []).length;
  const size = fs.statSync(out).size;
  console.log('');
  console.log('=== 出包完成 ===');
  console.log('文件:', out);
  console.log('大小:', mb(size), '(' + size + ' 字节)');
  console.log('条目:', fileCount);
  console.log('SHA256:', sha256(out));
  console.log('');
  console.log('校验用的 7zr t 完整性检测…');
  execFileSync(SEVEN, ['t', '-bd', out], { stdio: 'inherit' });

  fs.rmSync(stage, { recursive: true, force: true });
  console.log('暂存目录已清理');
}

try { main(); } catch (e) { console.error('出包失败:', e && e.message || e); process.exit(1); }
