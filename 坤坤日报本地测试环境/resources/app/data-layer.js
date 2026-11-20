// ═══════════════════════════════════════════════════════
// 数据层：结构定义 / 版本迁移
// 纯 Node 模块，不依赖 Electron —— 可以单独跑测试
//
// 3.0.0 起结构与「练习室」界面完全对齐：
//   todos / ideas / habits / books / readDays / ledger / moodLog / journals / settings
//   v8 追加：planDays（计划/目标按天归档） / goalLog（目标动态） / lastPlanDay（上次跨天归档日）
//   注：版本号由用户手动定，SCHEMA_VERSION 保持 8；v8 快照内新增 goals 字段靠 baseNormalize 兼容，无需迁移
//
// 核心约定：
//   1. 每份数据文件都带 schemaVersion（旧文件没有这个字段，一律视为 1）
//   2. 结构改动只在 MIGRATIONS 里加一步，按 v+1 逐级升，禁止改动历史步骤
//   3. 迁移函数必须幂等：同一份数据重复迁移结果不变
//   4. 迁移只做「解释」不做「猜」：语义变化的字段用标记保留歧义
// ═══════════════════════════════════════════════════════
'use strict';

// 当前数据结构版本。改动数据结构时 +1，并在 MIGRATIONS 里补一条同版本号的迁移。
const SCHEMA_VERSION = 8;

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const DEFAULT_DATA = {
  // ── 个人计划（四段式轨道：今天 / 短期 / 中期 / 长期）──
  // { t: 标题, k: 'imp'|'daily'|'heavy', note: 备注, done: 是否完成, hor: 'today'|'short'|'mid'|'long' }
  todos: [],
  // 灵感墙
  ideas: [],
  // 每日锻炼：{ ic: 图标, nm: 名称, hist: { 'YYYY.MM.DD': 1 } }
  habits: [],
  // 阅读：{ nm: 书名, cur: 已读章, total: 总章 }
  books: [],
  curBook: 0,
  // 阅读打卡：{ 'YYYY.MM.DD': 1 }
  readDays: {},
  // 记账：{ d: 说明, a: 金额（支出为负）, ts: 时间戳 }
  ledger: [],
  // 心情日记：{ ts: 时间戳, m: 1~5, t: 正文 }
  moodLog: [],
  moodPick: 0,
  // 工作日报：{ date: 'YYYY.MM.DD 周X', text: 正文, ts: 时间戳 }
  journals: [],
  // 计划/目标历史（v8）：每天一个快照，键为 'YYYY.MM.DD'
  // { items: [{ t, k, note, done }], done, total,
  //   goals: [{ t, k, note, done, hor }], goalDone, goalTotal }
  planDays: {},
  // 目标动态（v8）：阶段目标的新增 / 完成 / 取消完成 / 删除，带时间戳
  // { ts, t, hor: 'short'|'mid'|'long', action: 'added'|'done'|'undone'|'removed' }
  goalLog: [],
  // 上次完成跨天归档的日期（空 = 还没跑过，首次启动只记当天，不归档）
  lastPlanDay: '',
  // 应用设置（原 reminderSettings.autoStart / closeBehavior.keepRunning 迁移到这里）
  settings: {
    motion: true, autoStart: false, keepRunning: false, seenVersion: '',
    /* 久坐提醒：开启后主进程按 intervalMin 循环计时，到点弹起身卡。
       计时状态只在主进程内存里，重启从满间隔重来，所以这里只存配置。 */
    standup: { enabled: false, intervalMin: 45 }
  },
  // 是否已经灌过演示数据：老用户升级后不该被塞一堆示例待办
  seeded: false,
  // 是否已对「历史版本新装时被 seedDemo 灌过演示数据」做过一次性清理。
  // 只删标题/金额/文本完全匹配种子的条目，用户改过的或后建的同名数据不动。
  demoCleaned: false,
  lastVersion: '',
  schemaVersion: SCHEMA_VERSION
};

// ── 基础工具 ──────────────────────────────────────────────
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function genId() { return 'id' + Math.random().toString(36).slice(2, 10); }

// 严格日期：必须是 2026-10-29 这种格式，且真实存在（排除 2026-02-30）
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
  return s;
}

// 严格时间：HH:MM，统一补零
function validTime(s) {
  if (typeof s !== 'string') return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return '';
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return '';
  return pad2(h) + ':' + pad2(mi);
}

function num(v, fallback) {
  return (typeof v === 'number' && isFinite(v)) ? v : fallback;
}

function str(v, fallback) {
  return typeof v === 'string' ? v : (fallback === undefined ? '' : fallback);
}

function todayStr(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

// 'YYYY-MM-DD' → 'YYYY.MM.DD 周X'（练习室界面的日期写法）
function zhDate(ymd) {
  const v = validDate(ymd);
  if (!v) return '';
  const y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
  const dt = new Date(y, m - 1, d);
  return v.replace(/-/g, '.') + ' ' + WEEK_CN[dt.getDay()];
}

// ── 单条记录归一化 ────────────────────────────────────────
function normalizeTodo(raw) {
  const o = isObj(raw) ? raw : {};
  const hor = ['today', 'short', 'mid', 'long'].indexOf(o.hor) >= 0 ? o.hor : 'today';
  const k = ['imp', 'daily', 'heavy'].indexOf(o.k) >= 0 ? o.k : 'daily';
  return {
    t: str(o.t).slice(0, 200),
    k: k,
    note: str(o.note).slice(0, 1000),
    done: o.done === true,
    hor: hor
  };
}

// v8：计划/目标归档快照与目标动态的归一化（每次读写都跑，保证幂等、脏数据进不来）
function normalizePlanItem(raw) {
  const o = isObj(raw) ? raw : {};
  return {
    t: str(o.t).slice(0, 200),
    k: ['imp', 'daily', 'heavy'].indexOf(o.k) >= 0 ? o.k : 'daily',
    note: str(o.note).slice(0, 1000),
    done: o.done === true
  };
}

// v8 扩展：目标快照比计划快照多一个 hor（阶段），其余同构
function normalizeGoalItem(raw) {
  const g = normalizePlanItem(raw);
  g.hor = ['short', 'mid', 'long'].indexOf(isObj(raw) ? raw.hor : '') >= 0 ? raw.hor : 'short';
  return g;
}

function normalizePlanDays(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  Object.keys(raw).forEach(k => {
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(k)) return;
    const d = isObj(raw[k]) ? raw[k] : {};
    const items = (Array.isArray(d.items) ? d.items : []).map(normalizePlanItem).filter(i => i.t);
    const goals = (Array.isArray(d.goals) ? d.goals : []).map(normalizeGoalItem).filter(i => i.t);
    // 允许「只有目标、没有当日计划」的快照存在（v8 会因 items 为空整条丢掉）
    if (!items.length && !goals.length) return;
    out[k] = {
      items: items,
      done: items.filter(i => i.done).length, total: items.length,
      goals: goals,
      goalDone: goals.filter(g => g.done).length, goalTotal: goals.length
    };
  });
  return out;
}

function normalizeGoalLog(raw) {
  const o = isObj(raw) ? raw : {};
  return {
    ts: num(o.ts, Date.now()),
    t: str(o.t).slice(0, 200),
    hor: ['short', 'mid', 'long'].indexOf(o.hor) >= 0 ? o.hor : 'short',
    action: ['added', 'done', 'undone', 'removed'].indexOf(o.action) >= 0 ? o.action : 'added'
  };
}

function normalizeIdea(raw) {
  const o = isObj(raw) ? raw : {};
  return { t: str(o.t).slice(0, 1000) };
}

function normalizeHabit(raw) {
  const o = isObj(raw) ? raw : {};
  const hist = {};
  if (isObj(o.hist)) {
    Object.keys(o.hist).forEach(k => { if (/^\d{4}\.\d{2}\.\d{2}$/.test(k) && o.hist[k]) hist[k] = 1; });
  }
  return {
    ic: str(o.ic, '🏀').slice(0, 8) || '🏀',
    nm: str(o.nm, '锻炼').slice(0, 40) || '锻炼',
    hist: hist
  };
}

function normalizeBook(raw, idx) {
  const o = isObj(raw) ? raw : {};
  const total = Math.max(0, Math.floor(num(o.total, 0)));
  const cur = Math.max(0, Math.floor(num(o.cur, 0)));
  // id 是书架的稳定标识（curBook 存的是 id 不是下标），丢了会让"当前在读"错位
  const id = (typeof o.id === 'number' || (typeof o.id === 'string' && o.id)) ? o.id : (idx + 1);
  const cv = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(str(o.cv)) ? str(o.cv) : '#E8552D';
  return {
    id: id,
    nm: str(o.nm, '未命名').slice(0, 60) || '未命名',
    cur: total ? Math.min(cur, total) : cur,
    total: total,
    cv: cv
  };
}

function normalizeLedger(raw) {
  const o = isObj(raw) ? raw : {};
  const a = num(o.a, 0);
  return {
    d: str(o.d, '一笔').slice(0, 80) || '一笔',
    a: isFinite(a) ? Math.round(a * 100) / 100 : 0,
    ts: num(o.ts, Date.now())
  };
}

function normalizeMood(raw) {
  const o = isObj(raw) ? raw : {};
  const m = Math.floor(num(o.m, 3));
  return {
    ts: num(o.ts, Date.now()),
    m: Math.min(5, Math.max(1, m)),
    t: str(o.t).slice(0, 4000)
  };
}

function normalizeJournal(raw) {
  const o = isObj(raw) ? raw : {};
  return {
    date: str(o.date).slice(0, 24),
    text: str(o.text).slice(0, 20000),
    ts: num(o.ts, Date.now())
  };
}

// 日期键表（readDays）：只保留合法键
function normalizeDayMap(raw) {
  const out = {};
  if (isObj(raw)) {
    Object.keys(raw).forEach(k => { if (/^\d{4}\.\d{2}\.\d{2}$/.test(k) && raw[k]) out[k] = 1; });
  }
  return out;
}

// ── 根结构归一化（每一版都会跑，幂等） ────────────────────
function baseNormalize(raw) {
  const d = JSON.parse(JSON.stringify(DEFAULT_DATA));
  const src = isObj(raw) ? raw : {};

  if (Array.isArray(src.todos)) d.todos = src.todos.map(normalizeTodo).filter(t => t.t);
  if (Array.isArray(src.ideas)) d.ideas = src.ideas.map(normalizeIdea).filter(i => i.t);
  if (Array.isArray(src.habits)) d.habits = src.habits.map(normalizeHabit);
  if (Array.isArray(src.books)) d.books = src.books.map((b, i) => normalizeBook(b, i));
  // curBook 存的是书的 id：找不到就退回第一本
  if (d.books.length) {
    const want = num(src.curBook, null);
    const has = d.books.some(b => b.id === want);
    d.curBook = has ? want : d.books[0].id;
  } else {
    d.curBook = 0;
  }
  d.readDays = normalizeDayMap(src.readDays);
  if (Array.isArray(src.ledger)) d.ledger = src.ledger.map(normalizeLedger);
  if (Array.isArray(src.moodLog)) d.moodLog = src.moodLog.map(normalizeMood);
  d.moodPick = Math.min(5, Math.max(0, Math.floor(num(src.moodPick, 0))));
  if (Array.isArray(src.journals)) d.journals = src.journals.map(normalizeJournal).filter(j => j.text || j.date);
  // 日报按时间倒序：新的在最上面
  d.journals.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // v8：计划历史 / 目标动态必须走归一化，否则 baseNormalize 每次重建 DEFAULT_DATA
  // 会把这几个字段丢掉（历史会在下一次保存时蒸发）。
  d.planDays = normalizePlanDays(src.planDays);
  if (Array.isArray(src.goalLog)) d.goalLog = src.goalLog.map(normalizeGoalLog).filter(g => g.t);
  d.goalLog.sort((a, b) => b.ts - a.ts);
  const lpd = str(src.lastPlanDay);
  d.lastPlanDay = /^\d{4}\.\d{2}\.\d{2}$/.test(lpd) ? lpd : '';

  const st = isObj(src.settings) ? src.settings : {};
  /* 久坐提醒配置：间隔夹在 5~240 分钟，非法值回落到 45。
     baseNormalize 每次从 DEFAULT_DATA 重建，这里漏写就会「保存一次就蒸发」。 */
  const su = isObj(st.standup) ? st.standup : {};
  let suMin = Math.round(Number(su.intervalMin));
  if (!isFinite(suMin) || suMin <= 0) suMin = 45;
  suMin = Math.min(240, Math.max(5, suMin));
  d.settings = {
    motion: st.motion !== false,
    autoStart: st.autoStart === true,
    keepRunning: st.keepRunning === true,
    seenVersion: str(st.seenVersion),
    standup: { enabled: su.enabled === true, intervalMin: suMin }
  };

  d.seeded = src.seeded === true;
  // 兼容 true / 1 两种写法（seedDemo 里写的是数字 1）
  d.demoCleaned = src.demoCleaned === true || src.demoCleaned === 1;
  d.lastVersion = str(src.lastVersion);
  // 刻意丢弃：projects / dailyReports / standUp / reminderSettings / closeBehavior / theme 等 2.x 遗留字段
  return d;
}

// ── 迁移步骤 ──────────────────────────────────────────────
// key = 迁移到第几版；run(data, raw, ctx) 就地修改 data
const MIGRATIONS = {
  2: {
    desc: '字段模型定稿：取消待办等级与子任务',
    run: function () {}
  },
  3: {
    desc: '待办日期语义：计划日 → 截止日期',
    run: function () {}
  },
  4: {
    desc: '待办取消具体的截止时分',
    run: function () {}
  },
  5: {
    desc: '新增起身活动提醒配置',
    run: function () {}
  },
  6: {
    desc: '新增免打扰时段配置',
    run: function () {}
  },
  7: {
    desc: '3.0.0 重构：分类下线、待办清空、日报并入日记（正文前置分类名、标题丢弃）',
    run: function (data, raw, ctx) {
      const src = isObj(raw) ? raw : {};
      const reports = Array.isArray(src.dailyReports) ? src.dailyReports : [];

      // 分类名查表：迁移后分类概念取消，但要让人看得出这条原来在哪个分类里
      const nameOf = {};
      if (Array.isArray(src.projects)) {
        src.projects.forEach(p => {
          if (!isObj(p) || typeof p.id !== 'string') return;
          const nm = str(p.name).trim();
          nameOf[p.id] = nm || '未分类';
        });
      }

      const out = [];
      let skippedEmpty = 0;
      reports.forEach(r => {
        if (!isObj(r)) return;
        const body = str(r.content);
        if (!body.trim()) { skippedEmpty++; return; }   // 只有标题没有正文的，标题已丢弃 → 没内容可留

        // 日期优先取记录自身的 date；坏日期回落到 createdAt
        let ymd = validDate(r.date);
        if (!ymd) {
          const ts = num(r.createdAt, 0);
          if (ts) ymd = todayStr(new Date(ts));
        }
        const pj = nameOf[r.projectId] || '未分类';
        out.push({
          date: ymd ? zhDate(ymd) : '',
          text: pj + '：' + body,
          ts: num(r.createdAt, Date.now())
        });
      });
      out.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      data.journals = out;
      data.todos = [];          // 用户明确要求：原待办内容全部不要
      data.ideas = [];
      data.seeded = out.length > 0;   // 老用户升级后不灌演示数据

      // 2.x 的两个设置项跟着搬过来（其余 2.x 设置项随功能一起下线）。
      // 注意用 merge 而不是整个替换：baseNormalize 已经先跑过，里面带着
      // seenVersion / standup 这些新字段，直接覆盖会让它们退回默认值。
      const rs = isObj(src.reminderSettings) ? src.reminderSettings : {};
      const cb = isObj(src.closeBehavior) ? src.closeBehavior : {};
      data.settings = Object.assign({}, data.settings, {
        motion: data.settings.motion !== false,
        autoStart: rs.autoStart === true,
        keepRunning: cb.keepRunning === true
      });

      ctx.stats.migratedReports = out.length;
      ctx.stats.skippedReports = skippedEmpty;
      ctx.stats.droppedTodos = Array.isArray(src.todos) ? src.todos.length : 0;
      ctx.stats.droppedProjects = Array.isArray(src.projects) ? src.projects.length : 0;
    }
  },
  8: {
    desc: '新增计划按天归档与目标动态：旧 todos 没有日期，历史从升级当天开始记，不伪造过去',
    run: function () {}   // 字段由 baseNormalize 补齐，无需改动旧数据
  }
};

// ── 版本探测 ──────────────────────────────────────────────
function detectSchema(raw) {
  if (!isObj(raw)) return 1;
  const v = Number(raw.schemaVersion);
  if (isFinite(v) && v >= 1) return Math.floor(v);
  return 1;   // v1.3.0 之前的数据文件没有 schemaVersion 字段
}

function countsOf(data) {
  const d = isObj(data) ? data : {};
  return {
    todos: Array.isArray(d.todos) ? d.todos.length : 0,
    ideas: Array.isArray(d.ideas) ? d.ideas.length : 0,
    habits: Array.isArray(d.habits) ? d.habits.length : 0,
    books: Array.isArray(d.books) ? d.books.length : 0,
    ledger: Array.isArray(d.ledger) ? d.ledger.length : 0,
    moods: Array.isArray(d.moodLog) ? d.moodLog.length : 0,
    journals: Array.isArray(d.journals) ? d.journals.length : 0,
    planDays: isObj(d.planDays) ? Object.keys(d.planDays).length : 0,
    goalSnapshots: isObj(d.planDays) ? Object.values(d.planDays).reduce((n, x) => n + (isObj(x) && Array.isArray(x.goals) ? x.goals.length : 0), 0) : 0,
    goalLog: Array.isArray(d.goalLog) ? d.goalLog.length : 0
  };
}

// ── 迁移主入口 ────────────────────────────────────────────
// 返回 { data, from, to, migrated, steps, stats, tooNew }
//   tooNew = true 表示文件由更高版本的程序写入：结构未知，只读保护，禁止回写
function applyMigrations(raw, options) {
  const opt = options || {};
  const today = opt.today || todayStr();
  const from = detectSchema(raw);

  if (from > SCHEMA_VERSION) {
    return {
      data: raw, from: from, to: SCHEMA_VERSION,
      migrated: false, steps: [], stats: countsOf(raw), tooNew: true
    };
  }

  const data = baseNormalize(raw);
  const ctx = { today: today, stats: {} };
  const steps = [];
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) continue;
    step.run(data, raw, ctx);
    steps.push(step.desc);
  }
  data.schemaVersion = SCHEMA_VERSION;
  return {
    data: data,
    from: from,
    to: SCHEMA_VERSION,
    migrated: from < SCHEMA_VERSION,
    steps: steps,
    stats: Object.assign(countsOf(data), {
      migratedReports: ctx.stats.migratedReports || 0,
      skippedReports: ctx.stats.skippedReports || 0,
      droppedTodos: ctx.stats.droppedTodos || 0,
      droppedProjects: ctx.stats.droppedProjects || 0
    }),
    tooNew: false
  };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_DATA,
  MIGRATIONS,
  WEEK_CN,
  detectSchema,
  countsOf,
  baseNormalize,
  applyMigrations,
  normalizeTodo,
  normalizeHabit,
  normalizeBook,
  normalizeLedger,
  normalizeMood,
  normalizeJournal,
  validDate,
  validTime,
  zhDate,
  todayStr,
  genId
};
