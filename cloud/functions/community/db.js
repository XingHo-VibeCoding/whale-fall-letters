/**
 * db.js —— 论坛接口的数据访问层（Day 30 第二阶段）
 *
 * 职责边界（与 books/db.js、auth/db.js 一致）：
 *   - 只负责「和数据库说话」，不做输入校验（那是 index.js 的活）；
 *   - 出错就 throw，由接口层 catch 后翻成人话。
 *
 * 通道：PostgreSQL 的 HTTP API（PostgREST 风格），零 npm 依赖。
 *
 * ⚠️ 两处容易踩的地方：
 *   ① 列表要显示"谁发的"，但没建物理外键，PostgREST 的嵌套 select 用不了。
 *      所以是「先查帖子 → 收集 authorId → 批量查用户 → 内存里拼」。
 *      两次查询固定，不会随帖子数增长（不做 N+1）。
 *   ② PostgREST 的 in.(a,b,c) 语法里，值不能含逗号。
 *      我们所有 id 都是 `post-xxx` / `user-xxx` 这种格式，安全。
 */

const REQUEST_TIMEOUT_MS = 8000;

function headers(apiKey, json) {
  const h = { Authorization: `Bearer ${apiKey}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function restUrl(baseUrl, table, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return `${baseUrl}/v1/rdb/rest/${table}${qs}`;
}

async function getRows(table, params, baseUrl, apiKey) {
  const resp = await fetch(restUrl(baseUrl, table, params), {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

async function insertRow(table, row, baseUrl, apiKey) {
  const resp = await fetch(restUrl(baseUrl, table), {
    method: "POST",
    headers: headers(apiKey, true),
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
}

// ---------------------------------------------------------------- 登录态

/** 按 token 查会话（与 auth 函数同一张 sessions 表）。没查到返回 null。 */
async function findSessionByToken(token, baseUrl, apiKey) {
  if (!token) throw new Error("findSessionByToken 缺少 token，已中止");
  const rows = await getRows(
    "sessions",
    { select: "*", token: `eq.${token}`, limit: "1" },
    baseUrl,
    apiKey
  );
  return rows.length > 0 ? rows[0] : null;
}

async function findUserById(id, baseUrl, apiKey) {
  if (!id) throw new Error("findUserById 缺少 id，已中止");
  const rows = await getRows("users", { select: "*", id: `eq.${id}`, limit: "1" }, baseUrl, apiKey);
  return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------- 帖子

/**
 * 帖子列表，按发帖时间倒序。limit 不传 = 全部。
 *
 * Day 31：加了 q —— 按书名 / 书的作者 / 正文做**大小写不敏感**的模糊搜索。
 *
 * ⚠️ 搜索词必须清洗：PostgREST 的 or 语法里 `,` `(` `)` 是结构字符、`*` 是通配符。
 *    用户搜 "三体(上)" 如果不处理，整个 or 条件会被解析坏，返回一堆莫名其妙的结果。
 *    这里把结构字符换成空格 —— 宁可少匹配几个字，也不能让查询语法崩掉。
 */
async function fetchPosts(limit, baseUrl, apiKey, q) {
  const params = { select: "*", order: "createdAt.desc", is_deleted: "eq.false" };
  if (limit !== undefined) params.limit = String(limit);

  const keyword = String(q || "").replace(/[(),*%]/g, " ").trim();
  if (keyword) {
    // ilike = 大小写不敏感；* 是 PostgREST 的通配符（等价于 SQL 的 %）
    params.or = `(title.ilike.*${keyword}*,author.ilike.*${keyword}*,content.ilike.*${keyword}*)`;
  }

  return getRows("posts", params, baseUrl, apiKey);
}

async function fetchPostById(id, baseUrl, apiKey) {
  if (!id) throw new Error("fetchPostById 缺少 id，已中止");
  const rows = await getRows(
    "posts",
    { select: "*", id: `eq.${id}`, is_deleted: "eq.false", limit: "1" },
    baseUrl,
    apiKey
  );
  return rows.length > 0 ? rows[0] : null;
}

async function insertPost(row, baseUrl, apiKey) {
  await insertRow("posts", row, baseUrl, apiKey);
}

// ---------------------------------------------------------------- 评论

/** 某篇帖子的全部评论，按时间**正序**（先发的在上面，跟聊天记录相反）。 */
async function fetchCommentsByPostId(postId, baseUrl, apiKey) {
  if (!postId) throw new Error("fetchCommentsByPostId 缺少 postId，已中止");
  return getRows(
    "comments",
    { select: "*", postId: `eq.${postId}`, order: "createdAt.asc", is_deleted: "eq.false" },
    baseUrl,
    apiKey
  );
}

async function insertComment(row, baseUrl, apiKey) {
  await insertRow("comments", row, baseUrl, apiKey);
}

/**
 * 批量统计「每篇帖子有几条评论」，返回 { [postId]: 数字 }。
 * 一次查询拿走所有 postId 列，在内存里数 —— 数据量小的时候比给每篇帖子发一次 count 划算得多。
 */
async function countCommentsByPostIds(postIds, baseUrl, apiKey) {
  const out = {};
  if (!postIds || postIds.length === 0) return out;
  const rows = await getRows(
    "comments",
    { select: "postId", postId: `in.(${postIds.join(",")})`, is_deleted: "eq.false" },
    baseUrl,
    apiKey
  );
  for (const r of rows) out[r.postId] = (out[r.postId] || 0) + 1;
  return out;
}

// ---------------------------------------------------------------- 用户信息

/**
 * 批量取用户，只拿显示需要的三列（id / username / avatar）。
 * **绝不 select=***，那会把 passwordHash 和 salt 一起拉进内存，
 * 虽然不会返回给前端，但完全没有理由让它们出现在这个函数里。
 */
async function fetchUsersByIds(ids, baseUrl, apiKey) {
  const out = {};
  if (!ids || ids.length === 0) return out;
  const uniq = Array.from(new Set(ids));
  const rows = await getRows(
    "users",
    { select: "id,username,avatar", id: `in.(${uniq.join(",")})` },
    baseUrl,
    apiKey
  );
  for (const r of rows) out[r.id] = r;
  return out;
}

// ---------------------------------------------------------------- 私信

/**
 * 查「跟我有关的所有消息」（我发的 + 我收的），按时间**倒序**。
 * 会话列表就是拿这批消息按对方分组的 —— 所以不建会话表，会话是算出来的。
 *
 * PostgREST 的 or 语法：or=(fromId.eq.x,toId.eq.x) → WHERE fromId='x' OR toId='x'
 */
async function fetchMessagesOfUser(userId, baseUrl, apiKey) {
  if (!userId) throw new Error("fetchMessagesOfUser 缺少 userId，已中止");
  return getRows(
    "messages",
    {
      select: "*",
      or: `(fromId.eq.${userId},toId.eq.${userId})`,
      order: "createdAt.desc",
      is_deleted: "eq.false",
    },
    baseUrl,
    apiKey
  );
}

/**
 * 查两个**特定的人**之间的全部消息，按时间正序（聊天记录顺序）。
 * or=(and(fromId.eq.a,toId.eq.b),and(fromId.eq.b,toId.eq.a))
 * —— 少写任何一个 and，都会把"我跟所有人的消息"拉出来。
 */
async function fetchThread(meId, peerId, baseUrl, apiKey) {
  if (!meId || !peerId) throw new Error("fetchThread 缺少 id，已中止");
  return getRows(
    "messages",
    {
      select: "*",
      or: `(and(fromId.eq.${meId},toId.eq.${peerId}),and(fromId.eq.${peerId},toId.eq.${meId}))`,
      order: "createdAt.asc",
      is_deleted: "eq.false",
    },
    baseUrl,
    apiKey
  );
}

async function insertMessage(row, baseUrl, apiKey) {
  await insertRow("messages", row, baseUrl, apiKey);
}

/**
 * 把「对方发给我的、还没读的」全部标成已读，返回真实更新了几条。
 *
 * ⚠️ 条件里三个筛选同时存在（toId / fromId / readAt is null），
 *    少了任何一个都会误伤：只按 toId 更新 = 把我所有会话都标已读。
 */
async function markThreadRead(meId, peerId, nowIso, baseUrl, apiKey) {
  if (!meId || !peerId) throw new Error("markThreadRead 缺少 id，已中止");

  const params = new URLSearchParams({
    toId: `eq.${meId}`,
    fromId: `eq.${peerId}`,
    readAt: "is.null",
    is_deleted: "eq.false",
  });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/messages?${params}`, {
    method: "PATCH",
    headers: { ...headers(apiKey, true), Prefer: "return=representation" },
    body: JSON.stringify({ readAt: nowIso }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

// ---------------------------------------------------------------- 评论点赞（Day 31）

/**
 * 算一批评论各有几个赞，返回 { [commentId]: 数字 }。
 * 一次查询把该帖所有点赞记录拉下来在内存里数 —— 比给每条评论发一次 count 划算。
 */
async function countLikesByCommentIds(commentIds, baseUrl, apiKey) {
  const out = {};
  if (!commentIds || commentIds.length === 0) return out;
  const rows = await getRows(
    "comment_likes",
    { select: "commentId", commentId: `in.(${commentIds.join(",")})` },
    baseUrl,
    apiKey
  );
  for (const r of rows) out[r.commentId] = (out[r.commentId] || 0) + 1;
  return out;
}

/**
 * 这批评论里，**我**赞过哪些。
 * 没登录（userId 为空）直接返回空集合 —— 不是错误，是"谁都不是"。
 */
async function fetchMyLikedCommentIds(userId, commentIds, baseUrl, apiKey) {
  if (!userId || !commentIds || commentIds.length === 0) return [];
  const rows = await getRows(
    "comment_likes",
    {
      select: "commentId",
      userId: `eq.${userId}`,
      commentId: `in.(${commentIds.join(",")})`,
    },
    baseUrl,
    apiKey
  );
  return rows.map((r) => r.commentId);
}

/** 加一个赞。重复点会撞复合主键（409），这里当成功处理 —— 目标状态已达成。 */
async function insertLike(userId, commentId, nowIso, baseUrl, apiKey) {
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/comment_likes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ userId, commentId, createdAt: nowIso }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    if (resp.status === 409) return false; // 已经赞过
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  return true;
}

/** 取消赞，返回真实删掉的行数（0 = 本来就没赞过）。 */
async function deleteLike(userId, commentId, baseUrl, apiKey) {
  if (!userId || !commentId) throw new Error("deleteLike 缺少参数，已中止");
  const params = new URLSearchParams({ userId: `eq.${userId}`, commentId: `eq.${commentId}` });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/comment_likes?${params}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}`, Prefer: "return=representation" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

/** 我到底赞没赞过这一条（拿来做 toggle 判断）。 */
async function hasLiked(userId, commentId, baseUrl, apiKey) {
  if (!userId || !commentId) return false;
  const rows = await getRows(
    "comment_likes",
    { select: "userId", userId: `eq.${userId}`, commentId: `eq.${commentId}`, limit: "1" },
    baseUrl,
    apiKey
  );
  return rows.length > 0;
}

module.exports = {
  findSessionByToken,
  findUserById,
  fetchPosts,
  fetchPostById,
  insertPost,
  fetchCommentsByPostId,
  insertComment,
  countCommentsByPostIds,
  fetchUsersByIds,
  fetchMessagesOfUser,
  fetchThread,
  insertMessage,
  markThreadRead,
  countLikesByCommentIds,
  fetchMyLikedCommentIds,
  insertLike,
  deleteLike,
  hasLiked,
};
