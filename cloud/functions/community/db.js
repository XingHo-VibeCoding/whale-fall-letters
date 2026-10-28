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

/**
 * 同 getRows，但顺便把「总共有多少行」也带回来（PostgREST 的 count=exact）。
 *
 * 为什么非要多这一次读：前端要显示「共 N 篇」并判断「后面还有没有」。
 * 只靠「这一页满没满」去猜的话，最后一页正好装满时会多给一个空页 ——
 * 用户点了「加载更多」什么也没多出来，会以为坏了。
 *
 * Content-Range 响应头的形状是 `0-19/1234`（起始-结束/总数），
 * 数不出来时总数位是 `*`，这时 total 返回 null，由调用方退回推断。
 */
async function getRowsWithCount(table, params, baseUrl, apiKey) {
  const h = headers(apiKey);
  h.Prefer = "count=exact";
  const resp = await fetch(restUrl(baseUrl, table, params), {
    headers: h,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // ⚠️ Day 32 真库踩到的坑：offset 超过总行数时，PostgREST 回的是 **HTTP 416**
  // （Range Not Satisfiable），不是「200 + 空数组」。
  // 对分页来说这根本不是错误 —— 就是"这一页是空的"，当最后一页处理即可。
  // 不特判的话，用户翻到比总页数还大的页码（比如别人刚删了帖子）会看到
  // "数据源暂时不可用（HTTP 416）"这种谁也看不懂的报错。
  // 416 的响应头同样带 Content-Range: * / 总数，总数照读。
  if (resp.status === 416) {
    const tail416 = (resp.headers.get("content-range") || "").split("/")[1];
    const total416 = tail416 && tail416 !== "*" ? Number(tail416) : NaN;
    return { rows: [], total: Number.isFinite(total416) ? total416 : null };
  }

  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  const list = Array.isArray(rows) ? rows : [];
  const tail = (resp.headers.get("content-range") || "").split("/")[1];
  const total = tail && tail !== "*" ? Number(tail) : NaN;
  return { rows: list, total: Number.isFinite(total) ? total : null };
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
 * 帖子列表，按发帖时间倒序，**分页**。返回 { rows, total }。
 *
 * Day 31：加了 q —— 按书名 / 书的作者 / 正文做**大小写不敏感**的模糊搜索。
 * Day 32：改成必须带 limit/offset。原来"limit 不传 = 全部"是个定时炸弹 ——
 *         前端不带参数就是全表拉取，帖子上千篇时必然撞 8 秒超时，论坛页白屏。
 *         现在**没有"一次拉全部"这条路了**，要全量就得自己翻页。
 *
 * ⚠️ 排序必须有第二把钥匙 id.desc：
 *    createdAt 是 VARCHAR 存的 ISO 字符串，同一毫秒发的两篇排序结果不确定。
 *    Postgres 不保证相同排序键的行顺序稳定 → 翻页时第 2 页可能重复第 1 页的某篇、
 *    同时又漏掉另一篇（这类 bug 只在数据多了以后才出现，很难复现）。
 *
 * ⚠️ 搜索词必须清洗：PostgREST 的 or 语法里 `,` `(` `)` 是结构字符、`*` 是通配符。
 *    用户搜 "三体(上)" 如果不处理，整个 or 条件会被解析坏，返回一堆莫名其妙的结果。
 *    这里把结构字符换成空格 —— 宁可少匹配几个字，也不能让查询语法崩掉。
 */
async function fetchPosts(opts, baseUrl, apiKey) {
  const limit = opts && opts.limit;
  const offset = opts && opts.offset;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("fetchPosts 缺少合法的 limit，已中止");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("fetchPosts 缺少合法的 offset，已中止");

  const params = {
    select: "*",
    order: "createdAt.desc,id.desc",
    is_deleted: "eq.false",
    limit: String(limit),
    offset: String(offset),
  };

  const keyword = String((opts && opts.q) || "").replace(/[(),*%]/g, " ").trim();
  if (keyword) {
    // ilike = 大小写不敏感；* 是 PostgREST 的通配符（等价于 SQL 的 %）
    params.or = `(title.ilike.*${keyword}*,author.ilike.*${keyword}*,content.ilike.*${keyword}*)`;
  }

  // Day 32 加的精确过滤：个人主页要「某人发的帖子」，同书列表要「关于某本书的帖子」。
  // 为什么不能让前端从列表缓存里筛：分页之后缓存里只有已经翻到的那几篇，
  // 筛出来的结果会少一大截（个人主页会说"还没发过帖子"，同书列表会说"还没有讨论"）。
  // title 是书名（不是帖子标题），值是用户可见文本，交给 URLSearchParams 编码。
  if (opts && opts.authorId) params.authorId = `eq.${opts.authorId}`;
  if (opts && opts.title) params.title = `eq.${opts.title}`;

  return getRowsWithCount("posts", params, baseUrl, apiKey);
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

// ---------------------------------------------------------------- 备份

/**
 * 要备份的表，顺序有意义：恢复时必须先写被依赖的
 * （users 在 posts/messages 之前，books 在 notes 之前，posts 在 comments 之前）。
 *
 * ⚠️ 这里必须与库里真实的表一一对应。少一张 = 那一张的数据不在备份里，
 *    而且**不会报错**——等真出事那天才发现少了点赞记录，是最坏的一种失败。
 *    目前 8 张：books / notes / users / sessions / posts / comments / messages / comment_likes
 */
const BACKUP_TABLES = [
  "users",
  "books",
  "notes",
  "posts",
  "comments",
  "messages",
  "sessions",
  "comment_likes",
];

const BACKUP_PAGE = 1000;          // 单次拉取上限，避免一次拉太多撞网关响应体上限
const BACKUP_MAX_ROWS = 500000;    // 单表行数护栏：超过就停，免得备份任务把函数拖死

/**
 * 把一张表整份拉下来（分页，防静默截断）。
 *
 * 为什么不用 getRowsWithCount：备份不需要总数，多算一次 count 纯属浪费；
 * 而且它遇到 416 有特殊处理，这里的循环语义不一样。
 */
async function fetchTableAll(table, baseUrl, apiKey) {
  const out = [];
  let offset = 0;

  for (;;) {
    if (offset > BACKUP_MAX_ROWS) {
      throw new Error(`${table} 行数超过 ${BACKUP_MAX_ROWS}，备份已中止`);
    }
    const params = new URLSearchParams({
      select: "*",
      limit: String(BACKUP_PAGE),
      offset: String(offset),
    });
    const resp = await fetch(`${baseUrl}/v1/rdb/rest/${table}?${params}`, {
      headers: headers(apiKey),
      signal: AbortSignal.timeout(30000),
    });

    // 恰好翻过最后一行时 PostgREST 回 416 —— 这是正常收尾，不是错误
    if (resp.status === 416) break;
    if (!resp.ok) throw new Error(`${table} 拉取失败：HTTP ${resp.status}`);

    const page = await resp.json();
    const list = Array.isArray(page) ? page : [];
    out.push(...list);
    if (list.length < BACKUP_PAGE) break;
    offset += BACKUP_PAGE;
  }

  return out;
}

/** 删掉同 label 的旧快照（同一天重跑不该堆成好几份）。备份是派生数据，硬删即可。 */
async function deleteBackupsByLabel(label, baseUrl, apiKey) {
  const params = new URLSearchParams({ label: `eq.${label}` });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/backups?${params}`, {
    method: "DELETE",
    headers: headers(apiKey),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`清理旧快照失败：HTTP ${resp.status}`);
}

/**
 * 生成一份备份。返回 { id, label, tableCount, rowCount, sizeBytes }（不含 payload）。
 *
 * 为什么 label 用「年月日-时分」而不是随机串：出事后人要看的是"这是哪天的数据"，
 * 随机 id 得去查表才知道。同一天重复跑会先删同 label 的旧份，所以不会堆。
 */
async function createBackup(label, baseUrl, apiKey) {
  const pack = {};
  let rowCount = 0;

  for (const t of BACKUP_TABLES) {
    const rows = await fetchTableAll(t, baseUrl, apiKey);
    pack[t] = rows;
    rowCount += rows.length;
  }

  const payload = JSON.stringify({
    // ⚠️ 结构必须和 tools/backup-pg.js 导出的文件一致：{ meta, data }。
    // 两边格式一样，tools/restore-pg.js 才能不分来源地恢复
    // （不管这份是从本地文件来的还是从库里 backups 表来的）。
    meta: {
      label,
      createdAt: new Date().toISOString(),
      // 恢复脚本会打印这个字段（"备份时间：xxx"），格式与 tools/backup-pg.js 保持一致
      createdAtBeijing:
        new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " +08",
      source: "cloud-function",
      tables: BACKUP_TABLES,
    },
    data: pack,
  });
  const sizeBytes = Buffer.byteLength(payload, "utf8");

  await deleteBackupsByLabel(label, baseUrl, apiKey);

  const row = {
    id: "bak-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    label,
    payload,
    tableCount: BACKUP_TABLES.length,
    rowCount,
    sizeBytes,
    createdAt: new Date().toISOString(),
    is_deleted: false,
  };
  await insertRow("backups", row, baseUrl, apiKey);

  return {
    id: row.id,
    label,
    tableCount: row.tableCount,
    rowCount,
    sizeBytes,
    detail: BACKUP_TABLES.map((t) => `${t}:${pack[t].length}`).join(" "),
  };
}

/** 快照列表（只有元信息，绝不带 payload —— 里面是密码散列）。 */
async function listBackups(baseUrl, apiKey) {
  return getRows(
    "backups",
    { select: "id,label,tableCount,rowCount,sizeBytes,createdAt", order: "createdAt.desc" },
    baseUrl,
    apiKey
  );
}

/**
 * 只保留最近 keep 份，更老的删掉。
 * 不做这个的话，一天一份、八个表全量，几个月就能把体验版的库撑满。
 */
async function pruneBackups(keep, baseUrl, apiKey) {
  const rows = await getRows(
    "backups",
    { select: "id", order: "createdAt.desc" },
    baseUrl,
    apiKey
  );
  const stale = rows.slice(keep).map((r) => r.id);
  if (!stale.length) return 0;

  // 一次删一批（PostgREST 的 in.(a,b,c) 语法）；分批是为了不让 URL 太长
  const CHUNK = 50;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const ids = stale.slice(i, i + CHUNK).join(",");
    const params = new URLSearchParams({ id: `in.(${ids})` });
    const resp = await fetch(`${baseUrl}/v1/rdb/rest/backups?${params}`, {
      method: "DELETE",
      headers: headers(apiKey),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`清理过期快照失败：HTTP ${resp.status}`);
  }

  return stale.length;
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
  createBackup,
  listBackups,
  pruneBackups,
  BACKUP_TABLES,
};
