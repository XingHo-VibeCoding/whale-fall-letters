/**
 * /api/posts —— 论坛接口（HTTP 型 / Web 函数，结构照抄 books / auth）
 *
 * Day 30 第二阶段。它要替换掉的是 community.js 里那段假的：
 *   MOCK_POSTS 是写死在代码里的三篇假文章，你发的评论只 push 进内存，
 *   刷新页面就没了 —— 所以"别人能看到我的评论"这件事从来没成立过。
 *
 * 本函数提供四个接口：
 *   GET  /api/posts                 帖子列表（公开，不用登录也能看）
 *   GET  /api/posts/:id             帖子详情 + 该帖全部评论（公开）
 *   POST /api/posts                 发帖（★ 必须登录）
 *   POST /api/posts/:id/comments    发评论（★ 必须登录）
 *
 * 环境变量（与 books / auth 同一套）：
 *   PG_API_KEY   数据 API 的 API Key
 *   PG_API_BASE  可选，数据 API 基地址
 *
 * 契约同前两个函数：成功 { ok:true, data:{...} }，失败 { ok:false, error:"人话" }，
 * 一律 HTTP 200 —— 前端只看 ok 字段。
 *
 * ★ 登录态怎么验（与 auth 函数共用同一张 sessions 表）：
 *   前端带 Authorization: Bearer <token> → 查 sessions 找到 userId → 查 users 拿到人。
 *   云函数之间不能互调代码，所以这里必须自己查一遍库（不是重复实现，是同一份数据的第二个读者）。
 *
 * ★ 一条硬规矩：**作者身份只认 token，不认请求体**。
 *   前端传什么 authorId 都不看 —— 否则谁都能伪造成别人发帖。
 */

const http = require("http");
const db = require("./db");

const PORT = 9000;

const TITLE_MAX = 200;      // 书名
const BOOK_AUTHOR_MAX = 100; // 书的作者
const COVER_MAX = 500;
const POST_CONTENT_MAX = 5000;
const COMMENT_CONTENT_MAX = 1000;

const LIMIT_MAX = 100;
const BODY_MAX_BYTES = 100 * 1024;

// ---------- 回包 ----------

function send(res, payload) {
  // 跨域只在网关一处配（Day 17 的坑：两边都加会拼成逗号分隔值）
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function fail(res, message) {
  send(res, { ok: false, error: message });
}

function describeError(err) {
  if (err && err.name === "TimeoutError") return "数据源响应超时，请稍后重试";
  const msg = (err && err.message) || "";
  const httpCode = /HTTP\s+(\d{3})/.exec(msg);
  if (httpCode) return `数据源暂时不可用（HTTP ${httpCode[1]}），请稍后重试`;
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|terminated/i.test(msg)) {
    return "连不上数据源，请稍后重试";
  }
  return "数据源暂时不可用，请稍后重试";
}

function beijingTime() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// 日志里不打印 token、不打印正文（正文可能是用户私密想法）
function log(method, path, result, extra) {
  console.log(`[community] ${beijingTime()} +08 ${method} ${path} -> ${result}${extra ? " | " + extra : ""}`);
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

// ---------- 小工具 ----------

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function readBearer(req) {
  const raw = req.headers["authorization"] || req.headers["Authorization"] || "";
  const m = /^Bearer\s+(\S+)$/i.exec(String(raw).trim());
  return m ? m[1] : "";
}

/**
 * 路由解析。返回：
 *   { notMatched:true }                      不是 /api/posts 开头
 *   { list:true }                            /api/posts
 *   { id:'post-x' }                          /api/posts/post-x
 *   { id:'post-x', comments:true }           /api/posts/post-x/comments
 *   { error:'...' }                          格式不对（**有 error 就到此为止，绝不带着空 id 往下走**）
 */
function matchPostsPath(pathname) {
  if (pathname === "/api/posts" || pathname === "/api/posts/") return { list: true };
  if (!pathname.startsWith("/api/posts/")) return { notMatched: true };

  const raw = pathname.slice("/api/posts/".length).replace(/\/$/, "");
  if (raw === "") return { list: true };

  const parts = raw.split("/");
  let id;
  try {
    id = decodeURIComponent(parts[0]);
  } catch {
    return { error: "帖子 id 的编码格式不对" };
  }
  if (!id) return { error: "帖子 id 不能为空" };

  if (parts.length === 1) return { id };
  if (parts.length === 2 && parts[1] === "comments") return { id, comments: true };
  return { error: "路径格式不对，正确写法：/api/posts 或 /api/posts/<id> 或 /api/posts/<id>/comments" };
}

/** 把数据库里的帖子行拼成前端要的形状（补上作者名和评论数）。 */
function shapePost(row, userMap, commentCount) {
  const u = (userMap && userMap[row.authorId]) || {};
  return {
    id: row.id,
    authorId: row.authorId,
    authorName: u.username || "读者",   // 查不到人时的兜底（正常不会发生）
    authorAvatar: u.avatar || "",
    title: row.title,
    author: row.author,
    coverUrl: row.coverUrl,
    content: row.content,
    createdAt: row.createdAt,
    commentCount: commentCount || 0,
  };
}

function shapeComment(row, userMap) {
  const u = (userMap && userMap[row.authorId]) || {};
  return {
    id: row.id,
    postId: row.postId,
    authorId: row.authorId,
    authorName: u.username || "读者",
    authorAvatar: u.avatar || "",
    content: row.content,
    createdAt: row.createdAt,
  };
}

// ---------- 鉴权 ----------

/**
 * 验 token，成功返回 { user }，失败返回 { error }（中文，可直接显示）。
 * ⚠️ 过期要真判：sessions 表的 expiresAt 不是摆设。
 */
function requireUser(req, baseUrl, apiKey) {
  const token = readBearer(req);
  if (!token) return Promise.resolve({ error: "请先登录" });

  return db
    .findSessionByToken(token, baseUrl, apiKey)
    .then((session) => {
      if (!session) return { error: "登录状态已失效，请重新登录" };
      if (String(session.expiresAt) <= isoNow()) {
        return { error: "登录已过期，请重新登录" };
      }
      return db.findUserById(session.userId, baseUrl, apiKey).then((user) => {
        if (!user) return { error: "登录状态已失效，请重新登录" };
        return { user };
      });
    });
}

// ---------- 输入校验 ----------

function validatePostInput(body) {
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return { error: "书名不能为空" };
  }
  const title = body.title.trim();
  if (title.length > TITLE_MAX) return { error: `书名太长了（最多 ${TITLE_MAX} 字）` };

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return { error: "感受 / 看法不能为空" };
  }
  const content = body.content.trim();
  if (content.length > POST_CONTENT_MAX) {
    return { error: `正文太长了（最多 ${POST_CONTENT_MAX} 字）` };
  }

  const bookAuthor = typeof body.author === "string" ? body.author.trim() : "";
  if (bookAuthor.length > BOOK_AUTHOR_MAX) {
    return { error: `书的作者名字太长了（最多 ${BOOK_AUTHOR_MAX} 字）` };
  }

  const coverUrl = typeof body.coverUrl === "string" ? body.coverUrl.trim() : "";
  if (coverUrl.length > COVER_MAX) return { error: "封面地址太长了" };

  return { row: { title, author: bookAuthor, coverUrl, content } };
}

function validateCommentInput(body) {
  if (typeof body.content !== "string" || body.content.trim() === "") {
    return { error: "评论不能为空" };
  }
  const content = body.content.trim();
  if (content.length > COMMENT_CONTENT_MAX) {
    return { error: `评论太长了（最多 ${COMMENT_CONTENT_MAX} 字）` };
  }
  return { row: { content } };
}

// ================================================================
// 服务
// ================================================================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  const baseUrl =
    process.env.PG_API_BASE || "https://reading-sea-d7gd8l7o78b7304ae.api.tcloudbasegateway.com";
  const apiKey = process.env.PG_API_KEY || "";

  if (!apiKey) {
    log(req.method, url.pathname, "500", "缺少 PG_API_KEY");
    return fail(res, "服务端未配置数据源凭证（环境变量 PG_API_KEY），请联系站长");
  }

  const m = matchPostsPath(url.pathname);
  if (m.notMatched) {
    fail(res, "未知路径，本服务提供 GET/POST /api/posts 与 GET /api/posts/:id、POST /api/posts/:id/comments");
    log(req.method, url.pathname, "404", "未知路径");
    return;
  }
  if (m.error) {
    fail(res, m.error);
    log(req.method, url.pathname, "400", m.error);
    return;
  }

  // ---------- GET /api/posts（列表） ----------
  if (req.method === "GET" && m.list) {
    const rawLimit = url.searchParams.get("limit");
    let limit;
    if (rawLimit !== null && rawLimit !== "") {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n <= 0) {
        fail(res, "limit 必须是正整数，例如 /api/posts?limit=5");
        log("GET", "/api/posts", "400", "limit 非法");
        return;
      }
      limit = Math.min(n, LIMIT_MAX);
    }

    db.fetchPosts(limit, baseUrl, apiKey)
      .then((rows) => {
        const ids = rows.map((r) => r.id);
        return Promise.all([
          db.fetchUsersByIds(rows.map((r) => r.authorId), baseUrl, apiKey),
          db.countCommentsByPostIds(ids, baseUrl, apiKey),
          Promise.resolve(rows),
        ]);
      })
      .then(([userMap, counts, rows]) => {
        const posts = rows.map((r) => shapePost(r, userMap, counts[r.id]));
        log("GET", "/api/posts", "200", `返回 ${posts.length} 篇`);
        send(res, { ok: true, data: { posts } });
      })
      .catch((err) => {
        log("GET", "/api/posts", "500", err.message);
        fail(res, describeError(err));
      });
    return;
  }

  // ---------- GET /api/posts/:id（详情 + 评论） ----------
  if (req.method === "GET" && m.id) {
    db.fetchPostById(m.id, baseUrl, apiKey)
      .then((post) => {
        if (!post) {
          log("GET", url.pathname, "404", "帖子不存在");
          return fail(res, "这篇帖子不存在或已删除");
        }
        return db.fetchCommentsByPostId(post.id, baseUrl, apiKey).then((comments) => ({ post, comments }));
      })
      .then((pack) => {
        if (!pack) return; // 上面已经回过 404
        const { post, comments } = pack;
        const authorIds = [post.authorId].concat(comments.map((c) => c.authorId));
        return db.fetchUsersByIds(authorIds, baseUrl, apiKey).then((userMap) => {
          const shaped = shapePost(post, userMap, comments.length);
          shaped.comments = comments.map((c) => shapeComment(c, userMap));
          log("GET", url.pathname, "200", `帖子 ${post.id}，${comments.length} 条评论`);
          send(res, { ok: true, data: { post: shaped } });
        });
      })
      .catch((err) => {
        log("GET", url.pathname, "500", err.message);
        fail(res, describeError(err));
      });
    return;
  }

  // ---------- POST /api/posts（发帖，必须登录） ----------
  if (req.method === "POST" && m.list) {
    readBody(req)
      .then((raw) => {
        const { body, error: jsonErr } = parseJson(raw);
        if (jsonErr) {
          log("POST", "/api/posts", "400", jsonErr);
          return fail(res, jsonErr);
        }
        const v = validatePostInput(body);
        if (v.error) {
          log("POST", "/api/posts", "400", v.error);
          return fail(res, v.error);
        }

        return requireUser(req, baseUrl, apiKey).then((auth) => {
          if (auth.error) {
            log("POST", "/api/posts", "401", auth.error);
            return fail(res, auth.error);
          }
          const user = auth.user;
          const row = {
            id: newId("post"),
            authorId: user.id,     // ★ 只认 token 里的人，不认请求体
            title: v.row.title,
            author: v.row.author,
            coverUrl: v.row.coverUrl,
            content: v.row.content,
            createdAt: isoNow(),
            is_deleted: false,
          };
          return db
            .insertPost(row, baseUrl, apiKey)
            .then(() => {
              log("POST", "/api/posts", "200", `新帖 ${row.id}《${row.title}》by ${user.id}`);
              const userMap = {};
              userMap[user.id] = { id: user.id, username: user.username, avatar: user.avatar };
              send(res, { ok: true, data: { post: shapePost(row, userMap, 0) } });
            })
            .catch((err) => {
              log("POST", "/api/posts", "500", err.message);
              fail(res, `发帖失败：${describeError(err)}`);
            });
        });
      })
      .catch((err) => {
        log("POST", "/api/posts", "400", err.message);
        fail(res, err.message === "请求体太大" ? "请求体太大，请减小内容后重试" : "读取请求失败");
      });
    return;
  }

  // ---------- POST /api/posts/:id/comments（发评论，必须登录） ----------
  if (req.method === "POST" && m.id && m.comments) {
    readBody(req)
      .then((raw) => {
        const { body, error: jsonErr } = parseJson(raw);
        if (jsonErr) {
          log("POST", url.pathname, "400", jsonErr);
          return fail(res, jsonErr);
        }
        const v = validateCommentInput(body);
        if (v.error) {
          log("POST", url.pathname, "400", v.error);
          return fail(res, v.error);
        }

        return requireUser(req, baseUrl, apiKey).then((auth) => {
          if (auth.error) {
            log("POST", url.pathname, "401", auth.error);
            return fail(res, auth.error);
          }
          const user = auth.user;

          // 先确认帖子真的存在：否则会往一个不存在的帖子下面挂评论（孤儿数据）
          return db.fetchPostById(m.id, baseUrl, apiKey).then((post) => {
            if (!post) {
              log("POST", url.pathname, "404", "帖子不存在");
              return fail(res, "这篇帖子不存在或已删除");
            }
            const row = {
              id: newId("comment"),
              postId: post.id,
              authorId: user.id,   // ★ 同上，只认 token
              content: v.row.content,
              createdAt: isoNow(),
              is_deleted: false,
            };
            return db
              .insertComment(row, baseUrl, apiKey)
              .then(() => {
                log("POST", url.pathname, "200", `新评论 ${row.id} on ${post.id}`);
                const userMap = {};
                userMap[user.id] = { id: user.id, username: user.username, avatar: user.avatar };
                send(res, { ok: true, data: { comment: shapeComment(row, userMap) } });
              })
              .catch((err) => {
                log("POST", url.pathname, "500", err.message);
                fail(res, `评论失败：${describeError(err)}`);
              });
          });
        });
      })
      .catch((err) => {
        log("POST", url.pathname, "400", err.message);
        fail(res, err.message === "请求体太大" ? "请求体太大，请减小内容后重试" : "读取请求失败");
      });
    return;
  }

  fail(res, `不支持的请求：${req.method} ${url.pathname}`);
  log(req.method, url.pathname, "405", "方法不支持");
});

server.listen(PORT, () => {
  console.log(`community function listening on port ${PORT}`);
});
