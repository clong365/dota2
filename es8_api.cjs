"use strict";
/**
 * esports8.com API 客户端(零依赖, Node >= 18)。
 *
 * 签名机制(逆向自前端 JS):
 * - 任意页面 HTML 内 window.__NUXT__.state 含有 s / k / l 三个值
 * - XOR key = AES-128-CBC-decrypt(hex(s), key=utf8(k), iv=utf8(l))
 * - content = [排序后拼接的params值, unix时间戳-655876800, "js", "/v1/...路径"].join("&")
 * - sign  = base64( content 逐字符与 key[(i+19)%len] 异或后的字符串, utf8 )
 * - GET 请求附加参数 k=sign
 */
const crypto = require("crypto");

const BASE = "https://www.esports8.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** 从页面 HTML 中提取 __NUXT__.state 的 s/k/l */
async function loadSecrets() {
  const html = await fetchText(BASE + "/en/");
  const i = html.indexOf("window.__NUXT__=") + "window.__NUXT__=".length;
  const j = html.indexOf("</script>", i);
  const data = eval(html.slice(i, j));
  const { s, k, l } = data.state;
  return { s, k, l };
}

class Esports8 {
  static async create() {
    const { s, k, l } = await loadSecrets();
    const d = crypto.createDecipheriv("aes-128-cbc", Buffer.from(k, "utf8"), Buffer.from(l, "utf8"));
    const key = d.update(s, "hex", "utf8") + d.final("utf8");
    return new Esports8(key);
  }
  constructor(key) {
    this.key = key;
  }
  sign(params, path) {
    const vals = Object.values(params).map(String).sort().join("");
    const content = [vals, Math.floor(Date.now() / 1000) - 655876800, "js", path].join("&");
    const key = this.key;
    const xored = [...content]
      .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key[(i + 19) % key.length].charCodeAt(0)))
      .join("");
    return Buffer.from(xored, "utf8").toString("base64");
  }
  /** apiPath 形如 /web/api/match/live_data */
  async get(apiPath, params = {}) {
    const v1Path = apiPath.replace("/web/api/", "/v1/");
    const q = new URLSearchParams({ ...params, k: this.sign(params, v1Path) });
    const res = await fetch(`${BASE}${apiPath}?${q}`, {
      headers: { "User-Agent": UA, Referer: BASE + "/en/", language: "en" },
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`API error ${apiPath}: ${JSON.stringify(data)}`);
    return data.data;
  }
}

module.exports = { Esports8 };

if (require.main === module) {
  (async () => {
    const api = await Esports8.create();
    console.log("sign key OK");
    const data = await api.get("/web/api/home/match/list", { game_id: 3, search_time: 0 });
    const matches = data.matches || [];
    console.log(`matches: ${matches.length}`);
    for (const m of matches) {
      console.log(
        " ", m.id, "status", m.status_id,
        m.home.name, m.home.score, "-", m.away.score, m.away.name
      );
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
