# api-contract.md —— 接口契约（第 3 周唯一仲裁物）

> **这是什么**：前后端之间的「合同」。后端（云函数）照这里实现，前端照这里调用。
> 任何路径、字段、响应形状的分歧，以本文档为准；要改先改这里，再改代码。
>
> **状态标记**：✅ 已实现 · 🕐 已登记占位，待实现（第 3 周 Day 16–20）
>
> 定稿：2026-10-13（Day 15）

---

## 1. 通用约定

### 1.1 基地址

**公网接口（前端 → 云函数），两个域名都指向同一套函数，任选其一：**

| 优先级 | 基地址 | 实测记录 |
|---|---|---|
| **首选** | `https://reading-sea-d7gd8l7o78b7304ae.service.tcloudbase.com` | Day 19 实测可用；**Day 22 的 PATCH / DELETE 真库闭环全程走它**（六个请求全 200） |
| 备用 | `https://reading-sea-d7gd8l7o78b7304ae-1385227197.ap-shanghai.app.tcloudbase.com` | 时好时坏：Day 19 上午报 `INVALID_ENV`，Day 20 下午复测恢复（books 返 200 真数据）；Day 22 未复测 |

> ⚠️ 网关只映射 `/api/books` 前缀（Day 22 实测）：其他路径（如 `/api/no-such-path`）在网关层就被拦下，
> 返回 `{"code":"INVALID_PATH"}`，**请求根本到不了函数**。排查时别把网关的 404 当成函数的 bug；
> 要探测函数是否活着，用 `GET /api/health`；要探测「函数 → 数据库」是否通，用 `GET /api/books`。
> ⚠️ **更正（Day 28 实测）**：`GET /api/books/:id`（查单本）**从未实现**，请求它会返回
> `{"ok":false,"error":"未知路径，本服务提供 GET/POST /api/books 与 PATCH/DELETE /api/books/:id"}`。
> 此前本文档和 `ROLLBACK.md` 都拿它当探针，是错的——真出事时照那句做，会得到「函数挂了」的误判。

> 前端 `community.js` 的 `API_DEMO_URL` 从 Day 20 起用的是首选（service）域名。

**数据 API（云函数 → 数据库），与上面不是一回事：**

| 用途 | 基地址 |
|---|---|
| PG HTTP API（PostgREST 风格，云函数内部调用） | `https://reading-sea-d7gd8l7o78b7304ae.api.tcloudbasegateway.com` |

> ⚠️ 更正（Day 17）：此前记录的域名把环境 ID 抄错了两处（小写 l 抄成 i、字母 b 抄成 6），
> 导致访问一直返回 INVALID_ENV，并被误判成「腾讯侧关闭了公网服务」。
> 环境服务器区分大小写（实测大写 I 返 421、小写 i 返 404），正确 ID 以本文件为准：
> `reading-sea-d7gd8l7o78b7304ae`。公网服务本身一直是通的，无需工单。

### 1.2 响应形状（所有接口统一）

**成功**——HTTP 200，body：

```json
{ "ok": true, "data": { } }
```

`data` 的内容按各接口定义，见下文。

**失败**——HTTP 200（网关层不区分状态码，业务错误放 body 里），body：

```json
{ "ok": false, "error": "<人能看懂的中文错误信息>" }
```

前端约定：**只看 `ok` 字段判断成败**，`error` 直接展示给用户。

### 1.3 其他约定

- 时间字段一律 ISO 8601 字符串（如 `2026-10-13T04:00:00.000Z`）
- 所有 id 由后端生成，前端不指定
- 阅读状态 `status` 全局只用三个值：`want`（想读）/ `reading`（在读）/ `finished`（已读）
- ⚠️ 私信「已读」与阅读「已读」（finished）是两码事，社区接口登记时用 `conv-read` 等词区分

---

## 2. 已实现接口

### ✅ 2.1 GET /api/health —— 健康检查

**用途**：证明「代码部署到 CloudBase 且公网可访问」，不连数据库、无业务逻辑。

**请求**：无参数

**响应 data**：

```json
{
  "ok": true,
  "service": "whale-fall-letters",
  "time": "<服务器当前时间 ISO 8601>"
}
```

**实现**：`cloud/functions/health/index.js`（Day 15）
**验证**：浏览器打开 `<基地址>/api/health`，核对 `service` 值与 `time` 是否为当前时间

---

## 3. 占位接口（Day 16–20 实现，今天只登记不实现）

### 数据模型（与前端 store.js 现有字段一致）

**book**：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 后端生成，`book-` 前缀 |
| title | string | 书名，必填 |
| author | string | 作者，可为空串 |
| coverUrl | string | 封面图地址（Google Books 源），可为空串 |
| status | string | `want` / `reading` / `finished` |
| totalPages | number \| null | 总页数，未填为 null |
| currentPage | number \| null | 当前页，未填为 null |
| startedAt | string \| null | 转入「在读」时的时间戳 |
| finishedAt | string \| null | 转入「已读」时的时间戳 |

**note**：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 后端生成，`note-` 前缀 |
| bookId | string | 所属书的 id |
| content | string | 笔记正文，非空 |
| page | number \| null | 页码，未填为 null |
| createdAt / updatedAt | string | ISO 8601 |

> 阅读进度百分比**不存储**，由前端按 `currentPage / totalPages` 实时计算（PRD 3.2）。

### ✅ 3.1 GET /api/books —— 书单列表

- 请求参数：无（本期单用户）；余力加练（Day 17）：可选 `?limit=N`，正整数、上限 100，不传 = 返回全部
- 响应 data：`{ "books": [ <book>, ... ] }`，按创建时间倒序
- 错误：无业务错误分支（limit 非法时返回 `{ok:false}` 的中文提示）
- 实现：`cloud/functions/books/index.js`（Day 17，HTTP 型云函数，经网关调 PG HTTP API 读真库，凭证走环境变量 PG_API_KEY）
- 验证（Day 17）：公网 200 返回 5 本真书；控制台把 book-002 的 currentPage 改 200 后刷新接口同步变化；线上页面 `#/api-demo` 显示真库数据

### 🕐 3.2 POST /api/books —— 新增书籍

- 请求 body：`{ "title", "author", "coverUrl", "status", "totalPages", "currentPage" }`
  - `title` 必填非空；`status` 缺省为 `want`；其余可空
- 响应 data：`{ "book": <book> }`（含后端生成的 id 和时间戳）
- 错误示例：`{ "ok": false, "error": "书名不能为空" }`

### ✅ 3.3 PATCH /api/books/:id —— 修改书籍（状态 / 进度 / 资料）

- 请求 body：要改的字段（部分更新），如 `{ "status": "reading", "currentPage": 42 }`
  - 只接受白名单字段：`title` / `author` / `coverUrl` / `status` / `totalPages` / `currentPage`；
    `id`、`createdAt` 等传入后**静默忽略**（主键与创建时间不归客户端决定）
  - 一个可改字段都没有时返回 `{ok:false}`「没有可修改的字段…」，不做空更新
  - `title` 传了必须非空；`status` 走三值白名单；页数必须非负整数，可传 `null` 清空
- 约定：`status` 变为 `reading` / `finished` 时由后端维护 `startedAt` / `finishedAt`
  （**只补空、不覆盖**：同一状态来回切不会刷掉第一次的时间）
- 响应 data：`{ "book": <book> }`（改后的完整对象）
- 错误示例：`"这本书不存在，可能已被删除"` / `"书 id 不能为空，正确写法：/api/books/book-001"`
- 实现：`cloud/functions/books/index.js` 的 `handlePatch` + `db.js` 的 `findBookById` / `updateBook`（Day 22）
- 验证（Day 22）：公网真库新建临时书 → PATCH `{"status":"reading","currentPage":42}`
  → `status` 由 `want` 变 `reading`、`currentPage` 由 `null` 变 `42`、`startedAt` 由 `null` 被自动补上；
  不存在 id / 空 body / 非法状态 / 空书名 / 负页码 / 空 id 六类输入均被拦下

### ✅ 3.4 DELETE /api/books/:id —— 删除书籍（Day 23 起改为软删除）

- 删除方式：**软删除**。只把 `books.is_deleted` 置为 `true`，行仍留在表里，删错了能找回
  - 找回办法：`UPDATE books SET "is_deleted" = FALSE WHERE "id" = '...'`（一句 SQL，不需要新增接口）
  - 接口侧三处查询（列表 / 查单本 / 查重）都带 `is_deleted = false` 过滤，被软删的书对外等于不存在
  - ⚠️ 部署顺序：**先**跑 `db/migration-20261020-soft-delete.sql` 加列，**再**部署新代码；反了会报 `column is_deleted does not exist`
- 笔记处理（Day 23 起）：**不再跟随删除，故意保留** —— "删错可找回"要完整，书一恢复笔记也都在
  - 与 Day 22 的「先删笔记、再删书」不同；PRD AC-10 的措辞已同步更改
- 响应 data：`{ "deletedBooks": 1, "deletedNotes": 0, "softDeleted": true }`
  - `deletedBooks` 是**真实影响行数**，不是写死的 1；重复删除返回 0 行，接口报错而不谎报成功
  - `deletedNotes` 保留字段以兼容旧调用，恒为 0（笔记不删）
- 错误示例：`"这本书不存在，可能已被删除"`
- 实现：`index.js` 的 `handleDelete` + `db.js` 的 `softDeleteBook`（Day 23）；硬删 `deleteBook` 保留但接口不再调用
- 验证：
  - Day 22（硬删时期）：公网真库删临时书 → `{deletedBooks:1, deletedNotes:0}`，随后 GET 列表由 6 本回到 5 本
  - Day 23 软删除回合（本地假数据源）：5 本 → 软删 1 本 → 列表变 4 本 → 重复删报"不存在" → 改已删的书报"不存在" → 同名书可重新添加 → 手工恢复后回到 6 本

### 🕐 3.5 GET /api/notes?bookId=xxx —— 某本书的笔记列表

- 请求参数：`bookId`（query string，必填）
- 响应 data：`{ "notes": [ <note>, ... ] }`，按创建时间倒序
- 错误示例：`"这本书不存在，可能已被删除"`

### 🕐 3.6 POST /api/notes —— 新增笔记

- 请求 body：`{ "bookId", "content", "page" }`
  - `bookId` 必须真实存在；`content` 必填非空；`page` 可空
- 响应 data：`{ "note": <note> }`
- 错误示例：`"笔记必须属于一本书"` / `"笔记内容不能为空"`

### 🕐 3.7 DELETE /api/notes/:id —— 删除笔记

- 响应 data：`{ "deletedNotes": 1 }`
- 错误示例：`"这条笔记不存在，可能已被删除"`

---

## 4. 明确不在本契约内（Day 15 时点）

- 社区/论坛/评论/私信接口 —— 做到社区层时再登记，避免提前设计返工
- 登录/用户接口 —— 第 3 周暂不涉及
- 跨域（CORS）配置 —— **Day 17 已提前在 HTTP 网关路由上启用**（实测有效）；
  函数内一律不再加跨域头：两边都加时网关会把两个值拼成 `域名,*` 一个头，
  浏览器直接拒绝（Failed to fetch）。跨域头全站只留网关一处
