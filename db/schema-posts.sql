-- ============================================================
-- db/schema-posts.sql —— 帖子与评论建表脚本（Day 30 第二阶段）
-- ------------------------------------------------------------
-- 解决什么问题：
--   在它之前，论坛的帖子和评论全写在 community.js 的 MOCK_POSTS 常量里 ——
--   那是代码里的三篇假文章，刷新页面就恢复原样，你发的评论别人永远看不到，
--   因为**它从来没离开过你的浏览器内存**。
--   这里把「帖子」和「评论」落成两张真正的表，配合账号（users）就能做到
--   「我发的评论，换台设备/换个人也看得到」。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 能否重复跑：能。全部带 IF NOT EXISTS。
-- 执行顺序：本文件 → 跑 seed-posts.sql（可选，灌几篇初始帖）→ 部署 community 云函数。
--
-- ⚠️ PostgreSQL 铁律：带大写字母的列名必须用双引号包住，照贴即可。
--
-- 字段命名说明（容易混，特意写清）：
--   posts."authorId"   = **发帖的人**，指向 users.id
--   posts."author"     = **这本书的作者**，比如"刘慈欣"。名字沿用了前端
--                        MOCK_POSTS 的老字段（那边就是这么叫的），改掉会牵动前端一堆代码。
--   posts."title"      = **书名**，不是帖子标题。论坛的帖子都是"关于某本书的读后感"，
--                        所以帖子没有自己的标题，它的标题就是书名。
--
-- 设计说明：
--   ① 不建物理外键（与 books/notes 一致），关联正确性由接口逻辑保证。
--   ② 软删除：is_deleted 打标记而不是真删，删错了能捞回来（沿用 Day 23 的做法）。
--   ③ 评论挂在帖子下（comments.postId），删帖时**连带软删**该帖所有评论 ——
--      和书单那里"删书先删笔记"是同一套逻辑，但这里连删都一起软删，
--      因为评论离了帖子单独存在没有意义。
-- ============================================================

-- ---------- 表 1：posts（帖子表，一篇读后感一行） ----------
CREATE TABLE IF NOT EXISTS posts (
  "id"         VARCHAR(40)  NOT NULL,
  "authorId"   VARCHAR(40)  NOT NULL,
  "title"      VARCHAR(200) NOT NULL,
  "author"     VARCHAR(100) NOT NULL DEFAULT '',
  "coverUrl"   VARCHAR(500) NOT NULL DEFAULT '',
  "content"    TEXT         NOT NULL,
  "createdAt"  VARCHAR(40)  NOT NULL,
  "is_deleted" BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("id")
);

COMMENT ON TABLE posts IS '帖子表：一篇"关于某本书的读后感"。论坛首页列表就是这张表按 createdAt 倒序';
COMMENT ON COLUMN posts."id" IS '帖子 id，后端生成，post- 前缀';
COMMENT ON COLUMN posts."authorId" IS '★ 发帖人，指向 users.id。有了它，"这篇是我写的吗"才判得出来（能不能删、能不能编辑）';
COMMENT ON COLUMN posts."title" IS '书名（不是帖子标题）。论坛的帖子都是"关于某本书"，所以书名即标题';
COMMENT ON COLUMN posts."author" IS '这本书的作者，比如"刘慈欣"。注意别和 authorId 混：authorId 是发帖的人，author 是写书的人';
COMMENT ON COLUMN posts."coverUrl" IS '书的封面图地址，可为空串';
COMMENT ON COLUMN posts."content" IS '帖子正文（读后感）。选 TEXT，长短不预设';
COMMENT ON COLUMN posts."createdAt" IS '发帖时间，ISO 8601 字符串。列表按它倒序';
COMMENT ON COLUMN posts."is_deleted" IS '软删除标记。false = 正常，true = 已删除但行还在，接口查询一律带 is_deleted = false 过滤';

-- 索引：查"某个人发的所有帖子"（我的页聚合）会频繁用到
CREATE INDEX IF NOT EXISTS idx_posts_authorId ON posts ("authorId");
-- 索引：列表按时间倒序，数据多了之后避免每次全表排序
CREATE INDEX IF NOT EXISTS idx_posts_createdAt ON posts ("createdAt");

-- ---------- 表 2：comments（评论表，一条评论一行） ----------
CREATE TABLE IF NOT EXISTS comments (
  "id"         VARCHAR(40)  NOT NULL,
  "postId"     VARCHAR(40)  NOT NULL,
  "authorId"   VARCHAR(40)  NOT NULL,
  "content"    TEXT         NOT NULL,
  "createdAt"  VARCHAR(40)  NOT NULL,
  "is_deleted" BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY ("id")
);

COMMENT ON TABLE comments IS '评论表：一条评论一行。这张表存在，才谈得上"我发的评论别人也能看到"';
COMMENT ON COLUMN comments."id" IS '评论 id，后端生成，comment- 前缀';
COMMENT ON COLUMN comments."postId" IS '★ 关联字段：属于哪篇帖子，指向 posts.id。查详情页时按它捞评论';
COMMENT ON COLUMN comments."authorId" IS '★ 评论人，指向 users.id。要显示"谁说的"，拿它去 users 表查用户名';
COMMENT ON COLUMN comments."content" IS '评论正文';
COMMENT ON COLUMN comments."createdAt" IS '评论时间，ISO 8601 字符串。同一帖内按它正序（先发的在上面）';
COMMENT ON COLUMN comments."is_deleted" IS '软删除标记，用法同 posts.is_deleted';

-- 索引：详情页按帖子查评论（每次打开帖子都要用）
CREATE INDEX IF NOT EXISTS idx_comments_postId ON comments ("postId");
