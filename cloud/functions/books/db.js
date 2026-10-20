/**
 * db.js —— 数据访问层（Day 19 从 index.js 拆出）
 *
 * 这个文件只干一件事：和数据库说话。
 * 上层的 index.js（接口层）收请求、做校验，需要数据时调这里的函数；
 * 它不需要知道数据存在哪、怎么取的——哪天换存储方式，只改这个文件。
 *
 * ⚠️ 为什么不直连数据库：官方社区确认（Issue #953），HTTP 型云函数与
 *   云开发数据库之间不走内网、不支持 VPC，体验版也没有公网直连开关。
 *   所以走官方文档给的唯一通道 —— PostgreSQL 的 HTTP API（PostgREST 风格）：
 *     基地址  https://<envId>.api.tcloudbasegateway.com
 *     查表    GET  /v1/rdb/rest/books?select=*&order=createdAt.desc
 *     插入    POST /v1/rdb/rest/books   （body 就是要插入的那一行，HTTP 201 = 插入成功）
 *   好处：Node 20 自带 fetch 就能调，本函数零 npm 依赖，控制台部署不用装包。
 *
 * Day 19 分层约定：
 *   - 这里的函数【不做】输入校验——那是接口层（index.js）的职责，分层后各管各的；
 *   - 这里的函数【会】抛错——超时、数据源不可用都 throw，由接口层 catch 后
 *     转成人能看懂的中文返回（错误翻译成什么样，属于「和人说话」，不归这层管）。
 *
 * 凭证说明：baseUrl 和 apiKey 由调用方传进来（index.js 每次请求时从环境变量读）。
 * 密钥只放环境变量（AGENTS.md 五.3），绝不写进代码/仓库。
 *
 * 读表的铁律（Day 16 定）：books 表的列名是驼峰（createdAt 等），
 * PostgREST 会原样返回这些键；title/author 全小写无此问题。
 */

// 统一的请求超时：8 秒。数据源卡住时尽快抛错，
// 让上层给用户一个明确提示，而不是让请求干等到底。
const REQUEST_TIMEOUT_MS = 8000;

// 读：查 books 表，按创建时间倒序。limit 不传 = 返回全部。
// Day 23 余力（软删除）：只取 is_deleted = false 的行。
// 被"删掉"的书仍然躺在表里（is_deleted = true），所以这里必须过滤，
// 否则删过的书会重新出现在列表里 —— 那就等于没删。
async function fetchBooks(limit, baseUrl, apiKey) {
  const params = new URLSearchParams({
    select: "*",
    order: "createdAt.desc",
    is_deleted: "eq.false",
  });
  if (limit !== undefined) params.set("limit", String(limit));

  const resp = await fetch(`${baseUrl}/v1/rdb/rest/books?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  return resp.json(); // PostgREST 查询返回行对象数组
}

// 查重：把现有书的 title/author 拉回来逐条比对。
// 书单表很小（个位数到几十行），不值得为此造复杂查询；中文书名放 URL
// 参数里还要做编码，多一个坑，所以选「全拉回来在内存里比」。
// 口径（大帅拍板）：书名+作者都相同（trim 后）即算重复，其他字段不管——
// 同一本书补了封面再存也会被拒。
async function findDuplicate(title, author, baseUrl, apiKey) {
  // Day 23 余力：被软删的书不该挡住重新添加 —— 删过的书再添一遍是正常需求
  const params = new URLSearchParams({
    select: "id,title,author",
    is_deleted: "eq.false",
  });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/books?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  const rows = await resp.json();
  return rows.find(
    (r) => r.title.trim() === title && (r.author || "").trim() === author
  );
}

// 读单本（Day 22）：按 id 查一行，查不到返回 null。
// PATCH 之前必须先调它——「先确认这本书在不在」是今天的核心动作：
// 不查就改，改到 0 行也会被当成成功，用户以为改了、其实什么都没发生。
async function findBookById(id, baseUrl, apiKey) {
  // Day 23 余力：软删掉的书在接口层看来等于"不存在"，PATCH 不该还能改它
  const params = new URLSearchParams({
    select: "*",
    id: `eq.${id}`,
    is_deleted: "eq.false",
  });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/books?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  const rows = await resp.json(); // 形状是数组（PostgREST 永远返回数组）
  return rows[0] || null;
}

// 改（Day 22）：部分更新。patch 里只有要改的字段，没传的列数据库不动。
//   PATCH /v1/rdb/rest/books?id=eq.<id>
//   Prefer: return=representation  → 让数据源把「改后那一行」回给我们
// 不加这个头，PostgREST 默认返回 204 空响应，接口就没法把改后的结果给前端。
// 影响 0 行时它返回的是空数组 []，这里转成 null，让上层能分辨「没改到东西」。
async function updateBook(id, patch, baseUrl, apiKey) {
  const params = new URLSearchParams({ id: `eq.${id}` });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/books?${params}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  const rows = await resp.json();
  return rows[0] || null;
}

// 删笔记（Day 22）：把某本书名下的笔记全部删掉，返回真实删掉的条数。
// schema.sql 里没建物理外键，所以"删书连带删笔记"这条关系只能靠代码保证——
// 顺序必须是「先删笔记，再删书」；反过来先删书，笔记就成了找不到主人的
// 孤儿数据，而且再也查不出该删哪些。
// ⚠️ Day 23 起本函数【不再被 /api/books/:id 调用】：DELETE 改成了软删除，
//    笔记故意保留（书一恢复笔记也都在，见契约 3.4）。保留它是因为
//    "彻底清理某本书及其笔记"迟早要用（清测试数据、真删账号），安全阀继续有效。
async function deleteNotesByBookId(bookId, baseUrl, apiKey) {
  // ⚠️ 最后一道保险：没有 bookId 就不许发请求。
  // 条件为空 = 匹配整张笔记表，这一下会把所有书的笔记全删掉。
  if (!bookId) throw new Error("deleteNotesByBookId 缺少 bookId，已中止");

  const params = new URLSearchParams({ bookId: `eq.${bookId}` });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/notes?${params}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=representation", // 让数据源把删掉的行回给我们，条数才是真的
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  const rows = await resp.json();
  return rows.length; // 真实影响行数，不是猜的
}

// 软删除（Day 23 余力）：把 is_deleted 置为 true，行还在表里，删错了能捞回来。
// 为什么是 UPDATE 而不是 DELETE：DELETE 一走，书和它的阅读记录就真的没了，
// 接口层没有任何撤销手段；is_deleted 留个标记，一句 SQL 就能还原。
// 和硬删一样只认真实影响行数：0 行 = 没删到（可能本来就删过了），不能报成功。
// ⚠️ 条件里带 is_deleted=eq.false 有两层用处：
//    ① 对同一本书重复删除，第二次会返回 0 行，接口能如实报"这本书不存在"
//    ② 条件里永远同时有 id 和 is_deleted，绝不会退化成"无条件的整表更新"
async function softDeleteBook(id, baseUrl, apiKey) {
  if (!id) throw new Error("softDeleteBook 缺少 id，已中止");

  const params = new URLSearchParams({ id: `eq.${id}`, is_deleted: "eq.false" });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/books?${params}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation", // 回来的行数才是真的
    },
    body: JSON.stringify({ is_deleted: true }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  const rows = await resp.json();
  return rows.length;
}

// 硬删（Day 22）：按 id 精确删一行，返回真实删掉的行数（0 = 什么都没删到）。
// Day 23 余力起，/api/books/:id 的 DELETE 改走 softDeleteBook，这里不再被接口调用；
// 保留它是因为"彻底清理"迟早要用（比如清测试数据），底层的 id 空值保险继续有效。
async function deleteBook(id, baseUrl, apiKey) {
  if (!id) throw new Error("deleteBook 缺少 id，已中止");

  const params = new URLSearchParams({ id: `eq.${id}` });
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/books?${params}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Prefer: "return=representation",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
  const rows = await resp.json();
  return rows.length;
}

// 写：往 books 表插一行。row 就是要插入的行对象（键=驼峰列名），
// HTTP 201 Created = 插入成功（PostgREST 约定）。
async function insertBook(row, baseUrl, apiKey) {
  const resp = await fetch(`${baseUrl}/v1/rdb/rest/books`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`数据源返回 HTTP ${resp.status}`);
  }
}

module.exports = {
  fetchBooks,
  findDuplicate,
  findBookById,
  updateBook,
  insertBook,
  deleteNotesByBookId,
  softDeleteBook,
  deleteBook,
};
