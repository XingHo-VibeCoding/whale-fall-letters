-- ============================================================
-- db/schema.sql —— 建表脚本（Day 16，PostgreSQL 版）
-- ------------------------------------------------------------
-- 方言说明：环境里的 SQL 型数据库是 PostgreSQL（控制台「SQL 型数据库 →
--   PostgreSQL 管理」）。初版按 MySQL 语法写，实测发现后改为 PG 语法。
-- 这是什么：把 Day 15 接口契约（docs/api-contract.md）里的
--   book / note 数据模型，落成两张真正的表。
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能。CREATE TABLE / CREATE INDEX 都带 IF NOT EXISTS，已存在就跳过。
-- 执行顺序：先本文件（建表），再 seed.sql（灌数据）。
-- 两表关联：notes.bookId → books.id（一条笔记属于一本书，多对一）。
-- 设计说明：不建物理外键（FOREIGN KEY），关联正确性由接口逻辑保证。
--   Day 23 起删书改为「软删除」（books.is_deleted 打标记），
--   笔记不再跟随删除、故意保留，删错的书只要把标记改回 false 就能连笔记一起回来。
-- ⚠️ PostgreSQL 铁律：带大写字母的列名（coverUrl / totalPages 等）必须用
--   双引号包住，不加引号 PG 会悄悄把它们转成全小写。本文件已处理好，照贴即可。
-- ============================================================

-- ---------- 表 1：books（书单表，一本书记录一行） ----------
CREATE TABLE IF NOT EXISTS books (
  "id"          VARCHAR(40)  NOT NULL,
  "title"       VARCHAR(200) NOT NULL,
  "author"      VARCHAR(100) NOT NULL DEFAULT '',
  "coverUrl"    VARCHAR(500) NOT NULL DEFAULT '',
  "status"      VARCHAR(10)  NOT NULL DEFAULT 'want',
  "totalPages"  INT          NULL,
  "currentPage" INT          NULL,
  "startedAt"   VARCHAR(40)  NULL,
  "finishedAt"  VARCHAR(40)  NULL,
  "createdAt"   VARCHAR(40)  NOT NULL,
  "is_deleted"  BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("id")
);

-- 字段注释（PG 的注释是单独的 COMMENT ON 语句，不像 MySQL 写在建表语句里）
COMMENT ON TABLE books IS '书单表：想读/在读/已读的书都记在这';
COMMENT ON COLUMN books."id" IS '书 id，后端生成，book- 前缀。选 VARCHAR 而非自增数字：契约规定 id 由后端生成且带前缀，字符串 id 也不暴露「这是第几条数据」';
COMMENT ON COLUMN books."title" IS '书名，必填。200 字符足够容纳正常书名';
COMMENT ON COLUMN books."author" IS '作者，可为空串';
COMMENT ON COLUMN books."coverUrl" IS '封面图地址（Google Books 源），可为空串。URL 可能很长，给 500';
COMMENT ON COLUMN books."status" IS '阅读状态：want 想读 / reading 在读 / finished 已读。全局只有这三个值（契约 1.3），与前端 store 一致';
COMMENT ON COLUMN books."totalPages" IS '总页数，未填为 NULL。选 INT 而非 VARCHAR：页数要参与进度计算（currentPage/totalPages）与排序，数字类型才能比大小';
COMMENT ON COLUMN books."currentPage" IS '当前读到第几页，未填为 NULL。进度百分比不存库，由前端实时算（PRD 3.2）';
COMMENT ON COLUMN books."startedAt" IS '转入「在读」时的时间戳。存 ISO 8601 字符串（契约 1.3），接口查出来直接返回，不用做时区/格式转换';
COMMENT ON COLUMN books."finishedAt" IS '转入「已读」时的时间戳，同上';
COMMENT ON COLUMN books."createdAt" IS '创建时间，ISO 8601 字符串。书单列表按它倒序（契约 3.1）';
COMMENT ON COLUMN books."is_deleted" IS '软删除标记（Day 23 余力）。false = 正常，true = 已被"删除"但行还在表里。接口查列表/查单本/查重都会带 is_deleted = false 过滤，所以被软删的书对外等于不存在；要找回只需把它改回 false。';

-- ---------- 表 2：notes（读书笔记表，一条笔记一行） ----------
CREATE TABLE IF NOT EXISTS notes (
  "id"        VARCHAR(40)  NOT NULL,
  "bookId"    VARCHAR(40)  NOT NULL,
  "content"   TEXT         NOT NULL,
  "page"      INT          NULL,
  "createdAt" VARCHAR(40)  NOT NULL,
  "updatedAt" VARCHAR(40)  NOT NULL,
  PRIMARY KEY ("id")
);

COMMENT ON TABLE notes IS '读书笔记表：靠 bookId 挂在书上，删书时连同笔记一起删（PRD AC-10）';
COMMENT ON COLUMN notes."id" IS '笔记 id，后端生成，note- 前缀。选 VARCHAR 理由同 books.id';
COMMENT ON COLUMN notes."bookId" IS '★ 关联字段：所属书的 id，指向 books.id。两张表全靠它关联';
COMMENT ON COLUMN notes."content" IS '笔记正文，非空。选 TEXT 而非 VARCHAR：笔记长短难预估，TEXT 不用猜上限（单值上限 1GB，足够）';
COMMENT ON COLUMN notes."page" IS '这条笔记对应的页码，未填为 NULL（有的笔记不针对具体页）';
COMMENT ON COLUMN notes."createdAt" IS '创建时间，ISO 8601 字符串。笔记列表按它倒序（契约 3.5）';
COMMENT ON COLUMN notes."updatedAt" IS '最后编辑时间，ISO 8601 字符串';

-- 索引：按书查笔记（GET /api/notes?bookId=xxx，Day 17）会频繁用到，避免全表扫描
CREATE INDEX IF NOT EXISTS idx_bookId ON notes ("bookId");
