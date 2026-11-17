// 更新器失败路径自测（一次性跑完四条路径，22 项断言）
//
// 为什么需要它：一键更新的真正风险不在"能不能装上"，而在"装不上时能不能退回去"。
// 而回滚逻辑全在一个现场生成的批处理里 —— 靠人工点界面永远测不到"新版起不来"这种情况。
//
// 做法：把 main.js 里 buildUpdateBat() 生成的脚本原样取出来，在临时目录里造一个
// 假的安装目录 + 假的更新包，用 Node 以中文 exe 名和 Unicode 环境变量去调它，
// 分别模拟：正常升级 / 新版不报到 / 包损坏 / 包内缺主程序。
//
// 运行： node tests/updater.test.js
// 退出码： 0 = 全部通过，1 = 有失败

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const APP = path.join(__dirname, '..', '坤坤日报本地测试环境', 'resources', 'app');
const SEVEN = path.join(APP, '7zr.exe');
const WHERE = 'C:/Windows/System32/where.exe';   // 任意能秒退的真实 PE，当假主程序
const EXE = '坤坤日报测试.exe';                   // 中文名，验证中文路径；与正式版不同名，避免误杀
const ROOT = path.join(process.env.TEMP, 'kk-updater-test');

function genBat() {
  const t = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
  const i = t.indexOf('function buildUpdateBat()');
  const j = t.indexOf('\n}\n', i);
  if (i < 0 || j < 0) throw new Error('main.js 里找不到 buildUpdateBat()，测试无法继续');
  const fn = new Function('return ' + t.slice(i, j + 3).replace('function buildUpdateBat()', 'function()'))();
  return fn();
}

const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { } };
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

// 造一套环境：旧版安装目录 + 新版更新包
function setup(tag, mode) {
  const base = path.join(ROOT, tag);
  rm(base);
  const install = path.join(base, 'install');
  const src = path.join(base, 'src');
  const pkg = path.join(base, 'pkg');

  fs.mkdirSync(install, { recursive: true });
  fs.copyFileSync(WHERE, path.join(install, EXE));
  w(path.join(install, 'resources/app/app.js'), 'OLD');
  w(path.join(install, 'todo-data.json'), '{"keep":true}');   // 升级绝不能碰用户数据
  w(path.join(install, 'oldonly.dll'), 'OLDFILE');
  w(path.join(install, 'backups/keep.txt'), 'BACKUP');        // 备份目录必须排除

  fs.mkdirSync(src, { recursive: true });
  fs.copyFileSync(SEVEN, path.join(src, '7zr.exe'));
  const packRoot = path.join(pkg, '坤坤日报');
  fs.mkdirSync(packRoot, { recursive: true });
  if (mode !== 'noexe') fs.copyFileSync(WHERE, path.join(packRoot, EXE));
  w(path.join(packRoot, 'resources/app/app.js'), 'NEW');
  w(path.join(packRoot, 'newfile.dll'), 'NEWFILE');
  w(path.join(packRoot, 'todo-data.json'), '{"evil":true}');  // 必须被 /XF 排除
  w(path.join(packRoot, 'app.log'), 'EVIL LOG');              // 必须被 /XF 排除

  const pkgFile = path.join(src, 'update.7z');
  cp.execFileSync(path.join(src, '7zr.exe'),
    ['a', pkgFile, path.join(pkg, '坤坤日报')], { cwd: pkg, stdio: 'ignore' });
  if (mode === 'broken') fs.writeFileSync(pkgFile, Buffer.from('not-a-7z-file'));

  fs.writeFileSync(path.join(base, 'update.bat'), genBat(), 'ascii');
  return { base, install, src, pkgFile };
}

function mkEnv(s) {
  return Object.assign({}, process.env, {
    KK_SRC: s.src, KK_INSTALL: s.install, KK_EXE: EXE,
    KK_PKG: s.pkgFile, KK_SEVEN: path.join(s.src, '7zr.exe')
  });
}

// flagDelayMs: 多少毫秒后模拟"新版启动成功并报到"；0 = 模拟新版起不来
function run(env, flagDelayMs) {
  const t0 = Date.now();
  let helper = null;
  if (flagDelayMs) {
    // 必须用独立进程写标记：execFileSync 会阻塞事件循环，本进程的 timer 发不出来
    const flagPath = path.join(env.KK_INSTALL, 'update-boot-ok.flag');
    const code = 'setTimeout(function(){try{require("fs").writeFileSync(' +
      JSON.stringify(flagPath) + ',String(Date.now()))}catch(e){}},' + flagDelayMs + ')';
    helper = cp.spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true });
    helper.unref();
  }
  try {
    cp.execFileSync('cmd.exe', ['/c', path.join(env.KK_SRC, '..', 'update.bat')],
      { cwd: env.KK_SRC, env, stdio: 'ignore', timeout: 120000 });
  } catch (e) { /* 批处理退出码不参与判定 */ }
  if (helper) { try { helper.kill(); } catch (e) { } }
  return Date.now() - t0;
}

const results = [];
const check = (name, cond) => results.push({ name, pass: !!cond });

function state(env, inst) {
  return {
    exe: fs.existsSync(path.join(inst, EXE)),
    old: fs.existsSync(path.join(inst, EXE + '.old')),
    appjs: r(path.join(inst, 'resources/app/app.js')),
    data: r(path.join(inst, 'todo-data.json')),
    log: r(path.join(inst, 'update.log')) || '',
    fail: fs.existsSync(path.join(inst, 'update-failed.flag')),
    backups: fs.existsSync(path.join(inst, 'backups/keep.txt')),
    srcLeft: fs.existsSync(env.KK_SRC)
  };
}

console.log('用例1：正常升级（新版 3 秒后报到）');
{
  const s = setup('t1', 'ok'), env = mkEnv(s);
  const ms = run(env, 3000), c = state(env, s.install);
  console.log('  耗时 ' + ms + 'ms');
  check('1.1 新文件已覆盖', c.appjs === 'NEW');
  check('1.2 新增文件已落地', r(path.join(s.install, 'newfile.dll')) === 'NEWFILE');
  check('1.3 用户数据未被覆盖', c.data === '{"keep":true}');
  check('1.4 *.log 未被包覆盖', r(path.join(s.install, 'app.log')) === null);
  check('1.5 backups 目录保留', c.backups);
  check('1.6 成功后删除 .old', c.old === false);
  check('1.7 未写失败标记', c.fail === false);
  check('1.8 清理临时目录', c.srcLeft === false);
  check('1.9 主程序在', c.exe);
}

console.log('用例2：新版起不来（一直不报到）→ 必须回滚');
{
  const s = setup('t2', 'ok'), env = mkEnv(s);
  const ms = run(env, 0), c = state(env, s.install);
  console.log('  耗时 ' + ms + 'ms');
  check('2.1 旧版 app.js 已恢复', c.appjs === 'OLD');
  check('2.2 主程序存在', c.exe);
  check('2.3 写了失败标记', c.fail);
  check('2.4 日志含 ROLLBACK', /ROLLBACK/.test(c.log));
  check('2.5 用户数据完好', c.data === '{"keep":true}');
  check('2.6 清理临时目录', c.srcLeft === false);
}

console.log('用例3：包损坏（解压失败）→ 必须回滚且文件不变');
{
  const s = setup('t3', 'broken'), env = mkEnv(s);
  run(env, 0);
  const c = state(env, s.install);
  check('3.1 旧版 app.js 未被污染', c.appjs === 'OLD');
  check('3.2 主程序存在', c.exe);
  check('3.3 日志含 FAIL unzip', /FAIL unzip/.test(c.log));
  check('3.4 写了失败标记', c.fail);
}

console.log('用例4：包内缺主程序 → 必须拒绝覆盖');
{
  const s = setup('t4', 'noexe'), env = mkEnv(s);
  run(env, 0);
  const c = state(env, s.install);
  check('4.1 旧版 app.js 未被污染', c.appjs === 'OLD');
  check('4.2 日志含 FAIL exe not found', /FAIL exe not found/.test(c.log));
  check('4.3 主程序存在', c.exe);
}

rm(ROOT);

const bad = results.filter((x) => !x.pass);
console.log('\n=========== 结果 ===========');
results.forEach((x) => console.log((x.pass ? 'PASS ' : 'FAIL ') + x.name));
console.log('----------------------------');
console.log(bad.length === 0
  ? '全部通过（' + results.length + ' 项）'
  : bad.length + ' 项失败 / 共 ' + results.length + ' 项');
process.exit(bad.length === 0 ? 0 : 1);
