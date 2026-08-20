# DOTA2 赛果抓取与展示(Cloudflare Worker)设计

日期:2026-08-15(2026-08-20 修订:数据源从 esports8 切换为 OpenDota)

## 目标

定时抓取 DOTA2 The International 2026(OpenDota leagueid 19719,可用 `LEAGUE_ID` 配置)已完赛比赛每一局的数据,存入 Cloudflare KV,访问 Worker URL 时以 HTML 表格展示;并关联 etopfun 的每局时长大小盘赔率,顶部给出时长大小统计结论。

## 数据源

### OpenDota(赛果)

公开免费 API(`https://api.opendota.com`),无需登录/签名;匿名约 60 次/分钟、每日限额,因此:

- 请求限速(≥1.1s 间隔)并带重试(2s/5s 退避)
- 单局详情一旦抓取即永久缓存于 KV key `dota2:gamecache`(已完赛数据不可变),日常运行只增量抓新局

端点:

| 端点 | 用途 |
|---|---|
| `GET /api/leagues/{id}/matches` | 联赛全部局(match_id、双方 team_id、人头、用时、radiant_win、series_id、series_type、start_time) |
| `GET /api/teams` | team_id → 队名 |
| `GET /api/matches/{match_id}` | 单局详情(见下) |

单局字段映射(队伍A=天辉 radiant,队伍B=夜魇 dire):

| 字段 | 来源 |
|---|---|
| 单局比分(人头) | `radiant_score` / `dire_score` |
| 用时(秒) | `duration` |
| 单局胜者 | `radiant_win` |
| coin-value(经济) | 该方 5 名选手 `net_worth` 之和 |
| 一血 | `players[].firstblood_claimed` 所在方 |
| 首塔 | `objectives` 首个 tower 类 `building_kill`,被拆建筑所属方的对方 |
| 先10杀 | 双方选手 `kills_log` 时间戳合并排序,先达到 10 杀的一方 |

系列赛:按 `series_id` 归组,`series_type` 0/1/2 = BO1/BO3/BO5;大比分与系列赛胜者按各局胜者累计。

### etopfun.com(时长大小盘赔率)

无需登录/签名:`GET https://www.etopfun.com/api/match/list.do?status=end&game=dota2&rows=20&page=N`(按时间倒序分页,抓到早于所需日期即止)。

- 每场 `sublist[]` 为盘口:`map`=0 全场 / 1,2,3 对应 Game1/2/3;`type=9` 为时长大小盘
- 时长盘:`totalScore` = 盘口线(分钟,如 44.0/45.0),`vs1.odds` = 大时间赔率,`vs2.odds` = 小时间赔率(已用已结算盘口 `winTeam: "Over"/"Under"` 验证)
- 与 OpenDota 比赛的对应:无共通 ID,用"双方队名模糊匹配(规范化包含/去 team/gaming 前后缀/共享 ≥4 字母单词/首字母缩写如 VG↔Vici Gaming)+ 开赛时间差 <6h 取最近"锁定;部分比赛 etopfun 未开时长盘,相应列为空

## 架构

Cloudflare Worker + KV + Cron Trigger,零 npm 运行时依赖。

- `src/worker.js` — 单文件 Worker:
  - `scheduled()` handler:Cron 触发,执行抓取流程,结果写 KV
  - `fetch()` handler:GET `/` 读 KV 渲染 HTML 表格;GET `/refresh` 手动触发一次抓取
- `wrangler.toml` — KV namespace 绑定(`GAMES_KV`)、Cron(`*/30 * * * *`)、环境变量 `DAYS`(默认 1)、`LEAGUE_ID`(默认 19719)
- `README.md` — 部署步骤

## 抓取流程(scheduled / refresh)

1. 并行取联赛全部局列表 + 队伍表;`DAYS>0` 时按时间窗(UTC+8)过滤,`DAYS=0`(默认)展示联赛全部;按 `series_id` 归组
2. 单局详情先查 KV 缓存,未命中才调 OpenDota(限速);受 Workers 免费版单次约 50 子请求上限约束,每次最多补 40 局,剩余记入 `pending_details` 由后续 Cron 分轮补齐,写回缓存
3. 抓 etopfun 时长盘赔率(失败不影响主流程;翻页窗口对齐到统计范围内最早一局)
4. 组装系列赛记录并关联赔率(按局序号对应 etopfun 的 map 号)
5. 结果 + 抓取时间戳写入 KV key `dota2:games`

## 展示(fetch, GET /)

服务端渲染 HTML 表格,每局一行,列:

赛事 | 阶段 | 开赛时间 | 队伍A | 队伍B | BO几 | 大比分 | 系列赛胜者 | Game序号 | 单局比分 | 用时 | A经济 | B经济 | 先10杀 | 一血 | 首塔 | 时长盘口 | 大赔率 | 小赔率

- 按开赛时间倒序;该局胜者队名绿色高亮;赔率命中侧绿色高亮
- 顶部:数据更新时间;时长对比 44:00 的大小统计;按盘口线判定的大小统计
- 空态:从未抓取 vs 抓取成功但区间内无比赛(赛事空窗)分别提示

## 错误处理

- OpenDota / etopfun 请求失败:重试后仍失败则跳过该局/该场,记入页面顶部告警,下次抓取自动补全
- KV 无数据时显示"暂无数据,等待首次抓取"

## 测试

- 本地模拟 KV 跑通 `/refresh` + `/`:5 个系列赛 12 局全量字段正确,二次运行 0 新抓(缓存命中),赔率 5/5 匹配
