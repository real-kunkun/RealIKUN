// ═══════════════════════════════════════════════════════
// 坤坤日报 3.0.0 主进程
//
// 与 2.x 的差别：
//   · 界面换成「练习室」，数据结构见 data-layer.js（v8）
//   · 删除：下班提醒、日间/夜间模式、导出导入
//   · 保留：无边框窗口/拖拽/贴边、托盘、开机自启、关窗后台、检查更新、久坐起身提醒
//   · 更新改为 GitHub 单包：下载 → 解压覆盖 → 重启，并保证桌面图标存在
// ═══════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, screen, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const DL = require('./data-layer.js');
const WX = require('./weather.js');
const { checkForUpdate } = require('./update-check.js');

// ── 本地测试环境标记 ────────────────────────────────────
// 同目录存在 LOCAL_TEST_ENV 这个空文件，就说明这是「坤坤日报本地测试环境」的拷贝。
// 正式版没有这个文件，一行代码都不会多跑。
// 目的：让测试环境绝不碰正式版的桌面快捷方式、开机自启、单实例锁和更新通道。
const LOCAL_TEST = (() => {
  try { return fs.existsSync(path.join(__dirname, 'LOCAL_TEST_ENV')); }
  catch (e) { return false; }
})();

// 默认使用 GPU 硬件加速：弹窗背景虚化、卡片 3D 翻转、多路常驻动效都依赖合成器。
// 实测强制软件渲染时，全屏模糊会把整屏钉在 ~30fps（33ms/帧，静止也一样）。
// 老显卡若出现黑屏/闪烁，在快捷方式目标后加 --disable-gpu 回退（Electron 内置参数）。

if (process.platform === 'win32') {
  // AppUserModelID 决定任务栏分组与通知归属，测试环境必须用另一个，
  // 否则两个程序的图标会被 Windows 合并成一个
  app.setAppUserModelId(LOCAL_TEST ? 'com.kunkun.todo-daily.test' : 'com.kunkun.todo-daily');
}

// 缓存/本地存储也分开：默认都落在 %APPDATA%\todo-daily，共用会互相顶掉
if (LOCAL_TEST) {
  try { app.setPath('userData', path.join(app.getPath('appData'), 'todo-daily-test')); } catch (e) {}
}

// ── 版本号 ───────────────────────────────────────────────
// 唯一来源：同目录 package.json 的 version 字段（改版本只改那一处）
const APP_VERSION = (() => {
  try { return String(require('./package.json').version || '0.0.0'); }
  catch (e) { return '0.0.0'; }
})();

// 升级检测地址：公开仓库 raw 直链，配置在 package.json 的 updateUrl
const UPDATE_URL = (() => {
  try { return String(require('./package.json').updateUrl || ''); } catch (e) { return ''; }
})();

let mainWindow = null;
let tray = null;
let trayMenu = null;
let forceQuit = false;
let latestRemoteInfo = null;
let updating = false;

// ── 数据目录与文件 ──────────────────────────────────────
// 绿色版：数据跟 exe 放一起（解压到哪数据就在哪）；目录不可写时退回 userData
let DATA_DIR = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
try {
  if (app.isPackaged) fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  DATA_DIR = app.getPath('userData');
}
const DATA_FILE = path.join(DATA_DIR, 'todo-data.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 30;
// 提醒音乐：跟数据放在同一个可写目录（绿色版＝exe 旁边），单独一个 music 文件夹。
// 用户可以自己把歌拖进去，也可以在提醒卡上点「＋」用系统选文件框加进来 ——
// 两条路最终都落到这个目录，所以列表永远只认这一个来源。
// 注意：①不要放进 resources/app，那里升级时会被整包覆盖，用户放进去的歌会没；
//       ②目录名必须是 ASCII（music）—— 更新脚本 buildUpdateBat() 用 'ascii' 写盘，
//         /XD 里写中文会变成问号，升级的备份/覆盖就跳不过这个目录。
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const MUSIC_EXTS = ['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.opus', '.wma'];

// ── 更新回执（与一键更新的批处理约定的文件）─────────────
// 新版启动后必须在 INSTALL_DIR 里留下 update-boot-ok.flag，
// 批处理等不到这个文件就把备份换回去 —— 这是"升级后打不开"的唯一兜底。
// 注意：这里固定用 exe 所在目录，不能用 DATA_DIR（目录不可写时它会退回 userData，
// 批处理就永远收不到回执，每次更新都会被误判成失败）。
const INSTALL_DIR = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
const BOOT_OK_FLAG = path.join(INSTALL_DIR, 'update-boot-ok.flag');
const UPDATE_FAIL_FLAG = path.join(INSTALL_DIR, 'update-failed.flag');
const UPDATE_LOG_FILE = path.join(INSTALL_DIR, 'update.log');

const SCHEMA_VERSION = DL.SCHEMA_VERSION;
const MIGRATE_DIR = path.join(BACKUP_DIR, 'migrate');

let dataLocked = false;       // 数据由更高版本写入 → 只读保护
let migrationNote = '';       // 本次启动做过格式升级的说明

// ── 崩溃日志 ────────────────────────────────────────────
function writeCrashLog(tag, err) {
  try {
    const line = '[' + new Date().toISOString() + '] ' + tag + ': ' +
      (err && err.stack ? err.stack : String(err)) + '\n';
    fs.appendFileSync(path.join(DATA_DIR, 'error.log'), line, 'utf8');
  } catch (e) {
    console.error(tag, err);
  }
}
process.on('uncaughtException', (err) => { writeCrashLog('uncaughtException', err); });
process.on('unhandledRejection', (reason) => { writeCrashLog('unhandledRejection', reason); });

// ── 更新回执 / 回滚提示 ─────────────────────────────────
// 什么时候算"这次更新真的成功"：界面脚本跑到 api.loadData() 那一步。
// 只建出窗口还不够 —— 覆盖失败时窗口照样能建出来，只是空白。
// 所以回执挂在 load-data 这个 IPC 上（app.js 启动必调），一次就够。
let bootMarked = false;
function markBootOk() {
  if (bootMarked) return;
  bootMarked = true;
  try { fs.writeFileSync(BOOT_OK_FLAG, String(Date.now()), 'utf8'); } catch (e) { }
}

// 上次更新被批处理回滚了 → 首次启动时告诉用户，然后抹掉标记（只提示一次）。
// 3.0.3 起交给渲染层用应用内弹窗显示（原生 dialog 跟漫画风完全两套语言）。
// 必须等渲染层注册好 onUpdateRollback 监听才推：用 did-finish-load + 延迟兜底。
function reportUpdateRollback() {
  try {
    if (!fs.existsSync(UPDATE_FAIL_FLAG)) return;
    let info = '';
    try { info = (fs.readFileSync(UPDATE_FAIL_FLAG, 'utf8') || '').trim(); } catch (e) { }
    try { fs.unlinkSync(UPDATE_FAIL_FLAG); } catch (e) { }
    const send = () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
          mainWindow.webContents.send('update-rollback', { info: info });
        } else {
          setTimeout(send, 400);   // 页面还没加载完，稍后再试
        }
      } catch (e) { }
    };
    setTimeout(send, 900);
  } catch (e) { }
}

// 清理历史更新残留：进程被强杀时 temp 里会留下上百 MB 的解压目录
// 注意：刚更新完重启的那一次，批处理还在用 %TEMP%\kk-update-<ts> 里的 bak/ext 目录
// （启动成功后它才收尾，失败时还要拿 bak 回滚）。所以这里只清「30 分钟以前」的，
// 不能一上来就全删 —— 否则新版启动瞬间就把回滚备份删了，更新失败就救不回来。
function cleanStaleUpdateDirs() {
  try {
    const tmp = app.getPath('temp');
    const now = Date.now();
    for (const name of fs.readdirSync(tmp)) {
      if (!/^kk-update-\d+$/.test(name)) continue;
      const dir = path.join(tmp, name);
      try {
        const st = fs.statSync(dir);
        let stamp = st.mtimeMs;
        /* 真正能说明「批处理正在用这里」的是 bak/ 目录的创建时间：
           更新包可能下载了很久，外层 kk-update-* 早就建好了，但 bak 是批处理
           启动后才现建的，用它判断才不会把还在回滚用的备份当垃圾删掉。 */
        try {
          const b = fs.statSync(path.join(dir, 'bak'));
          if (b.mtimeMs > stamp) stamp = b.mtimeMs;
        } catch (e) { }
        if (now - stamp < 30 * 60 * 1000) continue;
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) { }
    }
  } catch (e) { }
}

// 统一读 JSON：兼容记事本保存时写入的 UTF-8 BOM
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}

// ── 自动检查更新的节奏 ──────────────────────────────────
// 用户定的规则：① 每天只静默查一次（不是每次启动都查）；
//             ② 点了「先不更新」就不再提示这个版本，手动点「开团」仍能查出来。
// 状态单独放一个小文件，不塞进 todo-data.json —— 它属于「程序状态」而不是用户数据，
// 不该跟着数据一起被备份/迁移，也不该让渲染层有机会改它。文件坏了就自愈成空对象。
const UPDATE_STATE_FILE = path.join(DATA_DIR, 'update-state.json');
function readUpdateState() {
  try {
    if (!fs.existsSync(UPDATE_STATE_FILE)) return {};
    const o = readJson(UPDATE_STATE_FILE);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) {
    return {};
  }
}
function writeUpdateState(patch) {
  try {
    const next = Object.assign(readUpdateState(), patch || {});
    fs.writeFileSync(UPDATE_STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) {
    writeCrashLog('writeUpdateState', e);
    return null;
  }
}

// ── 数据层 ──────────────────────────────────────────────
// 结构定义与版本迁移集中在 data-layer.js，这里只负责「读写 + 快照 + 日志」

function snapshotBeforeMigrate(tag, fromVersion) {
  try {
    if (!fs.existsSync(DATA_FILE)) return '';
    if (!fs.existsSync(MIGRATE_DIR)) fs.mkdirSync(MIGRATE_DIR, { recursive: true });
    const dst = path.join(MIGRATE_DIR, 'v' + fromVersion + '-' + tag + '-' + Date.now() + '.json');
    fs.copyFileSync(DATA_FILE, dst);
    return dst;
  } catch (e) {
    console.error('升级前快照失败', e);
    return '';
  }
}

function appendMigrateLog(entry) {
  try {
    if (!fs.existsSync(MIGRATE_DIR)) fs.mkdirSync(MIGRATE_DIR, { recursive: true });
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n';
    fs.appendFileSync(path.join(MIGRATE_DIR, 'migrate.log'), line, 'utf8');
  } catch (e) { }
}

function loadData() {
  let raw = null;
  let broken = '';
  try {
    if (fs.existsSync(DATA_FILE)) raw = readJson(DATA_FILE);
  } catch (e) {
    // 文件损坏：必须把原文件「移走」而不是只留副本，
    // 否则随后任意一次 save 都会用空数据覆盖它，原始内容永久丢失。
    console.error('加载数据失败', e);
    const target = DATA_FILE + '.corrupt-' + Date.now() + '.json';
    try {
      fs.renameSync(DATA_FILE, target);
      broken = target;
    } catch (e2) {
      try { fs.unlinkSync(DATA_FILE); } catch (e3) { }
    }
    raw = null;
  }

  const res = DL.applyMigrations(raw);

  if (res.tooNew) {
    dataLocked = true;
    migrationNote = '数据文件由更高版本创建（v' + res.from + '），已进入只读保护';
    console.error('数据版本高于当前程序，已禁止写入：v' + res.from + ' / 程序 v' + SCHEMA_VERSION);
    return res.data;
  }

  if (!raw) {
    if (broken) migrationNote = '数据文件无法读取，已留档为 ' + path.basename(broken) + '，本次以空数据启动';
    return res.data;
  }

  if (res.migrated) {
    // 升级：先留原始快照，再立刻把结果写盘，保证磁盘上始终是自洽的新格式
    const snap = snapshotBeforeMigrate('pre-upgrade', res.from);
    appendMigrateLog({
      from: res.from, to: res.to, steps: res.steps,
      stats: res.stats, snapshot: snap ? path.basename(snap) : ''
    });
    migrationNote = '数据格式已升级 v' + res.from + ' → v' + res.to +
      '：日报 ' + res.stats.migratedReports + ' 条已并入日记，原待办清空 ' + res.stats.droppedTodos + ' 条';
  }
  return res.data;
}

let appData = loadData();
if (!dataLocked && migrationNote && appData) {
  try { writeDataAtomically(appData); } catch (e) { console.error('写回升级后的数据失败', e); }
}

// 原子替换数据文件：唯一临时文件 + fsync + rename，写前留一份 todo-data.json.bak
function writeDataAtomically(data) {
  const tmp = DATA_FILE + '.tmp-' + process.pid + '-' + Date.now();
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(DATA_FILE)) {
      try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (e) { console.error('生成写前副本失败', e); }
    }
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { }
    throw e;
  }
}

function saveData() {
  if (dataLocked) return false;
  try {
    appData.schemaVersion = SCHEMA_VERSION;
    writeDataAtomically(appData);
    backupDaily();
    return true;
  } catch (e) {
    console.error('保存数据失败', e);
    return false;
  }
}

// ── 每日快照：每天首份数据保留一份，最多 BACKUP_KEEP 份 ──
let lastBackupDay = '';

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

function backupDaily() {
  try {
    const day = fmtDate(new Date());
    if (lastBackupDay === day) return;
    if (!fs.existsSync(DATA_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const dst = path.join(BACKUP_DIR, day + '.json');
    if (!fs.existsSync(dst)) fs.copyFileSync(DATA_FILE, dst);
    lastBackupDay = day;
    pruneBackups();
  } catch (e) {
    console.error('生成快照失败', e);
  }
}

function pruneBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    while (files.length > BACKUP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (e) { }
    }
  } catch (e) {
    console.error('清理旧快照失败', e);
  }
}

// ── 桌面快捷方式 ────────────────────────────────────────
// 每次启动都检查：没有就建，有就更新指向（解压到别处/更新后路径变了都能自愈）。
// 不指定 icon，直接用 exe 自带图标。
function ensureDesktopShortcut() {
  if (!app.isPackaged) return;
  // 测试环境绝不写桌面快捷方式：它会覆盖正式版那个同名 .lnk，导致桌面上点开的是测试版
  if (LOCAL_TEST) return;
  try {
    const exe = process.execPath;
    const lnk = path.join(app.getPath('desktop'), '坤坤日报.lnk');
    const opts = {
      target: exe,
      cwd: path.dirname(exe),
      description: '坤坤日报 · 练习室',
      // 显式指回 exe 自己：不写这个字段的话，「更新模式」会保留 lnk 里历史遗留的
      // IconLocation，旧路径被删后桌面图标就悬空了
      icon: exe,
      iconIndex: 0
    };
    const exist = fs.existsSync(lnk);
    const ok = shell.writeShortcutLink(lnk, exist ? 'update' : 'create', opts);
    if (!ok && exist) {
      try { fs.unlinkSync(lnk); } catch (e) { }
      shell.writeShortcutLink(lnk, 'create', opts);
    }
  } catch (e) {
    writeCrashLog('ensureDesktopShortcut', e);
  }
}

// ── 无边框窗口拖拽 ──────────────────────────────────────
const WIN_CONTROL_ACTIONS = ['minimize', 'close', 'toggle-maximize', 'is-maximized',
  'drag-start', 'drag-move', 'drag-end'];
const WIN_SNAP_SIDES = ['left', 'right', 'top', 'bottom',
  'top-left', 'top-right', 'bottom-left', 'bottom-right'];
let winDragState = null;

function applyWindowSnap(win, side) {
  if (!win || win.isDestroyed()) return;
  if (side === 'top') { win.maximize(); return; }
  if (win.isMaximized()) win.unmaximize();
  const [x, y] = win.getPosition();
  const disp = screen.getDisplayNearestPoint({ x, y });
  const wa = disp.workArea;
  const hw = Math.round(wa.width / 2), hh = Math.round(wa.height / 2);
  let b = null;
  if (side === 'left') b = { x: wa.x, y: wa.y, width: hw, height: wa.height };
  else if (side === 'right') b = { x: wa.x + hw, y: wa.y, width: wa.width - hw, height: wa.height };
  else if (side === 'bottom') b = { x: wa.x, y: wa.y + hh, width: wa.width, height: wa.height - hh };
  else if (side === 'top-left') b = { x: wa.x, y: wa.y, width: hw, height: hh };
  else if (side === 'top-right') b = { x: wa.x + hw, y: wa.y, width: wa.width - hw, height: hh };
  else if (side === 'bottom-left') b = { x: wa.x, y: wa.y + hh, width: hw, height: wa.height - hh };
  else if (side === 'bottom-right') b = { x: wa.x + hw, y: wa.y + hh, width: wa.width - hw, height: wa.height - hh };
  if (b) win.setBounds(b, true);
}

// ── 窗口 ────────────────────────────────────────────────
function createWindow(hidden) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    title: '坤坤日报',
    backgroundColor: '#F4ECD7',
    show: !hidden,
    icon: path.join(__dirname, 'icon.png'),
    // 无边框：标题栏与右上三个按钮全部自绘，拖拽/贴边走 win-control IPC
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /* 窗口收进托盘 / 切到别的应用时，Chromium 默认把渲染层定时器节流到每分钟一次。
         久坐倒计时、天气自动刷新都挂在渲染层的定时器上，被节流后数字就不动了，
         用户会以为「后台不计时」。这里关掉节流：代价只是后台每秒一次极轻的 DOM 更新，
         换来倒计时始终准确。（主进程的 suTick 本来就不受这个影响。） */
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    if (forceQuit) return;
    e.preventDefault();
    const keep = !!(appData && appData.settings && appData.settings.keepRunning);
    if (keep) hideToTray();
    else setImmediate(doQuit);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function hideToTray() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function doQuit() {
  forceQuit = true;
  if (tray) { try { tray.destroy(); } catch (e) { } tray = null; }
  app.quit();
}

// ── 托盘 ────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let icon;
  try {
    icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  } catch (e) {
    console.error('托盘图标解码失败，使用空图标', e);
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('坤坤日报');
  // 原生托盘菜单改不了样式，改成自绘窗口（见 showTrayMenu）
  tray.on('right-click', () => showTrayMenu());
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) hideToTray();
    else showMainWindow();
  });
}

// ── 托盘右键菜单（自绘）──────────────────────────────────
// Windows 的 Tray 上下文菜单是系统原生控件，颜色/圆角一律改不了，
// 所以自己开一个 transparent 小窗当菜单：位置贴着光标，失焦或选完就收起。
// 窗口尺寸要与 tray-menu.html 里 body 的 padding 对齐，否则卡片硬投影会被窗口边缘裁掉。
const TRAY_MENU = { w: 190, h: 132, cardW: 172, cardH: 116, padL: 8, padT: 7, shadow: 10 };

function ensureTrayMenu() {
  if (trayMenu && !trayMenu.isDestroyed()) return trayMenu;
  trayMenu = new BrowserWindow({
    width: TRAY_MENU.w,
    height: TRAY_MENU.h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,          // 硬投影用 CSS 画，系统阴影会让透明边缘发灰
    webPreferences: {
      preload: path.join(__dirname, 'tray-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  try { trayMenu.setAlwaysOnTop(true, 'pop-up-menu'); } catch (e) { }
  trayMenu.loadFile('tray-menu.html');
  trayMenu.on('blur', () => hideTrayMenu());
  trayMenu.on('closed', () => { trayMenu = null; });
  return trayMenu;
}

function hideTrayMenu() {
  if (trayMenu && !trayMenu.isDestroyed() && trayMenu.isVisible()) trayMenu.hide();
}

function showTrayMenu() {
  const win = ensureTrayMenu();
  if (win.isVisible()) { win.hide(); return; }   // 再点一次 = 收起

  // 锚点优先用托盘图标自己的矩形：鼠标位置在托盘"展开面板"里会与实际图标错位，
  // 只靠光标定位会让菜单离图标忽远忽近。
  let ib = null;
  try { ib = (tray && typeof tray.getBounds === 'function') ? tray.getBounds() : null; } catch (e) { ib = null; }
  const pt = screen.getCursorScreenPoint();
  const hasIcon = !!(ib && ib.width > 1 && ib.height > 1);
  const ax = hasIcon ? (ib.x + ib.width) : pt.x;   // 图标右边缘
  const ay = hasIcon ? ib.y : pt.y;                // 图标顶边
  const ah = hasIcon ? ib.height : 0;

  const disp = screen.getDisplayNearestPoint({ x: ax, y: ay });
  // 用整块屏幕而不是 workArea：原生托盘菜单本来就浮在任务栏上，限制在 workArea 里会显得离图标很远
  const db = disp.bounds;

  // 常态（任务栏在底部）：卡片右边缘贴图标右边缘，底边贴图标上沿，
  // 让 4px 硬投影刚好压住图标头顶一点，视觉上就是"挂在图标上"
  let x = Math.round(ax + 2 - TRAY_MENU.cardW - TRAY_MENU.padL);
  let y = Math.round(ay - 2 - TRAY_MENU.cardH - TRAY_MENU.padT);
  // 上方空间不够（任务栏在顶部 / 图标贴顶）→ 翻到图标下方
  if (y < db.y + 2) y = Math.round(ay + ah + 8 - TRAY_MENU.padT);
  // 左侧不够放整张卡（图标靠屏幕左缘）→ 贴着图标往右弹
  if (x < db.x + 2) x = Math.round(ax - 2 - TRAY_MENU.padL);
  // 只保证"卡片本体"在屏内：窗口右侧/底部那点留白是给硬投影的，可以出屏
  const maxX = db.x + db.width - 2 - (TRAY_MENU.padL + TRAY_MENU.cardW);
  const maxY = db.y + db.height - 2 - (TRAY_MENU.padT + TRAY_MENU.cardH);
  x = Math.max(db.x + 2 - TRAY_MENU.padL, Math.min(x, maxX));
  y = Math.max(db.y + 2 - TRAY_MENU.padT, Math.min(y, maxY));
  win.setBounds({ x: x, y: y, width: TRAY_MENU.w, height: TRAY_MENU.h });
  win.show();
  win.focus();
}

// ── 一键更新（GitHub 单包）────────────────────────────────
// 下载完整压缩包到临时目录 → 写一个 ascii 批处理 → 派发并退出
// → 批处理等进程退出后解压、覆盖程序文件（保留 todo-data.json 与 backups）→ 重启。
// 版本包是 .7z，解压用随包携带的 7zr.exe（先复制到临时目录，避免覆盖时被占用）。
// ── 更新包下载器 ───────────────────────────────────────
// 国内网络下 github.com / release-assets 这两个域名经常不可达，所以下载这一环
// 和「检测更新」一样要兜住三件事：
//   ① 传输层用 Electron 的 net（走 Chromium 网络栈，自动遵循系统代理），
//      而不是 Node 原生 https —— 后者无视系统代理，挂了代理也照样直连。
//   ② 多源竞速/接力：官方直链 → version.json 里配置的 mirrors（加速站），
//      一个源失败或校验不过就换下一个，镜像列表可远程改，不用重新发版。
//   ③ 大包容易断：支持 Range 的源走 8 路分片并发（单源限速时多连接能叠加），
//      每片独立超时重试。
// 安全底线：从第三方加速站下 exe 必须校验 SHA256，对不上就当这个源被投毒，换源重下。
// 没有校验值就根本不下载 —— 宁可更新失败，也不能装来路不明的包。
const MAX_PKG_BYTES = 500 * 1024 * 1024;   // 单包上限，防伪造超大 Content-Range 写爆磁盘
function hdr(headers, name) {
  if (!headers) return '';
  const lower = String(name).toLowerCase();
  for (const k in headers) { if (String(k).toLowerCase() === lower) return headers[k]; }
  return '';
}

function netFetch(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = net.request({
        url: url,
        method: 'GET',
        redirect: 'follow',
        headers: Object.assign({ 'User-Agent': 'kunkun-daily-updater' }, headers || {})
      });
    } catch (e) { return done({ ok: false, reason: 'request-failed' }); }

    const killer = setTimeout(() => {
      try { req.abort(); } catch (e) { }
      done({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    req.on('response', (res) => {
      clearTimeout(killer);
      const code = res.statusCode;
      done({ ok: code === 200 || code === 206, status: code, headers: res.headers, res: res, req: req });
    });
    req.on('error', () => { clearTimeout(killer); done({ ok: false, reason: 'network-error' }); });
    try { req.end(); } catch (e) { clearTimeout(killer); done({ ok: false, reason: 'request-failed' }); }
  });
}

// 探测：拿总大小、判断是否支持 Range（206 才支持分片）
async function probeSource(url, timeoutMs) {
  const r = await netFetch(url, { Range: 'bytes=0-0' }, timeoutMs);
  if (!r.ok) {
    try { if (r.req) r.req.abort(); } catch (e) { }
    return { ok: false, reason: r.reason || ('http-' + r.status) };
  }
  const cr = String(hdr(r.headers, 'content-range') || '');
  const m = /\/(\d+)\s*$/.exec(cr);
  const size = m ? parseInt(m[1], 10) : (parseInt(hdr(r.headers, 'content-length') || '0', 10) || 0);
  try { if (r.req) r.req.abort(); } catch (e) { }
  if (!(size > 0)) return { ok: false, reason: 'bad-size' };
  if (size > MAX_PKG_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, size: size, range: r.status === 206 };
}

// 单片下载：Range 模式下写到文件的 start 偏移处
function downloadChunk(url, dest, start, end, useRange, onBytes) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      const headers = { 'User-Agent': 'kunkun-daily-updater' };
      if (useRange) headers.Range = 'bytes=' + start + '-' + end;
      req = net.request({ url: url, method: 'GET', redirect: 'follow', headers: headers });
    } catch (e) { return reject(new Error('request-failed')); }

    let idle = null;
    const arm = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        try { req.abort(); } catch (e) { }
        reject(new Error('timeout'));
      }, 30000);
    };
    arm();

    req.on('response', (res) => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        clearTimeout(idle);
        try { res.resume(); } catch (e) { }
        return reject(new Error('http-' + res.statusCode));
      }
      const ws = fs.createWriteStream(dest, { flags: 'r+', start: useRange ? start : 0 });
      let got = 0;
      res.on('data', (c) => { got += c.length; arm(); onBytes(got); });
      res.on('error', (e) => { clearTimeout(idle); try { ws.destroy(); } catch (e2) { } reject(e); });
      ws.on('error', (e) => { clearTimeout(idle); reject(e); });
      ws.on('finish', () => { clearTimeout(idle); resolve(); });
      res.pipe(ws);
    });
    req.on('error', () => { clearTimeout(idle); reject(new Error('network-error')); });
    try { req.end(); } catch (e) { clearTimeout(idle); reject(new Error('request-failed')); }
  });
}

// 单源完整下载：支持 Range 就 8 路分片，否则单流
async function downloadFromSource(url, dest, size, useRange, onProgress) {
  let totalLoaded = 0;
  let lastEmit = 0;
  const emit = (delta) => {
    totalLoaded += delta;
    const now = Date.now();
    if (onProgress && (now - lastEmit > 200 || totalLoaded >= size)) {
      lastEmit = now;
      onProgress(totalLoaded, size);
    }
  };

  // 预分配文件（分片各写自己的偏移，必须先有长度）
  try { fs.writeFileSync(dest, Buffer.alloc(0)); fs.truncateSync(dest, size); } catch (e) { }

  const chunks = useRange ? Math.max(1, Math.min(8, Math.ceil(size / (2 * 1024 * 1024)))) : 1;
  const per = Math.ceil(size / chunks);
  const tasks = [];
  for (let i = 0; i < chunks; i++) {
    const start = i * per;
    const end = Math.min(size - 1, start + per - 1);
    const prev = { n: 0 };
    tasks.push(downloadChunk(url, dest, start, end, useRange, (got) => {
      emit(got - prev.n);
      prev.n = got;
    }));
  }
  await Promise.all(tasks);
  return totalLoaded;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// 可用磁盘空间（取不到就返回 -1，由调用方决定是否跳过检查）
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (e) { return -1; }
}

// 多源接力下载：每个源最多试 2 轮，失败/校验不过就换下一个
// 校验值缺失时直接拒下（fail-closed）：放行一个没校验的包，等于把安装权限交给下载源。
async function downloadPackage(sources, destPath, onProgress, expectedSha) {
  if (!sources || !sources.length) throw new Error('没有可用的下载地址');
  const want = String(expectedSha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) {
    throw new Error('更新配置里缺少有效的 SHA256 校验值，为安全起见已拒绝下载');
  }
  let lastErr = null;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const p = await probeSource(src, 15000);
        if (!p.ok) { lastErr = new Error('源' + (i + 1) + ' 探测失败:' + (p.reason || '')); break; }
        await downloadFromSource(src, destPath, p.size, p.range, onProgress);
        const actual = String(await sha256File(destPath)).toLowerCase();
        if (actual !== want) {
          lastErr = new Error('源' + (i + 1) + ' 校验失败(文件被改动或损坏)');
          try { fs.unlinkSync(destPath); } catch (e) { }
          break;   // 这个源不可信，换下一个
        }
        return { size: p.size, source: src };
      } catch (e) {
        lastErr = e;
        try { fs.unlinkSync(destPath); } catch (e2) { }
      }
    }
  }
  throw lastErr || new Error('所有下载源都失败了');
}


// 批处理里只出现 ascii：路径全部通过环境变量传入，规避中文路径＋bat 编码坑
//
// 这份脚本是"升级后打不开"的唯一防线，设计原则：先备份、后覆盖、失败必回滚。
//   ① 等旧进程真正退出（能改名成功＝句柄已释放），最多 30 轮，不再无限循环
//   ② 覆盖前把整个程序目录备份到 temp，用于文件级回滚（不只回滚 exe）
//   ③ 解压看 7-Zip 返回码 + 确认包内真有主程序，不再"目录存在就算成功"
//   ④ 覆盖看 robocopy 返回码（≥8 才算失败）
//   ⑤ 启动新版后等它写 update-boot-ok.flag，等不到就整体回滚再拉起旧版
function buildUpdateBat() {
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    'set "SRC=%KK_SRC%"',
    'set "INSTALL=%KK_INSTALL%"',
    'set "EXE=%KK_EXE%"',
    'set "PKG=%KK_PKG%"',
    'set "SEVEN=%KK_SEVEN%"',
    'set "LOG=%INSTALL%\\update.log"',
    'set "OKF=%INSTALL%\\update-boot-ok.flag"',
    'set "FAILF=%INSTALL%\\update-failed.flag"',
    'set "OLD=%INSTALL%\\%EXE%.old"',
    'set "EXT=%SRC%\\ext"',
    'set "BAK=%SRC%\\bak"',
    '',
    'echo [%date% %time%] update start >>"%LOG%"',
    '',
    'rem cmd was launched with cwd inside SRC, and Windows refuses to delete the',
    'rem current directory -- leaving 500MB+ of temp behind on every update.',
    'rem All paths below are absolute, so stepping out of it is safe.',
    'cd /d "%SystemRoot%" >nul 2>&1',
    '',
    'rem ---- 0) previous run died halfway: restore exe from .old if missing',
    'if not exist "%INSTALL%\\%EXE%" if exist "%OLD%" ren "%OLD%" "%EXE%" >nul 2>&1',
    'if not exist "%INSTALL%\\%EXE%" goto noexe',
    'if exist "%OLD%" del "%OLD%" >nul 2>&1',
    '',
    'rem ---- 1) wait for old process to exit (rename success = handle released)',
    'set /a tries=0',
    ':wait',
    'ren "%INSTALL%\\%EXE%" "%EXE%.old" >nul 2>&1',
    'if not exist "%INSTALL%\\%EXE%" goto unlocked',
    'set /a tries+=1',
    'if %tries% geq 30 goto giveup',
    'ping -n 3 127.0.0.1 >nul',
    'goto wait',
    '',
    ':giveup',
    'echo [%date% %time%] ABORT exe still locked, nothing changed >>"%LOG%"',
    'rd /s /q "%SRC%" >nul 2>&1',
    'start "" "%INSTALL%\\%EXE%"',
    'exit',
    '',
    ':unlocked',
    'rem ---- 2) back up whole install dir for file-level rollback',
    'robocopy "%INSTALL%" "%BAK%" /E /XD backups music /XF update.log update-*.flag >nul 2>&1',
    'if errorlevel 8 echo [%date% %time%] WARN backup incomplete, exe-only rollback >>"%LOG%"',
    '',
    'rem ---- 3) extract: check 7-Zip exit code and that exe exists in package',
    '"%SEVEN%" x "%PKG%" -o"%EXT%" -y >nul 2>&1',
    'if errorlevel 2 goto fail_extract',
    'if not exist "%EXT%" goto fail_extract',
    'set "SRC2="',
    'for /d %%d in ("%EXT%\\*") do if exist "%%d\\%EXE%" set "SRC2=%%d"',
    'if not defined SRC2 goto fail_pkg',
    '',
    'rem ---- 4) copy program files (robocopy returns >=8 on real failure)',
    'robocopy "%SRC2%" "%INSTALL%" /E /XD backups music /XF todo-data.json *.bak error.log *.log update-*.flag >nul 2>&1',
    'if errorlevel 8 goto rollback',
    'if not exist "%INSTALL%\\%EXE%" goto rollback',
    '',
    'rem ---- 5) launch new version and wait for its boot flag (about 25s max)',
    'if exist "%OKF%" del "%OKF%" >nul 2>&1',
    'start "" "%INSTALL%\\%EXE%"',
    'set /a ticks=0',
    ':boot',
    'ping -n 2 127.0.0.1 >nul',
    'if exist "%OKF%" goto success',
    'set /a ticks+=1',
    'if %ticks% geq 25 goto rollback',
    'goto boot',
    '',
    ':success',
    'echo [%date% %time%] OK >>"%LOG%"',
    'if exist "%OKF%" del "%OKF%" >nul 2>&1',
    'if exist "%OLD%" del "%OLD%" >nul 2>&1',
    'rd /s /q "%SRC%" >nul 2>&1',
    'exit',
    '',
    ':rollback',
    'echo [%date% %time%] ROLLBACK new version failed, restoring old >>"%LOG%"',
    'taskkill /f /im "%EXE%" >nul 2>&1',
    'ping -n 3 127.0.0.1 >nul',
    'if exist "%INSTALL%\\%EXE%" del "%INSTALL%\\%EXE%" >nul 2>&1',
    'if exist "%BAK%" robocopy "%BAK%" "%INSTALL%" /E /XD backups music >nul 2>&1',
    'if not exist "%INSTALL%\\%EXE%" if exist "%OLD%" ren "%OLD%" "%EXE%" >nul 2>&1',
    'if not exist "%INSTALL%\\%EXE%" goto noexe',
    'echo %date% %time% >"%FAILF%"',
    'rd /s /q "%SRC%" >nul 2>&1',
    'start "" "%INSTALL%\\%EXE%"',
    'exit',
    '',
    ':fail_extract',
    'echo [%date% %time%] FAIL unzip errorlevel >>"%LOG%"',
    'goto rollback',
    '',
    ':fail_pkg',
    'echo [%date% %time%] FAIL exe not found in package >>"%LOG%"',
    'goto rollback',
    '',
    ':noexe',
    'echo [%date% %time%] FATAL no executable in install dir >>"%LOG%"',
    'rd /s /q "%SRC%" >nul 2>&1',
    'exit'
  ];
  return lines.join('\r\n');
}

async function runOneClickUpdate(onProgress) {
  if (updating) throw new Error('正在更新中');
  const info = latestRemoteInfo;
  if (!info) throw new Error('没有可用的更新信息');
  const pkgUrl = info.url || (Array.isArray(info.parts) && info.parts[0]) || '';
  if (!pkgUrl) throw new Error('更新包地址为空');
  // 官方地址打头，version.json 里配的镜像排在后面当兜底
  const sources = [pkgUrl].concat(Array.isArray(info.mirrors) ? info.mirrors : []);

  updating = true;
  const workDir = path.join(app.getPath('temp'), 'kk-update-' + Date.now());
  fs.mkdirSync(workDir, { recursive: true });
  const pkgPath = path.join(workDir, 'update.7z');

  try {
    // 磁盘预检：包本体 + 解压副本 + 整目录备份，加起来约 700MB，留点余量
    const freeTmp = freeBytes(workDir);
    if (freeTmp >= 0 && freeTmp < 800 * 1024 * 1024) {
      throw new Error('磁盘空间不足：更新过程需要约 800MB 临时空间，当前只剩 ' +
        Math.round(freeTmp / 1024 / 1024) + 'MB');
    }

    await downloadPackage(sources, pkgPath, (loaded, size) => {
      if (onProgress) onProgress({ phase: 'download', loaded, size });
    }, info.sha256 || '');

    const sevenSrc = path.join(__dirname, '7zr.exe');
    const sevenDst = path.join(workDir, '7zr.exe');
    if (!fs.existsSync(sevenSrc)) throw new Error('缺少解压组件 7zr.exe');
    fs.copyFileSync(sevenSrc, sevenDst);

    if (onProgress) onProgress({ phase: 'unzip', pct: 100 });

    /* 必须用 INSTALL_DIR（exe 所在目录），不能用 DATA_DIR：
       DATA_DIR 在「安装目录不可写」时会退回 userData，那样批处理会把新版覆盖到
       用户数据目录去，真正的程序目录一个文件都不动 —— 更新必然失败，还会污染数据。 */
    const installDir = INSTALL_DIR;
    const exeName = path.basename(process.execPath);
    const batPath = path.join(workDir, 'update.bat');
    fs.writeFileSync(batPath, buildUpdateBat(), 'ascii');

    const env = Object.assign({}, process.env, {
      KK_SRC: workDir,
      KK_INSTALL: installDir,
      KK_EXE: exeName,
      KK_PKG: pkgPath,
      KK_SEVEN: sevenDst
    });

    if (onProgress) onProgress({ phase: 'restart', pct: 100 });

    // 更新前再留一份数据快照：覆盖文件不动 todo-data.json，但新版首次启动可能迁移数据，
    // 万一迁移出问题，这一步是最后一道退路
    try { snapshotBeforeMigrate('pre-update', APP_VERSION); } catch (e) { }

    cp.spawn('cmd.exe', ['/c', batPath], {
      cwd: workDir, env, detached: true, stdio: 'ignore', windowsHide: true
    }).unref();

    setTimeout(() => { forceQuit = true; app.quit(); }, 500);
    return true;
  } catch (e) {
    updating = false;
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e2) { }
    throw e;
  }
}

// ── IPC ─────────────────────────────────────────────────
// ── 久坐提醒（起身活动）──────────────────────────────────
// 计时状态只活在内存里：重启就从满间隔重新开始，不落盘、不污染数据结构；
// 只有「开关 + 间隔」这两项配置落在 settings.standup。
// 到点弹过提醒后计时彻底停住（suPending=true），必须用户点按钮才排下一轮 ——
// 否则起身休息的时间会被算进下一段久坐，等于白提醒。
// 用单调时钟（performance.now）而不是 Date.now：系统自动校时不会打乱计时。
let suNextMono = 0;    // 下一跳的单调时刻，0 = 停用中或正在等用户响应
let suPending = false; // 已弹提醒、等按钮，期间不重复弹
let suTipIdx = 0;
// ── 提醒音乐目录工具 ────────────────────────────────────
function ensureMusicDir() {
  try { fs.mkdirSync(MUSIC_DIR, { recursive: true }); return true; }
  catch (e) { writeCrashLog('ensureMusicDir', e); return false; }
}
// 同名文件不覆盖，改成「曲名 (2).mp3」
function uniqueMusicPath(name) {
  let p = path.join(MUSIC_DIR, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name), base = path.basename(name, ext);
  for (let i = 2; i < 1000; i++) {
    p = path.join(MUSIC_DIR, base + ' (' + i + ')' + ext);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(MUSIC_DIR, Date.now() + ext);
}
// 「艺术家 - 曲名」拆分。只认第一个 " - "，曲名里再出现连字符不动。
function musicTracks() {
  ensureMusicDir();
  let files = [];
  try { files = fs.readdirSync(MUSIC_DIR); } catch (e) { return []; }
  return files
    .filter(f => MUSIC_EXTS.indexOf(path.extname(f).toLowerCase()) !== -1)
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((f) => {
      const base = path.basename(f, path.extname(f))
        .replace(/[_ ]*(HQ|hq|无损|FLAC|flac)$/, '')
        .replace(/[_\s]+/g, ' ')
        .trim();
      const cut = base.indexOf(' - ');
      const artist = cut > 0 ? base.slice(0, cut).trim() : '';
      const title = cut > 0 ? base.slice(cut + 3).trim() : base;
      // 用 file:// URL 交给渲染层：音乐目录在 exe 旁边，相对 index.html 要退好几层，
      // 绝对 URL 更稳，中文和空格由 pathToFileURL 负责转义。
      return { file: pathToFileURL(path.join(MUSIC_DIR, f)).href, name: f, title: title, artist: artist };
    });
}

let suCfgSnap = '';    // 上一次的配置快照，用来发现「设置被改了」并重排计时
const SU_MIN = 5, SU_MAX = 240, SU_DEFAULT = 45;
/* 到点弹窗里轮播的那句话（11-17 换成坤味儿：一律围着「站起来打篮球」说事，
   但别写成看不懂的暗语 —— 提醒要能让人立刻起身） */
const SU_TIPS = [
  '坐了俩点儿，篮板都替你着急',
  '小黑子都起身了，你还坐着',
  '两年半的练习生也得中场歇会儿',
  '去接杯水，顺便哼两句只因你太美',
  '唱跳 rap 篮球，先站起来再说',
  '椅子都坐热了，球场可还空着'
];

function suCfg() {
  const s = appData && appData.settings && appData.settings.standup;
  let m = Math.round(Number(s && s.intervalMin));
  if (!isFinite(m) || m <= 0) m = SU_DEFAULT;
  m = Math.min(SU_MAX, Math.max(SU_MIN, m));
  return { enabled: !!(s && s.enabled === true), intervalMin: m };
}

function suState() {
  const c = suCfg();
  const remainMs = (c.enabled && suNextMono) ? Math.max(0, Math.round(suNextMono - performance.now())) : 0;
  return { enabled: c.enabled, intervalMin: c.intervalMin, remainMs: remainMs, pending: suPending };
}

function suBroadcast() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('standup-state', suState());
  } catch (e) { }
}

// 配置变化或刚开启时重排下一跳（关闭则清零）
function suReset() {
  const c = suCfg();
  suPending = false;
  suNextMono = c.enabled ? performance.now() + c.intervalMin * 60000 : 0;
  suBroadcast();
}

// 深夜不打扰：22:00~08:00 不弹，但计时状态一点不动，
// 过了静默时段第一个 tick 就补弹（不会因为静默而漏掉这一轮）
function suSilentNow(d) {
  const h = d.getHours();
  return h >= 22 || h < 8;
}

// 窗口收在托盘里 / 最小化了也要让人看见：先亮出来再送卡
function suReveal() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  } catch (e) { }
}

function suFire() {
  suPending = true;
  suNextMono = 0;
  suBroadcast();
  suReveal();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('show-standup', {
        title: '起来打会儿篮球',
        message: SU_TIPS[suTipIdx++ % SU_TIPS.length],
        intervalMin: suCfg().intervalMin
      });
    }
  } catch (e) { }
}

function suTick() {
  try {
    if (dataLocked || !appData) return;
    const c = suCfg();
    if (!c.enabled) {
      if (suNextMono || suPending) { suPending = false; suNextMono = 0; suBroadcast(); }
      return;
    }
    if (suPending) return;
    if (!suNextMono) { suReset(); return; }
    if (performance.now() < suNextMono) return;
    if (suSilentNow(new Date())) return;
    suFire();
  } catch (e) { writeCrashLog('久坐提醒检查出错', e); }
}

// kind: 'done' 起身了 → 按满间隔重新计；'later' 再坐 10 分钟
function suRespond(kind) {
  const c = suCfg();
  suPending = false;
  if (!c.enabled) { suNextMono = 0; suBroadcast(); return suState(); }
  suNextMono = performance.now() + (kind === 'later' ? 10 : c.intervalMin) * 60000;
  suBroadcast();
  return suState();
}

function registerIpc() {
  ipcMain.on('boot-version', (e) => { e.returnValue = APP_VERSION; });

  // 托盘自绘菜单：选完先收面板再执行动作，避免"菜单还浮在窗口上"
  ipcMain.on('tray-menu-action', (e, action) => {
    hideTrayMenu();
    if (action === 'show') showMainWindow();
    else if (action === 'quit') doQuit();
  });
  ipcMain.on('tray-menu-close', () => hideTrayMenu());

  ipcMain.handle('load-data', () => {
    // 界面脚本跑到这里 = 这次更新装的东西是活的，向批处理报到
    markBootOk();
    return { ok: true, data: appData, version: APP_VERSION, note: migrationNote, locked: dataLocked };
  });

  ipcMain.handle('save-data', (e, data) => {
    if (dataLocked) return { ok: false, locked: true };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'bad-data' };
    appData = Object.assign({}, appData, data);
    appData.schemaVersion = SCHEMA_VERSION;
    const ok = saveData();
    // 久坐配置变了（开关 / 间隔）→ 重排计时；没变就不动，
    // 否则用户每存一次数据倒计时都会被清零，永远等不到提醒。
    try {
      const snap = JSON.stringify(suCfg());
      if (snap !== suCfgSnap) { suCfgSnap = snap; suReset(); }
    } catch (e) { }
    return { ok: ok };
  });

  // 清空本机数据：留一份快照后删除数据文件，再重启回到初始状态
  ipcMain.handle('reset-data', () => {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const keep = path.join(DATA_DIR, 'todo-data.reset-' + Date.now() + '.json');
        try { fs.copyFileSync(DATA_FILE, keep); } catch (e) { }
        fs.unlinkSync(DATA_FILE);
      }
    } catch (e) { }
    forceQuit = true;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle('check-update', async () => {
    // 测试环境不查远端也不许自我覆盖：本地改动会被升级包冲掉
    if (LOCAL_TEST) return { ok: false, reason: 'local-test' };
    if (!UPDATE_URL) return { ok: false, reason: 'no-url' };
    const r = await checkForUpdate(UPDATE_URL, APP_VERSION, 6000);
    if (r && r.ok) {
      if (r.hasUpdate) latestRemoteInfo = r.info;
      // 手动查过也算「今天查过了」：免得刚关掉弹窗，几秒后自动检查又推一遍
      writeUpdateState({ lastCheck: fmtDate(new Date()) });
    }
    return r;
  });

  /* 「先不更新」：记住这个版本，之后自动检查不再为它弹窗。
     不清 skipVersion —— 下次真有更新版本时版本号不同，自然又会提示。 */
  ipcMain.handle('skip-update', (e, version) => {
    const v = String(version || '').trim();
    if (!/^\d+(\.\d+){0,3}$/.test(v)) return { ok: false, error: 'bad-version' };
    const st = writeUpdateState({ skipVersion: v });
    return { ok: !!st, skipVersion: v };
  });

  ipcMain.handle('one-click-update', async () => {
    try {
      if (LOCAL_TEST) throw new Error('本地测试环境不执行自动更新');
      await runOneClickUpdate((p) => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', p); } catch (e) { }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('open-external', (e, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false };
    try { shell.openExternal(url); return { ok: true }; } catch (e) { return { ok: false }; }
  });

  ipcMain.handle('set-auto-start', async (e, enabled) => {
    try {
      // 测试环境不写注册表：Windows 的自启项按应用名登记，会覆盖正式版那一条
      if (LOCAL_TEST) return { ok: true };
      app.setLoginItemSettings({ openAtLogin: enabled === true, args: ['--hidden'] });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // 久坐提醒：状态查询 / 用户响应。配置走 save-data（渲染层改 S.settings.standup 即可）。
  ipcMain.handle('standup-get', () => suState());
  ipcMain.handle('standup-respond', (e, kind) => {
    return suRespond(kind === 'later' ? 'later' : 'done');
  });

  // 休息音乐的播放列表：直接扫 resources/app/audio 目录，丢进去就出现，不用改配置。
  // 曲名按「艺术家 - 曲名」拆；没有连字符就整串当曲名。
  // ── 本地天气 ────────────────────────────────────────────
  // 纯展示：拿不到就返回 null，渲染层直接把那一行隐藏，不弹任何错误
  ipcMain.handle('weather-get', async (e, force) => {
    try { return await WX.getWeather(force === true); } catch (e) { return null; }
  });

  // ── 提醒音乐 ────────────────────────────────────────────
  // 目录不存在就建（首次启动、用户删了文件夹、升级后都靠这一句兜住）
  ipcMain.handle('audio-list', () => {
    return { ok: true, tracks: musicTracks(), dir: MUSIC_DIR };
  });

  // 用系统选文件框加歌：多选，复制进音乐目录，重名自动加序号不覆盖
  // paths 可选：给了就直接用（将来做拖放复用同一个入口），没给就弹系统选文件框
  ipcMain.handle('music-add', async (e, paths) => {
    try {
      ensureMusicDir();
      let picked = Array.isArray(paths) ? paths.filter(p => typeof p === 'string') : null;
      if (!picked || !picked.length) {
        const r = await dialog.showOpenDialog(mainWindow || undefined, {
          title: '选择提醒音乐',
          defaultPath: app.getPath('music'),
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: '音频文件', extensions: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac', 'opus', 'wma'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: true, added: 0, canceled: true };
        picked = r.filePaths;
      }
      let added = 0, skipped = 0;
      const names = [];
      for (const src of picked) {
        if (MUSIC_EXTS.indexOf(path.extname(src).toLowerCase()) === -1) { skipped++; continue; }
        try {
          const dest = uniqueMusicPath(path.basename(src));
          fs.copyFileSync(src, dest);
          names.push(path.basename(dest));
          added++;
        } catch (e) { skipped++; writeCrashLog('music-add copy', e); }
      }
      // names 给渲染层定位到「刚加的那首」，不用它去猜
      return { ok: true, added: added, skipped: skipped, names: names, tracks: musicTracks() };
    } catch (e) {
      writeCrashLog('music-add', e);
      return { ok: false, error: String(e) };
    }
  });

  // 打开音乐文件夹，方便用户直接往里拖
  ipcMain.handle('music-open', async () => {
    try { ensureMusicDir(); } catch (e) { }
    const err = await shell.openPath(MUSIC_DIR);
    return { ok: !err, error: err || '' , dir: MUSIC_DIR };
  });

  ipcMain.handle('win-control', (e, action, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (typeof action !== 'string' || WIN_CONTROL_ACTIONS.indexOf(action) === -1) {
      return { ok: false, error: 'invalid win-control action' };
    }
    if (payload != null && (typeof payload !== 'object' || Array.isArray(payload))) {
      return { ok: false, error: 'invalid win-control payload' };
    }
    if (action === 'drag-end') {
      const side = payload && payload.side;
      if (side != null && (typeof side !== 'string' || WIN_SNAP_SIDES.indexOf(side) === -1)) {
        return { ok: false, error: 'invalid snap side' };
      }
    }
    try {
      switch (action) {
        case 'minimize': mainWindow.minimize(); break;
        case 'close': mainWindow.close(); break;
        case 'toggle-maximize':
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          else mainWindow.maximize();
          break;
        case 'is-maximized': return { ok: true, value: mainWindow.isMaximized() };
        case 'drag-start': {
          if (mainWindow.isMaximized()) return { ok: false, reason: 'maximized' };
          winDragState = {
            cursor: screen.getCursorScreenPoint(),
            bounds: mainWindow.getBounds()
          };
          break;
        }
        case 'drag-move': {
          if (!winDragState) break;
          const st = winDragState;
          const cur = screen.getCursorScreenPoint();
          const x = Math.round(st.bounds.x + (cur.x - st.cursor.x));
          const y = Math.round(st.bounds.y + (cur.y - st.cursor.y));
          if (mainWindow.isMaximized()) mainWindow.unmaximize();
          // 显式带上开始时的宽高：整个拖动过程尺寸锁死，不会越拖越大
          mainWindow.setBounds({ x, y, width: st.bounds.width, height: st.bounds.height });
          break;
        }
        case 'drag-end': {
          const side = payload && payload.side;
          winDragState = null;
          if (side) applyWindowSnap(mainWindow, side);
          break;
        }
        default: return { ok: false, error: 'unknown action' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

// ── 生命周期 ────────────────────────────────────────────
// 测试环境不抢单实例锁：否则正式版开着的时候测试版起不来（反之亦然）
const gotLock = LOCAL_TEST ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      showMainWindow();
    }
  });

  function init() {
    // 先把上次更新留下的残骸清掉（进程被强杀时 temp 里会剩上百 MB）
    try { cleanStaleUpdateDirs(); } catch (e) { writeCrashLog('cleanStaleUpdateDirs', e); }

    try { Menu.setApplicationMenu(null); } catch (e) { writeCrashLog('setApplicationMenu', e); }
    try { createWindow(process.argv.includes('--hidden')); } catch (e) { writeCrashLog('createWindow', e); }
    try { createTray(); } catch (e) { writeCrashLog('createTray', e); }
    try { registerIpc(); } catch (e) { writeCrashLog('registerIpc', e); }
    // 久坐提醒：按已保存的配置排第一跳，之后每秒检查一次
    try {
      suCfgSnap = JSON.stringify(suCfg());
      suReset();
      setInterval(suTick, 1000);
    } catch (e) { writeCrashLog('久坐提醒启动', e); }
    try { ensureDesktopShortcut(); } catch (e) { writeCrashLog('shortcut', e); }

    // 上次更新是被批处理回滚回来的 → 告诉用户一次，别让他以为"更新了个寂寞"
    try { reportUpdateRollback(); } catch (e) { writeCrashLog('reportUpdateRollback', e); }

    // 开机自启状态跟数据里的设置对齐（用户可能在系统里手动改过）
    // 测试环境跳过：同上，会顶掉正式版的自启项
    try {
      if (!LOCAL_TEST && appData && appData.settings) {
        app.setLoginItemSettings({ openAtLogin: !!appData.settings.autoStart, args: ['--hidden'] });
      }
    } catch (e) { }

    /* 启动后延迟静默查一次更新：不卡启动、失败无声，发现新版本才推给界面。
       两个闸门：① 今天已经查过就跳过（每天一次，不是每次开窗都查）；
                ② 用户点过「先不更新」的那个版本不再推（仍可手动「开团」查）。
       只有查成功才记下今天的日期 —— 断网那一次不算，下次启动还会再试。 */
    try {
      if (!LOCAL_TEST && UPDATE_URL) {
        const today = fmtDate(new Date());
        if (readUpdateState().lastCheck !== today) {
          setTimeout(() => {
            checkForUpdate(UPDATE_URL, APP_VERSION, 5000).then((r) => {
              if (!r || !r.ok) return;
              const st = writeUpdateState({ lastCheck: fmtDate(new Date()) }) || {};
              if (!r.hasUpdate || !r.info || !r.info.version) return;
              if (st.skipVersion && st.skipVersion === r.info.version) return;
              latestRemoteInfo = r.info;
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('update-available', r.info);
              }
            }).catch(() => { });
          }, 3500);
        }
      }
    } catch (e) { writeCrashLog('update-auto-check', e); }

    try {
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    } catch (e) { writeCrashLog('activate', e); }
  }

  app.whenReady().then(init).catch((e) => {
    writeCrashLog('whenReady', e);
    try { registerIpc(); } catch (e2) { writeCrashLog('registerIpc(fallback)', e2); }
  });

  app.on('window-all-closed', () => {
    // 驻留托盘，不因窗口关闭而退出
  });
}
