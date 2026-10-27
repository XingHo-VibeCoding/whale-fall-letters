-- ============================================================
-- db/migrate-books-userid.sql —— 书单归属到人（Day 31）
-- ------------------------------------------------------------
-- 解决什么问题：
--   在这之前，books 表**没有 userId** —— 云上那份书单是全局共享的。
--   谁登录都看到同一批书，A 加的书 B 也看得见、还能删。
--   这个文件给每本书加上「属于谁」。
--
-- ⚠️ 执行顺序铁律：**先跑本文件，再部署 books 云函数**。
--   反了会这样：新函数按 userId 查书，而老数据那列还是空串 →
--   你会看到「书单突然空了」。数据没丢，只是查不出来。
--   补救办法：跑完本文件、再部署一次函数，书就回来了。
--
-- 能否重复跑：能（ADD COLUMN IF NOT EXISTS + 带条件的 UPDATE）。
-- ============================================================

-- 1. 加列。先给一个空串默认值，是为了老数据能顺利加上（NOT NULL 必须有默认值）
ALTER TABLE books ADD COLUMN IF NOT EXISTS "userId" VARCHAR(40) NOT NULL DEFAULT '';

COMMENT ON COLUMN books."userId" IS '★ 这本书属于谁，指向 users.id。加了这一列之后，书单不再是全局共享的：每个账号只看得到自己的书。空串 = 迁移前的历史数据，需要下面第 3 步归属';

-- 2. 索引：每次列表/查重都要按 userId 过滤，没索引会全表扫
CREATE INDEX IF NOT EXISTS idx_books_userId ON books ("userId");

-- 3. ★ 把历史数据归属给一个账号。
--    迁移前所有书都没有主人（userId = ''），它们其实是同一个人加进来的。
--    改成你自己的用户 id 才能继续用。
--
--    不知道自己的 id？有两种查法：
--      a) 页面上随便发一条评论，然后运行（把我的名字换掉）：
--         curl "https://reading-sea-d7gd8l7o78b7304ae.service.tcloudbase.com/api/posts/post-mvqf7wnt515vlo"
--         —— 返回的评论里每个 authorName 后面的 authorId 就是
--      b) 或者直接问运营（我）：从库里读出来告诉你
--
--    ⚠️ 下面这条 UPDATE 默认已经填好了你自己的 id（user-mvqda6ksmkmkmn = ZJ122456）。
--       如果你想归给别的账号，改掉它再执行。
UPDATE books
SET "userId" = 'user-mvqda6ksmkmkmn'
WHERE "userId" = '';

-- 4. 核对：每本书都应该有主人了（owner 列不该有空串）
SELECT "id", "title", "userId", "is_deleted"
FROM books
ORDER BY "createdAt" DESC;
