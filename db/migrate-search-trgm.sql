-- ============================================================
-- db/migrate-search-trgm.sql —— 给论坛搜索加索引（Day 32）
-- ------------------------------------------------------------
-- 解决什么问题：
--   `GET /api/posts?q=词` 拼出来的是
--     title ILIKE '%词%' OR author ILIKE '%词%' OR content ILIKE '%词%'
--   **通配符在前面**，B-tree 索引完全用不上（B-tree 只能加速"从头匹配"）。
--   结果就是每搜一次都全表扫、逐行比对三个字段。5000 行时 3ms 能忍，
--   但代价随行数线性涨：5 万行 30ms、50 万行 300ms，再加上云函数和网关往返就超时了。
--
-- 为什么用 pg_trgm 而不是中文分词：
--   中文分词（zhparser / pg_jieba）要另装扩展，体验版基本不可能；
--   而且我们要的是"书名/正文**片段**匹配"，不是"关键词检索"。
--   pg_trgm 把字符串切成三元组建 GIN 索引，正好让 `ILIKE '%词%'` 能走索引，
--   不需要词典、不需要空格分词。
--
-- 怎么执行：CloudBase 控制台 → SQL 型数据库 → SQL 编辑器，**一条一条粘**。
--           （这个编辑器会把"选中的内容"整体执行，别把 DDL 和 INSERT 混在一起跑）
-- 能否重复跑：能。扩展和索引都带 IF NOT EXISTS。
--
-- ⚠️ 三条索引一条都不能少：
--   查询里是 `title OR author OR content`，Planner 要做 BitmapOr，
--   要求**每一列都有索引**。少一条，整个 OR 就退回全表扫，另外两条等于白建。
--
-- ⚠️ 建完必须 VACUUM (ANALYZE)：
--   统计信息不更新的话，Planner 还拿着旧数据判断"要不要走索引"。
-- ============================================================

-- ---------- 第 1 步：装扩展（需要一次权限，装完就一直在了） ----------
-- 先确认它能装（Day 32 实测体验版可以）：
--   SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'pg_trgm';
--   → pg_trgm | 1.6 | NULL      ← installed_version 为空 = 能装还没装
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- 第 2 步：三条 GIN 索引 ----------
-- gin_trgm_ops 是 pg_trgm 提供的操作符类，专门给 ILIKE/LIKE 的模糊匹配用
CREATE INDEX IF NOT EXISTS idx_posts_title_trgm   ON posts USING gin (title   gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_posts_author_trgm  ON posts USING gin (author  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_posts_content_trgm ON posts USING gin (content gin_trgm_ops);

-- ---------- 第 3 步：更新统计信息（否则 Planner 可能不选新索引） ----------
VACUUM (ANALYZE) posts;

-- ---------- 自查 ----------
-- 索引应该在列表里（连同原有的 authorid / createdat / pkey，一共 6 条）
SELECT indexname,
       pg_size_pretty(pg_relation_size((schemaname || '.' || indexname)::regclass)) AS "大小"
FROM pg_indexes
WHERE tablename = 'posts'
ORDER BY indexname;

-- ============================================================
-- Day 32 实测（5003 行数据，查一个零命中的词 —— 最坏情况）：
--
--   建索引前：Seq Scan on posts        Buffers hit=124   Execution 3.036 ms
--   建索引后：Bitmap Heap Scan + BitmapOr  Buffers hit=27   Execution 0.067 ms
--
--   扫描方式、读的数据页、执行时间三项都变了，其中执行时间快约 45 倍。
--   注意这个倍数会随数据量继续拉大：全表扫的成本线性涨，bitmap 扫只和命中的三元组有关。
--
-- 索引体积（5003 行）：
--   idx_posts_title_trgm    152 kB
--   idx_posts_content_trgm  152 kB
--   idx_posts_author_trgm    48 kB
--   合计约 350 kB —— 换来的是搜索不再随数据量线性变慢，划算。
--
-- ⚠️ 两个容易误判的地方：
--   1. 小表上建完索引，EXPLAIN 有可能**仍然显示 Seq Scan**。那不是索引没用，
--      而是整张表才一百多个数据页、全在内存里，优化器算完觉得顺序扫更便宜。
--      想单独验证索引本身的速度，用 `SET enable_seqscan = off;` 再 EXPLAIN 对比。
--   2. `VACUUM` **不会缩小索引文件**。删除大量行之后索引会"膨胀"
--      （Day 32 就出现过 idx_posts_createdat 涨到 872 kB），普通 VACUUM 只把空间
--      标记为可复用，文件大小不变。真要缩回去得 `REINDEX INDEX 索引名;`
--      或 `VACUUM FULL 表名;`（后者会锁表）。
-- ============================================================
