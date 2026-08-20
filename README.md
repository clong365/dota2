# dota2-results

抓取 DOTA2 **The International 2026** 已完赛比赛的每局数据,并关联 [etopfun.com](https://www.etopfun.com/) 的每局时长大小盘赔率。Cloudflare Worker 定时抓取存入 KV,访问页面以 HTML 表格展示,顶部给出时长大小统计结论。

设计文档:`docs/superpowers/specs/2026-08-15-dota2-worker-design.md`

## 数据源

- **赛果**:[OpenDota](https://www.opendota.com/) 公开 API(免费,匿名约 60 次/分钟、每日限额)。单局详情一旦抓取即永久缓存于 KV(已完赛数据不可变),日常 Cron 运行只增量抓新局,配额消耗极小
- **赔率**:etopfun 公开接口,无需登录/签名;与 OpenDota 比赛按"队名模糊匹配(含缩写如 VG ↔ Vici Gaming)+ 开赛时间窗口"关联;部分比赛未开时长盘,相应列为空属正常

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

顶部统计:时长对比 44:00 的大小局数与占比,以及按盘口线判定的大小局数与占比。

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

- `DAYS` — 抓取最近 N 天(含今天,按 UTC+8 划分),默认 `1`
- `LEAGUE_ID` — OpenDota 联赛 ID,默认 `19719`(The International 2026)

## 本地调试

```bash
npx wrangler dev           # 本地起服务,访问 http://localhost:8787/refresh 触发抓取
```

注意:本地 `wrangler dev` 使用模拟 KV,数据不会写入线上。开发依赖里的 `undici` 仅用于本地测试时走系统代理,Worker 运行不需要。

## 数据说明

- OpenDota 匿名限额约 60 次/分钟;请求已限速并带重试,单局详情有 KV 缓存
- 单场详情抓取失败会跳过该局并记入页面顶部告警,下次抓取自动补全
- etopfun 时长盘:`type=9`,`totalScore` 为盘口线(分钟),`vs1.odds`=大、`vs2.odds`=小
