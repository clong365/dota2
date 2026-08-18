/**
 * esports8.com DOTA2 赛果抓取与展示 Worker。
 *
 * - scheduled(): Cron 定时抓取最近 DAYS 天的已完赛 DOTA2 比赛每局数据,写入 KV
 * - fetch(): GET / 渲染 HTML 表格; GET /refresh 手动触发一次抓取
 *
 * 签名机制(逆向自站点前端 JS):
 * - 首页 HTML 的 window.__NUXT__ 内含 s / k / l 三个字符串
 * - XOR key = AES-128-CBC-decrypt(hex(s), key=utf8(k), iv=utf8(l)),按 utf8 解码
 * - content = [排序后的 params 值拼接, unix时间戳-655876800, "js", v1路径].join("&")
 * - sign = base64( content 逐字符 charCode 与 key[(i+19)%len] 异或后的字符串, utf8 )
 * - GET 请求附加参数 k=sign
 *
 * DOTA2(game_id=3)单局 stats 数组含义(home/away 各一个):
 *   [0]总金钱 [1]推塔数 [3]一血 [4]首塔 [6]先10杀 [7]人头 [8]经济(coin-value) [9]胜方标记
 * 单局用时 = timer[3](秒)
 */

const BASE = "https://www.esports8.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const KV_KEY = "dota2:games";
const REQUEST_INTERVAL_MS = 300;
const CN_OFFSET_SEC = 8 * 3600; // 按东八区划分"天"

// ---------- 签名 ----------

function unescapeJsString(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, ch) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : ch
  );
}

/** 从 __NUXT__ 表达式中提取 state 的 s/k/l(字面量,或经函数参数间接引用) */
function extractSecrets(html) {
  const marker = "window.__NUXT__=";
  const i = html.indexOf(marker);
  if (i < 0) throw new Error("window.__NUXT__ not found");
  const j = html.indexOf("</script>", i);
  const expr = html.slice(i + marker.length, j);

  const re =
    /[,{]s:([A-Za-z_$][\w$]*|"(?:[^"\\]|\\.)*"),k:([A-Za-z_$][\w$]*|"(?:[^"\\]|\\.)*"),l:([A-Za-z_$][\w$]*|"(?:[^"\\]|\\.)*")[,}]/;
  const m = expr.match(re);
  if (!m) throw new Error("s/k/l not found in __NUXT__");

  // 解析函数参数名列表和实参列表,以便解析间接引用
  let paramNames = null;
  let args = null;
  const resolve = (token) => {
    if (token.startsWith('"')) return unescapeJsString(token.slice(1, -1));
    if (!paramNames) {
      const pm = expr.match(/^\(function\(([\w$,]*)\)/);
      if (!pm) throw new Error("cannot parse __NUXT__ function params");
      paramNames = pm[1] ? pm[1].split(",") : [];
      args = splitTopLevelArgs(expr);
    }
    const idx = paramNames.indexOf(token);
    if (idx < 0 || idx >= args.length) throw new Error(`cannot resolve __NUXT__ param ${token}`);
    const v = args[idx].trim();
    if (!v.startsWith('"')) throw new Error(`unexpected __NUXT__ arg for ${token}: ${v}`);
    return unescapeJsString(v.slice(1, -1));
  };
  return { s: resolve(m[1]), k: resolve(m[2]), l: resolve(m[3]) };
}

/** 拆分 IIFE 末尾的实参列表(仅按顶层逗号,识别字符串) */
function splitTopLevelArgs(expr) {
  const start = expr.lastIndexOf("}(");
  if (start < 0) throw new Error("cannot locate __NUXT__ argument list");
  const body = expr.slice(start + 2, expr.lastIndexOf(")"));
  const out = [];
  let cur = "";
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      cur += c;
      if (c === "\\") cur += body[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function deriveKey({ s, k, l }) {
  const enc = new TextEncoder();
  const ck = await crypto.subtle.importKey("raw", enc.encode(k), { name: "AES-CBC" }, false, [
    "decrypt",
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: enc.encode(l) },
    ck,
    hexToBytes(s)
  );
  return new TextDecoder().decode(plain);
}

function sign(key, params, path) {
  const vals = Object.values(params).map(String).sort().join("");
  const content = [vals, Math.floor(Date.now() / 1000) - 655876800, "js", path].join("&");
  const xored = content
    .split("")
    .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt((i + 19) % key.length)))
    .join("");
  return bytesToBase64(new TextEncoder().encode(xored));
}

async function apiGetOnce(key, apiPath, params) {
  const v1Path = apiPath.replace("/web/api/", "/v1/");
  const q = new URLSearchParams({ ...params, k: sign(key, params, v1Path) });
  const res = await fetch(`${BASE}${apiPath}?${q}`, {
    headers: { "User-Agent": UA, Referer: BASE + "/en/", language: "en" },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status},非 JSON 响应: ${text.slice(0, 100).replace(/\s+/g, " ")}`);
  }
  if (data.code !== 0) throw new Error(`code=${data.code} ${data.msg || ""}`.trim());
  return data.data;
}

/** 带重试的 API 调用:失败(含 520 等源站抖动)按 0.5s/1.5s 退避重试 2 次 */
async function apiGet(key, apiPath, params = {}) {
  let lastErr;
  for (const delay of [0, 500, 1500]) {
    if (delay) await sleep(delay);
    try {
      return await apiGetOnce(key, apiPath, params);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`API ${apiPath} error: ${lastErr.message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 抓取 ----------

function cnDayStart(dayOffset = 0) {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor((now + CN_OFFSET_SEC) / 86400) * 86400 - CN_OFFSET_SEC - dayOffset * 86400;
}

function sideFlag(stats, idx) {
  return Array.isArray(stats) && stats[idx] === 1;
}

function extractGame(match, tab, live) {
  const hs = live.home?.stats || [];
  const as = live.away?.stats || [];
  const winnerByStats = sideFlag(hs, 9) ? match.home.name : sideFlag(as, 9) ? match.away.name : "";
  const winner = tab.win_team?.name || winnerByStats;
  const pick = (idx) =>
    sideFlag(hs, idx) ? match.home.name : sideFlag(as, idx) ? match.away.name : "";
  return {
    box_num: tab.box_num,
    winner,
    winner_conflict: Boolean(winner && winnerByStats && winner !== winnerByStats),
    home_kills: hs[7] ?? null,
    away_kills: as[7] ?? null,
    duration_sec: live.timer?.[3] ?? null,
    home_coin: hs[8] ?? null,
    away_coin: as[8] ?? null,
    first_10_kills: pick(6),
    first_blood: pick(3),
    first_tower: pick(4),
  };
}

// ---------- etopfun 赔率(时长大小盘) ----------

const ETOPFUN = "https://www.etopfun.com";

function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 队名模糊匹配:规范化后相等/包含、去 team 前缀后包含、或共享 >=4 字母的单词 */
function teamSimilar(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const strip = (t) => t.replace(/^team/, "");
  const sa = strip(na);
  const sb = strip(nb);
  if (sa && sb && (sa === sb || sa.includes(sb) || sb.includes(sa))) return true;
  const tok = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4);
  const ta = tok(a);
  const tb = new Set(tok(b));
  return ta.some((x) => tb.has(x));
}

const MATCH_TIME_TOLERANCE_SEC = 6 * 3600;

/**
 * 抓取 etopfun 已完赛 DOTA2 比赛的时长大小盘(type=9,vs1=大,vs2=小)。
 * 返回每场 [{timeSec, names:[n1,n2], games: Map<box_num, {line, over, under}>}]
 */
async function fetchEtopfunTimeOdds(minTimeSec, errors) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    let list;
    try {
      const res = await fetch(
        `${ETOPFUN}/api/match/list.do?status=end&game=dota2&rows=20&page=${page}`,
        { headers: { "User-Agent": UA } }
      );
      const data = await res.json();
      list = data?.datas?.list || [];
    } catch (e) {
      errors.push(`etopfun page ${page}: ${e.message}`);
      break;
    }
    if (!list.length) break;
    let oldest = Infinity;
    for (const m of list) {
      const timeSec = (m.time || 0) / 1000;
      oldest = Math.min(oldest, timeSec);
      const games = new Map();
      for (const s of m.sublist || []) {
        if (s.type === 9 && s.map >= 1) {
          games.set(s.map, {
            line: s.totalScore ?? null,
            over: s.vs1?.odds ?? null,
            under: s.vs2?.odds ?? null,
          });
        }
      }
      if (games.size)
        out.push({ timeSec, names: [m.vs1?.name, m.vs2?.name], games });
    }
    if (oldest < minTimeSec - MATCH_TIME_TOLERANCE_SEC) break;
    await sleep(REQUEST_INTERVAL_MS);
  }
  return out;
}

/** 在 etopfun 记录中找对应比赛:双方队名均相似且开赛时间差最小(<6h) */
function matchEtopfun(rec, etopMatches) {
  let best = null;
  let bestDiff = Infinity;
  for (const e of etopMatches) {
    const direct =
      teamSimilar(rec.home.name, e.names[0]) && teamSimilar(rec.away.name, e.names[1]);
    const swapped =
      teamSimilar(rec.home.name, e.names[1]) && teamSimilar(rec.away.name, e.names[0]);
    if (!direct && !swapped) continue;
    const diff = Math.abs(e.timeSec - rec.start_time);
    if (diff < MATCH_TIME_TOLERANCE_SEC && diff < bestDiff) {
      best = e;
      bestDiff = diff;
    }
  }
  return best;
}

async function scrape(env) {
  const days = Math.max(1, parseInt(env.DAYS || "1", 10) || 1);
  const errors = [];
  // 首页偶发 5xx(源站抖动),重试 3 次
  let html = null;
  let lastStatus = 0;
  for (const delay of [0, 800, 2000, 4000]) {
    if (delay) await sleep(delay);
    const homeResp = await fetch(BASE + "/en/", { headers: { "User-Agent": UA } });
    lastStatus = homeResp.status;
    const text = await homeResp.text();
    if (homeResp.ok && text.includes("window.__NUXT__")) {
      html = text;
      break;
    }
  }
  if (!html) throw new Error(`window.__NUXT__ not found,首页最后状态 ${lastStatus}`);
  const key = await deriveKey(extractSecrets(html));

  // etopfun 时长大小盘赔率(失败不影响主流程)
  const etopMatches = await fetchEtopfunTimeOdds(cnDayStart(days - 1), errors);

  // 逐天取比赛列表,按 match id 去重
  const matchMap = new Map();
  for (let d = 0; d < days; d++) {
    try {
      const data = await apiGet(key, "/web/api/home/match/list", {
        game_id: 3,
        search_time: cnDayStart(d),
      });
      for (const m of data.matches || []) {
        if (m.status_id === 3 && !matchMap.has(m.id)) matchMap.set(m.id, m);
      }
    } catch (e) {
      errors.push(`match list day-${d}: ${e.message}`);
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  const matches = [];
  for (const m of [...matchMap.values()].sort((a, b) => b.start_time - a.start_time)) {
    const rec = {
      id: m.id,
      tournament: m.title_full_en || m.title_full_zh || "",
      stage: m.stage_name || "",
      start_time: m.start_time,
      box: m.box,
      home: { name: m.home.name, score: m.home.score },
      away: { name: m.away.name, score: m.away.score },
      series_winner: m.home.score > m.away.score ? m.home.name : m.away.name,
      games: [],
    };
    try {
      const nav = await apiGet(key, "/web/api/match/live_nav", { match_id: m.id });
      await sleep(REQUEST_INTERVAL_MS);
      for (const tab of (nav.tabs || []).filter((t) => t.is_data === 1)) {
        try {
          const live = await apiGet(key, "/web/api/match/live_data", {
            match_id: m.id,
            box_num: tab.box_num,
          });
          rec.games.push(extractGame(rec, tab, live));
        } catch (e) {
          errors.push(`live_data ${m.id}#${tab.box_num}: ${e.message}`);
        }
        await sleep(REQUEST_INTERVAL_MS);
      }
    } catch (e) {
      errors.push(`live_nav ${m.id}: ${e.message}`);
    }
    matches.push(rec);
  }

  // 关联 etopfun 时长大小盘赔率(按 map 号对应每一局)
  let oddsMatched = 0;
  for (const rec of matches) {
    const e = matchEtopfun(rec, etopMatches);
    if (!e) continue;
    oddsMatched++;
    for (const g of rec.games) {
      const odds = e.games.get(g.box_num);
      if (odds) Object.assign(g, odds);
    }
  }

  const payload = {
    updated_at: Math.floor(Date.now() / 1000),
    odds_matched: oddsMatched,
    matches,
    errors,
  };
  await env.GAMES_KV.put(KV_KEY, JSON.stringify(payload));
  return payload;
}

// ---------- 渲染 ----------

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function fmtTime(sec) {
  if (sec == null) return "";
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function fmtDate(sec) {
  return new Date((sec + CN_OFFSET_SEC) * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function fmtCoin(v) {
  return v == null ? "" : (v / 1000).toFixed(1) + "k";
}

function render(payload) {
  const rows = [];
  if (payload) {
    for (const m of payload.matches) {
      for (const g of m.games) {
        // 队伍名绿色高亮该局胜者;两个数据源不一致时胜方队名后带 ⚠
        const homeWin = g.winner === m.home.name;
        const awayWin = g.winner === m.away.name;
        const homeMark = homeWin && g.winner_conflict ? `${esc(m.home.name)}⚠` : esc(m.home.name);
        const awayMark = awayWin && g.winner_conflict ? `${esc(m.away.name)}⚠` : esc(m.away.name);
        // 用时按盘口线判定大小(无盘口时按 44:00),命中的一侧高亮
        const lineSec = g.line != null ? Math.round(g.line * 60) : 44 * 60;
        const isOver = g.duration_sec != null && g.duration_sec > lineSec;
        const overCls = g.over != null && isOver ? "win" : "";
        const underCls = g.under != null && !isOver && g.duration_sec != null ? "win" : "";
        rows.push(`<tr>
<td>${esc(m.tournament)}</td><td>${esc(m.stage)}</td><td>${fmtDate(m.start_time)}</td>
<td class="${homeWin ? "win" : ""}">${homeMark}</td>
<td class="${awayWin ? "win" : ""}">${awayMark}</td>
<td>BO${esc(m.box)}</td>
<td>${esc(m.home.score)} : ${esc(m.away.score)}</td><td>${esc(m.series_winner)}</td>
<td>Game ${esc(g.box_num)}</td>
<td>${esc(g.home_kills)} : ${esc(g.away_kills)}</td><td>${fmtTime(g.duration_sec)}</td>
<td>${fmtCoin(g.home_coin)}</td><td>${fmtCoin(g.away_coin)}</td>
<td>${esc(g.first_10_kills)}</td><td>${esc(g.first_blood)}</td><td>${esc(g.first_tower)}</td>
<td>${g.line != null ? esc(g.line.toFixed(1)) : ""}</td>
<td class="${overCls}">${g.over ?? ""}</td><td class="${underCls}">${g.under ?? ""}</td>
</tr>`);
      }
    }
  }
  const updated = payload?.updated_at ? fmtDate(payload.updated_at) + " (UTC+8)" : "从未";
  // 时长与 44 分钟对比统计
  let overCount = 0;
  let underCount = 0;
  if (payload) {
    for (const m of payload.matches)
      for (const g of m.games) {
        if (g.duration_sec == null) continue;
        if (g.duration_sec > 44 * 60) overCount++;
        else underCount++;
      }
  }
  const total = overCount + underCount;
  // 按盘口线判定的大小统计(仅有赔率的局)
  let lineOver = 0;
  let lineUnder = 0;
  if (payload) {
    for (const m of payload.matches)
      for (const g of m.games) {
        if (g.duration_sec == null || g.line == null) continue;
        if (g.duration_sec > Math.round(g.line * 60)) lineOver++;
        else lineUnder++;
      }
  }
  const lineTotal = lineOver + lineUnder;
  const durationStats = total
    ? `<p>时长对比 44:00 — <b>大时间(>44分钟):${overCount} 局(${(overCount / total * 100).toFixed(1)}%)</b> · ` +
      `<b>小时间(≤44分钟):${underCount} 局(${(underCount / total * 100).toFixed(1)}%)</b>(共 ${total} 局)` +
      (lineTotal
        ? `<br>按 etopfun 盘口线判定 — <b>大:${lineOver} 局(${(lineOver / lineTotal * 100).toFixed(1)}%)</b> · ` +
          `<b>小:${lineUnder} 局(${(lineUnder / lineTotal * 100).toFixed(1)}%)</b>(有盘口的 ${lineTotal} 局,赔率列绿色为命中侧)`
        : "") +
      `</p>`
    : "";
  const errs = payload?.errors?.length
    ? `<p class="err">抓取告警 ${payload.errors.length} 条:${payload.errors.map(esc).join("; ")}</p>`
    : "";
  const body = rows.length
    ? `<table><thead><tr>
<th>赛事</th><th>阶段</th><th>开赛时间</th><th>队伍A</th><th>队伍B</th><th>赛制</th>
<th>大比分</th><th>系列赛胜者</th><th>局</th><th>单局比分</th><th>用时</th>
<th>A经济</th><th>B经济</th><th>先10杀</th><th>一血</th><th>首塔</th>
<th>时长盘口</th><th>大赔率</th><th>小赔率</th>
</tr></thead><tbody>${rows.join("\n")}</tbody></table>`
    : "<p>暂无数据,等待首次抓取。</p>";

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DOTA2 赛果 - esports8</title>
<style>
body{font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;margin:24px;color:#e8eaf0;background:#15181e}
h1{font-size:18px} .meta{color:#8a90a0;margin-bottom:12px} .err{color:#f2a154;font-size:12px}
table{border-collapse:collapse;width:100%;background:#1d2129}
th,td{border:1px solid #2c313c;padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#252a35;position:sticky;top:0}
tr:nth-child(even){background:#20242e}
.win{color:#6fd08c;font-weight:600}
</style></head><body>
<h1>DOTA2 已完赛比赛 · 每局数据</h1>
<p class="meta">赛果来源 esports8.com · 时长盘口来源 etopfun.com · 更新时间:${esc(updated)} · 时间均为 UTC+8 · 绿色为该局/该盘口命中方,⚠ 表示两个数据源不一致</p>
${durationStats}
${errs}
${body}
</body></html>`;
}

// ---------- 入口 ----------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scrape(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/refresh") {
      try {
        const payload = await scrape(env);
        return new Response(
          `抓取完成:${payload.matches.length} 场比赛,${payload.errors.length} 条告警`,
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      } catch (e) {
        return new Response(`抓取失败:${e.message}`, { status: 500 });
      }
    }
    const raw = await env.GAMES_KV.get(KV_KEY);
    const payload = raw ? JSON.parse(raw) : null;
    return new Response(render(payload), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};
