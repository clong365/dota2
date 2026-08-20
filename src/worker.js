/**
 * DOTA2 The International 2026 赛果抓取与展示 Worker。
 *
 * 数据源:
 * - OpenDota(https://api.opendota.com):比赛数据。免费公开,匿名约 60 次/分钟、
 *   每日限额,故单局详情做 KV 永久缓存(已完赛数据不可变,每局只抓一次)
 * - etopfun.com:每局时长大小盘赔率(公开接口,无需签名)
 *
 * - scheduled(): Cron 定时抓取最近 DAYS 天的比赛,写入 KV
 * - fetch(): GET / 渲染 HTML 表格; GET /refresh 手动触发一次抓取
 *
 * 单局字段来源(OpenDota /api/matches/{id}):
 *   比分 radiant_score/dire_score;用时 duration;胜者 radiant_win
 *   双方经济(coin-value) = 该方 5 名选手 net_worth 之和
 *   一血 = firstblood_claimed=1 的选手所在方
 *   首塔 = objectives 中首个 tower 类 building_kill 的被拆方的对方
 *   先10杀 = 双方选手 kills_log 时间戳合并排序,先达到 10 杀的一方
 * 系列赛: 按 series_id 归组,series_type 0/1/2 = BO1/BO3/BO5
 */

const OPENDOTA = "https://api.opendota.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const KV_KEY = "dota2:games";
const CACHE_KEY = "dota2:gamecache"; // 单局详情永久缓存 {match_id: gameRecord}
const TEAMS_KEY = "dota2:teams"; // 队伍表缓存 {updated_at, teams},7 天有效
const TEAMS_TTL_SEC = 7 * 86400;
const ETOPFUN_INTERVAL_MS = 300;
const OPENDOTA_INTERVAL_MS = 1100; // 匿名限额 60 次/分钟
const DETAILS_PER_RUN = 40; // 单次抓取最多补的单局详情数(受 Workers 子请求上限约束)
const CN_OFFSET_SEC = 8 * 3600; // 按东八区划分"天"
const DEFAULT_LEAGUE_ID = "19719"; // The International 2026
const LEAGUE_NAME = "The International 2026";
const BO_MAP = { 0: 1, 1: 3, 2: 5 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cnDayStart(dayOffset = 0) {
  const now = Math.floor(Date.now() / 1000);
  return Math.floor((now + CN_OFFSET_SEC) / 86400) * 86400 - CN_OFFSET_SEC - dayOffset * 86400;
}

// ---------- OpenDota ----------

async function odGetOnce(path, apiKey) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${OPENDOTA}${path}${apiKey ? `${sep}api_key=${apiKey}` : ""}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status},非 JSON 响应: ${text.slice(0, 100).replace(/\s+/g, " ")}`);
  }
  // 429/5xx 也可能返回 JSON 错误体,必须按状态码判定
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 100).replace(/\s+/g, " ")}`);
  return data;
}

/** 带重试的 OpenDota 调用(429/5xx 按 2s/5s 退避重试 2 次);apiKey 可空(匿名) */
async function odGet(path, apiKey) {
  let lastErr;
  for (const delay of [0, 2000, 5000]) {
    if (delay) await sleep(delay);
    try {
      return await odGetOnce(path, apiKey);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`opendota ${path}: ${lastErr.message}`);
}

/** 从单局详情提取页面所需字段;home=天辉,away=夜魇 */
function extractGame(detail, teamName) {
  const rad = detail.players.filter((p) => p.isRadiant);
  const dire = detail.players.filter((p) => !p.isRadiant);
  const radName = teamName(detail.radiant_team_id);
  const direName = teamName(detail.dire_team_id);
  const sumNW = (ps) => ps.reduce((a, p) => a + (p.net_worth || 0), 0);

  // 一血归属
  const fbPlayer = detail.players.find((p) => p.firstblood_claimed);
  const firstBlood = fbPlayer ? (fbPlayer.isRadiant ? radName : direName) : "";

  // 首塔:首个 tower 类建筑被拆,goodguys=天辉的建筑 → 夜魇拆的
  const towerObj = (detail.objectives || []).find(
    (o) => o.type === "building_kill" && String(o.key || "").includes("tower")
  );
  const firstTower = towerObj
    ? String(towerObj.key).includes("goodguys")
      ? direName
      : radName
    : "";

  // 先10杀:合并双方 kills_log 时间戳,各自第 10 杀更早的一方
  const killTimes = (ps) =>
    ps.flatMap((p) => (p.kills_log || []).map((k) => k.time)).sort((a, b) => a - b);
  const rt = killTimes(rad);
  const dt = killTimes(dire);
  const first10 = rt.length >= 10 && (dt.length < 10 || rt[9] < dt[9])
    ? radName
    : dt.length >= 10
      ? direName
      : "";

  return {
    winner: detail.radiant_win ? radName : direName,
    winner_conflict: false,
    home_kills: detail.radiant_score ?? null,
    away_kills: detail.dire_score ?? null,
    duration_sec: detail.duration ?? null,
    home_coin: sumNW(rad) || null,
    away_coin: sumNW(dire) || null,
    first_10_kills: first10,
    first_blood: firstBlood,
    first_tower: firstTower,
  };
}

// ---------- etopfun 赔率(时长大小盘) ----------

const ETOPFUN = "https://www.etopfun.com";

function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 队名模糊匹配:规范化后相等/包含、去 team/gaming 前后缀后包含、共享 >=4 字母的单词、或首字母缩写一致 */
function teamSimilar(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const strip = (t) => t.replace(/^team/, "").replace(/gaming$/, "");
  const sa = strip(na);
  const sb = strip(nb);
  if (sa && sb && (sa === sb || sa.includes(sb) || sb.includes(sa))) return true;
  const tok = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const ta = tok(a);
  const tb = tok(b);
  if (
    ta.some((x) => x.length >= 4 && tb.includes(x)) ||
    tb.some((x) => x.length >= 4 && ta.includes(x))
  )
    return true;
  // 首字母缩写:Vici Gaming ↔ VG
  const acr = (ts) => ts.map((x) => x[0]).join("");
  return acr(ta) === nb || acr(tb) === na;
}

const MATCH_TIME_TOLERANCE_SEC = 6 * 3600;

/**
 * 抓取 etopfun 已完赛 DOTA2 比赛的大小盘赔率(vs1=大,vs2=小):
 * type=9 时长盘(min),type=13 总人头盘。
 * 返回每场 [{timeSec, names:[n1,n2], games: Map<box_num, {line, over, under}>,
 *           killsGames: Map<box_num, {kline, kover, kunder}>}]
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
      const killsGames = new Map();
      for (const s of m.sublist || []) {
        if (s.map < 1) continue;
        if (s.type === 9) {
          games.set(s.map, {
            line: s.totalScore ?? null,
            over: s.vs1?.odds ?? null,
            under: s.vs2?.odds ?? null,
          });
        } else if (s.type === 13) {
          killsGames.set(s.map, {
            kline: s.totalScore ?? null,
            kover: s.vs1?.odds ?? null,
            kunder: s.vs2?.odds ?? null,
          });
        }
      }
      if (games.size || killsGames.size)
        out.push({ timeSec, names: [m.vs1?.name, m.vs2?.name], games, killsGames });
    }
    if (oldest < minTimeSec - MATCH_TIME_TOLERANCE_SEC) break;
    await sleep(ETOPFUN_INTERVAL_MS);
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

// ---------- 抓取 ----------

async function scrape(env) {
  // DAYS<=0 表示不过滤,展示联赛全部比赛
  const days = parseInt(env.DAYS || "0", 10) || 0;
  const leagueId = env.LEAGUE_ID || DEFAULT_LEAGUE_ID;
  const errors = [];
  // 起始日期(UTC+8,如 "2026-08-20"):只展示该日及以后的比赛;与 DAYS 取较严者
  const since = Date.parse(`${env.SINCE || ""}T00:00:00+08:00`) / 1000 || 0;
  const minTime = Math.max(days > 0 ? cnDayStart(days - 1) : 0, since);
  // OpenDota 匿名限额按共享出口 IP 计,容易耗尽;配 API key 后按 key 独立计费
  const apiKey = env.OPENDOTA_API_KEY || "";

  // 队伍表变化极少,KV 缓存 7 天,减少请求数
  const now = Math.floor(Date.now() / 1000);
  let teams;
  const teamsCache = JSON.parse((await env.GAMES_KV.get(TEAMS_KEY)) || "null");
  if (teamsCache && now - teamsCache.updated_at < TEAMS_TTL_SEC) {
    teams = teamsCache.teams;
  } else {
    teams = await odGet(`/api/teams`, apiKey);
    await env.GAMES_KV.put(TEAMS_KEY, JSON.stringify({ updated_at: now, teams }));
  }
  const leagueMatches = await odGet(`/api/leagues/${leagueId}/matches`, apiKey);
  const teamMap = new Map(teams.map((t) => [t.team_id, t.name]));
  const teamName = (id) => teamMap.get(id) || String(id ?? "?");

  // 时间窗内的局,按 series_id 归组
  const games = (leagueMatches || [])
    .filter((m) => m.start_time >= minTime && m.duration > 0)
    .sort((a, b) => a.start_time - b.start_time);
  const seriesMap = new Map();
  for (const g of games) {
    if (!seriesMap.has(g.series_id)) seriesMap.set(g.series_id, []);
    seriesMap.get(g.series_id).push(g);
  }

  // 单局详情:KV 永久缓存,只抓新局。
  // Workers 免费版单次调用约 50 个子请求上限,故每次最多补 DETAILS_PER_RUN 局,
  // 剩余由后续 Cron 自动补齐。
  const cache = JSON.parse((await env.GAMES_KV.get(CACHE_KEY)) || "{}");
  let cacheDirty = false;
  let fetched = 0;
  let pending = 0;
  for (const list of seriesMap.values()) {
    for (const g of list) {
      if (cache[g.match_id]) continue;
      if (fetched >= DETAILS_PER_RUN) {
        pending++;
        continue;
      }
      try {
        const detail = await odGet(`/api/matches/${g.match_id}`, apiKey);
        if (detail && detail.players) {
          cache[g.match_id] = extractGame(detail, teamName);
          cacheDirty = true;
        } else {
          pending++;
        }
      } catch (e) {
        errors.push(`match ${g.match_id}: ${e.message}`);
        pending++;
      }
      fetched++;
      await sleep(OPENDOTA_INTERVAL_MS);
    }
  }
  if (cacheDirty) await env.GAMES_KV.put(CACHE_KEY, JSON.stringify(cache));

  // etopfun 时长盘赔率(失败不影响主流程;窗口对齐到最早一局)
  const oldestGame = games.length ? games[0].start_time : minTime;
  const etopMatches = await fetchEtopfunTimeOdds(oldestGame, errors);

  // 组装系列赛记录
  const matches = [];
  let oddsMatched = 0;
  for (const [seriesId, list] of seriesMap) {
    const first = list[0];
    const homeName = teamName(first.radiant_team_id);
    const awayName = teamName(first.dire_team_id);
    let homeScore = 0;
    let awayScore = 0;
    const recGames = [];
    list.forEach((g, idx) => {
      const cached = cache[g.match_id];
      const winRad = g.radiant_win;
      const winName = winRad ? teamName(g.radiant_team_id) : teamName(g.dire_team_id);
      if (winName === homeName) homeScore++;
      else awayScore++;
      if (!cached) return; // 详情抓取失败,跳过该局
      // 系列赛内可能换边:单局比分固定按 队伍A:队伍B 显示,换边局需翻转
      recGames.push({ box_num: idx + 1, swapped: g.radiant_team_id !== first.radiant_team_id, ...cached });
    });
    const rec = {
      id: String(seriesId),
      tournament: LEAGUE_NAME,
      stage: "",
      start_time: first.start_time,
      box: BO_MAP[first.series_type] || first.series_type || null,
      home: { name: homeName, score: homeScore },
      away: { name: awayName, score: awayScore },
      series_winner: homeScore > awayScore ? homeName : awayName,
      games: recGames,
    };
    // 关联 etopfun 赔率(按局序号对应 map)
    const e = matchEtopfun(rec, etopMatches);
    if (e) {
      oddsMatched++;
      for (const g of rec.games) {
        const odds = e.games.get(g.box_num);
        if (odds) Object.assign(g, odds);
        const kOdds = e.killsGames.get(g.box_num);
        if (kOdds) Object.assign(g, kOdds);
      }
    }
    matches.push(rec);
  }
  matches.sort((a, b) => b.start_time - a.start_time);

  const payload = {
    updated_at: Math.floor(Date.now() / 1000),
    odds_matched: oddsMatched,
    details_fetched: fetched,
    pending_details: pending,
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
        // 总人头(双方击杀之和)按人头盘口线判定大小,命中的一侧高亮
        const totalKills =
          g.home_kills != null && g.away_kills != null ? g.home_kills + g.away_kills : null;
        const kOver = totalKills != null && g.kline != null && totalKills > g.kline;
        const kUnder = totalKills != null && g.kline != null && totalKills <= g.kline;
        const koverCls = g.kover != null && kOver ? "win" : "";
        const kunderCls = g.kunder != null && kUnder ? "win" : "";
        // 缓存里 home_kills=该局天辉人头;换边局翻转,保证比分恒为 队伍A:队伍B
        const killsA = g.swapped ? g.away_kills : g.home_kills;
        const killsB = g.swapped ? g.home_kills : g.away_kills;
        rows.push(`<tr>
<td>${fmtDate(m.start_time)}</td>
<td class="${homeWin ? "win" : ""}">${homeMark}</td>
<td class="${awayWin ? "win" : ""}">${awayMark}</td>
<td>BO${esc(m.box)}</td>
<td>${esc(m.home.score)} : ${esc(m.away.score)}</td>
<td>Game ${esc(g.box_num)}</td>
<td>${esc(killsA)} : ${esc(killsB)}</td><td>${fmtTime(g.duration_sec)}</td>
<td>${esc(g.first_10_kills)}</td><td>${esc(g.first_blood)}</td>
<td>${g.line != null ? esc(g.line.toFixed(1)) : ""}</td>
<td class="${overCls}">${g.over ?? ""}</td><td class="${underCls}">${g.under ?? ""}</td>
<td>${g.kline != null ? esc(g.kline.toFixed(1)) : ""}</td>
<td class="${koverCls}">${g.kover ?? ""}</td><td class="${kunderCls}">${g.kunder ?? ""}</td>
</tr>`);
      }
    }
  }
  const updated = payload?.updated_at ? fmtDate(payload.updated_at) + " (UTC+8)" : "从未";
  // 均注回收对比:每局固定投 1,命中按该局赔率回收,比较均注大 vs 均注小哪边回收高
  // (仅统计盘口、大小赔率齐全的局)
  let dN = 0, dOverHit = 0, dOverRet = 0, dUnderRet = 0;
  let kN = 0, kOverHit = 0, kOverRet = 0, kUnderRet = 0;
  if (payload) {
    for (const m of payload.matches)
      for (const g of m.games) {
        if (g.duration_sec != null && g.line != null && g.over != null && g.under != null) {
          dN++;
          if (g.duration_sec > Math.round(g.line * 60)) { dOverHit++; dOverRet += g.over; }
          else dUnderRet += g.under;
        }
        if (g.home_kills != null && g.away_kills != null && g.kline != null && g.kover != null && g.kunder != null) {
          kN++;
          if (g.home_kills + g.away_kills > g.kline) { kOverHit++; kOverRet += g.kover; }
          else kUnderRet += g.kunder;
        }
      }
  }
  // 两扇区派图:均注大回收 vs 均注小回收,归一化为占比
  const pie = (name, n, overRet, underRet) => {
    const total = overRet + underRet;
    if (!n || total <= 0) return "";
    const p = overRet / total;
    const R = 56, C = 60;
    const ang = 2 * Math.PI * p;
    const x = (C + R * Math.sin(ang)).toFixed(2);
    const y = (C - R * Math.cos(ang)).toFixed(2);
    const slice =
      p >= 1
        ? `<circle cx="${C}" cy="${C}" r="${R}" fill="#3f7a4e"/>`
        : `<circle cx="${C}" cy="${C}" r="${R}" fill="#b0682c"/>` +
          (p > 0
            ? `<path d="M ${C} ${C} L ${C} ${C - R} A ${R} ${R} 0 ${p > 0.5 ? 1 : 0} 1 ${x} ${y} Z" fill="#3f7a4e"/>`
            : "");
    return (
      `<div class="pie"><div>${name}(${n} 局)</div>` +
      `<svg viewBox="0 0 120 120">${slice}</svg>` +
      `<div><span style="color:#6fd08c">大 ${(p * 100).toFixed(1)}%</span>(回收 ${overRet.toFixed(2)})` +
      ` · <span style="color:#e09a54">小 ${((1 - p) * 100).toFixed(1)}%</span>(回收 ${underRet.toFixed(2)})</div></div>`
    );
  };
  const pies =
    dN || kN
      ? `<p>均注回收占比:每局固定投 1,命中按赔率回收(港盘,回收 = 命中局赔率之和,回收 &gt; 未中局数即盈利)</p><div class="pies">` +
        pie("时长盘", dN, dOverRet, dUnderRet) +
        pie("人头盘", kN, kOverRet, kUnderRet) +
        `</div>`
      : "";
  // 均注大命中统计(顶部文字)
  const hitLine = (label, hit, n) =>
    `均注大·${label}(每局买大,按 etopfun 盘口线判定) — <b>命中 ${hit} / ${n} 局` +
    `(${((hit / n) * 100).toFixed(1)}%)</b>,未中 ${n - hit} 局`;
  const durationStats =
    dN || kN
      ? `<p>` +
        (dN ? hitLine("时长", dOverHit, dN) : "") +
        (dN && kN ? `<br>` : "") +
        (kN ? hitLine("人头", kOverHit, kN) : "") +
        `(赔率列绿色为命中侧)</p>`
      : "";
  const errs = payload?.errors?.length
    ? `<p class="err">抓取告警 ${payload.errors.length} 条:${payload.errors.map(esc).join("; ")}</p>`
    : "";
  const pendingNote = payload?.pending_details
    ? `<p class="err">还有 ${payload.pending_details} 局详情待抓取,将随后续定时抓取自动补全(受单次请求数限制,每次最多补 40 局)。</p>`
    : "";
  const body = rows.length
    ? `<table><thead><tr>
<th>开赛时间</th><th>队伍A</th><th>队伍B</th><th>赛制</th>
<th>赛果</th><th>局</th><th>单局比分</th><th>用时</th>
<th>先10杀</th><th>一血</th>
<th>时长盘口</th><th>大赔率</th><th>小赔率</th>
<th>人头盘口</th><th>大赔率</th><th>小赔率</th>
</tr></thead><tbody>${rows.join("\n")}</tbody></table>`
    : payload
      ? "<p>抓取成功,但统计区间内没有已完赛的 DOTA2 比赛(赛事空窗期)。</p>"
      : "<p>暂无数据,等待首次抓取。</p>";

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DOTA2 赛果 - ${esc(LEAGUE_NAME)}</title>
<style>
body{font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;margin:24px;color:#e8eaf0;background:#15181e}
h1{font-size:18px} .meta{color:#8a90a0;margin-bottom:12px} .err{color:#f2a154;font-size:12px}
table{border-collapse:collapse;width:100%;background:#1d2129}
th,td{border:1px solid #2c313c;padding:6px 10px;text-align:left;white-space:nowrap}
th{background:#252a35;position:sticky;top:0}
tr:nth-child(even){background:#20242e}
.win{color:#6fd08c;font-weight:600}
.pies{display:flex;gap:48px;margin-top:16px}
.pie{font-size:13px;color:#c9cedb;text-align:center}
.pie svg{width:150px;height:150px;margin:6px 0}
</style></head><body>
<h1>${esc(LEAGUE_NAME)} · 每局数据</h1>
<p class="meta">赛果来源 OpenDota · 盘口来源 etopfun.com · 更新时间:${esc(updated)} · 时间均为 UTC+8 · 单局比分 = 队伍A:队伍B · 绿色为该局/该盘口命中方</p>
${durationStats}
${pendingNote}
${errs}
${body}
${pies}
</body></html>`;
}

// ---------- 入口 ----------

const DISABLED_KEY = "dota2:disabled"; // 赛事结束标记:存在则 Cron 永久停抓

/**
 * 定时抓取闸门,尽量减少 OpenDota 调用(按调用次数计费):
 * - 比赛时段(UTC+8 ACTIVE_START_HOUR 点至 ACTIVE_END_HOUR 点)之外直接跳过
 * - 赛事结束后(最新一场比赛超过 STALE_DAYS 天)写入结束标记,Cron 永久停抓;
 *   不会自动恢复,访问一次 /refresh 清除标记并立即抓取,即为手动恢复
 */
async function scheduledShouldRun(env) {
  if (await env.GAMES_KV.get(DISABLED_KEY)) return false;
  const startH = parseInt(env.ACTIVE_START_HOUR || "9", 10); // UTC+8
  const endH = parseInt(env.ACTIVE_END_HOUR || "24", 10); // 24 = 午夜
  const hourCN = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  if (hourCN < startH || hourCN >= endH) return false;
  const staleDays = parseInt(env.STALE_DAYS || "5", 10);
  if (staleDays > 0) {
    const raw = await env.GAMES_KV.get(KV_KEY);
    const payload = raw ? JSON.parse(raw) : null;
    const newest = payload?.matches?.[0]?.start_time; // matches 按开赛时间倒序
    if (newest && Date.now() / 1000 - newest > staleDays * 86400) {
      await env.GAMES_KV.put(DISABLED_KEY, String(Math.floor(Date.now() / 1000)));
      return false;
    }
  }
  return true;
}

export default {
  async scheduled(event, env, ctx) {
    if (await scheduledShouldRun(env)) ctx.waitUntil(scrape(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/refresh") {
      try {
        // 手动触发 = 手动恢复:清除赛事结束标记,Cron 重新生效
        await env.GAMES_KV.delete(DISABLED_KEY);
        const payload = await scrape(env);
        return new Response(
          `抓取完成:${payload.matches.length} 个系列赛,新抓 ${payload.details_fetched} 局详情,待补 ${payload.pending_details} 局,${payload.errors.length} 条告警`,
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
