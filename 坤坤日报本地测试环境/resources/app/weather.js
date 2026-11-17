// ═══════════════════════════════════════════════════════
// 本地天气（主进程）
//
// 数据源：wttr.in —— 一次请求同时给出「IP 定位到的城市」和「当前天气」，
// 免费、不用 key、支持 https。实测这台机器上 open-meteo 直接超时（国内常见），
// wttr.in 2 秒左右能回来，所以只用它一个源，不做多源切换（多写一套失败路径
// 反而更容易出隐蔽 bug）。
//
// 设计原则：天气是锦上添花，任何一步失败都只是「不显示」，绝不弹错、不阻塞日历。
// 所以这里所有异常都被吞掉，返回 null 交给渲染层隐藏那一行。
//
// 缓存 30 分钟：天气按小时变，没必要每次开窗都打一次；也给失败留了重试窗口
// （失败只缓存 5 分钟，别让一次断网把整小时都钉死）。
// ═══════════════════════════════════════════════════════
const { fetchText } = require('./update-check.js');

const WX_URL = 'https://wttr.in/?format=j1';
const WX_TTL_OK = 30 * 60 * 1000;   // 成功缓存 30 分钟
const WX_TTL_FAIL = 5 * 60 * 1000;  // 失败缓存 5 分钟
const WX_TIMEOUT = 9000;

// wttr.in 用的是 WorldWeatherOnline 的天气代码，不是 WMO。
// 只归并成日常会用到的几类 —— 用户看天气只需要知道「晴/阴/下雨/要不要带伞」。
const WX_KINDS = [
  { icon: '☀️', text: '晴', codes: [113] },
  { icon: '⛅', text: '多云', codes: [116] },
  { icon: '☁️', text: '阴', codes: [119, 122] },
  { icon: '🌫️', text: '雾', codes: [143, 248, 260] },
  { icon: '⛈️', text: '雷阵雨', codes: [200, 386, 389, 392, 395] },
  { icon: '🌧️', text: '雨', codes: [176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359] },
  { icon: '❄️', text: '雪', codes: [179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377] },
];

let cache = { at: 0, data: null };
let inflight = null;

function kindOf(code) {
  const n = Number(code);
  for (const k of WX_KINDS) if (k.codes.indexOf(n) !== -1) return k;
  return { icon: '🌡️', text: '—' };
}

// wttr.in 的字段都是 [{value:'xx'}] 这种形状，取第一个值出来
function val(a) {
  return (Array.isArray(a) && a[0] && a[0].value != null) ? String(a[0].value) : '';
}

function normalize(json) {
  const c = json && Array.isArray(json.current_condition) ? json.current_condition[0] : null;
  if (!c) return null;
  const t = Number(c.temp_C);
  if (!isFinite(t)) return null;
  const area = (Array.isArray(json.nearest_area) && json.nearest_area[0]) ? json.nearest_area[0] : {};
  const k = kindOf(c.weatherCode);
  const today = (Array.isArray(json.weather) && json.weather[0]) ? json.weather[0] : null;
  return {
    temp: Math.round(t),
    feels: Math.round(Number(c.FeelsLikeC) || t),
    icon: k.icon,
    text: k.text,
    city: val(area.areaName),
    region: val(area.region),
    hi: today ? Math.round(Number(today.maxtempC)) : null,
    lo: today ? Math.round(Number(today.mintempC)) : null,
    at: Date.now(),
    // 只有这一项能说明「这是本地天气」：IP 定位出来的位置，放在 title 里给用户核对
    place: [val(area.region), val(area.areaName)].filter(Boolean).join(' ')
  };
}

async function pull() {
  const r = await fetchText(WX_URL, WX_TIMEOUT);
  if (!r || !r.ok) return null;
  let json;
  try { json = JSON.parse(r.body); } catch (e) { return null; }
  return normalize(json);
}

// force=true 忽略缓存（用户在设置里手动刷新、或跨天时用）
async function getWeather(force) {
  const now = Date.now();
  const ttl = cache.data ? WX_TTL_OK : WX_TTL_FAIL;
  if (!force && cache.at && (now - cache.at) < ttl) return cache.data;
  if (inflight) return inflight;   // 并发请求合并，别打两次

  inflight = (async () => {
    let data = null;
    try { data = await pull(); } catch (e) { data = null; }
    cache = { at: Date.now(), data: data };
    inflight = null;
    return data;
  })();
  return inflight;
}

module.exports = { getWeather };
