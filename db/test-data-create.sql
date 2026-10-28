-- ============================================================
-- db/test-data-create.sql —— 造 5000 篇压测帖子（临时用，测完请删）
-- ------------------------------------------------------------
-- 为什么需要它：
--   库里现在只有 3 篇帖子。分页在 3 篇上是「看起来对」，
--   真正会出问题的边界（第 2 页有没有重复、最后一页 hasMore 对不对、
--   搜索几十条命中时翻页顺不顺）一条都测不出来。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，整段粘贴执行。
-- 跑完怎么删：执行 db/test-data-drop.sql（一条 DELETE，别手打）
--
-- ⚠️ 跑完这段时间线上论坛会多出 5000 篇「压测书 N」，用户能看见。
--    验证做完立刻跑 test-data-drop.sql，别留着过夜。
--
-- ⚠️ authorId 必须是一个真实存在的用户 id（有 NOT NULL 约束，且没建外键
--    但接口会拿它去 users 表查名字）。这里取 users 表里 id 最小的那个。
--    **先跑下面这条确认它不是空的**，空表会让整个 INSERT 失败：
--        SELECT "id" FROM users ORDER BY "id" LIMIT 1;
--
-- 数量：5000（想改就改 generate_series 的第二个参数，和下面的判断无关）
-- ============================================================

INSERT INTO posts ("id", "authorId", "title", "author", "coverUrl", "content", "createdAt", "is_deleted")
SELECT
  'post-load' || lpad(g::text, 5, '0'),                                  -- 统一的 id 前缀，方便一条 DELETE 精准清掉
  (SELECT "id" FROM users ORDER BY "id" LIMIT 1),
  '压测书 ' || g,
  '压测作者 ' || (g % 20),
  '',
  '这是第 ' || g || ' 篇压测帖子的正文，用来验证分页和搜索。'
    || CASE WHEN g % 50 = 0 THEN ' 关键词：星海鲸落' ELSE '' END,
  -- 时间格式必须跟现有数据一致（ISO 8601 带毫秒和 Z），
  -- 因为列表排序直接按这个字符串比大小，格式一乱顺序就错
  to_char(
    (now() AT TIME ZONE 'utc') - (g || ' seconds')::interval,
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ),
  FALSE
FROM generate_series(1, 5000) AS g;

-- 跑完自查：应该回 5000
SELECT count(*) AS "造出来的篇数" FROM posts WHERE "id" LIKE 'post-load%';
