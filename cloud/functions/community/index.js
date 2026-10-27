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
const MESSAGE_MAX = 1000;          // 单条私信正文上限

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
  // Day 31：/api/posts/:postId/comments/:commentId/like（点赞 / 取消赞）
  if (parts.length === 4 && parts[1] === "comments" && parts[3] === "like") {
    let commentId;
    try {
      commentId = decodeURIComponent(parts[2]);
    } catch {
      return { error: "评论 id 的编码格式不对" };
    }
    if (!commentId) return { error: "评论 id 不能为空" };
    return { id, commentId, like: true };
  }
  return { error: "路径格式不对，正确写法：/api/posts 或 /api/posts/<id> 或 /api/posts/<id>/comments" };
}

/**
 * 私信路由解析。返回：
 *   { notMatched:true }        不是 /api/messages 开头
 *   { list:true }              /api/messages
 *   { peerId:'user-x' }        /api/messages/user-x
 *   { error:'...' }            格式不对（有 error 就到此为止，绝不带着空 id 往下走）
 */
function matchMessagesPath(pathname) {
  if (pathname === "/api/messages" || pathname === "/api/messages/") return { list: true };
  if (!pathname.startsWith("/api/messages/")) return { notMatched: true };

  const raw = pathname.slice("/api/messages/".length).replace(/\/$/, "");
  if (raw === "") return { list: true };
  if (raw.includes("/")) {
    return { error: "路径格式不对，正确写法：/api/messages 或 /api/messages/<对方用户id>" };
  }
  let peerId;
  try {
    peerId = decodeURIComponent(raw);
  } catch {
    return { error: "用户 id 的编码格式不对" };
  }
  return { peerId };
}

/**
 * 把「我参与的全部消息」按对方分组，拼成前端要的会话列表。
 *
 * 这一步是私信里最像"数据库活"的地方：表里只有一条条消息，
 * 「有哪些会话、各自最后一句是什么、几条没读」全是这里算出来的。
 */
function shapeConversations(rows, meId, userMap) {
  const byPeer = {};

  for (const r of rows) {
    // 对方是谁：自己发的看 toId，收到的看 fromId
    const peer = r.fromId === meId ? r.toId : r.fromId;
    if (!byPeer[peer]) byPeer[peer] = { peerId: peer, messages: [], unread: 0 };
    byPeer[peer].messages.push(r);
    // 未读只算「发给我的、还没读的」；我自己发的不算
    if (r.toId === meId && !r.readAt) byPeer[peer].unread += 1;
  }

  const out = [];
  for (const peer of Object.keys(byPeer)) {
    const c = byPeer[peer];
    // 会话内按时间正序（聊天记录顺序：早的在上）
    c.messages.sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1 : 1));
    const u = userMap[peer] || {};
    c.peerName = u.username || "读者";
    c.peerAvatar = u.avatar || "";
    c.lastAt = c.messages.length ? c.messages[c.messages.length - 1].createdAt : "";
    out.push(c);
  }
  // 会话列表按"最后一条消息时间"倒序，最近的在上
  out.sort((a, b) => (String(b.lastAt) < String(a.lastAt) ? -1 : 1));
  return out;
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

function shapeComment(row, userMap, likeCount, likedByMe) {
  const u = (userMap && userMap[row.authorId]) || {};
  return {
    id: row.id,
    postId: row.postId,
    authorId: row.authorId,
    authorName: u.username || "读者",
    authorAvatar: u.avatar || "",
    content: row.content,
    createdAt: row.createdAt,
    // Day 31：点赞数改成后端算，不再存本地。刚发的评论默认 0，没赞过就是 false。
    likeCount: likeCount || 0,
    likedByMe: !!likedByMe,
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

  // ================ 私信（Day 30 第三阶段） ================
  //
  // 三个接口都要求登录 —— 私信天然是私密的，没有"公开看"的说法。
  const msgPath = matchMessagesPath(url.pathname);

  if (!msgPath.notMatched) {
    if (msgPath.error) {
      fail(res, msgPath.error);
      log(req.method, url.pathname, "400", msgPath.error);
      return;
    }

    // ---------- GET /api/messages（我的会话列表） ----------
    if (req.method === "GET" && msgPath.list) {
      return requireUser(req, baseUrl, apiKey).then((auth) => {
        if (auth.error) {
          log("GET", "/api/messages", "401", auth.error);
          return fail(res, auth.error);
        }
        const me = auth.user.id;

        return db
          .fetchMessagesOfUser(me, baseUrl, apiKey)
          .then((rows) => {
            const peerIds = rows.map((r) => (r.fromId === me ? r.toId : r.fromId));
            return db
              .fetchUsersByIds(peerIds, baseUrl, apiKey)
              .then((userMap) => {
                const conversations = shapeConversations(rows, me, userMap);
                const totalUnread = conversations.reduce((n, c) => n + c.unread, 0);
                log("GET", "/api/messages", "200", `${conversations.length} 个会话，未读 ${totalUnread}`);
                send(res, { ok: true, data: { conversations, totalUnread } });
              });
          })
          .catch((err) => {
            log("GET", "/api/messages", "500", err.message);
            fail(res, describeError(err));
          });
      });
    }

    // ---------- GET /api/messages/:peerId（和某人的消息） ----------
    if (req.method === "GET" && msgPath.peerId) {
      return requireUser(req, baseUrl, apiKey).then((auth) => {
        if (auth.error) {
          log("GET", url.pathname, "401", auth.error);
          return fail(res, auth.error);
        }
        const me = auth.user.id;
        const peerId = msgPath.peerId;

        return db.findUserById(peerId, baseUrl, apiKey).then((peer) => {
          if (!peer) {
            log("GET", url.pathname, "404", "对方不存在");
            return fail(res, "这个用户不存在");
          }
          return db.fetchThread(me, peerId, baseUrl, apiKey).then((rows) => {
            // ★ 打开会话就算读过了。GET 带副作用不"纯"，但这里值：
            //   否则前端还得额外发一个请求，而那一步失败就会被当成"聊天没加载出来"。
            //   失败不影响消息本身返回，所以 catch 掉。
            return db
              .markThreadRead(me, peerId, isoNow(), baseUrl, apiKey)
              .catch(() => 0)
              .then((markedRead) => {
                log("GET", url.pathname, "200", `${rows.length} 条消息，标记已读 ${markedRead}`);
                send(res, {
                  ok: true,
                  data: {
                    peer: { id: peer.id, username: peer.username, avatar: peer.avatar || "" },
                    messages: rows,
                    markedRead,
                  },
                });
              });
          });
        }).catch((err) => {
          log("GET", url.pathname, "500", err.message);
          fail(res, describeError(err));
        });
      });
    }

    // ---------- POST /api/messages/:peerId（发消息） ----------
    if (req.method === "POST" && msgPath.peerId) {
      return readBody(req)
        .then((raw) => {
          const { body, error: jsonErr } = parseJson(raw);
          if (jsonErr) {
            log("POST", url.pathname, "400", jsonErr);
            return fail(res, jsonErr);
          }
          if (typeof body.content !== "string" || body.content.trim() === "") {
            log("POST", url.pathname, "400", "消息为空");
            return fail(res, "消息不能为空");
          }
          const content = body.content.trim();
          if (content.length > MESSAGE_MAX) {
            log("POST", url.pathname, "400", "消息太长");
            return fail(res, `消息太长了（最多 ${MESSAGE_MAX} 字）`);
          }

          return requireUser(req, baseUrl, apiKey).then((auth) => {
            if (auth.error) {
              log("POST", url.pathname, "401", auth.error);
              return fail(res, auth.error);
            }
            const me = auth.user.id;
            const peerId = msgPath.peerId;

            if (me === peerId) {
              log("POST", url.pathname, "400", "发给自己");
              return fail(res, "不能给自己发私信");
            }

            return db.findUserById(peerId, baseUrl, apiKey).then((peer) => {
              if (!peer) {
                log("POST", url.pathname, "404", "收件人不存在");
                return fail(res, "这个用户不存在");
              }
              const row = {
                id: newId("msg"),
                fromId: me,          // ★ 只认 token 里的人
                toId: peer.id,
                content,
                createdAt: isoNow(),
                readAt: null,        // 刚发出，对方还没读
                is_deleted: false,
              };
              return db
                .insertMessage(row, baseUrl, apiKey)
                .then(() => {
                  log("POST", url.pathname, "200", `新消息 ${row.id} → ${peer.id}`);
                  send(res, { ok: true, data: { message: row } });
                })
                .catch((err) => {
                  log("POST", url.pathname, "500", err.message);
                  fail(res, `发送失败：${describeError(err)}`);
                });
            });
          });
        })
        .catch((err) => {
          log("POST", url.pathname, "400", err.message);
          fail(res, err.message === "请求体太大" ? "请求体太大，请减小内容后重试" : "读取请求失败");
        });
    }

    fail(res, `不支持的请求：${req.method} ${url.pathname}`);
    log(req.method, url.pathname, "405", "方法不支持");
    return;
  }

  const m = matchPostsPath(url.pathname);
  if (m.notMatched) {
    fail(
      res,
      "未知路径，本服务提供 GET/POST /api/posts、GET /api/posts/:id、POST /api/posts/:id/comments、GET/POST /api/messages、GET /api/messages/:peerId"
    );
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
        const commentIds = comments.map((c) => c.id);

        // 可选身份：带了有效 token 就顺带算出"我赞过哪些"，没带就是都没赞过。
        // 详情页是公开的，不能因为没登录就打不开 —— 所以这里不能强制 requireUser。
        const token = readBearer(req);
        const mePromise = token
          ? db
              .findSessionByToken(token, baseUrl, apiKey)
              .then((s) => (s && String(s.expiresAt) > isoNow() ? s.userId : ""))
              .catch(() => "")
          : Promise.resolve("");

        return Promise.all([
          db.fetchUsersByIds(authorIds, baseUrl, apiKey),
          db.countLikesByCommentIds(commentIds, baseUrl, apiKey),
          mePromise,
        ]).then(([userMap, likeCounts, meId]) =>
          db.fetchMyLikedCommentIds(meId, commentIds, baseUrl, apiKey).then((mine) => {
            const mineSet = {};
            for (const id of mine) mineSet[id] = true;

            const shaped = shapePost(post, userMap, comments.length);
            shaped.comments = comments.map((c) =>
              shapeComment(c, userMap, likeCounts[c.id], mineSet[c.id])
            );
            log("GET", url.pathname, "200", `帖子 ${post.id}，${comments.length} 条评论`);
            send(res, { ok: true, data: { post: shaped } });
          })
        );
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
  // ---------- POST /api/posts/:id/comments/:cid/like（点赞 / 取消赞） ----------
  //
  // 一个接口做两件事（toggle）：赞过了就取消，没赞过就加上。
  // 为什么不做成 POST/DELETE 两个接口：前端只有一个心眼按钮，点一下就该有一个结果，
  // 让前端先判断"我赞过没"再决定调哪个，等于把并发问题推给客户端（连点两下就错）。
  if (req.method === "POST" && m.id && m.like) {
    return requireUser(req, baseUrl, apiKey).then((auth) => {
      if (auth.error) {
        log("POST", url.pathname, "401", auth.error);
        return fail(res, auth.error);
      }
      const userId = auth.user.id;
      const commentId = m.commentId;

      // ★ 先确认这条评论真的挂在这篇帖子下面。
      //   不查的话，可以拿 A 帖的 id + B 帖的评论 id 去点赞，等于绕过了帖子边界。
      return db
        .fetchCommentsByPostId(m.id, baseUrl, apiKey)
        .then((comments) => {
          const target = comments.find((c) => c.id === commentId);
          if (!target) {
            log("POST", url.pathname, "404", "评论不在该帖下");
            return fail(res, "这条评论不存在");
          }

          return db.hasLiked(userId, commentId, baseUrl, apiKey).then((liked) => {
            const step = liked
              ? db.deleteLike(userId, commentId, baseUrl, apiKey)
              : db.insertLike(userId, commentId, isoNow(), baseUrl, apiKey);

            return step
              .then(() => db.countLikesByCommentIds([commentId], baseUrl, apiKey))
              .then((counts) => {
                const nowLiked = !liked;
                log("POST", url.pathname, "200", `${nowLiked ? "点赞" : "取消赞"} ${commentId}，共 ${counts[commentId] || 0}`);
                send(res, {
                  ok: true,
                  data: { liked: nowLiked, likeCount: counts[commentId] || 0 },
                });
              });
          });
        })
        .catch((err) => {
          log("POST", url.pathname, "500", err.message);
          fail(res, `点赞失败：${describeError(err)}`);
        });
    });
  }

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
