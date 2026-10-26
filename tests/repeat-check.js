#!/usr/bin/env node
/* ============================================================================
 * repeat-check.js —— 核心流程重复检测（Day 28 结营验收，附录 J 板块②）
 *
 * 要回答的问题
 *   附录 J 原话：「完整走两遍『写入 → 刷新 → 持久化 → 修改 → 删除』，
 *   两遍结果一致 = 可重复完成；只成功一遍 = 还不算能交付。」
 *
 * 这个脚本怎么做到「真」
 *   - 用的是仓库里真的 store.js，不复制、不改写
 *   - localStorage 是自己实现的（内存表），但**实例活在两轮刷新之间**
 *   - 「刷新页面」= 丢掉整个 JS 运行环境（VM 上下文），只把 localStorage 的内容留下来，
 *     再重新加载一次 store.js。这跟浏览器 F5 的语义一致：
 *     JS 内存清空、localStorage 留下。
 *
 * 它测不到什么（诚实说清）
 *   - 不做 DOM 渲染，所以测不了「列表里立刻出现」这种界面反馈
 *     （那部分由 _ac_test.js 的 78 条断言覆盖，但那个脚本不在仓库里）
 *   - 不联网，测不了数据库那条链（接口层的两遍闭环在
 *     docs/repeat-test-2026-10-23.md 里有实测记录）
 *
 * 为什么两轮不能字节级对比
 *   id 是 前缀_时间戳+随机串，时间戳是 new Date()。两轮必然不同。
 *   所以比的是**行为等价**：每步的成功/失败、字段取值、刷新后可见性、
 *   以及最终存储内容在「把 id 与时间戳抹掉之后」是否完全相同。
 *
 * 用法
 *   node tests/repeat-check.js            # 跑两轮，退出码 0=两轮全通且一致
 *   node tests/repeat-check.js --verbose  # 额外打印每一步之后的存储内容
 * ========================================================================== */

'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const ROUNDS = 2;

/* ------------------------------------------------------ 一、真 localStorage */

/**
 * 内存版 localStorage。要点：它**不随刷新销毁** —— boot() 每次新建 VM 上下文，
 * 但传进去的永远是同一个 storage 实例。
 */
function createStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    /* 只给本脚本用：导出便于比对的快照 */
    _snapshot() {
      const out = {};
      for (const k of Array.from(map.keys()).sort()) out[k] = map.get(k);
      return out;
    }
  };
}

/* ------------------------------------------------ 二、「刷新」= 重建上下文 */

/**
 * 加载一次 store.js。
 * 每次调用都是一个全新的 VM 上下文 —— 上一轮的 Store 实例、内存变量全部丢失，
 * 只有传进来的 storage 带着数据活下来。这就是「刷新」。
 */
function boot(storage) {
  const ctx = {};
  ctx.window = ctx;          // store.js 结尾是 })(window);
  ctx.localStorage = storage;
  ctx.console = console;
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(REPO, 'store.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'store.js' });
  if (!ctx.Store) throw new Error('store.js 没有导出 Store，检查结尾的 })(window)');
  return ctx.Store;
}

/* ------------------------------------------------------------ 三、断言工具 */

const steps = [];          // 跨轮汇总：[{round, no, name, pass, detail}]
let currentRound = 0;

function check(name, pass, detail) {
  steps.push({ round: currentRound, no: steps.filter(s => s.round === currentRound).length + 1,
               name, pass: !!pass, detail: detail || '' });
  const mark = pass ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? '  —— ' + detail : ''}`);
  return !!pass;
}

/** 抹掉会自然变化的部分：id 与时间戳。 */
function normalize(v) {
  return JSON.stringify(v, null, 1)
    .replace(/"id": "[^"]+"/g, '"id": "<ID>"')
    .replace(/"bookId": "[^"]+"/g, '"bookId": "<ID>"')
    .replace(/"[a-zA-Z]+At": "[^"]+"/g, '"<TS>": "<ISO>"')
    .replace(/<TS>/g, '"<AT>"')      // 让 startedAt/finishedAt/createdAt 归一成同一个键
    .replace(/_<AT>/g, '')
    .replace(/"book_<ID>"/g, '"<ID>"');
}

/* ---------------------------------------------------- 四、跑一轮核心流程 */

/**
 * 一轮 = 写入 → 刷新 → 持久化校验 → 修改 → 刷新 → 删除 → 刷新 → 确认清空。
 * 全程只用两样东西：Store 的公开方法、以及「刷新」这个动作。
 */
function runRound(storage, round) {
  currentRound = round;
  const title = '重复检测·第 ' + round + ' 轮';

  // —— 1. 写入
  let Store = boot(storage);                        // 干净打开
  const before = Store.listBooks();
  const add = Store.addBook({ title, author: '张三' });
  check('写入：addBook 成功', add.ok, add.ok ? ('id=' + add.data.id) : add.error);
  const bookId = add.ok ? add.data.id : null;
  check('写入：列表由 ' + before.data.length + ' 本变为 1 本',
        Store.listBooks().data.length === 1);

  // —— 2. 刷新（丢掉内存，保留 localStorage）
  Store = boot(storage);
  let got = Store.getBook(bookId);
  check('刷新后：这本书还在', got.ok && got.data.title === title,
        got.ok ? ('status=' + got.data.status) : got.error);
  check('刷新后：状态默认是 want', got.ok && got.data.status === 'want');

  // —— 3. 修改（状态 + 进度，验 startedAt 自动补）
  const upd = Store.updateBook(bookId, { status: 'reading', currentPage: 42, totalPages: 320 });
  check('修改：updateBook 成功', upd.ok, upd.ok ? '' : upd.error);
  check('修改：startedAt 被自动补上', upd.ok && !!upd.data.startedAt);

  // —— 4. 刷新后再验（这一步才是「持久化」的实证）
  Store = boot(storage);
  got = Store.getBook(bookId);
  check('刷新后：修改生效', got.ok && got.data.status === 'reading' && got.data.currentPage === 42,
        got.ok ? (got.data.currentPage + ' / ' + got.data.totalPages) : got.error);
  check('刷新后：startedAt 仍在', got.ok && !!got.data.startedAt);

  // —— 5. 写一条笔记，为删除时的级联准备证据
  const note = Store.addNote({ bookId, content: '重复检测笔记' });
  check('写入：addNote 成功', note.ok, note.ok ? '' : note.error);

  // —— 6. 删除（连同笔记）
  const del = Store.deleteBook(bookId);
  check('删除：deleteBook 成功', del.ok, del.ok ? ('连带删笔记 ' + del.data.deletedNotes + ' 条') : del.error);
  check('删除：连带删掉 1 条笔记', del.ok && del.data.deletedNotes === 1);

  // —— 7. 刷新后确认干净
  Store = boot(storage);
  // ⚠️ 语义坑（Day 28 踩过）：store.getBook 找不到时返回 【ok:true + data:null】，
  //    不是 ok:false。后端接口 /api/books/:id 那条链反过来，用的是 ok:false + error。
  //    同一个「书不存在」，前后端两套表达 —— 断言写错就会误报成 bug。
  const missing = Store.getBook(bookId);
  check('刷新后：书已消失（getBook 返回 ok:true + data:null）',
        missing.ok === true && missing.data === null,
        'ok=' + missing.ok + ' data=' + JSON.stringify(missing.data));
  check('刷新后：列表回到 0 本', Store.listBooks().data.length === 0);
  check('刷新后：笔记也清了', Store.listNotes(bookId).data.length === 0);

  // —— 8. 拍一张最终存储快照（给跨轮比对用）
  return { snapshot: normalize(storage._snapshot()), store: Store };
}

/* ------------------------------------------------------------ 五、主流程 */

function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  鲸落书简 · 核心流程重复检测（附录 J 板块②）');
  console.log('  真 store.js ｜ 真 localStorage 语义 ｜ 「刷新」= 重建 VM 上下文');
  console.log('══════════════════════════════════════════════════════════════');

  const results = [];
  for (let r = 1; r <= ROUNDS; r++) {
    console.log('');
    console.log(`── 第 ${r} 轮 ─────────────────────────────────────────────`);
    const storage = createStorage();          // 每轮从空存储开始，两轮条件完全相同
    const res = runRound(storage, r);
    results.push(res);
    if (VERBOSE) console.log('    存储快照：', res.snapshot);
  }

  /* ---- 跨轮一致性 ---- */
  console.log('');
  console.log('── 两轮一致性比对 ────────────────────────────────────────');

  const byRound = [1, 2].map(r => steps.filter(s => s.round === r));
  const n1 = byRound[0].length, n2 = byRound[1].length;
  const sameCount = check('两轮步骤数相同', n1 === n2, `${n1} vs ${n2}`);

  let diff = 0;
  const max = Math.min(n1, n2);
  for (let i = 0; i < max; i++) {
    const a = byRound[0][i], b = byRound[1][i];
    if (a.name !== b.name || a.pass !== b.pass) {
      diff++;
      console.log(`    ✗ 第 ${i + 1} 步不一致：`);
      console.log(`        轮1 ${a.pass ? '✓' : '✗'} ${a.name}`);
      console.log(`        轮2 ${b.pass ? '✓' : '✗'} ${b.name}`);
    }
  }
  const sameSteps = check('每一步的成败完全一致', diff === 0, diff ? `${diff} 步不一致` : '0 步差异');
  const sameFinal = check('最终存储状态等价（抹掉 id 与时间戳后）',
                          results[0].snapshot === results[1].snapshot);

  const allPass = steps.every(s => s.pass);
  const total = steps.length;
  const failed = steps.filter(s => !s.pass).length;

  console.log('');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`  共 ${total} 个断言 ｜ 通过 ${total - failed} ｜ 失败 ${failed}`);
  console.log(`  跨轮一致：${sameCount && sameSteps && sameFinal ? '是（可重复完成）' : '否（不算能交付）'}`);
  const ok = allPass && sameCount && sameSteps && sameFinal;
  console.log(`  结论：${ok ? '✓ 两轮结果一致，核心流程可重复完成' : '✗ 两轮存在差异或断言失败，不算能交付'}`);
  console.log('──────────────────────────────────────────────────────────────');
  console.log('');
  process.exit(ok ? 0 : 1);
}

main();
