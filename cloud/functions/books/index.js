/**
 * /api/books —— 书单接口（HTTP 型 / Web 函数，写法与 Day 15 的 health 同款）
 *
 * Day 17：GET  读书单列表（契约 3.1）
 * Day 18：POST 新增一本书（契约 3.2）——本函数第一次拥有「写入真库」的能力
 * Day 22：PATCH 修改一本书（契约 3.3）——只改传上来的字段，没传的不动
 * Day 22：DELETE 删除一本书（契约 3.4）——连同该书笔记一起删
 *
 * ⚠️ 为什么不直连数据库：官方社区确认（Issue #953），HTTP 型云函数与
 *   云开发数据库之间不走内网、不支持 VPC，体验版也没有公网直连开关。
 *   所以走官方文档给的唯一通道 —— PostgreSQL 的 HTTP API（PostgREST 风格）：
 *     基地址  https://<envId>.api.tcloudbasegateway.com
 *     查表    GET  /v1/rdb/rest/books?select=*&order=createdAt.desc
 *     插入    POST /v1/rdb/rest/books   （body 就是要插入的那一行，HTTP 201 = 插入成功）
 *   好处：Node 20 自带 fetch 就能调，本函数零 npm 依赖，控制台部署不用装包。
 *
 * 环境变量（在 CloudBase 控制台函数配置里填，密钥绝不写进代码/仓库，AGENTS.md 五.3）：
 *   PG_API_KEY  数据 API 的 API Key（服务端权限，控制台「数据 API / API Key」处创建）
 *   PG_API_BASE 可选，数据 API 基地址；本地测试时指向假数据源，不配则用线上地址
 *
 * 契约要点（docs/api-contract.md 1.2 / 3.1 / 3.2）：
 *   成功  HTTP 200  { ok: true,  data: { ... } }
 *   失败  HTTP 200  { ok: false, error: "人能看懂的中文" }   前端只看 ok 字段
 *
 * Day 18 主题——服务端为什么要自己校验：
 *   前端表单的校验可以被绕过（用 curl 直接打接口就绕过了），
 *   所以「缺必填字段」「非法值」「重复提交」必须在服务端再挡一遍。
 *   本函数防两类问题：
 *     ① 错误输入：书名为空 / status 不在三值白名单 / 页数不是非负整数
 *     ② 重复提交：书名+作者都相同（trim 后）的书已存在 → 拒绝再插一行
 *   每种拦截都有一条可复现的测试（见 journal 或 Day 18 验证记录）。
 */

const http = require("http");
// 数据访问层（Day 19 拆分）：所有查库/写库的操作都在 db.js，
// 本文件只负责「收请求 → 校验 → 调 db → 回 JSON」，不再直接 fetch 数据库。
const db = require("./db");

const PORT = 9000; // CloudBase HTTP 型函数的默认端口，别改

// ?limit 上限：防止一次拉全表把体验版的小实例拖垮；超过就悄悄按 100 算
const LIMIT_MAX = 100;

// status 全局只有这三个值（契约 1.3），白名单之外的都拒收
const STATUS_WHITELIST = ["want", "reading", "finished"];

// 请求体大小上限（100KB）：一本书的信息用不了这么大，
// 超过基本是恶意/异常请求，直接拒收省得白耗内存
const BODY_MAX_BYTES = 100 * 1024;

function send(res, payload) {
  // ⚠️ 这里故意【不】加 Access-Control-Allow-Origin —— 跨域由 HTTP 网关
  // 路由上的「跨域设置」负责（Day 17 起已启用，实测有效）。
  // 实测坑（Day 17）：函数和网关两边都加时，网关会把两个值拼进同一个头：
  //   access-control-allow-origin: https://静态域名,*
  // 浏览器见到逗号分隔的两个值直接拒绝，页面报 Failed to fetch。
  // 教训：跨域头全站只留一处，放网关（也正是契约第 4 节的原计划，只是提前了）。
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function fail(res, message) {
  send(res, { ok: false, error: message });
}

// ---------- Day 23：把底层异常翻成人话 ----------
// 改之前这里是 `fail(res, "数据源暂时不可用：" + err.message)`，
// 用户可能拿到的是 "数据源暂时不可用：fetch failed"、
// "数据源暂时不可用：terminated" —— 英文、内部术语、看不出该怎么办。
// 改之后只分三种说法，各自指向一个不同的动作：
//   ① 超时        → 数据源慢，等一下再试
//   ② 对端回错误码 → 服务器那边病了，把 HTTP 码留下来方便对截图说话
//   ③ 连不上      → DNS/拒绝连接/连接被重置，同属"再试"，但措辞分开免得误导
// 铁律：原始异常只进 log()（站长排查用），绝不拼进返回体（用户看的）。
function describeError(err) {
  if (err && err.name === "TimeoutError") {
    return "数据源响应超时，请稍后重试";
  }
  const msg = (err && err.message) || "";
  const http = /HTTP\s+(\d{3})/.exec(msg);
  if (http) {
    return `数据源暂时不可用（HTTP ${http[1]}），请稍后重试`;
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|terminated/i.test(msg)) {
    return "连不上数据源，请稍后重试";
  }
  return "数据源暂时不可用，请稍后重试";
}

// 余力加练（Day 18）：每次请求留一行服务端日志。
// 部署后在控制台「函数 → 日志」里能看到，以后排查「用户说接口不对」时
// 先看这里：请求到底进没进来、走到了哪个分支。
//
// 余力加练（Day 23）：补上时间。清单要求日志含「时间、路径、结果」三样，
// 原来只有后两样。
// ⚠️ 为什么要手动 +8 小时：云函数容器默认时区是 UTC，直接 new Date() 打出来
//    会比北京时间少 8 小时，排查时容易把「刚发生的请求」看成「一小时前的」。
//    这里不依赖容器时区，自己换算，日志行尾标 +08 表明是北京时间。
function beijingTime() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function log(method, path, result, extra) {
  const line = `[books] ${beijingTime()} +08 ${method} ${path} -> ${result}${extra ? " | " + extra : ""}`;
  console.log(line);
}

// ?limit 解析：不传 = 返回全部（undefined）；传了必须是正整数，超 100 按 100 算
function parseLimit(raw) {
  if (raw === null || raw === "") return { limit: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { error: "limit 必须是正整数，例如 /api/books?limit=5" };
  }
  return { limit: Math.min(n, LIMIT_MAX) };
}

// ---------- Day 18：请求体读取 ----------

// HTTP 型函数的请求体不是现成给的，要从流里一块块收。
// 包成 Promise 是为了让下面能用 async/await 顺序写，不嵌套回调。
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) {
        reject(new Error("请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- Day 18：输入校验（服务端门卫） ----------

// 把请求 body 洗成一行能入库的数据；不合格就返回中文错误。
// 返回 { row } 或 { error }，调用方只看有没有 error。
function validateBookInput(body) {
  // ---- title：必填 ----
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return { error: "书名不能为空" };
  }

  // ---- status：缺省 want，白名单校验 ----
  let status = body.status;
  if (status === undefined) status = "want";
  if (!STATUS_WHITELIST.includes(status)) {
    return { error: "阅读状态只能是 want、reading 或 finished" };
  }

  // ---- author / coverUrl：可空，缺省空串（与建表 DEFAULT '' 一致）----
  let author = body.author === undefined ? "" : body.author;
  let coverUrl = body.coverUrl === undefined ? "" : body.coverUrl;
  if (typeof author !== "string") return { error: "作者必须是文本" };
  if (typeof coverUrl !== "string") return { error: "封面地址必须是文本" };

  // ---- totalPages / currentPage：可空，传了必须是非负整数 ----
  // （页数以后要参与进度计算 currentPage/totalPages，非数字没法算）
  function parsePage(value, label) {
    if (value === undefined || value === null) return { value: null };
    if (!Number.isInteger(value) || value < 0) {
      return { error: `${label}必须是非负整数` };
    }
    return { value };
  }
  const total = parsePage(body.totalPages, "总页数");
  if (total.error) return total;
  const current = parsePage(body.currentPage, "当前页码");
  if (current.error) return current;

  // trim 收尾：存进库的统一去掉首尾空格，查重比对也基于 trim 后的值
  return {
    row: {
      title: body.title.trim(),
      author: author.trim(),
      coverUrl: coverUrl.trim(),
      status,
      totalPages: total.value,
      currentPage: current.value,
    },
  };
}

// 后端生成 id（契约 1.3：id 由后端生成，前端不指定）。
// 时间戳(base36)保证趋势唯一，随机段防同一毫秒内的碰撞，总长不超 VARCHAR(40)。
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- Day 22：PATCH 的路由解析与输入校验 ----------

// 允许前端改的字段白名单。id / createdAt 这些不在这里：
// 主键改了等于换了本书，创建时间改了等于伪造历史，都不该由客户端决定。
// 不在白名单里的键【静默忽略】而不是报错——前端多传个 isbn 之类不该让整个请求失败。
const PATCHABLE_FIELDS = [
  "title",
  "author",
  "coverUrl",
  "status",
  "totalPages",
  "currentPage",
];

// 从 /api/books/<id> 里取出 id。返回 { id } / { error }。
// ⚠️ 这是删除/修改类接口的第一道安全阀：id 取不到就绝不能往下走。
//    「条件为空就等于匹配所有行」——漏掉这层，一个 DELETE /api/books/
//    就可能被拼成不带条件的整表删除。
function matchBookId(pathname) {
  if (!pathname.startsWith("/api/books/")) return { notMatched: true };

  const raw = pathname.slice("/api/books/".length).replace(/\/$/, ""); // 去掉可能的结尾斜杠
  if (raw === "") return { error: "书 id 不能为空，正确写法：/api/books/book-001" };
  if (raw.includes("/")) return { error: "书 id 格式不对，不应该包含斜杠" };

  let id;
  try {
    id = decodeURIComponent(raw); // 中文/空格等在 URL 里是百分号编码，先还原
  } catch {
    return { error: "书 id 的编码格式不对" };
  }
  if (id.length > 40) return { error: "书 id 太长，最多 40 个字符" };
  return { id };
}

// PATCH 的字段校验：部分更新，只校验「传了的」字段，没传的一律不管。
// 返回 { patch } 或 { error }。patch 里只放白名单字段，值为筛过的干净值。
function validatePatch(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "请求体必须是一个 JSON 对象，例如 { \"status\": \"reading\" }" };
  }

  const patch = {};
  for (const key of PATCHABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) {
    return {
      error: `没有可修改的字段，允许修改的是：${PATCHABLE_FIELDS.join("、")}`,
    };
  }

  // ---- title：传了就不能是空串 ----
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || patch.title.trim() === "") {
      return { error: "书名不能为空" };
    }
    patch.title = patch.title.trim();
  }

  // ---- status：白名单 ----
  if (patch.status !== undefined && !STATUS_WHITELIST.includes(patch.status)) {
    return { error: "阅读状态只能是 want、reading 或 finished" };
  }

  // ---- author / coverUrl：必须是文本；传 null 视为清空（存空串，与建表默认值一致）----
  for (const [key, label] of [["author", "作者"], ["coverUrl", "封面地址"]]) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null) {
      patch[key] = "";
      continue;
    }
    if (typeof patch[key] !== "string") return { error: `${label}必须是文本` };
    patch[key] = patch[key].trim();
  }

  // ---- totalPages / currentPage：可传 null 清空，否则必须是非负整数 ----
  // 与 POST 的口径一致（同一批字段，不该两个接口两套规矩）
  for (const [key, label] of [["totalPages", "总页数"], ["currentPage", "当前页码"]]) {
    if (patch[key] === undefined || patch[key] === null) continue;
    if (!Number.isInteger(patch[key]) || patch[key] < 0) {
      return { error: `${label}必须是非负整数` };
    }
  }

  return { patch };
}

// PATCH /api/books/:id 的处理体（写在路由外面，是为了能用 async/await 线性读）
async function handlePatch(req, res, id, baseUrl, apiKey) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    fail(res, err.message === "请求体太大" ? "请求体太大，请减小内容后重试" : "读取请求失败");
    log("PATCH", `/api/books/${id}`, "400", err.message);
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    fail(res, "请求体不是合法的 JSON");
    log("PATCH", `/api/books/${id}`, "400", "JSON 解析失败");
    return;
  }

  const { patch, error } = validatePatch(body);
  if (error) {
    fail(res, error);
    log("PATCH", `/api/books/${id}`, "400", error);
    return;
  }

  if (!apiKey) {
    fail(res, "服务端未配置数据源凭证（环境变量 PG_API_KEY），请联系站长");
    log("PATCH", `/api/books/${id}`, "500", "缺少 PG_API_KEY");
    return;
  }

  try {
    // 第一层保护：先确认这本书真的存在。不存在就别往下改，
    // 免得「改了 0 行」被当成成功回报给前端。
    const current = await db.findBookById(id, baseUrl, apiKey);
    if (!current) {
      fail(res, "这本书不存在，可能已被删除");
      log("PATCH", `/api/books/${id}`, "404", "查无此书");
      return;
    }

    // 契约 3.3：status 变成 reading / finished 时，由后端维护时间戳。
    // 刻意只「补空」不「覆盖/清空」：同一状态来回切不该刷掉第一次的开始时间，
    // 而且这里只补时间、不改状态本身，逻辑简单、出错面小。
    const now = new Date().toISOString();
    if (patch.status === "reading" && !current.startedAt) {
      patch.startedAt = now;
    }
    if (patch.status === "finished" && !current.finishedAt) {
      patch.finishedAt = now;
    }

    const updated = await db.updateBook(id, patch, baseUrl, apiKey);
    if (!updated) {
      // 极端情况：查到之后、改之前这条被别人删了。
      // 不报成功——影响 0 行就是没改到。
      fail(res, "这本书不存在，可能已被删除");
      log("PATCH", `/api/books/${id}`, "404", "更新影响 0 行");
      return;
    }

    log(
      "PATCH",
      `/api/books/${id}`,
      "200",
      `改 ${Object.keys(patch).join(",")} ｜《${updated.title}》`
    );
    // 契约 3.3：返回改后的完整对象
    send(res, { ok: true, data: { book: updated } });
  } catch (err) {
    log("PATCH", `/api/books/${id}`, "500", err.message);
    fail(res, describeError(err));
  }
}


// ---------- 数据访问层已拆到 db.js（Day 19） ----------
// 原 fetchBooks / findDuplicate / insertBook 三个函数原样搬去 db.js，
// 本文件通过文件开头的 require("./db") 调用，函数体一行逻辑没改。

// DELETE /api/books/:id 的处理体。
// 今天要掌握的问题——「删除为什么比新增更容易出事」——答案就在这个函数的顺序里：
//   新增是加法，错了最多多一条垃圾数据，删掉就行；
//   删除是减法，错了数据就没了。
// 所以删除这条路必须比新增更保守，本函数做了三层：
//   ① 先确认真实存在（不盲删）
//   ② 只按 id 精确删（id 为空就停，绝不发空条件请求）
//   ③ 只认数据源回来的真实影响行数（0 行就是失败，不谎报成功）
// Day 23 余力补了一条：第 ② 层从「物理删行」换成「打 is_deleted 标记」。
//   原文写的"接口层没有任何撤销手段"到此为止不再成立 —— 现在撤得回来，
//   一句 UPDATE books SET is_deleted = false WHERE id = '...' 就能还原。
async function handleDelete(req, res, id, baseUrl, apiKey) {
  if (!apiKey) {
    fail(res, "服务端未配置数据源凭证（环境变量 PG_API_KEY），请联系站长");
    log("DELETE", `/api/books/${id}`, "500", "缺少 PG_API_KEY");
    return;
  }

  try {
    // ① 先确认这本书真的在。不在就直接报错——不要试图去删一个不存在的东西，
    //    那样只会得到「删除成功 0 行」这种既没意义又容易让人误会的结论。
    const current = await db.findBookById(id, baseUrl, apiKey);
    if (!current) {
      fail(res, "这本书不存在，可能已被删除");
      log("DELETE", `/api/books/${id}`, "404", "查无此书");
      return;
    }

    // ② Day 23 余力：从「物理删除」改成「软删除」——
    //    只给这本书打一个 is_deleted 标记，行还躺在表里，删错了捞得回来。
    //    笔记【故意保留】：以后恢复时笔记也跟着回来，这才是"删错可找回"的完整形态。
    //    ⚠️ 这也是与 Day 22 的唯一分歧点：Day 22 是「先删笔记再删书」，
    //    现在笔记不删了。契约 3.4 的措辞要不要跟着改，等大帅拍板（见 journal 待办）。
    const softDeleted = await db.softDeleteBook(id, baseUrl, apiKey);

    // ③ 数据源说影响 0 行 = 没删到，就不能回成功
    //    （软删的条件里带了 is_deleted = false，所以重复删除会走到这里）
    if (softDeleted === 0) {
      fail(res, "这本书不存在，可能已被删除");
      log("DELETE", `/api/books/${id}`, "404", "软删除影响 0 行");
      return;
    }

    log(
      "DELETE",
      `/api/books/${id}`,
      "200",
      `软删《${current.title}》，影响 ${softDeleted} 行，笔记保留`
    );
    // 契约 3.4 的形状保持兼容：仍回 deletedBooks / deletedNotes，
    // 只是 deletedNotes 现在恒为 0（笔记不删），另加一个 softDeleted 说明用的是软删
    send(res, { ok: true, data: { deletedBooks: softDeleted, deletedNotes: 0, softDeleted: true } });
  } catch (err) {
    log("DELETE", `/api/books/${id}`, "500", err.message);
    fail(res, `删除失败：${describeError(err)}`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // 凭证每次请求时读（而不是启动时读死）：环境变量配置后无需重新部署才生效，
  // 本地测试也能在同一次运行里切换「有/无密钥」两种场景
  const baseUrl = process.env.PG_API_BASE || "https://reading-sea-d7gd8l7o78b7304ae.api.tcloudbasegateway.com";
  const apiKey = process.env.PG_API_KEY || "";

  // ---------- GET /api/books（Day 17，逻辑不动） ----------
  if (req.method === "GET" && url.pathname === "/api/books") {
    const { limit, error } = parseLimit(url.searchParams.get("limit"));
    if (error) {
      log("GET", "/api/books", "400", error);
      return fail(res, error);
    }
    if (!apiKey) {
      log("GET", "/api/books", "500", "缺少 PG_API_KEY");
      return fail(res, "服务端未配置数据源凭证（环境变量 PG_API_KEY），请联系站长");
    }

    db.fetchBooks(limit, baseUrl, apiKey)
      .then((rows) => {
        log("GET", "/api/books", "200", `返回 ${rows.length} 本`);
        send(res, { ok: true, data: { books: rows } });
      })
      .catch((err) => {
        // Day 23：原始异常只进日志，用户只看人话
        log("GET", "/api/books", "500", err.message);
        fail(res, describeError(err));
      });
    return;
  }

  // ---------- POST /api/books（Day 18 新增） ----------
  if (req.method === "POST" && url.pathname === "/api/books") {
    readBody(req)
      .then((raw) => {
        // 第 1 关：必须是合法 JSON
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          fail(res, "请求体不是合法的 JSON");
          log("POST", "/api/books", "400", "JSON 解析失败");
          return;
        }

        // 第 2 关：字段校验（缺书名 / 非法 status / 非法页数都在这被拒）
        const { row, error } = validateBookInput(body);
        if (error) {
          fail(res, error);
          log("POST", "/api/books", "400", error);
          return;
        }

        if (!apiKey) {
          fail(res, "服务端未配置数据源凭证（环境变量 PG_API_KEY），请联系站长");
          log("POST", "/api/books", "500", "缺少 PG_API_KEY");
          return;
        }

        // 第 3 关：查重（书名+作者相同 → 拒绝，防重复提交）
        db.findDuplicate(row.title, row.author, baseUrl, apiKey)
          .then((dup) => {
            if (dup) {
              fail(res, "这本书已经在书单里了，不用重复添加");
              log("POST", "/api/books", "409", `重复：命中 ${dup.id}`);
              return;
            }

            // 三关全过：补上后端生成的 id 和时间戳，插库
            const book = {
              id: newId("book"),
              ...row,
              startedAt: null,
              finishedAt: null,
              createdAt: new Date().toISOString(),
            };
            db.insertBook(book, baseUrl, apiKey)
              .then(() => {
                log("POST", "/api/books", "200", `新增 ${book.id}《${book.title}》`);
                // 契约 3.2：返回 { ok: true, data: { book: {...} } }
                send(res, { ok: true, data: { book } });
              })
              .catch((err) => {
                log("POST", "/api/books", "500", err.message);
                fail(res, `写入失败：${describeError(err)}`);
              });
          })
          .catch((err) => {
            log("POST", "/api/books", "500", err.message);
            fail(res, describeError(err));
          });
      })
      .catch((err) => {
        fail(res, err.message === "请求体太大" ? "请求体太大，请减小内容后重试" : "读取请求失败");
        log("POST", "/api/books", "400", err.message);
      });
    return;
  }

  // ---------- PATCH /api/books/:id（Day 22 新增） ----------
  if (req.method === "PATCH") {
    const m = matchBookId(url.pathname);
    if (!m.notMatched) {
      // 连 id 都没解析出来就停在这里：绝不让「id 为空」的请求走到底层
      if (m.error) {
        fail(res, m.error);
        log("PATCH", url.pathname, "400", m.error);
        return;
      }
      handlePatch(req, res, m.id, baseUrl, apiKey);
      return;
    }
  }

  // ---------- DELETE /api/books/:id（Day 22 新增） ----------
  if (req.method === "DELETE") {
    const m = matchBookId(url.pathname);
    if (!m.notMatched) {
      // ⚠️ 最关键的一道门：id 没解析出来就到此为止。
      // 删除请求一旦带着空条件下发到数据库，删的就不是「一本书」而是整张表。
      if (m.error) {
        fail(res, m.error);
        log("DELETE", url.pathname, "400", m.error);
        return;
      }
      handleDelete(req, res, m.id, baseUrl, apiKey);
      return;
    }
  }

  // 备注：浏览器跨域 POST 会先发 OPTIONS 预检（网关跨域设置已覆盖，函数不用管）。
  fail(res, "未知路径，本服务提供 GET/POST /api/books 与 PATCH/DELETE /api/books/:id");
  log(req.method, url.pathname, "404", "未知路径");
});

server.listen(PORT, () => {
  console.log(`books function listening on port ${PORT}`);
});
