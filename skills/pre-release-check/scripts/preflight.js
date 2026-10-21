#!/usr/bin/env node
/**
 * preflight.js —— 「鲸落书简」发布前检查（Day 25）
 * ================================================================
 * 干什么：推上线 / 交出去之前，把「容易炸的九件事」逐条实测一遍，出数字。
 *
 * 用法：
 *   node skills/pre-release-check/scripts/preflight.js
 *   node skills/pre-release-check/scripts/preflight.js --only 1,2
 *   node skills/pre-release-check/scripts/preflight.js --md docs/skill-runs/2026-10-21.md
 *
 * 退出码：0 = 没有 FAIL ｜ 1 = 有 FAIL ｜ 2 = 脚本自己崩了
 *
 * 设计约束（对应 SKILL.md 的 R1~R5）：
 *   R1 每条都出实测数字，禁止「应该没问题」
 *   R2 三态 PASS / FAIL / MANUAL，人工项不计入通过
 *   R3 有 FAIL 就退出码 1，让「虚报通过」在机器层面不成立
 *   R4 查不动记 FAIL(reason)，不记 PASS
 *   R5 汇总必须说清红了几条、哪几条
 *
 * 依赖：Node（零第三方包）+ curl + git。本机开着 Watt Toolkit，
 *       所以所有 curl 都带 --ssl-no-revoke，否则报证书吊销检查失败。
 */

"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// ---------- 常量：项目地址与清单 ----------

// 仓库根目录（本文件在 skills/pre-release-check/scripts/ 下，往上三层）
const ROOT = path.resolve(__dirname, "../../..");

const CFG = {
  // GitHub Pages（静态站，推 main 后 1~3 分钟自动更新）
  pagesBase: "https://xingho-vibecoding.github.io/whale-fall-letters",
  // CloudBase 静态托管（⚠ 手动上传，git push 不动它）
  staticBase: "https://reading-sea-d7gd8l7o78b7304ae-1385227197.tcloudbaseapp.com",
  // HTTP 云函数网关（首选 service 域名）
  apiBase: "https://reading-sea-d7gd8l7o78b7304ae.service.tcloudbase.com",
  // 第 4 条逐文件比对的目标：前端五件套
  staticFiles: ["index.html", "styles.css", "app.js", "store.js", "community.js"],
  // 第 5 条要求的字段（is_deleted 是下划线，别按驼峰猜）
  bookFields: [
    "id", "title", "author", "coverUrl", "status", "totalPages",
    "currentPage", "startedAt", "finishedAt", "createdAt", "is_deleted",
  ],
};

const HTTP_META = "\n__PREFLIGHT_HTTP_STATUS__";
// ⚠ curl 的 -w 只输出你写在里面的东西。之前漏了 %{http_code}，
// 结果状态码永远解析成 0：接口明明返回了数据，却被判成「连不上」。
// 这类 bug 比检查项本身更危险——它会让你以为检查在报错，其实是检查自己瞎了。
const HTTP_FORMAT = HTTP_META + "%{http_code}";

// ---------- 小工具 ----------

const isTTY = Boolean(process.stdout.isTTY);

/** 颜色只在真终端里开，重定向到文件时不带转义码 */
function paint(code, text) {
  if (!isTTY) return text;
  const map = { green: 32, red: 31, yellow: 33, gray: 90, cyan: 36 };
  return `\x1b[${map[code] || 0}m${text}\x1b[0m`;
}

/** 跑一个命令，永不抛异常；失败也把 stdout/stderr 带回来 */
function run(bin, args, opts) {
  try {
    const out = execFileSync(bin, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts || {}),
    });
    return { ok: true, code: 0, out: out == null ? "" : String(out), err: "" };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === "number" ? e.status : null,
      out: e.stdout == null ? "" : String(e.stdout),
      err: (e.stderr == null ? "" : String(e.stderr)) || e.message || "未知错误",
    };
  }
}

function git(...args) {
  return run("git", args);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
let tmpSeq = 0;
function tmpFile(name) {
  tmpSeq += 1;
  return path.join(tmpDir, `${tmpSeq}-${name}`);
}

/** 把多行错误压成一行，报告里不至于刷屏 */
function brief(text, max) {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  const n = max || 120;
  return one.length > n ? one.slice(0, n) + "…" : one;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sha256NoCR(buf) {
  // 行尾 CRLF / LF 的差异不算「内容不同」，先去掉 \r 再算哈希
  return crypto.createHash("sha256").update(buf.toString("binary").replace(/\r/g, ""), "binary").digest("hex");
}

/**
 * 去掉 \r 之后的字节长度。
 *
 * ⚠ 为什么需要这个（2026-10-21 Day 26 踩到）：第 4 条原先用「原始字节数相等」+
 *   「去 CR 后哈希相等」两个条件，两个口径不一致 —— 本地工作区是 CRLF（core.autocrlf=true），
 *   线上是 LF，于是字节数必然差「行数」那么多（index.html 差 942 = 942 行），
 *   哈希明明相同却因为字节数先卡住而判 FAIL。
 *   证据：那天一个前端文件字都没改，回滚演练后复跑，第 4 条照样报红，
 *   报出「本地 120448 / 线上 117465（差 -2983）」，而 2983 正好是该文件的行数。
 *   现在字节数与哈希统一走「去 CR」口径，行尾差异不再误报。
 */
function lenNoCR(buf) {
  return buf.toString("binary").replace(/\r/g, "").length;
}

/** 跑一次 curl，返回状态码与落盘字节数 */
function curlFile(url, dest) {
  const r = run("curl", [
    "--ssl-no-revoke", "-sS", "-L", "-m", "25",
    "-o", dest, "-w", "%{http_code}", url,
  ]);
  const code = parseInt((r.out || "").trim(), 10);
  const exists = fs.existsSync(dest);
  const bytes = exists ? fs.statSync(dest).size : 0;
  return {
    status: Number.isFinite(code) ? code : 0,
    bytes,
    buf: exists ? fs.readFileSync(dest) : Buffer.alloc(0),
    err: r.ok ? "" : brief(r.err),
  };
}

/** 跑一次 curl 拿 JSON，返回状态码 + 解析后的 body */
function curlJson(method, url, bodyObj) {
  const args = ["--ssl-no-revoke", "-sS", "-m", "25", "-X", method, "-w", HTTP_FORMAT];
  if (bodyObj !== undefined) {
    // 用文件传 body：命令行直接带中文 JSON 在 Windows 上会被编码搞坏
    const bf = tmpFile("body.json");
    fs.writeFileSync(bf, JSON.stringify(bodyObj), "utf8");
    args.push("-H", "Content-Type: application/json; charset=utf-8", "--data-binary", "@" + bf);
  }
  args.push(url);

  const r = run("curl", args);
  const raw = r.out || "";
  const cut = raw.lastIndexOf(HTTP_META);
  const status = cut >= 0 ? parseInt(raw.slice(cut + HTTP_META.length), 10) : 0;
  const text = cut >= 0 ? raw.slice(0, cut) : raw;

  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }
  return {
    status: Number.isFinite(status) ? status : 0,
    body,
    text,
    err: r.ok ? "" : brief(r.err),
  };
}

// 只跟踪「git 管得到的文件」——临时目录、.temp、被忽略的脚本天然不在里面
function trackedFiles() {
  const r = git("ls-files", "-z");
  if (!r.ok) return { ok: false, files: [], err: brief(r.err) };
  return { ok: true, files: r.out.split("\0").filter(Boolean), err: "" };
}

// ---------- 九条检查 ----------
// 每条返回 { status: "PASS"|"FAIL", evidence: "带数字的一句话" }

/** 1. 密钥不进仓库 */
function check1_keys() {
  const t = trackedFiles();
  if (!t.ok) return { status: "FAIL", evidence: `git ls-files 失败，无法扫描：${t.err}` };

  const rules = [
    // 真实世界的 sk- 密钥几乎都分段带连字符（sk-live-…/sk-proj-…/sk-ant-api03-…），
    // 所以字符集必须含 - 和 _。Day 25 第一版写成 [A-Za-z0-9]，把 sk-live-xxx 整个漏掉了。
    {
      label: "sk- 长串",
      re: /sk-[A-Za-z0-9_-]{16,}/g,
      // 占位符不报：文档里写 sk-live-XXXX… 是在举例，不是泄露。
      // 没有这条，SKILL.md 和验证记录自己就会被自己扫红（Day 25 真踩过）。
      skip: (m) => /X{6,}|REDACTED|EXAMPLE|placeholder|[…]/i.test(m[0]),
    },
    { label: "Bearer 长令牌", re: /Bearer\s+[A-Za-z0-9._\-]{24,}/g },
    {
      label: "键名被直接赋长字面量",
      re: /(?:api[_-]?key|apikey|secret|passwd|password|access[_-]?token)\s*[:=]\s*["'`]([^"'`\r\n]{12,})["'`]/gi,
      // 值看起来是占位符就放过：YOUR_xxx / example / CHANGE_ME / test-xxx 之类
      skip: (m) => /(YOUR|X{3,}|xxx|example|sample|placeholder|CHANGE_ME|REDACTED|dummy|^test|^demo|<|\.\.\.)/i.test(m[1] || ""),
    },
  ];

  const hits = [];
  let scanned = 0;
  let skipped = 0;
  for (const rel of t.files) {
    const abs = path.join(ROOT, rel);
    let buf;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      buf = fs.readFileSync(abs);
    } catch (e) {
      continue;
    }
    // 二进制文件（前 8KB 里有 \0）跳过——图片里不可能藏密钥，扫了也是白扫
    if (buf.subarray(0, 8000).includes(0)) {
      skipped += 1;
      continue;
    }
    scanned += 1;

    const lines = buf.toString("utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of rules) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(line)) !== null) {
          if (rule.skip && rule.skip(m)) continue;
          hits.push(`${rel}:${i + 1}（${rule.label}）`);
        }
      }
    });
  }

  if (hits.length === 0) {
    return {
      status: "PASS",
      evidence: `扫描 ${scanned} 个文本文件（共 ${t.files.length} 个跟踪，跳过 ${skipped} 个二进制），0 处命中密钥模式`,
    };
  }
  const show = hits.slice(0, 3).join("；");
  return {
    status: "FAIL",
    evidence: `扫描 ${scanned} 个文件，命中 ${hits.length} 处：${show}${hits.length > 3 ? " 等" : ""}`,
  };
}

/** 2. 敏感文件被正确忽略 */
function check2_ignore() {
  const r = git("check-ignore", "-v", ".env");
  const envExists = fs.existsSync(path.join(ROOT, ".env"));
  const envNote = envExists ? "本地 .env 存在（含真密钥，别提交）" : "本地 .env 不存在";

  if (r.code !== 0) {
    return { status: "FAIL", evidence: `git check-ignore 未命中任何规则 → .env 会被提交；${envNote}` };
  }

  // 输出形如：.gitignore:10:*.env	.env
  const line = (r.out || "").trim().split("\n")[0];
  const parts = line.split("\t");
  const where = parts[0] || "?";
  const pattern = where.split(":").slice(2).join(":");
  const wide = /^\*\./.test(pattern);
  const tail = wide ? `；⚠ 规则是 ${pattern} 宽匹配，建议补一条显式 ".env"` : "";
  return { status: "PASS", evidence: `命中 ${where}；${envNote}${tail}` };
}

/** 3. GitHub Pages 首页可开 */
function check3_pages() {
  const got = curlFile(`${CFG.pagesBase}/index.html?preflight=${Date.now()}`, tmpFile("pages.html"));
  if (got.status === 0) {
    return { status: "FAIL", evidence: `连不上 Pages：${got.err || "curl 无返回"}` };
  }
  if (got.status !== 200) {
    return { status: "FAIL", evidence: `Pages 返回 HTTP ${got.status}（期望 200）` };
  }
  if (got.bytes < 1000) {
    return { status: "FAIL", evidence: `Pages 返回 200 但只有 ${got.bytes} 字节，不像真页面` };
  }
  return { status: "PASS", evidence: `HTTP 200，index.html ${fmtBytes(got.bytes)}（${got.bytes} 字节）` };
}

/** 4. 静态托管与本地逐文件一致 */
function check4_static() {
  const same = [];
  const diff = [];
  const broken = [];

  for (const name of CFG.staticFiles) {
    const localPath = path.join(ROOT, name);
    if (!fs.existsSync(localPath)) {
      broken.push(`${name}（本地不存在）`);
      continue;
    }
    const localBuf = fs.readFileSync(localPath);
    const got = curlFile(`${CFG.staticBase}/${name}?preflight=${Date.now()}`, tmpFile(name));

    if (got.status !== 200) {
      broken.push(`${name}（线上 HTTP ${got.status}）`);
      continue;
    }
    // 字节数与哈希必须同口径：都按「去 CR 后」比。
    // 只比原始字节数会把 CRLF/LF 差异误判成「静态托管没上传新版」（Day 26 真实误报过）。
    const lb = lenNoCR(localBuf);
    const rb = lenNoCR(got.buf);
    if (lb === rb && sha256NoCR(got.buf) === sha256NoCR(localBuf)) {
      same.push(name);
    } else {
      const delta = rb - lb;
      const note = got.buf.length !== rb || localBuf.length !== lb ? "，含行尾差异" : "";
      diff.push(`${name} 本地 ${lb} / 线上 ${rb}（差 ${delta > 0 ? "+" : ""}${delta} 字节${note}）`);
    }
  }

  if (broken.length) {
    return { status: "FAIL", evidence: `线上取不到：${broken.join("；")}` };
  }
  if (diff.length) {
    return {
      status: "FAIL",
      evidence: `本地与线上不一致 ${diff.length}/${CFG.staticFiles.length}：${diff.join("；")} → 静态托管没上传新版`,
    };
  }
  // 统计口径同样用「去 CR」的长度，与上面的比较保持一致
  const total = CFG.staticFiles.reduce((s, f) => s + lenNoCR(fs.readFileSync(path.join(ROOT, f))), 0);
  return {
    status: "PASS",
    evidence: `${same.length}/${CFG.staticFiles.length} 个文件字节与哈希全等（去 CR 口径），合计 ${total} 字节`,
  };
}

/** 5. 接口链路活着 */
function check5_api() {
  const r = curlJson("GET", `${CFG.apiBase}/api/books`);
  if (r.status === 0) return { status: "FAIL", evidence: `接口连不上：${r.err || "curl 无返回"}` };
  if (r.status !== 200) return { status: "FAIL", evidence: `GET /api/books 返回 HTTP ${r.status}：${brief(r.text, 80)}` };
  if (!r.body || r.body.ok !== true) return { status: "FAIL", evidence: `HTTP 200 但 ok 不为 true：${brief(r.text, 80)}` };

  const books = r.body.data && r.body.data.books;
  if (!Array.isArray(books)) {
    return { status: "FAIL", evidence: `返回体没有 data.books 数组（拿到 ${Object.keys(r.body.data || {})}）` };
  }
  if (books.length === 0) {
    return { status: "FAIL", evidence: `data.books 是空数组（0 本）——真库应该有数据` };
  }

  // 字段齐全性：所有书的 key 并集要覆盖 11 个字段
  const present = new Set();
  books.forEach((b) => Object.keys(b || {}).forEach((k) => present.add(k)));
  const missing = CFG.bookFields.filter((f) => !present.has(f));

  if (missing.length) {
    return { status: "FAIL", evidence: `返回 ${books.length} 本书，但缺字段：${missing.join(", ")}` };
  }
  return {
    status: "PASS",
    evidence: `HTTP 200，返回 ${books.length} 本书，${CFG.bookFields.length}/${CFG.bookFields.length} 个字段齐全`,
  };
}

/** 6. 迁移与代码对齐（会写真库，临时书带 preflight- 前缀，finally 必删） */
function check6_migration() {
  const steps = [];
  const title = `preflight-${Date.now()}`;
  let createdId = null;
  let confirmedDeleted = false;

  const cleanup = () => {
    if (createdId && !confirmedDeleted) {
      curlJson("DELETE", `${CFG.apiBase}/api/books/${createdId}`);
    }
  };

  try {
    // 第一关：能不能写进去
    const post = curlJson("POST", `${CFG.apiBase}/api/books`, { title, author: "preflight" });

    // ⚠ 先抢 id、再判状态。顺序反过来会漏删：如果状态码解析出岔子
    // （Day 25 真踩过），代码在赋值前就 return 了，临时书会永远留在真库里。
    if (post.body && post.body.data && post.body.data.book && post.body.data.book.id) {
      createdId = post.body.data.book.id;
    }
    if (post.status !== 200 || !createdId) {
      return {
        status: "FAIL",
        evidence: `建临时书失败：HTTP ${post.status} ${brief(post.text, 80)} → 写入链路有问题，后面两关没验`,
      };
    }
    steps.push(`建 ${createdId} 成功`);

    // 第二关：删它，看是不是走软删（softDeleted 字段只有新版函数才有）
    const del = curlJson("DELETE", `${CFG.apiBase}/api/books/${createdId}`);
    if (del.status !== 200) {
      return { status: "FAIL", evidence: `${steps.join(" → ")} → 删除失败 HTTP ${del.status}：${brief(del.text, 80)}` };
    }
    const soft = del.body && del.body.data && del.body.data.softDeleted === true;
    if (!soft) {
      return {
        status: "FAIL",
        evidence: `${steps.join(" → ")} → 删除返回里没有 softDeleted:true → 跑的是旧版函数或迁移没生效`,
      };
    }
    confirmedDeleted = true;
    steps.push("删除返回 softDeleted:true");

    // 第三关：再删一次应该报不存在（证明软删幂等、查询带了 is_deleted 过滤）
    // ⚠ 这个接口的业务失败一律 HTTP 200 + {ok:false, error}（send() 里固定 writeHead(200)，
    // 是 Day 19 定下的契约）。所以【不能】拿 404 当判定依据——Day 25 写这行时踩过：
    // 明明报的是「这本书不存在」，却因为 200 被判成 FAIL。判业务结果看 ok 字段。
    const again = curlJson("DELETE", `${CFG.apiBase}/api/books/${createdId}`);
    const msg = (again.body && (again.body.error || again.body.message)) || again.text || "";
    const saysMissing = /不存在/.test(msg);
    if (!again.body || again.body.ok !== false || !saysMissing) {
      return {
        status: "FAIL",
        evidence: `${steps.join(" → ")} → 第二次删除应为 ok:false +「这本书不存在」，实际 HTTP ${again.status} ok=${again.body ? again.body.ok : "?"}：${brief(msg, 60)}`,
      };
    }
    steps.push(`重复删除报不存在（HTTP ${again.status} + ok:false）`);

    // 第四关：列表里真的看不到了
    const list = curlJson("GET", `${CFG.apiBase}/api/books`);
    const books = list.body && list.body.data && list.body.data.books;
    if (!Array.isArray(books)) {
      return { status: "FAIL", evidence: `${steps.join(" → ")} → 列表读不到，无法确认已消失` };
    }
    if (books.some((b) => b && b.id === createdId)) {
      return { status: "FAIL", evidence: `${steps.join(" → ")} → 列表里仍能看到 ${createdId} → 查询没过滤 is_deleted` };
    }
    steps.push("列表已不含它");

    return { status: "PASS", evidence: `临时书 ${createdId}：${steps.join(" → ")}` };
  } finally {
    cleanup();
  }
}

/** 7. 临时测试文件没误入仓库 */
function check7_temp() {
  const t = trackedFiles();
  if (!t.ok) return { status: "FAIL", evidence: `git ls-files 失败：${t.err}` };

  const bad = t.files.filter((f) =>
    /(^|\/)_[^/]*_test\.js$/.test(f) ||
    /(^|\/)_smoke\.html$/.test(f) ||
    /^day\d+-verify\//.test(f) ||
    /\.zip$/.test(f) ||
    /\.log$/.test(f) ||
    /^\.temp\//.test(f)
  );

  if (bad.length === 0) {
    return { status: "PASS", evidence: `${t.files.length} 个跟踪文件中，临时验证物 0 个` };
  }
  return { status: "FAIL", evidence: `混进 ${bad.length} 个：${bad.slice(0, 3).join("、")}${bad.length > 3 ? " 等" : ""}` };
}

/** 8. 已全部推送 */
function check8_pushed(isDraft) {
  const br = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!br.ok) return { status: "FAIL", evidence: `读不到当前分支：${brief(br.err)}` };
  const branch = (br.out || "").trim();

  const fetch = git("fetch", "--quiet", "origin");
  if (!fetch.ok) {
    return { status: "FAIL", evidence: `git fetch 失败，无法确认远端状态：${brief(fetch.err)}` };
  }

  const r = git("rev-list", "--left-right", "--count", `${branch}...origin/${branch}`);
  if (!r.ok) {
    return { status: "FAIL", evidence: `远端没有 ${branch} 分支或比对失败：${brief(r.err)}` };
  }
  const nums = (r.out || "").trim().split(/\s+/).map(Number);
  const ahead = nums[0] || 0;
  const behind = nums[1] || 0;

  const dirty = (git("status", "--porcelain", "-uall").out || "").trim().split("\n").filter(Boolean).length;

  if (ahead === 0 && behind === 0) {
    return {
      status: "PASS",
      evidence: `${branch} 与 origin/${branch} 齐平（未推送 0 / 未拉取 0）；未提交改动 ${dirty} 个文件`,
    };
  }
  const bits = [];
  if (ahead > 0) bits.push(`本地有 ${ahead} 个提交没推`);
  if (behind > 0) bits.push(`远端有 ${behind} 个提交没拉`);
  const draftNote = isDraft ? "（DRAFT 轮，属预期；提交推送后复跑应为 0 0）" : "";
  return { status: "FAIL", evidence: `${bits.join("；")}；未提交改动 ${dirty} 个文件${draftNote}` };
}

/** 9. 不引外部 CDN */
function check9_cdn() {
  const t = trackedFiles();
  if (!t.ok) return { status: "FAIL", evidence: `git ls-files 失败：${t.err}` };

  const web = t.files.filter((f) => /\.(html|css|js)$/.test(f));
  const patterns = [
    { label: "script src", re: /<script[^>]+src\s*=\s*["']https?:\/\/[^"']+/gi },
    { label: "link href", re: /<link[^>]+href\s*=\s*["']https?:\/\/[^"']+/gi },
    { label: "img src", re: /<img[^>]+src\s*=\s*["']https?:\/\/[^"']+/gi },
    { label: "@import", re: /@import\s+(?:url\(\s*)?["']?https?:\/\//gi },
    { label: "url()", re: /url\(\s*["']?https?:\/\//gi },
  ];

  const hits = [];
  for (const rel of web) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    } catch (e) {
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const p of patterns) {
        p.re.lastIndex = 0;
        if (p.re.test(line)) hits.push(`${rel}:${i + 1}（${p.label}）`);
      }
    });
  }

  if (hits.length === 0) {
    return { status: "PASS", evidence: `扫描 ${web.length} 个 html/css/js，外部资源引用 0 处` };
  }
  return { status: "FAIL", evidence: `外部资源 ${hits.length} 处：${hits.slice(0, 3).join("；")}` };
}

// ---------- 清单定义 ----------

const STEPS = [
  { no: 1, layer: "安全", name: "密钥不进仓库", fn: () => check1_keys() },
  { no: 2, layer: "安全", name: "敏感文件被忽略", fn: () => check2_ignore() },
  { no: 3, layer: "上线", name: "Pages 可开", fn: () => check3_pages() },
  { no: 4, layer: "上线", name: "静态托管一致", fn: () => check4_static() },
  { no: 5, layer: "上线", name: "接口链路活着", fn: () => check5_api() },
  { no: 6, layer: "数据", name: "迁移与代码对齐", fn: () => check6_migration() },
  { no: 7, layer: "卫生", name: "无临时文件混入", fn: () => check7_temp() },
  { no: 8, layer: "卫生", name: "已全部推送", fn: (draft) => check8_pushed(draft), needsDraft: true },
  { no: 9, layer: "卫生", name: "不引外部 CDN", fn: () => check9_cdn() },
];

const MANUAL = [
  { no: "M1", layer: "人眼", name: "手机宽度观感", how: "浏览器缩到 390px 宽，看首页/论坛/我的三页是否横向溢出、按钮是否挤成一团" },
  { no: "M2", layer: "人眼", name: "键盘可操作", how: "只用 Tab / Enter / Space 走一遍：加书 → 筛选 → 进论坛 → 发帖" },
];

// ---------- 排版：中文按 2 格宽算 ----------

function vwidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function padV(s, width) {
  const text = String(s);
  return text + " ".repeat(Math.max(0, width - vwidth(text)));
}

// ---------- 主流程 ----------

function parseArgs() {
  const argv = process.argv.slice(2);
  const pick = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const onlyRaw = pick("--only");
  const only = onlyRaw ? onlyRaw.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n)) : null;
  return { only, md: pick("--md") };
}

function main() {
  const { only, md } = parseArgs();
  const startedAt = Date.now();

  // 轮次判断：工作区有没有未提交改动（-uall 把未跟踪目录展开成单个文件，
  // 否则一个新建的 skills/xxx/ 只会算成「1 个改动」，数字对不上会误导）
  const porcelain = git("status", "--porcelain", "-uall");
  const dirtyFiles = porcelain.ok
    ? (porcelain.out || "").trim().split("\n").filter(Boolean)
    : [];
  const isDraft = dirtyFiles.length > 0;

  const tracked = trackedFiles();
  const steps = only ? STEPS.filter((s) => only.includes(s.no)) : STEPS;

  const line = "─".repeat(78);
  console.log("");
  console.log(line);
  console.log("  " + paint("cyan", "鲸落书简 · 发布前检查 Preflight") + "    Day 25");
  console.log(`  ${stamp()} ｜ 轮次 ${isDraft ? paint("yellow", "DRAFT（工作区有未提交改动）") : paint("green", "FINAL（工作区干净）")}`);
  console.log(`  跟踪文件 ${tracked.ok ? tracked.files.length : "?"} 个 ｜ 未提交改动 ${dirtyFiles.length} 个 ｜ 跑 ${steps.length} 条`);
  console.log(line);
  console.log("  " + padV("#", 4) + padV("层", 6) + padV("检查项", 22) + padV("结果", 8) + "证据（实测）");
  console.log("  " + "─".repeat(74));

  const results = [];
  for (const s of steps) {
    const r = s.fn(isDraft);
    const ok = r.status === "PASS";
    const tag = ok ? paint("green", "✓ PASS") : paint("red", "✗ FAIL");
    console.log("  " + padV(s.no, 4) + padV(s.layer, 6) + padV(s.name, 22) + padV(tag, 8 + (isTTY ? 9 : 0)) + r.evidence);
    results.push({ ...s, ...r });
  }

  for (const m of MANUAL) {
    console.log("  " + padV(m.no, 4) + padV(m.layer, 6) + padV(m.name, 22) + padV(paint("yellow", "○ 人工"), 8 + (isTTY ? 9 : 0)) + "必须人眼看，不计入通过");
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL");
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("  " + "─".repeat(74));
  console.log(
    `  通过 ${paint("green", `${passed}/${results.length}`)} · 未通过 ${failed.length ? paint("red", String(failed.length)) : "0"} · 人工 ${MANUAL.length} · 耗时 ${elapsed}s`
  );

  if (failed.length) {
    console.log("  " + paint("red", "✗ 未通过明细："));
    for (const f of failed) {
      console.log(`     #${f.no} ${f.name} —— ${f.evidence}`);
    }
  } else if (results.length < STEPS.length) {
    // 只跑了子集时不能说「九条全绿」，那是结论比证据跑得快
    console.log("  " + paint("green", `✓ 本次 ${results.length} 条全绿（完整清单共 ${STEPS.length} 条，未跑的没验）`));
  } else {
    console.log("  " + paint("green", `✓ ${STEPS.length} 条全绿。人工 ${MANUAL.length} 项跑完再算真发布。`));
  }
  console.log(`  退出码 ${failed.length ? 1 : 0}`);
  console.log(line);
  console.log("");

  if (md) {
    writeMarkdown(md, { results, isDraft, dirtyFiles, tracked, elapsed, passed, failed });
  }

  // 清理临时目录
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    /* 删不掉不影响结论 */
  }

  process.exit(failed.length ? 1 : 0);
}

function writeMarkdown(out, ctx) {
  const { results, isDraft, dirtyFiles, tracked, elapsed, passed, failed } = ctx;
  const rows = results
    .map((r) => `| ${r.no} | ${r.layer} | ${r.name} | ${r.status === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${r.evidence} |`)
    .join("\n");
  const manualRows = MANUAL.map((m) => `| ${m.no} | ${m.name} | ${m.how} | ⏳ 待人工 |`).join("\n");

  const text = `# 发布前检查报告 · ${stamp()}

- 轮次：**${isDraft ? "DRAFT（工作区有未提交改动）" : "FINAL（工作区干净）"}**
- 未提交改动：${dirtyFiles.length} 个${dirtyFiles.length ? "（" + dirtyFiles.slice(0, 5).map((d) => d.trim()).join(" / ") + "）" : ""}
- 跟踪文件：${tracked.ok ? tracked.files.length : "?"} 个
- 结果：通过 ${passed}/${results.length} · 未通过 ${failed.length} · 人工 ${MANUAL.length} · 耗时 ${elapsed}s
- 退出码：${failed.length ? 1 : 0}

## 一、检查项（本次跑 ${results.length}/${STEPS.length} 条）

| # | 层 | 检查项 | 结果 | 证据（实测） |
|---|---|---|---|---|
${rows}

## 二、两条人工项（不计入通过）

| # | 检查项 | 怎么验 | 状态 |
|---|---|---|---|
${manualRows}

${failed.length ? "## 三、未通过明细\n\n" + failed.map((f) => `- **#${f.no} ${f.name}** —— ${f.evidence}`).join("\n") + "\n" : ""}
---

> 本报告由 \`skills/pre-release-check/scripts/preflight.js\` 生成，所有数字均为当次实测。
`;

  const abs = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
  console.log(`  报告已写入 ${path.relative(ROOT, abs)}`);
}

try {
  main();
} catch (e) {
  console.error("");
  console.error(paint("red", "✗ 脚本自己崩了（不是项目的问题）："));
  console.error("  " + (e && e.stack ? e.stack : e));
  console.error("");
  process.exit(2);
}
