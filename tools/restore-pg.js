#!/usr/bin/env node
/**
 * tools/restore-pg.js —— 从备份文件恢复数据（Day 31）
 *
 * 配合 tools/backup-pg.js 用。备份是「把每张表抓下来」，这个是「把抓下来的写回去」。
 *
 * ⚠️ 为什么不用业务接口（POST /api/books）恢复：
 *    业务接口会**重新生成 id**。书 id 一变，挂在它下面的笔记（notes.bookId）
 *    就全部失联 —— 数据看起来回来了，实际是断的。
 *    只有原样写回（连 id 一起），才算真的恢复。
 *
 * 用法：
 *   # 只看会写什么，不真写（推荐先跑这个）
 *   PG_API_KEY=xxx node tools/restore-pg.js --file backups/backup-xxx.json --table books --dry-run
 *
 *   # 恢复某一张表的全部行
 *   PG_API_KEY=xxx node tools/restore-pg.js --file backups/backup-xxx.json --table books
 *
 *   # 只恢复某一条（演练用）
 *   PG_API_KEY=xxx node tools/restore-pg.js --file backups/backup-xxx.json --table books --id book-xxx
 *
 *   # 恢复全部七张表（整库灾难重建，会按依赖顺序写）
 *   PG_API_KEY=xxx node tools/restore-pg.js --file backups/backup-xxx.json --all
 *
 * 参数：
 *   --file <路径>   备份文件；不传就取 backups/ 里最新的一份
 *   --table <表名>  只处理这张表
 *   --id <行的id>   只处理这一行（需要同时给 --table）
 *   --all           七张表全恢复（按依赖顺序）
 *   --dry-run       只打印，不写入
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.PG_API_BASE || 'https://reading-sea-d7gd8l7o78b7304ae.api.tcloudbasegateway.com';
const KEY = (process.env.PG_API_KEY || '').trim();
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

// 写回顺序（被依赖的先写）：人 → 书 → 笔记 → 帖子 → 评论 → 私信 → 会话
const ORDER = ['users', 'books', 'notes', 'posts', 'comments', 'messages', 'sessions'];

function parseArgs(argv) {
  const o = { all: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--table') o.table = argv[++i];
    else if (a === '--id') o.id = argv[++i];
  }
  return o;
}

function latestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^backup-.*\.json$/.test(f))
    .sort();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

async function postOne(table, row) {
  const resp = await fetch(`${BASE}/v1/rdb/rest/${table}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // 409 = 这行已经存在。恢复时遇到它不是失败，是"不用恢复"
    if (resp.status === 409) return { skipped: true, reason: '已存在（409）' };
    throw new Error(`HTTP ${resp.status} ${text.slice(0, 160)}`);
  }
  return { ok: true };
}

(async function main() {
  const o = parseArgs(process.argv.slice(2));

  if (!KEY) {
    console.error('缺少 PG_API_KEY。用法见文件头注释。');
    process.exit(2);
  }
  if (!o.all && !o.table) {
    console.error('要指定 --table <表名>，或者用 --all 恢复全部。');
    console.error('七张表：' + ORDER.join(' / '));
    process.exit(2);
  }

  const file = o.file || latestBackup();
  if (!file || !fs.existsSync(file)) {
    console.error('找不到备份文件：' + (file || '(backups/ 里没有)'));
    process.exit(2);
  }

  console.log('备份文件：' + file);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('备份时间：' + (backup.meta && backup.meta.createdAtBeijing) + '\n');

  const tables = o.all ? ORDER : [o.table];

  // 先算出要写多少行，让操作者看清楚再动手
  const plan = [];
  for (const t of tables) {
    let rows = (backup.data && backup.data[t]) || [];
    if (!Array.isArray(rows)) rows = [];
    if (o.id) rows = rows.filter((r) => r && (r.id === o.id || r.token === o.id));
    plan.push({ table: t, rows });
  }

  console.log('将要写入：');
  for (const p of plan) console.log(`  ${p.table.padEnd(10)} ${String(p.rows.length).padStart(4)} 行`);

  if (o.id && plan.every((p) => p.rows.length === 0)) {
    console.error('\n✗ 备份里找不到 id = ' + o.id + ' 的行。检查一下 id 拼写，或换一份备份。');
    process.exit(1);
  }

  if (o.dryRun) {
    console.log('\n(--dry-run：只预览，什么都没写)');
    return;
  }

  console.log('\n开始写入…\n');
  let total = 0, skipped = 0, failed = 0;

  for (const p of plan) {
    for (const row of p.rows) {
      try {
        const r = await postOne(p.table, row);
        if (r.skipped) { skipped++; console.log(`  · ${p.table} ${row.id || row.token} 跳过（${r.reason}）`); }
        else { total++; console.log(`  ✓ ${p.table} ${row.id || row.token}`); }
      } catch (err) {
        failed++;
        console.log(`  ✗ ${p.table} ${row.id || row.token} 失败：${err.message}`);
      }
    }
  }

  console.log(`\n写入 ${total} 行，跳过 ${skipped} 行，失败 ${failed} 行。`);
  if (failed) {
    console.log('⚠️ 有失败。注意写回顺序（users 要在 posts 之前），别只看总数。');
    process.exit(1);
  }
})();
