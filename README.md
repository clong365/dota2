# dota2-results

抓取 [esports8.com](https://www.esports8.com/en/) DOTA2 已完赛比赛的每局数据,并关联 [etopfun.com](https://www.etopfun.com/) 的每局时长大小盘赔率。Cloudflare Worker 定时抓取存入 KV,访问页面以 HTML 表格展示,顶部给出时长大小统计结论。

设计文档:`docs/superpowers/specs/2026-08-15-esports8-dota2-worker-design.md`

## 页面内容

每局一行:

| 列 | 说明 |
|---|---|
| 赛事 / 阶段 / 开赛时间 | 开赛时间为 UTC+8 |
| 队伍A / 队伍B | **绿色 = 该局胜者**;数据源不一致时胜方队名带 ⚠ |
| 赛制 / 大比分 / 系列赛胜者 | box=3 即 BO3 |
| 局 / 单局比分 | Game 序号、人头比 |
| 用时 / A经济 / B经济 | 用时 mm:ss;经济即 coin-value |
| 先10杀 / 一血 / 首塔 | 达成方队名 |
| 时长盘口 / 大赔率 / 小赔率 | 来自 etopfun;绿色 = 命中侧;未开盘则留空 |

顶部统计:时长对比 44:00 的大小局数与占比,以及按盘口线判定的大小局数与占比。

## 文件

- `src/worker.js` — Worker 主体(签名、抓取、渲染,零 npm 运行时依赖)
- `wrangler.toml` — KV / Cron / 环境变量配置
- `es8_api.cjs` — 独立的 Node 命令行客户端,用于本地探测接口(`node es8_api.cjs`)
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

- `DAYS` — 抓取最近 N 天(含今天,按 UTC+8 划分),默认 `1`;建议 1~3,避免单次抓取过久

## 本地调试

```bash
npx wrangler dev           # 本地起服务,访问 http://localhost:8787/refresh 触发抓取
```

注意:本地 `wrangler dev` 使用模拟 KV,数据不会写入线上。

## 数据说明

- esports8 接口带签名(逆向自前端 JS):首页 `__NUXT__` 提取 `s/k/l` → AES-128-CBC 解出 XOR key → 参数签名 `k`;实现见 `src/worker.js` 顶部注释
- 单局胜者取 `live_nav.win_team`;若与 `live_data` 的胜方标记(`stats[9]`)不一致,页面中以 ⚠ 标记
- etopfun 与 esports8 无共通比赛 ID,按"队名模糊匹配 + 开赛时间窗口"关联;部分比赛 etopfun 未开时长盘,相应列为空属正常
- esports8 源站偶发 5xx,首页与 API 请求均已带重试;单场/单局失败会跳过并记入页面顶部告警,下次抓取自动补全
- 该站数据疑似含生成成分(样例中存在归属矛盾),结果以接口返回为准
