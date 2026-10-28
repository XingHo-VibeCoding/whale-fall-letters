-- ============================================================
-- db/schema-backups.sql —— 备份快照表（Day 32）
-- ------------------------------------------------------------
-- 解决什么问题：
--   CloudBase 体验版（共享集群）**不提供任何平台备份** ——
--   控制台「平台管理 → 备份」里写的是「当前共享集群暂不提供相关能力」。
--   也就是说在那之前，一句手滑的 `DELETE FROM posts;` 就是永久损失。
--
-- 这张表干什么：
--   每天由 GitHub Actions 定时调一次 `POST /api/backup/run`，
--   云函数把 8 张业务表整份导成 JSON 塞进这里一行。
--   出事之后用 tools/restore-pg.js 把某一份写回去。
--
-- ⚠️ 它防得住 / 防不住：
--   ✅ 手滑删表、UPDATE 忘加 WHERE、代码 bug 批量写坏数据
--   ❌ 整个库没了（环境欠费回收、误删实例）—— 备份和原数据住在同一个库，
--      库没了它一起没。要防这个得把备份搬到库外，那是另一个方案。
--
-- ⚠️ payload 里含 passwordHash / salt / session token，
--   是**完整的原始数据**，不是接口返回的公开形状。
--   所以：这张表只能由云函数内部读写，**不要给它开任何对外读接口**；
--   恢复走本地脚本（tools/restore-pg.js），从控制台或本机连库跑。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能，带 IF NOT EXISTS。
-- ============================================================

CREATE TABLE IF NOT EXISTS backups (
  "id"         VARCHAR(40)  NOT NULL,
  "label"      VARCHAR(40)  NOT NULL,   -- 快照标识，形如 20261028-0200；同一天重跑会先删掉旧的
  "payload"    TEXT         NOT NULL,   -- 8 张表的全量 JSON
  "tableCount" INTEGER      NOT NULL DEFAULT 0,
  "rowCount"   INTEGER      NOT NULL DEFAULT 0,
  "sizeBytes"  INTEGER      NOT NULL DEFAULT 0,
  "createdAt"  VARCHAR(40)  NOT NULL,
  "is_deleted" BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("id")
);

COMMENT ON TABLE backups IS '备份快照：每天一份全库 JSON。体验版没有平台备份，这是唯一的一道保险';
COMMENT ON COLUMN backups."id" IS '快照 id，bak- 前缀';
COMMENT ON COLUMN backups."label" IS '★ 快照标识（年月日-时分）。同 label 唯一，重跑时先删旧的，不会堆成好几份';
COMMENT ON COLUMN backups."payload" IS '★ 八张表全量 JSON。含 passwordHash / salt / token，绝不能经任何接口对外露出';
COMMENT ON COLUMN backups."tableCount" IS '备份了几张表（正常是 8）';
COMMENT ON COLUMN backups."rowCount" IS '总行数，用来快速判断这份快照是不是空的/残缺的';
COMMENT ON COLUMN backups."sizeBytes" IS 'payload 的字节数';
COMMENT ON COLUMN backups."createdAt" IS '生成时间，ISO 8601 字符串。保留策略按它倒序取';
COMMENT ON COLUMN backups."is_deleted" IS '软删除标记，与其他表一致';

-- 索引：列快照列表、按时间取最新 N 份，都走这条
CREATE INDEX IF NOT EXISTS idx_backups_createdAt ON backups ("createdAt");

-- 索引：判断"同一天有没有备过"时按 label 查
CREATE INDEX IF NOT EXISTS idx_backups_label ON backups ("label");
