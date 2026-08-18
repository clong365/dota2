# esports8 DOTA2 赛果抓取与展示(Cloudflare Worker)设计

日期:2026-08-15

## 目标

定时抓取 esports8.com DOTA2 已完赛比赛每一局的数据,存入 Cloudflare KV,访问 Worker URL 时以 HTML 表格展示。

## 数据源(已逆向验证)

签名机制(来自前端 JS chunk `0233b2e.js` module 267/268 及 `483226d.js` module 21):

- 任意页面 HTML 内 `window.__NUXT__.state` 含 `s` / `k` / `l` 三个值,每次运行重新从首页 `https://www.esports8.com/en/` 获取
- XOR key = `AES-128-CBC-decrypt(hex(s), key=utf8(k), iv=utf8(l))`,按 utf8 解码为字符串
- `content = [排序后的 params 值拼接, unix时间戳 - 655876800, "js", v1路径].join("&")`
- `sign = base64( content 逐字符 charCode 与 key[(i+19) % key.length] 异或后的字符串, utf8 编码 )`
- GET 请求附加参数 `k=sign`

API 端点(base `https://www.esports8.com`,需带 `User-Agent`、`Referer`、`language: en` 头):

| 端点 | 参数 | 用途 |
|---|---|---|
| `/web/api/home/match/list` | `game_id=3`, `search_time=<当天0点unix秒>` | 比赛列表;`status_id=3` 为已完赛;`box`=BO几(3→BO3, 5→BO5) |
| `/web/api/match/live_nav` | `match_id` | 每局列表:`tabs[].box_num`、`win_team` |
| `/web/api/match/live_data` | `match_id`, `box_num` | 单局详情(见下) |

### etopfun.com(时长大小盘赔率)

无需登录/签名:`GET https://www.etopfun.com/api/match/list.do?status=end&game=dota2&rows=20&page=N`(按时间倒序分页,抓到早于所需日期即止)。

- 每场 `sublist[]` 为盘口:`map`=0 全场 / 1,2,3 对应 Game1/2/3;`type=9` 为时长大小盘
- 时长盘:`totalScore` = 盘口线(分钟,如 44.0/45.0),`vs1.odds` = 大时间赔率,`vs2.odds` = 小时间赔率(已用已结算盘口 `winTeam: "Over"/"Under"` 验证)
- 与 esports8 比赛的对应:无共通 ID,用"双方队名模糊匹配(规范化包含/去 team 前缀/共享 ≥4 字母单词)+ 开赛时间差 <6h 取最近"锁定;部分比赛 etopfun 未开时长盘,相应列为空

DOTA2(game_id=3)单局 `live_data` 字段映射(`home`/`away` 各有一个 `stats` 数组;左右展示顺序由 `home.side` 决定,本设计统一按 home/away 输出,不做左右交换):

| 字段 | 来源 |
|---|---|
| 单局比分(人头) | `stats[7]` |
| coin-value(经济) | `stats[8]` |
| 一血 | `stats[3]`(1=该方获得) |
| 首塔 | `stats[4]` |
| 推塔数 | `stats[1]` |
| 总金钱 | `stats[0]` |
| 先10杀 | `stats[6]`(1=该方先10杀) |
| 单局胜方标记 | `stats[9]` |
| 用时(秒) | `timer[3]`(如 3226 = 53:46) |

单局胜者以 `live_nav.win_team` 为准;与 `stats[9]` 不一致时在表格中标记。样例数据中两者存在矛盾(该站数据疑似含生成成分),以接口返回为准。

## 架构

Cloudflare Worker + KV + Cron Trigger,零 npm 依赖(签名用 Web Crypto API `crypto.subtle`)。

- `src/worker.js` — 单文件 Worker:
  - `scheduled()` handler:Cron 触发,执行抓取流程,结果写 KV
  - `fetch()` handler:GET `/` 读 KV 渲染 HTML 表格;GET `/refresh` 手动触发一次抓取(便于测试,可选)
- `wrangler.toml` — KV namespace 绑定(`GAMES_KV`)、Cron(默认 `*/30 * * * *`)、环境变量 `DAYS`(抓取最近 N 天,默认 1)
- `README.md` — 部署步骤:`wrangler login` → `wrangler kv:namespace create GAMES_KV` → 填入 id → `wrangler deploy`

## 抓取流程(scheduled)

1. 抓首页提取 `s/k/l`,生成签名 key
2. 对最近 N 天逐天调 `home/match/list`(`search_time` = 当天 0 点),过滤 `status_id=3`
3. 每场调 `live_nav` 拿局数;每局调 `live_data` 提取字段
4. API 请求间隔 ≥300ms;单个接口失败跳过该场并记录错误,不中断整体
5. 全部结果 + 抓取时间戳写入 KV key `dota2:games`

## 展示(fetch, GET /)

服务端渲染 HTML 表格,每局一行,列:

赛事 | 阶段 | 开赛时间 | 队伍A | 队伍B | BO几 | 大比分 | 系列赛胜者 | Game序号 | 单局胜者 | 单局比分 | 用时 | A经济 | B经济 | 先10杀 | 一血 | 首塔 | 时长盘口 | 大赔率 | 小赔率

按开赛时间倒序;顶部显示数据更新时间、时长对比 44:00 的大小统计、按盘口线判定的大小统计(赔率列绿色为命中侧)。

## 输出数据结构(KV 中的 JSON)

```json
{
  "updated_at": 1786800000,
  "matches": [
    {
      "id": "em4sxugt860g3fr",
      "tournament": "The International 2026",
      "stage": "Group Stage",
      "start_time": 1786786860,
      "box": 3,
      "home": {"name": "LGD", "score": 2},
      "away": {"name": "VG", "score": 0},
      "series_winner": "LGD",
      "games": [
        {
          "box_num": 1,
          "winner": "VG",
          "winner_conflict": true,
          "home_kills": 26, "away_kills": 17,
          "duration_sec": 3226,
          "home_coin": 152454, "away_coin": 111579,
          "first_10_kills": "VG",
          "first_blood": "LGD",
          "first_tower": "LGD"
        }
      ]
    }
  ],
  "errors": []
}
```

## 错误处理

- 密钥获取失败 / 签名错误(code≠0):本次抓取中止,保留 KV 中旧数据,错误写入 `errors`
- 单场/单局失败:跳过并记录,继续其余
- KV 无数据时页面显示"暂无数据,等待首次抓取"

## 测试

- 本地 `wrangler dev` 验证 scheduled(通过 `/refresh` 或 `wrangler dev --test-scheduled`)与页面渲染
- 用样例比赛 `em4sxugt860g3fr` 核对字段(人头 26:17、用时 53:46、经济 152454/111579、VG 先10杀、LGD 一血/首塔)
