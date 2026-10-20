# Day 23 ｜ 把裸报错翻成人话，先分清是哪一层在喊

> **日期**：2026-10-20（周二，第 4 周）
> **主题**：用户看不懂的报错，多半不是「出错」这件事的错，是我把内部术语直接递给了用户
> **当日提交**：Day 23 提交（hash 见 `git log`）

---

## 一、今日板块

| 板块 | 做了什么 | 状态 |
|---|---|---|
| ① 密钥排查（红线优先） | 宽口径扫词 64 条逐条判定，严口径扫值 0 条 | ✅ |
| ② `.env` 与忽略规则 | 六种变体实测被挡、造真 `.env` 撞规则、回查 41 个提交历史 | ✅ |
| ③ 三类错误提示统一 | 后端 `describeError()` 收口 5 处，前端拆网络/HTTP/业务三档 | ✅ |
| 余力① 请求日志补时间 | `beijingTime()`，日志带 `+08` | ✅ |
| 余力② 软删除 | `is_deleted` 列 + 迁移脚本 + 三处查询过滤 | ✅ |

今日不做：加异常处理框架（只加了一个 20 行的翻译函数，没引入中间件/错误码体系）、改业务逻辑（**软删除算越界，见第六节说明，是大帅批准的余力加练**）。

## 二、今日要掌握：你把哪句裸报错改成了人话？

**改前**：`数据源暂时不可用：fetch failed`
**改后**：`连不上数据源，请稍后重试`

这句来自 `index.js` 的 5 处 `fail(res, \`数据源暂时不可用：${err.message}\`)`。`err.message` 是 Node 的 `fetch` 在连不上时抛的英文，直接拼进返回体，用户拿到的是「数据源暂时不可用：fetch failed」——中文里夹一句英文，且没说下一步该怎么办。

前端还有一句更常见的：`接口暂时读不到：Failed to fetch（本地书单不受影响）`。`Failed to fetch` 是浏览器 `TypeError` 的原文，跨域被拒、断网、DNS 挂都会触发它。

**关键认识：不是「把英文翻成中文」这么简单。** 同一个 `fetch` 失败，背后有三种完全不同的原因，该让用户做的事也完全不同：

| 层 | 触发场景 | 浏览器给的原话 | 用户该做什么 |
|---|---|---|---|
| 网络层 | 请求根本没送出去 | `TypeError: Failed to fetch`（连状态码都没有） | 查网络、重试 |
| HTTP 层 | 送到了，对端回非 2xx | `HTTP 502` / `数据源返回 HTTP 503` | 等一会重试；地址配错了重试也没用 |
| 业务层 | 对端正常答话，说「不行」 | 后端给的中文（`limit 必须是正整数`） | 改输入 |

所以「统一」不是统一成一句「加载失败」——那等于把三种信息全丢掉。统一的是**格式和分寸**：每层说清是什么问题、用户能做什么。

**一条铁律**：原始异常只进 `log()` 和 `console`，**永远不进返回体**。用户看结论，我看堆栈。

## 三、实现要点

**后端 `index.js`（563 行）**
- 新增 `describeError(err)`，分三种说法：超时 / 带 HTTP 状态码 / 连不上，兜底一句「数据源暂时不可用，请稍后重试」
- 5 处调用点各变两行：`log(..., err.message)` + `fail(res, describeError(err))`
- 新增 `beijingTime()`：云函数容器默认 UTC，直接 `new Date()` 会少 8 小时，手动 +8 并在行尾标 `+08`

**数据层 `db.js`（227 行）**
- `fetchBooks` / `findBookById` / `findDuplicate` 三处都带 `is_deleted: "eq.false"`
- 新增 `softDeleteBook()`：PATCH 置 `is_deleted = true`，条件同时带 `id` 和 `is_deleted = false`，影响 0 行即失败
- 硬删 `deleteBook` 与 `deleteNotesByBookId` 保留但接口不再调用（彻底清理用）

**前端 `community.js`**
- 新增 `apiError(kind)` 造带类别标记的错误，`describeApiError(err)` 按 `kind` 分档
- `loadApiDemo` 重写：**先 `r.text()` 再 `JSON.parse`**。原来用 `r.json()`，网关返回 HTML 报错页时会抛 `Unexpected token '<' in JSON at position 0`，那句话既看不懂也指不出是谁的问题
- `catch` 里 `console.error` 打原始错误，页面只显示人话

## 四、验证证据

### 4.1 密钥排查

**宽口径（搜词）**：64 个已跟踪文件，命中 64 条 / 9 个文件。

| 类别 | 条数 | 命中长什么样 | 判定 |
|---|---|---|---|
| `.gitignore` 规则行 | 8 | `*secret*` `*.token` | 禁止牌本身 |
| `GIT-CHECKLIST.md` | 4 | `*.pem` `id_rsa` | 检查清单，列后缀名 |
| `journal/Day-02.md` | 3 | `git check-ignore -v .env` | 学习笔记 |
| `docs/COMMUNITY_DESIGN.md` | 4 | `passwordHash` | 设计文档字段名 |
| `docs/api-contract.md` | 1 | `PG_API_KEY` | 契约里的变量名 |
| `cloud/functions/books/*.js` | 41 | `fetchBooks(limit, baseUrl, apiKey)` | **变量名**，值从 env 读 |
| `community.js` + `index.html` | 3 | `byId('auth-password')` | 表单输入框 id |

定向证据：`apiKey` 全仓库只有一处赋值 `const apiKey = process.env.PG_API_KEY || ""`；20 位以上硬编码字面量只有一条，是按钮 id `btn-api-demo-refresh`；`postgres://` 连接串 0 条。

**严口径（搜值）**：`AKID[13+]｜eyJ[15+]｜-----BEGIN..PRIVATE KEY-----｜postgres://user:pass@｜Bearer[20+]｜sk-[20+]` → **0 条**。

**0 条必须证明不是正则写错**：拿同一套正则扫一份假密钥样本，**6 个全抓住**。没有这步，「0 条」和「搜索哑了」长得一模一样。

排除了「32 位以上十六进制」这个模式：命中 2 条，一条是 Day-06 记的 MD5、一条是 PNG 的二进制数据，假阳性太脏。

### 4.2 `.env` 与忽略规则

| 检查 | 结果 |
|---|---|
| `.env` / `.env.local` / `.env.production` / `.env.development.local` / `config.env` | 全部被挡 |
| `.env.example` | `.gitignore:9:!.env.example` 反向放行 |
| 造真 `.env` 后 `git status` | 看不见它 |
| `git status --ignored` | `!! .env` |
| 历史回查（41 个提交） | 从无 env 类文件入库 |

**反直觉的一条**：`.env` 其实是被第 10 行 `*.env` 挡住的，不是第 7 行那句 `.env`。因为 gitignore「最后命中的那条说了算」，而 `*` 能匹配空字符串。同理第 9 行 `!.env.example` 能生效，全靠它排在第 8 行 `.env.*` 后面——两行调换位置，模板就再也进不了仓库。

### 4.3 三类错误：改前改后（真跑，把 HEAD 的旧代码抠出来对跑）

```
改之前 ② 数据源回 503   -> {"ok":false,"error":"数据源暂时不可用：数据源返回 HTTP 503"}
改之前 ③ 数据源连不上   -> {"ok":false,"error":"数据源暂时不可用：fetch failed"}
改之后 ② 数据源回 503   -> {"ok":false,"error":"数据源暂时不可用（HTTP 503），请稍后重试"}
改之后 ③ 数据源连不上   -> {"ok":false,"error":"连不上数据源，请稍后重试"}
服务端日志              -> [books] 2026-10-20 15:24:53 +08 GET /api/books -> 500 | fetch failed
```

`fetch failed` 没消失，它从用户眼前挪进了日志。业务层那句 `limit 必须是正整数` 改前改后一字未动——**本来就合格的东西不该动**。

前端用真 `community.js` + 真 `index.html`（只替换 `fetch`）跑四场景：网络层「网络连不上服务器，请检查网络后重试」、HTTP 层「服务器暂时没响应（HTTP 502），请稍后重试」、业务层原样透传、对照组成功渲染。

### 4.4 软删除回合（本地假数据源）

5 本 → 软删 1 本 → 列表 4 本 → 重复删报「这本书不存在」→ 改已删的书报「这本书不存在」→ 同名书可重新添加 → 手工恢复后回到 6 本。

重复删除之所以会走到「不存在」，是因为软删条件里带了 `is_deleted = false`；**不会出现「删了两次，两次都报成功」**。

### 4.5 回归

`_ac_test` 78 项、`_d2d_test` 81 项、`_starsea_test` 43 项，**202 项全过**。

### 4.6 截图归档

| 文件 | 内容 |
|---|---|
| `journal/assets/Day-23-scan-zero.jpg` | Git Bash 里跑严口径扫描：64 个已跟踪文件、命中 0 条 |
| `journal/assets/Day-23-errors-1.jpg` | `report.html` 上半：后端改前改后 + 服务端日志 |
| `journal/assets/Day-23-errors-2.jpg` | `report.html` 下半：前端四场景（网络/HTTP/业务/对照组） |

`report.html` 不是手写的：`day23-verify/make-report.js` 把两套验证脚本真跑一遍，抓原始输出拼成页面。手写等于自己编答案。

## 五、⚠️ 上线前必须按顺序做

软删除改了表结构，顺序反了会让线上接口全挂：

1. 控制台 SQL 编辑器跑 `db/migration-20261020-soft-delete.sql`（加 `is_deleted` 列）
2. 再部署 books 函数的 `index.js` + `db.js`

反了会报 `column is_deleted does not exist`，检查台整页读不出数据。

原文写在这一处，是因为它的代价最大：**新代码查列表时会带 `is_deleted = false`，而这一列在第 1 步才存在。** 这类「代码先上、库后改」的事故，在任何项目里都算低级但高杀伤的一种。

## 六、诚实记账

- **越界了**：清单写「今日不做：改业务逻辑」，软删除动了数据模型和 DELETE 的语义。这是余力加练、大帅批准后做的，但确实与那句限制冲突，记在这里不粉饰。
- **契约与 PRD 已同步**：AC-10 保留用户能看见的承诺（书从列表消失、笔记不再出现在任何页面），把软删除放进括号。**AC 只管用户能看见什么，不替技术选型背书。**
- **没动的三处**：`TECH_DESIGN.md` 2.9、`store.js` 里的「级联删除」是**前端 localStorage 那层**，与这条链路无关，改错反而误导。
- **今日不动发现的**：`community.js` 登录是假登录（mock 只查账号名、不校验密码）。密码本身没落盘，不算泄露，但真后端必答。已记 BACKLOG。

## 七、待办

- 部署顺序第 1 步（跑迁移 SQL）未执行 —— 今天只改了仓库，没碰线上
- 登录 mock 不校验密码 —— 真后端接入时的必答题
- 前端删书按钮的二次确认弹窗仍未做（Day 22 遗留）
