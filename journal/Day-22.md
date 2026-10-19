# Day 22 ｜ 增删改查闭环：删除为什么比新增更容易出事

> **日期**：2026-10-19（周一，第 4 周）
> **主题**：删除比新增更容易出事——所以确认必须加在代码里，而不是加在嘴上
> **当日提交**：Day 22 提交（hash 见 `git log`）

---

## 一、今日板块

| 板块 | 做了什么 | 状态 |
|---|---|---|
| ① PATCH | `PATCH /api/books/:id` 部分更新，含字段白名单、先查后改、自动补时间戳 | ✅ |
| ② DELETE | `DELETE /api/books/:id`，先删笔记再删书，返回真实影响行数 | ✅ |
| ③ 闭环验证 | 公网真库跑「增→查→改→复核→删→再查」，四类操作打通 | ✅ |

今日不做（守住）：批量操作、用户系统 —— 都没碰。

## 二、今日要掌握：删除为什么比新增更容易出事？

一句话：**新增是加法，删除是减法，而接口层没有撤销键。**

- 新增错了，最坏是多一条垃圾数据，删掉就完事；
- 删除错了，数据直接消失，没有任何「撤销」按钮能按。

所以「确认」不是弹个窗问一句「确定吗」，而是三条**写进代码**的硬约束：

| 层 | 做法 | 防的是什么 |
|---|---|---|
| ① 不盲删 | 先 `findBookById`，查不到直接报「这本书不存在」 | 删了 0 行还回报成功 |
| ② 精确删 | id 为空 / 含斜杠 / 超长 / 编码坏 → 接口层就停，**不发请求**；`db.js` 里再兜一遍 | 空条件 = 匹配整张表 = 整表清空 |
| ③ 认真实结果 | `deletedBooks === 0` 就当失败 | 谎报成功 |

第 ② 条是今天最值钱的一条。SQL 的 `DELETE FROM books` 后面不加条件会删光全表，而「条件为空」这件事在代码里往往只是一次字符串拼接的疏忽——所以删除类接口的第一道门必须是**解析不出 id 就不许发请求**。

级联顺序也有讲究：**先删笔记、再删书**。反过来先删书，笔记的 `bookId` 就指向了一条不存在的记录，成了孤儿数据，靠 `bookId` 再也找不回该删哪些。`schema.sql` 里没建物理外键，这条关系全靠代码守。

## 三、实现要点

**数据层 `db.js`（178 行）**
- 新增 `findBookById` / `updateBook` / `deleteNotesByBookId` / `deleteBook`
- 后两个删除函数第一行就是 `if (!id) throw`，最后一道保险

**接口层 `index.js`（527 行）**
- `matchBookId()`：从 `/api/books/<id>` 取 id，空 id、斜杠、超 40 字符、编码坏一律 `{error}`
- `validatePatch()`：只收白名单 6 个字段，`id`/`createdAt` 静默忽略；一个可改字段都没有就报错，不做空更新
- `handlePatch()` / `handleDelete()`：先查存在 → 再动手 → 只认数据源返回的真实行数

PATCH 的时间戳约定：`status` 变 `reading` 补 `startedAt`、变 `finished` 补 `finishedAt`，**只补空不覆盖**——同一状态来回切不该刷掉第一次的开始时间。

## 四、验证证据

### 4.1 公网真库闭环（走 `service.tcloudbase.com` 网关）

靶子用**新建的临时书** `book-mvfbqbt112lbsx`（《Day22 验证专用 · 海上书简》），不动 5 本真书：

| 步骤 | 结果 |
|---|---|
| 新增前 GET | 5 本 |
| POST 新增 | 6 本，临时书在列表里 |
| PATCH `{"status":"reading","currentPage":42}` | `status` want→reading、`currentPage` null→42、`startedAt` null→自动补 |
| 删除后 GET | **5 本，临时书已消失** |
| DELETE 响应 | `{"deletedBooks":1,"deletedNotes":0}` |

`deletedNotes` 是 0 而不是 1 —— 因为临时书刚建、名下本来就没有笔记，**这个 0 是对的，不是 bug**。真库里没做「补一条笔记再删」这步，以免碰真实笔记数据；级联另在本地假数据源上验（4.2）。

截图对照页：`day22-verify/report.html`（改前/改后逐字段 + 删除后完整列表）。

### 4.2 本地验级联删除

假数据源种子与 `db/seed.sql` 一致，`book-003` 名下 2 条笔记、`book-002` 名下 1 条：

```
DELETE book-003 → {"deletedBooks":1,"deletedNotes":2}
book-003 的笔记 2 → 0
book-002 的笔记 1 → 1（未受波及）
```

### 4.3 异常输入拦截

| 接口 | 输入 | 返回 |
|---|---|---|
| PATCH | 不存在的 id | 这本书不存在，可能已被删除 |
| PATCH | `{}` | 没有可修改的字段… |
| PATCH | `{"status":"done"}` | 阅读状态只能是 want、reading 或 finished |
| PATCH | `/api/books/` | 书 id 不能为空… |
| PATCH | `{"id":"book-hack"}` | 没有可修改的字段（主键改不动） |
| PATCH | `{"title":"  "}` | 书名不能为空 |
| PATCH | `{"currentPage":-1}` | 当前页码必须是非负整数 |
| DELETE | 重复删同一条 | 这本书不存在，可能已被删除 |
| DELETE | `/api/books/` | 书 id 不能为空… |
| DELETE | `/api/books/a/b` | 书 id 格式不对，不应该包含斜杠 |

### 4.4 部署验证（一个坑）

原打算用 `/api/no-such-path` 探针确认新代码上线，结果网关先拦了：
`{"code":"INVALID_PATH"}` —— 网关只映射 `/api/books` 前缀，别的路径到不了函数。
改用 `GET /api/books/book-001`，返回新文案「本服务提供 GET/POST /api/books 与 PATCH/DELETE /api/books/:id」，
这才证明新代码生效。教训：**探针必须走网关已映射的路径，否则测的是网关不是函数**。

## 五、完成标准逐条对照

| 完成标准 | 状态 | 证据 |
|---|---|---|
| PATCH 修改一条数据生效 | ✅ | 真库临时书 status want→reading、currentPage null→42（4.1） |
| DELETE 删除后 GET 不再返回 | ✅ | 列表 6→5 本，临时书 id 已不在（4.1） |
| 增删改查四类操作闭环 | ✅ | 增→查→改→复核→删→再查，六个请求全 200 |
| 今日不做：批量操作 / 用户系统 | ✅ 守住了 | 未新增任何批量接口，未动用户相关代码 |
| 余力加练：软删除（is_deleted） | ⏳ 未做 | 需 `ALTER TABLE` 加列 + 改 GET/PATCH 过滤条件；今天先把硬删闭环拿到，软删除记为待办 |
| 截图两张 | ⏳ 待归档 | 对照页已生成 `day22-verify/report.html`；图片待存入 `journal/assets/` |

## 六、改动文件清单与归属

| 文件 | 归属 |
|---|---|
| `cloud/functions/books/db.js`（改，124→178 行） | Day 19 建 → **Day 22 扩容**（+4 函数） |
| `cloud/functions/books/index.js`（改，457→527 行） | Day 17 建 → **Day 22 扩容**（PATCH/DELETE 路由） |
| `docs/api-contract.md`（改，3.3/3.4 标 ✅ + 补实现与验证） | Day 15 定稿 → **Day 22 更新** |
| `journal/Day-22.md`（新，本文件） | **Day 22** |

验证脚本与报文（`day22-verify/` 下的 `mock-pg.js`、`live-e2e.sh`、`summarize.js`、`report.html`、`e2e-*.json`）在**仓库外**的工作区根目录，不进仓库。

## 七、今日学到的

1. **删除的三层保护**：先查存在 → 只按 id 精确删（id 空就停）→ 认真实影响行数。缺一层都可能出事故。
2. **空条件最危险**：`if (!id)` 这种判断看着像防御性编程的多余动作，在删除接口里是保命的那一行。
3. **级联顺序**：先删子表再删主表；反了就成孤儿数据。
4. **部分更新（PATCH）的核心是白名单**：不是「把 body 全塞进 UPDATE」，而是「只挑允许改的字段」。
5. **验证要看独立证据**：PATCH 的返回说改成了什么，不等于库里真是那个值——所以改完要重新 GET 一次。
6. **探针要打到对的地方**：网关映射之外的路径测不到函数，只会得到网关的 404。

## 八、待办

- [ ] 两张截图存入 `journal/assets/`（`Day-22-after-patch.*`、`Day-22-after-delete.*`）并回填本文
- [ ] 软删除（`is_deleted`）：加列 + 查询过滤 + 删错了能找回
- [ ] 前端删书按钮的二次确认弹窗（今天只做了接口层的确认）
- [ ] （跨天）`journal/Day-11.md` ~ `Day-21.md` 仍缺，补不补等定
