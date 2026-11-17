// 升级检测模块（主进程）
// 设计原则：
//  · 仅只读 GET 拉取远端 version.json，不带任何设备/用户标识（隐私红线）
//  · 超时 / 离线 / 404 / 坏 JSON 一律静默失败，绝不抛错、绝不卡启动、绝不弹错
//  · 版本比较用语义化 compareVersions，支持 major.minor.patch
//
// 国内网络两件事必须同时兜住：
//  ① 传输层：有代理 / 没代理都要能发请求。
//     Node 原生 https 完全无视系统代理，挂了代理也照样直连；所以优先用 Electron 的
//     net 模块（走 Chromium 网络栈，自动遵循系统的代理设置），拿不到 net 时才退回 https。
//  ② 地址层：raw.githubusercontent.com 在国内经常被 DNS 污染，而 api.github.com
//     往往直连就能通。所以把同一个 version.json 拆成三条通道并发竞速，谁先回用谁：
//       raw      原始文件，有代理时最快
//       api      GitHub contents 接口，直连成功率高（返回 base64，需解码）
//       jsDelivr CDN 兜底（有强缓存，放最后仅作保底）
//     并且三个通道都是同时发出的，总耗时等于最快通道而不是三者相加。

const http = require('http');
const https = require('https');

// Electron 的 net：只在主进程可用；纯 Node 环境（单测 / 脚本）拿不到，自动退回 https
let electronNet = null;
try {
  const electron = require('electron');
  if (electron && electron.net && typeof electron.net.request === 'function') electronNet = electron.net;
} catch (e) { /* 非 Electron 环境，正常退回 https */ }

const MAX_REDIRECTS = 4;
const MAX_BYTES = 1e6;

// 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// 把配置里的 raw 地址拆成三条通道；不是 raw 地址就只按原样试一次
function buildTargets(rawUrl) {
  const url = String(rawUrl || '');
  const m = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (!m) return [{ kind: 'raw', url: url }];
  const owner = m[1];
  const repo = m[2];
  const ref = m[3];
  const path = m[4];
  return [
    { kind: 'raw', url: url },
    { kind: 'api', url: 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path + (ref === 'main' ? '' : '?ref=' + encodeURIComponent(ref)) },
    { kind: 'jsdelivr', url: 'https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@' + ref + '/' + path },
  ];
}

// ── 传输层：Electron net（遵循系统代理，自动跟随 3xx） ──────────────
function getViaElectronNet(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      req = electronNet.request({
        url: url,
        method: 'GET',
        redirect: 'follow',
        headers: { 'User-Agent': 'kunkun-daily-updater', 'Accept': 'application/json' },
      });
    } catch (e) {
      return done({ ok: false, reason: 'request-failed' });
    }

    const killer = setTimeout(() => {
      try { req.abort(); } catch (e) { }
      done({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    req.on('response', (res) => {
      const code = res.statusCode;
      if (code !== 200) {
        clearTimeout(killer);
        try { res.resume(); } catch (e) { }
        return done({ ok: false, reason: 'http-' + code });
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (settled) return;
        data += c;
        if (data.length > MAX_BYTES) {
          try { req.abort(); } catch (e) { }
          clearTimeout(killer);
          done({ ok: false, reason: 'too-large' });
        }
      });
      res.on('end', () => { clearTimeout(killer); done({ ok: true, body: data }); });
      res.on('error', () => { clearTimeout(killer); done({ ok: false, reason: 'stream-error' }); });
    });

    req.on('error', () => { clearTimeout(killer); done({ ok: false, reason: 'network-error' }); });
    try { req.end(); } catch (e) { clearTimeout(killer); done({ ok: false, reason: 'request-failed' }); }
  });
}

// ── 传输层兜底：纯 Node https（无 Electron 时用，也能跟随 3xx） ──────
function getViaNodeHttps(rawUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    function fetchUrl(target, hopsLeft) {
      if (settled) return;
      let url;
      try { url = new URL(target); } catch (e) { return done({ ok: false, reason: 'bad-url' }); }

      let req;
      try {
        const lib = url.protocol === 'http:' ? http : https;
        const options = {
          hostname: url.hostname,
          path: url.pathname + url.search,
          timeout: timeoutMs,
          headers: { 'User-Agent': 'kunkun-daily-updater', 'Accept': 'application/json' },
        };
        if (url.port) options.port = Number(url.port);
        req = lib.get(options, (res) => {
          const code = res.statusCode;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (hopsLeft <= 0) return done({ ok: false, reason: 'too-many-redirects' });
            let next;
            try { next = new URL(res.headers.location, url).toString(); }
            catch (e) { return done({ ok: false, reason: 'bad-redirect' }); }
            return fetchUrl(next, hopsLeft - 1);
          }
          if (code !== 200) { res.resume(); return done({ ok: false, reason: 'http-' + code }); }

          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (settled) return;
            data += c;
            if (data.length > MAX_BYTES) { req.destroy(); done({ ok: false, reason: 'too-large' }); }
          });
          res.on('end', () => { if (!settled) done({ ok: true, body: data }); });
        });
      } catch (e) {
        return done({ ok: false, reason: 'request-failed' });
      }

      req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'timeout' }); });
      req.on('error', () => done({ ok: false, reason: 'network-error' }));
    }

    fetchUrl(rawUrl, MAX_REDIRECTS);
  });
}

function fetchText(url, timeoutMs) {
  return electronNet ? getViaElectronNet(url, timeoutMs) : getViaNodeHttps(url, timeoutMs);
}

// ── 解析：api contents 返回 base64，其余是明文 JSON ─────────────────
function parseBody(kind, body) {
  const json = JSON.parse(body);
  if (kind === 'api') {
    if (!json || !json.content) throw new Error('no-content');
    const txt = Buffer.from(String(json.content).replace(/\s+/g, ''), 'base64').toString('utf8');
    return JSON.parse(txt);
  }
  return json;
}

function normalizeInfo(json) {
  const latest = String(json.version || '');
  return {
    version: latest,
    notes: json.notes || '',
    downloadUrl: json.downloadUrl || '',
    publishedAt: json.publishedAt || '',
    // 3.0.0 起改为整包直链：优先 url，老格式 parts[0] 兜底
    url: String(json.url || (Array.isArray(json.parts) ? json.parts[0] : '') || ''),
    parts: Array.isArray(json.parts) ? json.parts : [],
    // 备用下载源（加速站 / 对象存储）：github.com 国内经常不可达时用它兜底
    mirrors: Array.isArray(json.mirrors) ? json.mirrors.filter((x) => typeof x === 'string' && /^https?:\/\//i.test(x)) : [],
    // 整包的 SHA256，从第三方源下载后必须校验，防止被投毒
    sha256: String(json.sha256 || '').trim().toLowerCase(),
  };
}

// 单通道：拿文本 → 解析 → 校验版本字段
async function tryTarget(target, timeoutMs) {
  const r = await fetchText(target.url, timeoutMs);
  if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'failed' };
  let json;
  try { json = parseBody(target.kind, r.body); }
  catch (e) { return { ok: false, reason: 'bad-json' }; }
  const info = normalizeInfo(json);
  if (!info.version) return { ok: false, reason: 'no-version' };
  return { ok: true, channel: target.kind, info: info };
}

// 拉取远端 version.json 并比较。始终 resolve，不会 reject。
// 三条通道并发，谁先拿到合法结果就用谁；全都失败才返回 { ok:false }。
// 返回 { ok, hasUpdate, current, latest, info, channel } 或 { ok:false, reason, tried }
function checkForUpdate(updateUrl, currentVersion, timeoutMs) {
  return new Promise((resolve) => {
    if (!updateUrl) return resolve({ ok: false, reason: 'no-url' });

    const perTimeout = timeoutMs || 4000;
    const targets = buildTargets(updateUrl);
    const tried = [];
    let pending = targets.length;
    let settled = false;

    // 总守卫：任何一条卡住都不拖过「单通道超时 + 800ms」
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'timeout', tried: tried.slice() });
    }, perTimeout + 800);

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(r);
    };

    targets.forEach((target) => {
      tryTarget(target, perTimeout).then((r) => {
        if (settled) return;
        if (r.ok) {
          const cmp = compareVersions(r.info.version, currentVersion);
          return finish({
            ok: true,
            hasUpdate: cmp > 0,
            current: currentVersion,
            latest: r.info.version,
            channel: r.channel,
            info: r.info,
          });
        }
        tried.push(target.kind + ':' + r.reason);
        pending--;
        if (pending === 0) finish({ ok: false, reason: 'all-failed', tried: tried.slice() });
      }).catch(() => {
        if (settled) return;
        tried.push(target.kind + ':exception');
        pending--;
        if (pending === 0) finish({ ok: false, reason: 'all-failed', tried: tried.slice() });
      });
    });
  });
}

// fetchText 也给天气用：它已经处理了「优先 Electron net（走系统代理）→ 退回 Node https」
// 和超时/大小上限，没必要再写一份联网逻辑。
module.exports = { checkForUpdate, compareVersions, buildTargets, fetchText };
