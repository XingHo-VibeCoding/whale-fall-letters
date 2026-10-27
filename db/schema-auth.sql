-- ============================================================
-- db/schema-auth.sql —— 账号与会话建表脚本（Day 30 第一阶段）
-- ------------------------------------------------------------
-- 解决什么问题：
--   在它之前，「账号」是一段写死在 community.js 里的假数组（MOCK_USERS），
--   注册只往内存 push 一条、刷新就没，登录连密码都不校验。
--   这里把「用户」和「登录会话」落成两张真正的表。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能。CREATE TABLE / CREATE INDEX 都带 IF NOT EXISTS。
-- 执行顺序：本文件先跑，**再**部署 auth 云函数（顺序反了接口会报「表不存在」）。
--
-- ⚠️ PostgreSQL 铁律（Day 16 踩过）：带大写字母的列名必须用双引号包住，
--   不加引号 PG 会悄悄把它们转成全小写，之后接口按驼峰查就查不到。
--   本文件已处理好，照贴即可。
--
-- 设计说明：
--   ① 密码**绝不存明文**。存的是 scrypt 散列 + 每个用户独立的随机 salt。
--      散列不可逆，就算整张表泄露也拿不到原密码。
--   ② 账号名唯一性靠**数据库唯一索引**保证，不靠接口先查一次再插。
--      接口查重是「友好提示」，唯一索引才是「最后一道锁」——
--      两个请求同时注册同一个名字时，只有索引能挡住第二个。
--   ③ usernameLower 单独存一列，原意是"大小写不同算同一个账号"。
--      **Day 30 改了主意**：现在按 username 原文判重，大小写不同算两个账号。
--      这一列保留但不参与判重（见下面索引处的说明）。
--      要改成「区分大小写」的老库，跑 migrate-auth-case-sensitive.sql。
--   ④ 不建物理外键（与 books/notes 一致），关联正确性由接口逻辑保证。
--   ⑤ 会话单独一张表（方案 A）：登录后在 sessions 里能查到一条记录，
--      要踢人下线只要删那一行。代价是每次验 token 多一次查询。
-- ============================================================

-- ---------- 表 1：users（账号表，一个账号一行） ----------
CREATE TABLE IF NOT EXISTS users (
  "id"            VARCHAR(40)  NOT NULL,
  "username"      VARCHAR(40)  NOT NULL,
  "usernameLower" VARCHAR(40)  NOT NULL,
  "passwordHash"  TEXT         NOT NULL,
  "salt"          VARCHAR(64)  NOT NULL,
  "avatar"        TEXT         NOT NULL DEFAULT '',
  "bio"           TEXT         NOT NULL DEFAULT '',
  "createdAt"     VARCHAR(40)  NOT NULL,
  PRIMARY KEY ("id")
);

COMMENT ON TABLE users IS '账号表：注册的用户都在这。密码只存散列，不存明文';
COMMENT ON COLUMN users."id" IS '用户 id，后端生成，user- 前缀。选 VARCHAR 理由同 books.id：不暴露"这是第几个用户"';
COMMENT ON COLUMN users."username" IS '账号名，保留用户输入的原始大小写，用于显示（Alice 就显示 Alice）';
COMMENT ON COLUMN users."usernameLower" IS '账号名的小写形式。**只作记录，不参与判重和登录查询**（Day 30 改为区分大小写后失去唯一性职责）。保留这一列是为了以后要改回"大小写无关"时有现成数据可用';
COMMENT ON COLUMN users."passwordHash" IS '★ scrypt 散列后的密码（十六进制字符串）。散列不可逆，是单向的：只能"拿输入的密码重新算一遍再比对"，没有任何办法从它还原出原密码';
COMMENT ON COLUMN users."salt" IS '★ 每个用户独立的随机盐（32 位十六进制）。作用：两个用户密码都是 123456，散列结果也完全不同，防止"撞库"和彩虹表预计算';
COMMENT ON COLUMN users."avatar" IS '头像：色值（如 #1f6f6b）或图片 dataURL，空串表示用首字占位。选 TEXT 因为 dataURL 可能很长';
COMMENT ON COLUMN users."bio" IS '个人简介，可为空串';
COMMENT ON COLUMN users."createdAt" IS '注册时间，ISO 8601 字符串';

-- ★ 唯一索引：账号名的最后一道锁。
-- Day 30 改动：建在 **username 原文** 上（原来建在 usernameLower 上）。
-- 后果：ZJ122456 和 zj122456 是两个不同的账号，注册互不冲突；
--      登录也必须一字不差，大小写不同会得到「账号名或密码错误」。
-- 已有的库不能只重跑本文件（旧索引不会被删），要跑 migrate-auth-case-sensitive.sql。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users ("username");

-- ---------- 表 2：sessions（登录会话表，一次登录一行） ----------
CREATE TABLE IF NOT EXISTS sessions (
  "token"     VARCHAR(80)  NOT NULL,
  "userId"    VARCHAR(40)  NOT NULL,
  "createdAt" VARCHAR(40)  NOT NULL,
  "expiresAt" VARCHAR(40)  NOT NULL,
  PRIMARY KEY ("token")
);

COMMENT ON TABLE sessions IS '登录会话表：登录成功发一个 token，前端存起来，之后每次请求带着它证明"我是谁"。退出登录 = 删掉这一行';
COMMENT ON COLUMN sessions."token" IS '★ 会话凭证，64 位十六进制随机串（32 字节）。它就是"临时密码"：谁拿到它就能冒充这个用户，所以只在登录/注册那一次返回，不作日志、不进 URL';
COMMENT ON COLUMN sessions."userId" IS '★ 关联字段：属于哪个用户，指向 users.id';
COMMENT ON COLUMN sessions."createdAt" IS '登录时间，ISO 8601 字符串';
COMMENT ON COLUMN sessions."expiresAt" IS '过期时间，ISO 8601 字符串。过了这个点 token 作废，用户要重新登录（当前设 7 天）';

-- 索引：验 token 时要反查「这个用户还有哪些会话」（比如以后做"退出所有设备"），
-- 按 userId 查会频繁用到，避免全表扫描
CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions ("userId");
