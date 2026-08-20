# dota2-results

抓取 DOTA2 **The International 2026** 已完赛比赛的每局数据,并关联 [etopfun.com](https://www.etopfun.com/) 的每局时长、总人头大小盘赔率。Cloudflare Worker 定时抓取存入 KV,访问页面以 HTML 表格展示,顶部给出均注大统计结论。

设计文档:`docs/superpowers/specs/2026-08-15-dota2-worker-design.md`

## 数据源

- **赛果**:[OpenDota](https://www.opendota.com/) API(key 按调用计费 $0.01/100 次、3000 次/分钟;未配 key 时匿名调用,但匿名限额按共享出口 IP 计,Cloudflare 上容易被他人耗尽)。单局详情一旦抓取即永久缓存于 KV(已完赛数据不可变),日常 Cron 运行只增量抓新局,配额消耗极小
- **赔率**:etopfun 公开接口,无需登录/签名;与 OpenDota 比赛按"队名模糊匹配(含缩写如 VG ↔ Vici Gaming)+ 开赛时间窗口"关联;部分比赛未开盘,相应列为空属正常

## 页面内容

每局一行(队伍A=天辉,队伍B=夜魇):

| 列 | 说明 |
|---|---|
| 赛事 / 阶段 / 开赛时间 | 开赛时间为 UTC+8 |
| 队伍A / 队伍B | **绿色 = 该局胜者** |
| 赛制 / 大比分 / 系列赛胜者 | 按 series_id 归组,BO1/BO3/BO5 |
| 局 / 单局比分 | Game 序号、天辉:夜魇人头比 |
| 用时 / A经济 / B经济 | 用时 mm:ss;经济 = 该方 5 名选手 net_worth 之和 |
| 先10杀 / 一血 / 首塔 | 由 kills_log 时间戳、firstblood_claimed、objectives 推出 |
| 时长盘口 / 大赔率 / 小赔率 | 来自 etopfun;绿色 = 命中侧 |
| 人头盘口 / 大赔率 / 小赔率 | 总人头(双方击杀之和)大小盘;绿色 = 命中侧 |

顶部统计:均注大(每局买大,按 etopfun 盘口线判定)的命中局数与占比,时长盘、人头盘各一行。

## 文件

- `src/worker.js` — Worker 主体(抓取、渲染,零 npm 运行时依赖)
- `wrangler.toml` — KV / Cron / 环境变量配置
- `preview.html` — 最近一次本地抓取渲染的页面快照

## 部署

```bash
npm install
npx wrangler login
npx wrangler kv namespace create GAMES_KV
# 把输出的 id 填入 wrangler.toml 的 [[kv_namespaces]].id
npx wrangler deploy
```

部署后 Cron 每 30 分钟抓一次并覆盖 KV 数据;访问 `https://<worker 域名>/refresh` 手动触发(请求会挂到抓取结束),`/refresh` 返回后再访问 `/` 查看结果页。

## 配置

`wrangler.toml` 的 `[vars]`:

- `DAYS` — 抓取最近 N 天(含今天,按 UTC+8 划分);`0`(默认)= 不过滤,展示联赛全部比赛
- `LEAGUE_ID` — OpenDota 联赛 ID,默认 `19719`(The International 2026)
- `ACTIVE_START_HOUR` / `ACTIVE_END_HOUR` — Cron 抓取时段(UTC+8,默认 9–24 点);时段外 Cron 直接跳过,不调用 OpenDota
- `STALE_DAYS` — 最新一场比赛超过 N 天(默认 5)视为赛事结束:写入结束标记,Cron **永久停抓,下届联赛不自动恢复**;访问一次 `/refresh` 清除标记并立即抓取,即为手动恢复。`0` = 不启用

OpenDota 按调用次数计费($0.01/100 次),通过 `npx wrangler secret put OPENDOTA_API_KEY` 配置 key。常态消耗:每次 Cron 仅 1 次联赛列表调用(时段内约 30 次/天),单局详情每局终身 1 次(KV 永久缓存);`/refresh` 手动触发不受时段/过期闸门限制。

注意:Workers 免费版单次调用约 50 个子请求上限,单局详情每次抓取最多补 40 局;首次全量回填(如 TI2026 共 115 局)由后续 Cron 自动分轮补齐,期间页面顶部会提示待补局数。

## 本地调试

```bash
npx wrangler dev           # 本地起服务,访问 http://localhost:8787/refresh 触发抓取
```

注意:本地 `wrangler dev` 使用模拟 KV,数据不会写入线上。开发依赖里的 `undici` 仅用于本地测试时走系统代理,Worker 运行不需要。

## 数据说明

- OpenDota 限速 60 次/分钟以内(请求已带重试),单局详情有 KV 缓存
- 单场详情抓取失败会跳过该局并记入页面顶部告警,下次抓取自动补全
- etopfun 时长盘:`type=9`,`totalScore` 为盘口线(分钟),`vs1.odds`=大、`vs2.odds`=小
- etopfun 总人头盘:`type=13`,`totalScore` 为盘口线(击杀数),`vs1`=Over(大)、`vs2`=Under(小)
