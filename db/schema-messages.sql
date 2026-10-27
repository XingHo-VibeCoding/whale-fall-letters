-- ============================================================
-- db/schema-messages.sql —— 私信建表脚本（Day 30 第三阶段）
-- ------------------------------------------------------------
-- 解决什么问题：
--   在它之前，私信全写在 community.js 的 MOCK_CONVERSATIONS 常量里 ——
--   两段假对话，'小林'和'月白'两个不存在的人。你发给他们的消息只 push 进内存，
--   刷新就没了，对方更是永远收不到。
--   这里把「消息」落成一张真正的表。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能。
-- 执行顺序：本文件 → 部署 community 云函数（新增了 /api/messages 接口）→ 网关加 /api/messages 路由。
--
-- ⚠️ PostgreSQL 铁律：带大写字母的列名必须用双引号包住，照贴即可。
--
-- 设计说明（这几条是权衡过的，不是随手定的）：
--   ① **不建 conversations 表**。
--      两个人之间的对话 = 这两人的消息集合。会话是"算出来的"，不是"存出来的"。
--      好处：不会出现「会话表说有一百条、消息表实际五条」这种不一致。
--      代价：查会话列表要扫一遍跟自己有关的消息（当前量级无所谓，有索引兜着）。
--   ② 一条消息一行，fromId / toId 都是 users.id。
--   ③ **已读用 readAt 时间戳**，不用布尔值。
--      unread 是"相对谁"而言的 —— 同一条消息，收件人看是未读，发件人看是自己发的。
--      存 readAt = 什么时候读的，既表达了未读（NULL），又留下了"何时读的"这个信息，
--      而且天然只有收件人那侧会被填。
--   ④ 软删除沿用 is_deleted，与 books / posts 一致。
-- ============================================================

CREATE TABLE IF NOT EXISTS messages (
  "id"        VARCHAR(40) NOT NULL,
  "fromId"    VARCHAR(40) NOT NULL,
  "toId"      VARCHAR(40) NOT NULL,
  "content"   TEXT        NOT NULL,
  "createdAt" VARCHAR(40) NOT NULL,
  "readAt"    VARCHAR(40) NULL,
  "is_deleted" BOOLEAN    NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("id")
);

COMMENT ON TABLE messages IS '私信表：一条消息一行。两人之间的"会话"由这两人的消息推导出来，不单独建表';
COMMENT ON COLUMN messages."id" IS '消息 id，后端生成，msg- 前缀';
COMMENT ON COLUMN messages."fromId" IS '★ 发件人，指向 users.id。谁发的只能由 token 决定，不接受前端传入（否则能冒充任何人）';
COMMENT ON COLUMN messages."toId" IS '★ 收件人，指向 users.id。发消息时校验：不能发给自己、对方必须真实存在';
COMMENT ON COLUMN messages."content" IS '消息正文';
COMMENT ON COLUMN messages."createdAt" IS '发送时间，ISO 8601 字符串。会话内按它正序（早的在上）';
COMMENT ON COLUMN messages."readAt" IS '★ 收件人读到它的时间，NULL = 未读。用时间戳而不是布尔值：既表达未读，又留下何时读的痕迹，而且只有收件人那侧会被填';
COMMENT ON COLUMN messages."is_deleted" IS '软删除标记，用法同 posts.is_deleted';

-- 索引：查"我参与的所有消息"（会话列表）会同时用到这两个方向
CREATE INDEX IF NOT EXISTS idx_messages_fromId ON messages ("fromId");
CREATE INDEX IF NOT EXISTS idx_messages_toId ON messages ("toId");
-- 索引：判断未读数时要按收件人 + 未读筛
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages ("toId", "readAt");
