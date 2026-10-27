-- ============================================================
-- db/schema-likes.sql —— 评论点赞表（Day 31）
-- ------------------------------------------------------------
-- 解决什么问题：
--   点赞记录一直存在浏览器本地（localStorage 的 reading:likes），
--   换个设备、换个浏览器就全没了 —— 而且别人看不到你点过赞，
--   界面上那个数字其实只有你自己在涨。
--
-- 怎么执行：CloudBase 控制台 → SQL 类型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能。
-- 执行顺序：本文件 → 部署 community 云函数。
--
-- ⚠️ PostgreSQL 铁律：带大写字母的列名必须用双引号包住。
--
-- 设计说明：
--   ① **复合主键 (userId, commentId)**，不另设自增 id。
--      好处：同一个人对同一条评论永远只可能有一行 —— 连点十下也只会有一行，
--      重复点赞在数据库层面就被挡住了，不靠代码判断。
--   ② 点赞数不存字段，**每次 COUNT 算**。
--      存个 likeCount 字段就得处理"删评论时要减、并发时要锁"，
--      而我们这个量级 COUNT 一次比维护计数器便宜得多。
--   ③ 不存 is_deleted：取消点赞就是删这一行，本来就没什么可留的。
-- ============================================================

CREATE TABLE IF NOT EXISTS comment_likes (
  "userId"    VARCHAR(40) NOT NULL,
  "commentId" VARCHAR(40) NOT NULL,
  "createdAt" VARCHAR(40) NOT NULL,
  PRIMARY KEY ("userId", "commentId")
);

COMMENT ON TABLE comment_likes IS '评论点赞表：谁给哪条评论点了赞。一条记录一行，取消点赞就是删掉这行';
COMMENT ON COLUMN comment_likes."userId" IS '★ 点赞的人，指向 users.id。只认 token，不接受前端传入';
COMMENT ON COLUMN comment_likes."commentId" IS '★ 被点赞的评论，指向 comments.id';
COMMENT ON COLUMN comment_likes."createdAt" IS '点赞时间，ISO 8601 字符串。目前不展示，留着以后做"最近点赞"';

-- 索引：算某条评论的点赞数时按 commentId 查（详情页每渲染一次就要用）
CREATE INDEX IF NOT EXISTS idx_comment_likes_commentId ON comment_likes ("commentId");
