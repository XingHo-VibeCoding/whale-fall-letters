#!/usr/bin/env node
/**
 * tools/backup-pg.js —— 数据库逻辑备份（Day 31）
 *
 * 为什么需要它：
 *   CloudBase 的 PG 备份由底层腾讯云 PostgreSQL 提供，体验版/共享实例不一定能在
 *   控制台看到备份入口。而且——**备份只有在你试过恢复之后才算真的存在**。
 *   这个脚本干的是最朴素的一件事：把每张表的每一行抓下来，存成一个文件。
 *   它能救回来的场景：手滑 DELETE 了整张表、写错 SQL 把数据刷成一样、删了不该删的行。
 *
 * 用法：
 *   1. 去 CloudBase 控制台 → 云函数 → 任一个函数 → 函数配置 → 环境变量，
 *      把 PG_API_KEY 的值复制出来
 *   2. 在仓库根目录跑：
 *        PG_API_KEY=你的密钥 node tools/backup-pg.js
 *      （Windows PowerShell：$env:PG_API_KEY="你的密钥"; node tools/backup-pg.js）
 *   3. 文件会写到 backups/ 目录，文件名带时间戳
 *
 * ⚠️ backups/ 目录必须在 .gitignore 里 —— 里面有 passwordHash、salt、会话 token，
 *    绝不能进仓库。（.gitignore 已经加好了）
 *
 * ⚠️ 这个脚本读的是**原始数据**（含密码散列、会话 token），不是接口返回的公开形状。
 *    恢复时要用它，就得原样写回，所以不能裁剪字段。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 七张表，顺序有意义：恢复时必须先建被依赖的（books 在 notes 之前，users 在 posts/messages 之前）
const TABLES = ['users', 'books', 'notes', 'posts', 'comments', 'messages', 'sessions'];

const BASE = process.env.PG_API_BASE || 'https://reading-sea-d7gd8l7o78b7304ae.api.tcloudbasegateway.com';
const KEY = (process.env.PG_API_KEY || '').trim();
const OUT_DIR = path.join(__dirname, '..', 'backups');

// PostgREST 单次返回有上限，分页拉，免得表大了静默截断（静默截断是最坏的一种失败）
const PAGE = 1000;

async function fetchTable(table) {
  const rows = [];
  let offset = 0;

  for (;;) {
    const url = `${BASE}/v1/rdb/rest/${table}?select=*&limit=${PAGE}&offset=${offset}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      throw new Error(`${table} 拉取失败：HTTP ${resp.status} ${await resp.text().catch(() => '')}`);
    }
    const page = await resp.json();
    if (!Array.isArray(page)) throw new Error(`${table} 返回的不是数组`);
    rows.push(...page);
    if (page.length < PAGE) break;      // 不到一页 = 拉完了
    offset += PAGE;
  }
  return rows;
}

(async function main() {
  if (!KEY) {
    console.error('缺少 PG_API_KEY。用法：PG_API_KEY=你的密钥 node tools/backup-pg.js');
    console.error('密钥在 CloudBase 控制台 → 云函数 → 函数配置 → 环境变量 里复制。');
    process.exit(2);
  }

  const started = Date.now();
  const stamp = new Date(Date.now() + 8 * 3600 * 1000)  // 用北京时间命名，好找
    .toISOString()
    .replace(/[:T]/g, '-')
    .slice(0, 16);
  const outFile = path.join(OUT_DIR, `backup-${stamp}.json`);

  console.log('开始备份 → ' + outFile);
  console.log('基地址：' + BASE);

  const data = {};
  const summary = [];

  try {
    for (const t of TABLES) {
      const rows = await fetchTable(t);
      data[t] = rows;
      summary.push({ 表: t, 行数: rows.length });
      console.log(`  ${t.padEnd(10)} ${String(rows.length).padStart(5)} 行`);
    }
  } catch (err) {
    console.error('\n✗ 备份中断：' + err.message);
    console.error('已拉到的表不会写文件 —— 半份备份比没有更危险，会让你以为有。');
    process.exit(1);
  }

  const payload = {
    meta: {
      createdAt: new Date().toISOString(),
      createdAtBeijing: new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' +08',
      apiBase: BASE,
      tables: summary,
      // 别把密钥写进备份文件
    },
    data,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');

  const size = fs.statSync(outFile).size;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n✓ 备份完成：${(size / 1024).toFixed(1)} KB，耗时 ${secs}s`);
  console.log('  文件：' + outFile);
  console.log('\n⚠️ 这个文件里有 passwordHash、salt 和会话 token，别上传、别进仓库。');
  console.log('   建议另存一份到 U 盘或网盘 —— 和代码放同一个地方，等于没有备份。');
})();
