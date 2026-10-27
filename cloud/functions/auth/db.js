/**
 * db.js —— 账号接口的数据访问层（Day 30 第一阶段）
 *
 * 职责边界（照抄 books/db.js 的约定）：
 *   - 这个文件只负责「和数据库说话」，**不做任何输入校验**（那是 index.js 的活）；
 *   - 出错就 throw，由接口层 catch 后翻成人话。
 *
 * 通道：与 books 相同 —— 不走 TCP 直连，走 PostgreSQL 的 HTTP API（PostgREST 风格）：
 *   GET  /v1/rdb/rest/users?select=*&usernameLower=eq.alice
 *   POST /v1/rdb/rest/users        （body 就是要插入的那一行，HTTP 201 = 成功）
 *   DELETE /v1/rdb/rest/sessions?token=eq.xxx
 * 好处：Node 自带 fetch 就够，本函数零 npm 依赖，控制台部署不用装包。
 *
 * ⚠️ 两条铁律：
 *   ① 查询条件里永远带上完整的定位条件（token=eq.xxx），
 *      绝不下发无条件请求 —— 无条件 DELETE 删的是整张表。
 *   ② 这个文件**永远不把 passwordHash / salt 往外送**的逻辑不在这里，
 *      在接口层的 pickPublicUser()。这层只是老实取行、老实返回。
 */

// 统一超时：8 秒，与 books 一致。数据源卡住时尽快抛错，让人看到明确提示
const REQUEST_TIMEOUT_MS = 8000;

/** 拼一个带 Bearer 的请求头，5 个函数共用，避免抄 5 遍。 */
function headers(apiKey, json) {
  const h = { Authorization: `Bearer ${apiKey}` };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function restUrl(baseUrl, table, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return `${baseUrl}/v1/rdb/rest/${table}${qs}`;
}

// ---------------------------------------------------------------- 读

/**
 * 按「小写账号名」查一个用户。没查到返回 null（**不是抛错** —— 查不到是正常情况）。
 * 只查 usernameLower 一列不行，要整行：登录时要拿 salt 和 passwordHash 做比对。
 */
async function findUserByUsernameLower(usernameLower, baseUrl, apiKey) {
  const resp = await fetch(
    restUrl(baseUrl, "users", {
      select: "*",
      usernameLower: `eq.${usernameLower}`,
      limit: "1",
    }),
    { headers: headers(apiKey), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** 按 id 查用户。GET /api/auth/me 用。没查到返回 null。 */
async function findUserById(id, baseUrl, apiKey) {
  if (!id) throw new Error("findUserById 缺少 id，已中止");

  const resp = await fetch(
    restUrl(baseUrl, "users", { select: "*", id: `eq.${id}`, limit: "1" }),
    { headers: headers(apiKey), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** 按 token 查会话。没查到返回 null（token 不存在 = 没登录/已退出）。 */
async function findSession(token, baseUrl, apiKey) {
  if (!token) throw new Error("findSession 缺少 token，已中止");

  const resp = await fetch(
    restUrl(baseUrl, "sessions", { select: "*", token: `eq.${token}`, limit: "1" }),
    { headers: headers(apiKey), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------- 写

/** 插一个新用户。row 的键就是驼峰列名。HTTP 201 = 成功。 */
async function insertUser(row, baseUrl, apiKey) {
  const resp = await fetch(restUrl(baseUrl, "users"), {
    method: "POST",
    headers: headers(apiKey, true),
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    // 唯一索引撞车时 PG 会回 409。把这句话单独认出来，接口层才能说人话
    if (resp.status === 409) throw new Error("账号名已被占用（唯一索引拦截）");
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
}

/** 插一条会话。 */
async function insertSession(row, baseUrl, apiKey) {
  const resp = await fetch(restUrl(baseUrl, "sessions"), {
    method: "POST",
    headers: headers(apiKey, true),
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
}

/**
 * 删一条会话（= 退出登录）。返回**真实删掉的行数**：
 * 0 表示这个 token 本来就不存在，接口据此如实回答，而不是假装成功。
 * ⚠️ token 为空直接抛错：绝不把条件为空的 DELETE 发给数据库。
 */
async function deleteSession(token, baseUrl, apiKey) {
  if (!token) throw new Error("deleteSession 缺少 token，已中止");

  const resp = await fetch(restUrl(baseUrl, "sessions", { token: `eq.${token}` }), {
    method: "DELETE",
    headers: { ...headers(apiKey), Prefer: "return=representation" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

/** 清掉某用户所有已过期的会话（登录时顺手打扫，表不会越积越脏）。 */
async function deleteExpiredSessions(userId, nowIso, baseUrl, apiKey) {
  if (!userId) throw new Error("deleteExpiredSessions 缺少 userId，已中止");

  const resp = await fetch(
    restUrl(baseUrl, "sessions", {
      userId: `eq.${userId}`,
      expiresAt: `lt.${nowIso}`,
    }),
    {
      method: "DELETE",
      headers: { ...headers(apiKey), Prefer: "return=representation" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );
  if (!resp.ok) throw new Error(`数据源返回 HTTP ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

module.exports = {
  findUserByUsernameLower,
  findUserById,
  findSession,
  insertUser,
  insertSession,
  deleteSession,
  deleteExpiredSessions,
};
