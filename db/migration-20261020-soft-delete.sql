-- ============================================================
-- db/migration-20261020-soft-delete.sql
-- Day 23 余力：给 books 表加软删除标记
-- ------------------------------------------------------------
-- 为什么单独一个文件：schema.sql 用的是 CREATE TABLE IF NOT EXISTS，
--   表已经存在时它整段跳过，新加的那列【不会】被补到老表上。
--   所以已经建过表的库，必须跑这个 ALTER。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能。ADD COLUMN IF NOT EXISTS，已存在就跳过。
--
-- ⚠️⚠️ 执行顺序（反了会让线上接口全挂）：
--   1. 先在控制台跑完这段 SQL
--   2. 再去函数编辑器部署新版 books 代码
--   理由：新代码查列表时会带 is_deleted = false 这个条件，
--   而列的建立发生在第 1 步。第 1 步没做就部署新代码，
--   PostgreSQL 会报「column is_deleted does not exist」，
--   检查台页面整个读不出数据。
-- ============================================================

ALTER TABLE books
  ADD COLUMN IF NOT EXISTS "is_deleted" BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN books."is_deleted" IS
  '软删除标记（Day 23 余力）。false = 正常，true = 已被"删除"但行还在表里。接口查列表/查单本/查重都会带 is_deleted = false 过滤，所以被软删的书对外等于不存在；要找回只需把它改回 false。';

-- ---------- 怎么"找回"一本被删错的书（手工执行） ----------
--   -- 先看看有哪些被删掉的（这一步不受接口的过滤影响，能看到全部）
--   SELECT "id", "title", "createdAt" FROM books WHERE "is_deleted" = TRUE;
--
--   -- 把某一本捞回来
--   UPDATE books SET "is_deleted" = FALSE WHERE "id" = 'book-003';
--
--   笔记没有跟着删（软删除只动 books），所以书一回来，笔记也都在。
