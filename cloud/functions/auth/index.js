/**
 * /api/auth —— 账号接口（HTTP 型 / Web 函数，结构照抄 books）
 *
 * Day 30 第一阶段。它要替换掉的是 community.js 里那段假的：
 *   MOCK_USERS 硬编码三个假人 → 注册只 push 内存、刷新就没 → 登录不校验密码。
 *
 * 本函数提供四个接口：
 *   POST /api/auth/register  注册：建账号 + 直接发登录凭证
 *   POST /api/auth/login     登录：校验密码 + 发登录凭证
 *   GET  /api/auth/me        用凭证换「我是谁」（刷新页面后恢复登录态靠它）
 *   POST /api/auth/logout    退出：删掉这条会话
 *
 * 环境变量（CloudBase 控制台函数配置里填，密钥不进代码/仓库，AGENTS.md 五.3）：
 *   PG_API_KEY  数据 API 的 API Key
 *   PG_API_BASE 可选，数据 API 基地址；不配则用线上地址
 *
 * 契约和 books 一致：
 *   成功  HTTP 200  { ok: true,  data: { ... } }
 *   失败  HTTP 200  { ok: false, error: "人能看懂的中文" }   ← 前端只看 ok 字段
 *
 * ★ 这个文件的四条安全铁律（每条都有对应测试）：
 *   ① 密码永不明文存储：只存 scrypt 散列 + 独立随机盐。
 *   ② passwordHash / salt **绝不出现在任何返回体里**，一律走 pickPublicUser()。
 *   ③ 登录失败不区分「没这个账号」和「密码错了」，统一一句话 ——
 *      否则等于免费送一个「这个账号存在不存在」的查询接口。
 *   ④ 会话过期要真的判，不能只存个 expiresAt 当摆设。
 */

const http = require("http");
const crypto = require("crypto");
const db = require("./db");

const PORT = 9000; // CloudBase HTTP 型函数的默认端口，别改

// ---------- 常量 ----------

// 密码散列参数。scrypt 是"故意算得慢"的算法，慢就是它的安全性来源：
// 攻击者想暴力猜，每猜一次都要付同样的算力。
const SCRYPT_KEYLEN = 64; // 输出 64 字节 = 128 位十六进制字符
const SALT_BYTES = 16; // 盐 16 字节 = 32 位十六进制
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 100; // 上限：scrypt 对超长输入会白烧 CPU，先挡住
const USERNAME_MIN = 2;
const USERNAME_MAX = 20;
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]+$/; // 中文/字母/数字/下划线（与前端 COMMUNITY_DESIGN 4.1 一致）

const SESSION_DAYS = 7; // 会话有效期
const TOKEN_BYTES = 32; // 128 位随机数，够抵抗猜测

const AVATAR_MAX = 30000; // 头像字符上限（dataURL 可能很长，但不能无限）

// 请求体上限 200KB：比 books 的 100KB 宽松，因为头像可能是 base64 图片
const BODY_MAX_BYTES = 200 * 1024;

// ---------- 回包 ----------

function send(res, payload) {
  // ⚠️ 故意不加 Access-Control-Allow-Origin —— 跨域只在网关一处配（Day 17 的坑：
  // 两边都加会拼成逗号分隔值，浏览器直接拒绝）。
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function fail(res, message) {
  send(res, { ok: false, error: message });
}

// 底层异常翻成人话（Day 23 定的三层，与 books 一致）
function describeError(err) {
  if (err && err.name === "TimeoutError") {
    return "数据源响应超时，请稍后重试";
  }
  const msg = (err && err.message) || "";
  const httpCode = /HTTP\s+(\d{3})/.exec(msg);
  if (httpCode) {
    return `数据源暂时不可用（HTTP ${httpCode[1]}），请稍后重试`;
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|terminated/i.test(msg)) {
    return "连不上数据源，请稍后重试";
  }
  return "数据源暂时不可用，请稍后重试";
}

// 北京时间日志（容器默认 UTC，直接 new Date() 会少 8 小时）
function beijingTime() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ⚠️ 日志里绝不打印 password / token / passwordHash。
// 日志是给排查用的，不是给泄露用的 —— 这些值一旦进日志，等于明文存在服务器上。
function log(method, path, result, extra) {
  console.log(`[auth] ${beijingTime()} +08 ${method} ${path} -> ${result}${extra ? " | " + extra : ""}`);
}

// ---------- 请求体 ----------

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

/** 解析 JSON body；不是 JSON 就返回 { error }。 */
function parseJson(raw) {
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: "请求体必须是一个 JSON 对象" };
    }
    return { body };
  } catch {
    return { error: "请求体不是合法的 JSON" };
  }
}

// ---------- 密码 ----------

function makeSalt() {
  return crypto.randomBytes(SALT_BYTES).toString("hex");
}

/** scrypt 散列。同样的密码 + 同样的盐 → 同样的结果，所以能用来比对，但不可逆。 */
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
}

/**
 * 验密码。用 timingSafeEqual 而不是 === ：
 * 普通字符串比较会在第一个不同的字符处提前返回，"错一位"和"错十位"耗时不同，
 * 攻击者能靠计时猜出前缀。timingSafeEqual 的耗时与内容无关。
 */
function verifyPassword(password, salt, expectedHex) {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(String(expectedHex || ""), "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- id / token / 时间 ----------

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function isoNow() {
  return new Date().toISOString();
}

function isoInDays(days) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

// ---------- 输出裁剪 ★ ----------

/**
 * ★ 把数据库里的一行 users 变成能返回给前端的样子。
 * 显式挑字段，而不是"删掉两个敏感字段"——
 * 以后表里加了新的敏感列（比如手机号、身份证），这种写法默认不会漏出去。
 */
function pickPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    avatar: row.avatar || "",
    bio: row.bio || "",
    createdAt: row.createdAt || "",
  };
}

// ---------- 校验 ----------

/** 账号名规则（与前端 community.js 的 doAuth 完全一致，前端能过的后端必须能过）。 */
function validateUsername(username) {
  if (typeof username !== "string") return "账号名不能为空";
  const name = username.trim();
  if (name === "") return "账号名不能为空";
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
    return `账号名需 ${USERNAME_MIN}~${USERNAME_MAX} 个字符`;
  }
  if (!USERNAME_RE.test(name)) return "账号名只能含中文、字母、数字、下划线";
  return null;
}

function validatePassword(password) {
  if (typeof password !== "string" || password === "") return "密码不能为空";
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`;
  if (password.length > PASSWORD_MAX) return `密码不能超过 ${PASSWORD_MAX} 位`;
  return null;
}

/** 从 Authorization: Bearer xxx 里取 token。取不到返回空串。 */
function readBearer(req) {
  const raw = req.headers["authorization"] || req.headers["Authorization"] || "";
  const m = /^Bearer\s+(\S+)$/i.exec(String(raw).trim());
  return m ? m[1] : "";
}

// ---------- 会话 ----------

/** 发一个会话，返回 { token, expiresAt }。 */
async function issueSession(userId, baseUrl, apiKey) {
  const session = {
    token: newToken(),
    userId: userId,
    createdAt: isoNow(),
    expiresAt: isoInDays(SESSION_DAYS),
  };
  await db.insertSession(session, baseUrl, apiKey);
  return { token: session.token, expiresAt: session.expiresAt };
}

/** 会话过没过期。ISO 8601 同格式下字符串可直接比大小。 */
function isExpired(session) {
  if (!session || !session.expiresAt) return true;
  return String(session.expiresAt) <= isoNow();
}

// ================================================================
// 服务
// ================================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // 凭证每次请求时读，环境变量改了不用重新部署
  const baseUrl =
    process.env.PG_API_BASE || "https://reading-sea-d7gd8l7o78b7304ae.api.tcloudbasegateway.com";
  const apiKey = process.env.PG_API_KEY || "";

  if (!apiKey) {
    log(req.method, url.pathname, "500", "缺少 PG_API_KEY");
    return fail(res, "服务端未配置数据源凭证（环境变量 PG_API_KEY），请联系站长");
  }

  // ---------- POST /api/auth/register ----------
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    readBody(req)
      .then((raw) => {
        const { body, error: jsonErr } = parseJson(raw);
        if (jsonErr) {
          log("POST", "/api/auth/register", "400", jsonErr);
          return fail(res, jsonErr);
        }

        const nameErr = validateUsername(body.username);
        if (nameErr) {
          log("POST", "/api/auth/register", "400", nameErr);
          return fail(res, nameErr);
        }
        const pwdErr = validatePassword(body.password);
        if (pwdErr) {
          log("POST", "/api/auth/register", "400", pwdErr);
          return fail(res, pwdErr);
        }

        const username = String(body.username).trim();
        // usernameLower 仍然写进库（留作记录），但**不再参与判重**：
        // 判重和登录查人都按 username 原文精确比对，所以 ZJ122456 ≠ zj122456。
        const usernameLower = username.toLowerCase();

        let avatar = typeof body.avatar === "string" ? body.avatar : "";
        if (avatar.length > AVATAR_MAX) {
          log("POST", "/api/auth/register", "400", "头像太大");
          return fail(res, "头像太大了，换一张小一点的");
        }

        // 先查一次：只为给出友好提示（"这个名字被用了"）。
        // 真正防并发重复的是数据库唯一索引，不靠这次查询。
        return db
          .findUserByUsername(username, baseUrl, apiKey)
          .then((existing) => {
            if (existing) {
              log("POST", "/api/auth/register", "409", `账号名占用：${username}`);
              return fail(res, "该账号名已被使用，无法注册");
            }

            const salt = makeSalt();
            const user = {
              id: newId("user"),
              username: username,
              usernameLower: usernameLower,
              passwordHash: hashPassword(String(body.password), salt),
              salt: salt,
              avatar: avatar,
              bio: "",
              createdAt: isoNow(),
            };

            return db
              .insertUser(user, baseUrl, apiKey)
              .then(() => issueSession(user.id, baseUrl, apiKey))
              .then((s) => {
                log("POST", "/api/auth/register", "200", `新账号 ${user.id}「${username}」`);
                send(res, {
                  ok: true,
                  data: { user: pickPublicUser(user), token: s.token, expiresAt: s.expiresAt },
                });
              })
              .catch((err) => {
                // 并发撞唯一索引时走这里：PG 回 409 → db.js 抛"账号名已被占用"
                if (/唯一索引拦截/.test(err.message)) {
                  log("POST", "/api/auth/register", "409", "唯一索引拦截");
                  return fail(res, "该账号名已被使用，无法注册");
                }
                log("POST", "/api/auth/register", "500", err.message);
                fail(res, `注册失败：${describeError(err)}`);
              });
          })
          .catch((err) => {
            log("POST", "/api/auth/register", "500", err.message);
            fail(res, describeError(err));
          });
      })
      .catch((err) => {
        log("POST", "/api/auth/register", "400", err.message);
        fail(res, err.message === "请求体太大" ? "请求体太大，请减小内容后重试" : "读取请求失败");
      });
    return;
  }

  // ---------- POST /api/auth/login ----------
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    readBody(req)
      .then((raw) => {
        const { body, error: jsonErr } = parseJson(raw);
        if (jsonErr) {
          log("POST", "/api/auth/login", "400", jsonErr);
          return fail(res, jsonErr);
        }

        // 登录只要求"非空"，不套注册那套规则：
        // 老账号的规则可能变过，不该因为规则更新而登不进去
        if (typeof body.username !== "string" || body.username.trim() === "") {
          log("POST", "/api/auth/login", "400", "账号名为空");
          return fail(res, "账号名不能为空");
        }
        if (typeof body.password !== "string" || body.password === "") {
          log("POST", "/api/auth/login", "400", "密码为空");
          return fail(res, "密码不能为空");
        }

        const username = body.username.trim();

        return db
          .findUserByUsername(username, baseUrl, apiKey)
          .then((user) => {
            // ★ 铁律③：没这个账号 和 密码错了，回同一句话。
            // 分开说等于送一个「这个账号存不存在」的探测接口。
            if (!user || !verifyPassword(String(body.password), user.salt, user.passwordHash)) {
              log("POST", "/api/auth/login", "401", user ? "密码不匹配" : "账号不存在");
              return fail(res, "账号名或密码错误");
            }

            // 顺手打扫这个用户已经过期的会话
            return db
              .deleteExpiredSessions(user.id, isoNow(), baseUrl, apiKey)
              .catch(() => 0) // 打扫失败不影响登录
              .then(() => issueSession(user.id, baseUrl, apiKey))
              .then((s) => {
                log("POST", "/api/auth/login", "200", `登录成功 ${user.id}`);
                send(res, {
                  ok: true,
                  data: { user: pickPublicUser(user), token: s.token, expiresAt: s.expiresAt },
                });
              });
          })
          .catch((err) => {
            log("POST", "/api/auth/login", "500", err.message);
            fail(res, describeError(err));
          });
      })
      .catch((err) => {
        log("POST", "/api/auth/login", "400", err.message);
        fail(res, err.message === "请求体太大" ? "请求体太大，请减小内容后重试" : "读取请求失败");
      });
    return;
  }

  // ---------- GET /api/auth/me ----------
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const token = readBearer(req);
    if (!token) {
      log("GET", "/api/auth/me", "401", "没有 Bearer token");
      return fail(res, "还没登录");
    }

    db.findSession(token, baseUrl, apiKey)
      .then((session) => {
        if (!session) {
          log("GET", "/api/auth/me", "401", "token 不存在");
          return fail(res, "登录状态已失效，请重新登录");
        }
        if (isExpired(session)) {
          // ★ 铁律④：过期要真判，而且顺手把这条死会话删掉
          return db
            .deleteSession(token, baseUrl, apiKey)
            .catch(() => 0)
            .then(() => {
              log("GET", "/api/auth/me", "401", "token 已过期");
              fail(res, "登录已过期，请重新登录");
            });
        }

        return db.findUserById(session.userId, baseUrl, apiKey).then((user) => {
          if (!user) {
            // 会话还在、用户没了（理论上不该发生）→ 当作未登录，并清掉坏会话
            return db
              .deleteSession(token, baseUrl, apiKey)
              .catch(() => 0)
              .then(() => {
                log("GET", "/api/auth/me", "401", `用户 ${session.userId} 不存在`);
                fail(res, "登录状态已失效，请重新登录");
              });
          }
          log("GET", "/api/auth/me", "200", `已登录 ${user.id}`);
          send(res, { ok: true, data: { user: pickPublicUser(user), expiresAt: session.expiresAt } });
        });
      })
      .catch((err) => {
        log("GET", "/api/auth/me", "500", err.message);
        fail(res, describeError(err));
      });
    return;
  }

  // ---------- POST /api/auth/logout ----------
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = readBearer(req);
    if (!token) {
      // 没带凭证就当已经退出：前端只要把本地 token 清掉即可，不该报错卡住
      log("POST", "/api/auth/logout", "200", "没带 token，当作已退出");
      return send(res, { ok: true, data: { loggedOut: true } });
    }

    db.deleteSession(token, baseUrl, apiKey)
      .then((removed) => {
        log("POST", "/api/auth/logout", "200", `删除会话 ${removed} 条`);
        // 删到 0 条也算成功：本来就不存在，目标状态已经达成
        send(res, { ok: true, data: { loggedOut: true, removed } });
      })
      .catch((err) => {
        log("POST", "/api/auth/logout", "500", err.message);
        fail(res, describeError(err));
      });
    return;
  }

  fail(
    res,
    "未知路径，本服务提供 POST /api/auth/register、POST /api/auth/login、GET /api/auth/me、POST /api/auth/logout"
  );
  log(req.method, url.pathname, "404", "未知路径");
});

server.listen(PORT, () => {
  console.log(`auth function listening on port ${PORT}`);
});
