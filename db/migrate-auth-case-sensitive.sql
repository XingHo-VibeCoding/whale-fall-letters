-- ============================================================
-- db/migrate-auth-case-sensitive.sql —— 账号名改为「区分大小写」（Day 30）
-- ------------------------------------------------------------
-- 为什么要这个文件：
--   原来的唯一索引建在 usernameLower 上，所以 Alice / alice / ALICE 算同一个账号。
--   现在改成：按 username 原文判重，大小写不同就是两个不同的账号。
--
--   ⚠️ 已经建好的库**不能靠重跑 schema-auth.sql 来改** ——
--      那个文件里全是 CREATE ... IF NOT EXISTS，旧索引不会被删掉，
--      于是两个索引同时存在，注册 zj122456 仍然会被旧索引挡住。
--      所以必须显式 DROP 旧的、CREATE 新的，就是本文件干的事。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能。DROP IF EXISTS + CREATE IF NOT EXISTS。
-- 执行顺序：本文件 → **再重新部署 auth 云函数**。
--   顺序反了会出这种事：函数按原文查用户（查不到 zj122456），
--   但旧索引还在挡（插入被 409 拒）—— 表现为"查重说不重复、插入又说重复"。
--
-- ⚠️ 前提检查：如果库里**已经**存在两个只差大小写的账号（比如 Alice 和 alice），
--   新索引会建失败（唯一冲突）。跑之前先查一下：
--     SELECT lower("username"), count(*) FROM users GROUP BY 1 HAVING count(*) > 1;
--   返回空 = 可以直接跑。返回了行 = 先把重复的其中一个改名或删掉。
-- ============================================================

-- 1. 拆掉旧的「大小写无关」唯一索引
DROP INDEX IF EXISTS idx_users_username_lower;

-- 2. 建新的「大小写敏感」唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users ("username");

COMMENT ON COLUMN users."usernameLower" IS '账号名的小写形式。**只作记录，不参与判重和登录查询**（Day 30 改为区分大小写后失去唯一性职责）';

-- 3. 核对：应该只剩 idx_users_username 一条唯一索引
--    （results 里看到 idx_users_username 且没有 idx_users_username_lower 就是成功）
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'users';
