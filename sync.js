/* ============================================================================
 * sync.js —— 书单与云端的同步层（数据互通第一步，v0：只读）
 *
 * 依据
 *   docs/PLAN-data-sync.md（方案 A：本地优先 + 后台同步）
 *   docs/api-contract.md 3.1（GET /api/books）
 *
 * 为什么要单独一个文件
 *   store.js 是同步的，app.js 有 15 处同步调用。把 fetch 塞进 store.js 会把
 *   那 15 处全变成异步。所以分成两层：store.js 继续管本地（离线缓存），
 *   本文件管云端（真相），app.js 一行不用改。
 *
 * 本版（v1）能做四件事：
 *   1. fetchAll()      —— 从云端拉全量书单
 *   2. readLocalBooks()—— 读本地那份（只读，不写）
 *   3. diff()/needsMigrate() —— 判断本地和云端差多少、要不要先迁移
 *   4. migrateLocal()  —— 首次迁移：**先下载备份**，再把本地书逐条推到云端，
 *                         最后拉全量回写本地缓存（通过 Store.replaceBooks）
 *
 * 本版**仍然不做**（留到下一步）：
 *   - 写路径（pushAdd / pushUpdate / pushDelete，即日常增删改的实时同步）
 *   - 接线（任何页面都还没引用本文件）
 *
 * 使用：
 *   <script src="store.js"></script>
 *   <script src="sync.js"></script>
 *   window.Sync.enable();          // 默认关闭，必须显式开
 *   window.Sync.fetchAll().then(...)
 *
 * 约定：保持 ES5 写法（与 store.js / app.js 一致），不用 ES Module，
 *       这样双击 index.html（file://）也能跑。
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ 常量 */

  // 存储键必须和 store.js 完全一致，否则读不到同一份数据
  var KEY_BOOKS = 'reading:books';
  var KEY_NOTES = 'reading:notes';

  // Day 31：书单归属到人之后，同步请求必须带登录凭证。
  // 这个键与 community.js 用的是同一个（reading:token），登录一次两边通用。
  var KEY_TOKEN = 'reading:token';

  function readToken() {
    try { return global.localStorage.getItem(KEY_TOKEN) || ''; } catch (e) { return ''; }
  }

  // ★ Day 31：多账号共用一台机器的记账本
  //   reading:uid          —— 现在这台浏览器是谁在用（community.js 登录时写）
  //   reading:books-owner  —— 本地这份书单和笔记是替谁缓存的（这里写）
  // 两个不一样 = 换人了 = 必须先清本地，否则 B 会看到 A 的书。
  var KEY_UID = 'reading:uid';
  var KEY_OWNER = 'reading:books-owner';

  function readUid() {
    try { return global.localStorage.getItem(KEY_UID) || ''; } catch (e) { return ''; }
  }
  function readOwner() {
    try { return global.localStorage.getItem(KEY_OWNER) || ''; } catch (e) { return ''; }
  }
  function writeOwner(id) {
    try { global.localStorage.setItem(KEY_OWNER, id); return true; } catch (e) { return false; }
  }

  // 接口基地址。允许外部覆盖，方便本地联调和以后换域名。
  // 注意用 service 域名：带地域段的那个时好时坏（Day 19/20 记录）。
  var API_BASE = typeof global.__SYNC_API_BASE__ === 'string' && global.__SYNC_API_BASE__
    ? global.__SYNC_API_BASE__
    : 'https://reading-sea-d7gd8l7o78b7304ae.service.tcloudbase.com';

  // 默认关闭。理由：v0 还没接线，开着也没用；更重要的是——
  // 谁打开它谁就要为「第一次拉取会覆盖本地缓存」负责，不该是悄悄发生的。
  var enabled = false;

  /* -------------------------------------------------------------- 开关 */

  function isEnabled() { return enabled; }
  function enable() { enabled = true; return true; }
  function disable() { enabled = false; return false; }

  /* ---------------------------------------------------------- 错误包装 */

  /**
   * 统一的错误对象。kind 用来区分「网络不通」和「服务端说不行」，
   * 两者给用户的提示完全不同（AC-23：出错不能白屏，也不能说错原因）。
   */
  function apiError(kind, message, status) {
    var e = new Error(message || '接口调用失败');
    e.kind = kind;                 // 'network' | 'http' | 'parse' | 'business' | 'off'
    e.status = status || 0;
    return e;
  }

  function describeApiError(err) {
    if (!err) return '未知错误';
    if (err.kind === 'off') return '同步未开启';
    if (err.kind === 'network') return '连不上服务器，请检查网络后重试';
    if (err.kind === 'parse') return '服务器返回的内容看不懂，可能网关出错了';
    if (err.kind === 'http') return '服务器返回 ' + err.status + '，请稍后重试';
    return err.message || '未知错误';
  }

  /* -------------------------------------------------------------- 请求 */

  /**
   * 发一个请求，返回 Promise<{ ok, data }>（与 api-contract 的响应形状一致）。
   *
   * 为什么先取 text 再 JSON.parse：
   *   网关出错时回的是 HTML 错误页，直接 r.json() 会抛
   *   「Unexpected token '<'」——既看不懂，也指不出是谁的问题。
   *   community.js 的接口检查台踩过这个坑（Day 20）。
   */
  function request(method, path, body) {
    if (!enabled) return Promise.reject(apiError('off', '同步未开启'));

    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    // ★ 每个请求都带上登录凭证：书单是按人隔离的，服务端靠它判断"你是谁"
    var token = readToken();
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;

    return fetch(API_BASE + path, opts)
      .then(function (r) {
        return r.text().then(function (text) {
          return { httpStatus: r.status, text: text };
        });
      })
      .then(function (res) {
        if (res.httpStatus < 200 || res.httpStatus >= 300) {
          throw apiError('http', '', res.httpStatus);
        }
        var parsed;
        try {
          parsed = JSON.parse(res.text);
        } catch (e) {
          throw apiError('parse', '返回内容不是 JSON');
        }
        // 业务失败：HTTP 200 + ok:false（后端 send() 固定 writeHead(200)）
        if (parsed && parsed.ok === false) {
          throw apiError('business', parsed.error || '服务端拒绝了这次请求', 200);
        }
        return parsed;
      }, function (netErr) {
        throw apiError('network', netErr && netErr.message);
      });
  }

  /* ---------------------------------------------------- 读云端 / 读本地 */

  /** 拉云端全量。返回 book 数组（按契约，data.books 是数组）。 */
  function fetchAll() {
    return request('GET', '/api/books').then(function (res) {
      var books = res && res.data && res.data.books;
      if (!books || Object.prototype.toString.call(books) !== '[object Array]') {
        throw apiError('parse', '返回里没有 books 数组');
      }
      return books;
    });
  }

  /**
   * 拉云端全部笔记（Day 31）。
   * 不带 bookId 时后端返回「我的所有笔记」——因为笔记挂在书上，书属于谁笔记就属于谁。
   */
  function fetchAllNotes() {
    return request('GET', '/api/notes').then(function (res) {
      var notes = res && res.data && res.data.notes;
      if (!notes || Object.prototype.toString.call(notes) !== '[object Array]') {
        throw apiError('parse', '返回里没有 notes 数组');
      }
      return notes;
    });
  }

  /**
   * 读本地那份（只读）。
   * 注意：这里**不写** localStorage —— 本版不碰任何数据。
   * 以后要写，走 store.js 新增的导出，不要在 sync.js 里直接改存储键。
   */
  function readLocalBooks() {
    try {
      var raw = global.localStorage.getItem(KEY_BOOKS);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) {
      return [];
    }
  }

  /* ------------------------------------------------------------ 差异判断 */

  /** 同一本书的判据：书名 + 作者（接口的重名校验就是这么判的）。 */
  function sameBook(a, b) {
    if (!a || !b) return false;
    var at = String(a.title || '').trim();
    var bt = String(b.title || '').trim();
    var aa = String(a.author || '').trim();
    var ba = String(b.author || '').trim();
    return at !== '' && at === bt && aa === ba;
  }

  /**
   * 比本地和云端差多少。
   * 返回 { onlyLocal, onlyRemote, both }，三份都是数组。
   *
   * 这是纯函数（不碰网络、不碰存储），所以能单独测——
   * 迁移那种不可逆动作，判据必须先被测过，不能靠「看起来对」。
   */
  function diff(localBooks, remoteBooks) {
    var local = localBooks || [];
    var remote = remoteBooks || [];
    var onlyLocal = [];
    var both = [];
    var i, j, hit;

    for (i = 0; i < local.length; i++) {
      hit = false;
      for (j = 0; j < remote.length; j++) {
        if (sameBook(local[i], remote[j])) { hit = true; break; }
      }
      if (hit) both.push(local[i]);
      else onlyLocal.push(local[i]);
    }

    var onlyRemote = [];
    for (j = 0; j < remote.length; j++) {
      hit = false;
      for (i = 0; i < local.length; i++) {
        if (sameBook(local[i], remote[j])) { hit = true; break; }
      }
      if (!hit) onlyRemote.push(remote[j]);
    }

    return { onlyLocal: onlyLocal, onlyRemote: onlyRemote, both: both };
  }

  /**
   * 要不要先做首次迁移？
   *
   * 判据只有一条：本地有书、而云端一本都没有。
   * 这种情况下直接 pull 覆盖，等于把用户本地记的书抹掉。
   *
   * 注意这个判断**故意做得保守**：
   *   - 本地为空 → 不用迁（云端有啥就是啥）
   *   - 云端已有书 → 不用迁（说明之前同步过，或者本来就用云端）
   *   - 两边都有但不同 → 也算需要人看一眼（返回 true），不自动合并
   */
  function needsMigrate(localBooks, remoteBooks) {
    var local = localBooks || readLocalBooks();
    var remote = remoteBooks || [];
    if (local.length === 0) return false;
    if (remote.length === 0) return true;
    return diff(local, remote).onlyLocal.length > 0;
  }

  /* ------------------------------------------------------- 笔记 id 重映射 */

  /** 读本地笔记（只读）。 */
  function readLocalNotes() {
    try {
      var raw = global.localStorage.getItem(KEY_NOTES);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * 书换了 id（本地临时 id → 云端 id）之后，挂在它下面的笔记必须跟着换。
   * 不换的后果：笔记指向一个不存在的书，界面上笔记就"消失"了（数据还在，只是挂空了）。
   * 这是 Day 29 迁移时踩过的坑，新增书时同样会遇到。
   */
  function remapNotesOfBook(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return 0;
    var S = global.Store;
    if (!S || typeof S.replaceNotes !== 'function') return 0;
    var all = readLocalNotes();
    var n = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].bookId === oldId) { all[i].bookId = newId; n++; }
    }
    if (n > 0) S.replaceNotes(all);
    return n;
  }

  /**
   * 把笔记里的 bookId 从「旧本地 id」换成「云端新 id」。
   *
   * 为什么必须做：迁移前书的 id 是本地生成的 book_xxxxx，迁移后被云端 id 取代。
   * 笔记里存的还是旧 id，于是详情页按新 id 查笔记 → 一条都查不到。
   * 数据没丢，但用户看到的是「我的笔记全没了」——这比报错更让人慌。
   *
   * 靠什么配对：书名 + 作者（和接口的重名校验同一套判据）。
   * 配不上的（书根本没迁上去）记为 orphan，原样保留，不删。
   *
   * 这是纯函数：不改存储、不发请求，所以能单独测。
   */
  function remapNotes(notes, oldBooks, newBooks) {
    var list = notes || [];
    var olds = oldBooks || [];
    var news = newBooks || [];

    // 旧 id → 新 id
    var map = {};
    var i, j;
    for (i = 0; i < olds.length; i++) {
      for (j = 0; j < news.length; j++) {
        if (sameBook(olds[i], news[j])) {
          if (olds[i].id) map[olds[i].id] = news[j].id;
          break;
        }
      }
    }

    var out = [];
    var remapped = 0;
    var orphan = [];
    for (i = 0; i < list.length; i++) {
      var note = list[i];
      var next = {};
      for (var k in note) {
        if (Object.prototype.hasOwnProperty.call(note, k)) next[k] = note[k];
      }
      if (map[note.bookId]) {
        next.bookId = map[note.bookId];
        remapped++;
      } else {
        orphan.push(note);
      }
      out.push(next);
    }

    return { notes: out, remapped: remapped, orphan: orphan, map: map };
  }

  /* ------------------------------------------------------------ 首次迁移 */

  // 迁移标记。有它就不再重复迁——否则每次打开页面都会把本地书重推一遍。
  var KEY_FLAG = 'reading:sync-migrated';

  function isMigrated() {
    try { return global.localStorage.getItem(KEY_FLAG) === '1'; } catch (e) { return false; }
  }

  function markMigrated() {
    try { global.localStorage.setItem(KEY_FLAG, '1'); return true; } catch (e) { return false; }
  }

  /** 清掉迁移标记。只在「迁移失败想重来」时用；正常情况别动。 */
  function clearMigratedFlag() {
    try { global.localStorage.removeItem(KEY_FLAG); return true; } catch (e) { return false; }
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /** 备份内容。迁移前必须先有这个东西，它是唯一能证明「原来有哪几本」的证据。 */
  function backupJson(books) {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      from: 'localStorage:reading:books',
      count: (books || []).length,
      books: books || []
    }, null, 2);
  }

  /** 在浏览器里触发下载。Node 里没有 document，返回 false（测试用）。 */
  function downloadBackup(text, fileName) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return false;
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // 立刻 revoke 在部分浏览器会打断下载，延后一点
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 首次迁移：本地 → 云端。
   *
   * 顺序不能改：
   *   ① 读本地 → ② **先下载备份** → ③ 逐条 POST → ④ 拉全量回写缓存 → ⑤ 打标记
   *
   * 第 ② 步在 ③ 之前，是这份代码唯一不能商量的地方。
   * 没有备份就往上推，等于把「原来有什么」的凭据交出去换一份「希望云端收下了」。
   *
   * options:
   *   books      指定要迁的书（默认读本地）
   *   download   默认 true，是否触发浏览器下载备份
   *   pullAfter  默认 true，迁完是否拉全量回写缓存（false 的话本地缓存不动）
   *
   * 返回 Promise<report>：
   *   { total, created[], existed[], failed[], pulled, cacheWritten, backupSaved, backup, note }
   */
  function migrateLocal(options) {
    var opt = options || {};
    var local = opt.books || readLocalBooks();

    if (!local.length) {
      return Promise.resolve({
        total: 0, created: [], existed: [], failed: [],
        skipped: '本地书单是空的，不需要迁移'
      });
    }

    var report = {
      total: local.length,
      created: [],     // 成功推上去的
      existed: [],     // 云端本来就有（按书名+作者判重），跳过
      failed: [],      // 其他失败，带原因
      backup: backupJson(local),
      backupSaved: false,
      note: '时间戳不保留：云端会按迁移那一刻重设 createdAt；startedAt / finishedAt 会变成 null'
    };

    // ② 先备份，再动数据
    if (opt.download !== false) {
      report.backupSaved = downloadBackup(report.backup, 'reading-books-backup-' + stamp() + '.json');
    }

    // ③ 逐条推。串行而不是并发：控制器上几百本一起打过去，容易被限流，
    //    而且失败时无法判断是哪一本。
    var chain = Promise.resolve();
    local.forEach(function (b) {
      chain = chain.then(function () {
        return request('POST', '/api/books', {
          title: b.title,
          author: b.author || '',
          coverUrl: b.coverUrl || '',
          status: b.status || 'want',
          totalPages: (b.totalPages === undefined ? null : b.totalPages),
          currentPage: (b.currentPage === undefined ? null : b.currentPage)
        }).then(function (res) {
          report.created.push({ title: b.title, id: res.data.book.id });
        }, function (err) {
          // 「已经在书单里」不是失败，是本来就有——记进 existed，别当错误报
          if (err.kind === 'business' && /已经在书单里/.test(err.message)) {
            report.existed.push({ title: b.title });
          } else {
            report.failed.push({ title: b.title, error: describeApiError(err) });
          }
        });
      });
    });

    return chain.then(function () {
      // 有失败就不回写缓存：本地保持原样，等修完再跑一次
      if (report.failed.length > 0) return report;
      if (opt.pullAfter === false) return report;

      return fetchAll().then(function (books) {
        var Store = global.Store;
        if (!Store || typeof Store.replaceBooks !== 'function') {
          throw apiError('parse', 'store.js 没有 replaceBooks，无法回写本地缓存');
        }
        var w = Store.replaceBooks(books);
        if (!w.ok) throw apiError('parse', w.error || '回写本地缓存失败');
        report.pulled = books.length;
        report.cacheWritten = true;

        // 书的 id 换了，笔记的 bookId 必须跟着换，否则详情页里一条笔记都看不见
        var notes = readLocalNotes();
        if (notes.length > 0) {
          var rm = remapNotes(notes, local, books);
          if (typeof Store.replaceNotes === 'function') {
            var wn = Store.replaceNotes(rm.notes);
            if (!wn.ok) throw apiError('parse', wn.error || '回写笔记失败');
          }
          report.notesTotal = notes.length;
          report.notesRemapped = rm.remapped;
          report.notesOrphan = rm.orphan.length;
        } else {
          report.notesTotal = 0;
          report.notesRemapped = 0;
          report.notesOrphan = 0;
        }

        markMigrated();
        return report;
      });
    });
  }

  /* ------------------------------------------------------ 写队列（串行） */

  var queue = [];
  var draining = false;

  var status = {
    pending: 0,      // 队列里还没发出去的
    sent: 0,         // 成功发出去几次
    failed: 0,       // 失败几次（每次失败都会回滚本地）
    lastError: null, // 最近一次错误（给界面提示用）
    lastOkAt: null   // 最近一次成功的时间
  };

  function enqueue(task) {
    status.pending++;
    return new Promise(function (resolve, reject) {
      queue.push({ task: task, resolve: resolve, reject: reject });
      drain();
    });
  }

  /**
   * 串行消费队列。
   *
   * 为什么不用并发：同一个用户连续点两下「添加」，两本书并发发过去，
   * 万一第一本失败要回滚，第二本的地基就没了。串行慢一点，但顺序可预期。
   */
  function drain() {
    if (draining) return;
    var item = queue.shift();
    if (!item) return;
    draining = true;

    var p;
    try {
      p = item.task();
    } catch (e) {
      p = Promise.reject(e);
    }

    p.then(function (v) {
      status.pending--;
      status.sent++;
      status.lastOkAt = new Date().toISOString();
      draining = false;
      item.resolve(v);
      drain();
    }, function (e) {
      status.pending--;
      status.failed++;
      status.lastError = e;
      draining = false;
      item.reject(e);
      drain();
    });
  }

  /** 队列空了没有。测试和「退出前等一下」用。 */
  function settle() {
    return new Promise(function (resolve) {
      (function check() {
        if (!draining && queue.length === 0 && status.pending === 0) return resolve(status);
        setTimeout(check, 20);
      })();
    });
  }

  /* -------------------------------------------------- 本地回滚（三处共用） */

  /** 只把接口认的白名单字段挑出来发，别把本地 id、时间戳塞过去。 */
  function pickWritable(src) {
    var out = {};
    var keys = ['title', 'author', 'coverUrl', 'status', 'totalPages', 'currentPage'];
    for (var i = 0; i < keys.length; i++) {
      if (src && Object.prototype.hasOwnProperty.call(src, keys[i])) out[keys[i]] = src[keys[i]];
    }

    // ★ Day 30 修：页数必须是**数字**。
    // 表单里 input.value 永远是字符串（"320"），而服务端校验是 Number.isInteger，
    // 直接发字符串会被拒 —— 表现就是「改了半天，一刷新又变回没填」。
    // 本地之所以看着正常，是因为 Store 内部自己转过一次；sync 推的是调用方给的原始值。
    // 这里统一再转一次，不管上游传的是字符串还是数字。
    ['totalPages', 'currentPage'].forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(out, k)) return;
      var v = out[k];
      if (v === null || v === undefined || v === '') { out[k] = null; return; }
      var n = Number(v);
      // 真的是数字就转，不是就原样传下去，让后端返回那句中文错误
      out[k] = (isFinite(n) && Math.floor(n) === n) ? n : v;
    });

    return out;
  }

  /** 服务端返回的书，用它替换本地那条（主要是把本地 id 换成云端 id）。 */
  function adoptServerBook(localId, serverBook) {
    var S = global.Store;
    if (!S || !serverBook) return false;
    var list = S.listBooks();
    if (!list.ok) return false;
    var hit = false;
    for (var i = 0; i < list.data.length; i++) {
      if (list.data[i].id === localId) { list.data[i] = serverBook; hit = true; break; }
    }
    if (!hit) return false;
    if (!S.replaceBooks(list.data).ok) return false;
    // ★ 书 id 变了，笔记的 bookId 也要跟着改（否则笔记挂空）
    remapNotesOfBook(localId, serverBook.id);
    return true;
  }

  // 接线前的原始方法。回滚必须走这里，绝不能走被包过的 Store.xxx。
  //
  // ⚠️ 这个坑是踩出来的（Day 29 自测第一次就红）：pushAdd 失败时如果调
  //    Store.deleteBook() 回滚，而这个方法已经被 installHooks 包过，
  //    于是「回滚」本身又变成一次删除请求 → 也失败 → 又走 restoreBook 把书放回来。
  //    结果：本地剩一本、failed 计数变成 2、报错文案显示成「删除」。
  //    一句话：**回滚动作不能被自己的监听器捕获。**
  var origMethods = { add: null, update: null, del: null };
  // 笔记的三个原始方法，作用同上（回滚不能被自己的监听器捕获）
  var origNoteMethods = { add: null, update: null, del: null };

  /**
   * 把某本书恢复成本地快照（回滚用）。
   * 存在就替换，不存在就加回去——删除失败了要能把它放回原位。
   */
  function restoreBook(snapshot) {
    if (!snapshot || !snapshot.id) return false;
    var S = global.Store;
    var list = S.listBooks();
    if (!list.ok) return false;
    for (var i = 0; i < list.data.length; i++) {
      if (list.data[i].id === snapshot.id) {
        list.data[i] = snapshot;
        return S.replaceBooks(list.data).ok;
      }
    }
    list.data.push(snapshot);
    return S.replaceBooks(list.data).ok;
  }

  /* ------------------------------------------------------------ 三条写路径 */

  /**
   * 新增：本地已经写好了（界面已反馈），这里只负责推到云端。
   * 推不上去就把本地那条撤掉——**不能留一个“看着存上了、其实没存”的记录**。
   */
  function pushAdd(localBook) {
    return enqueue(function () {
      return request('POST', '/api/books', pickWritable(localBook)).then(function (res) {
        var serverBook = res && res.data && res.data.book;
        if (serverBook) adoptServerBook(localBook.id, serverBook);
        return serverBook;
      }, function (err) {
        // 回滚：把本地这条撤掉。走原始 delete（不是被包过的那个），
        // 否则回滚本身又变成一次删除请求，见 origMethods 那段的说明。
        var del = origMethods.del || global.Store.deleteBook;
        del.call(global.Store, localBook.id);
        throw err;
      });
    });
  }

  /** 修改：失败就用改动前的快照盖回去。 */
  function pushUpdate(bookId, patch, before) {
    var body = pickWritable(patch);
    return enqueue(function () {
      return request('PATCH', '/api/books/' + encodeURIComponent(bookId), body).then(function (res) {
        var serverBook = res && res.data && res.data.book;
        if (serverBook) adoptServerBook(bookId, serverBook);
        return serverBook;
      }, function (err) {
        restoreBook(before);                     // 回滚
        throw err;
      });
    });
  }

  /** 删除：失败就把那本书（连同它的字段）放回本地。 */
  function pushDelete(bookId, before) {
    return enqueue(function () {
      return request('DELETE', '/api/books/' + encodeURIComponent(bookId)).then(function (res) {
        return res && res.data;
      }, function (err) {
        restoreBook(before);                     // 回滚
        throw err;
      });
    });
  }

  /* -------------------------------------------------------------- 笔记（Day 31） */

  /** 把本地那条笔记换成服务端返回的（拿到真 id 和时间戳）。 */
  function adoptServerNote(localId, serverNote) {
    var S = global.Store;
    if (!S || !serverNote || typeof S.replaceNotes !== 'function') return false;
    var all = readLocalNotes();
    var hit = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === localId) { all[i] = serverNote; hit = true; break; }
    }
    if (!hit) return false;
    return S.replaceNotes(all).ok;
  }

  /** 把某条笔记恢复成本地快照（回滚用）。找不到就放回最前面。 */
  function restoreNote(snapshot) {
    if (!snapshot || !snapshot.id) return false;
    var S = global.Store;
    if (!S || typeof S.replaceNotes !== 'function') return false;
    var all = readLocalNotes();
    var hit = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === snapshot.id) { all[i] = snapshot; hit = true; break; }
    }
    if (!hit) all.unshift(snapshot);
    return S.replaceNotes(all).ok;
  }

  function pushNoteAdd(localNote) {
    return enqueue(function () {
      return request('POST', '/api/notes', {
        bookId: localNote.bookId,
        content: localNote.content,
        page: localNote.page === undefined ? null : localNote.page,
      }).then(function (res) {
        var serverNote = res && res.data && res.data.note;
        if (serverNote) adoptServerNote(localNote.id, serverNote);
        return serverNote;
      }, function (err) {
        // 回滚走原始 deleteNote —— 不能走被包过的那个（否则回滚又发一次请求）
        var del = origNoteMethods.del;
        if (del) del.call(global.Store, localNote.id);
        throw err;
      });
    });
  }

  function pushNoteUpdate(noteId, patch, before) {
    return enqueue(function () {
      return request('PATCH', '/api/notes/' + encodeURIComponent(noteId), patch).then(function (res) {
        return res && res.data && res.data.note;
      }, function (err) {
        restoreNote(before);
        throw err;
      });
    });
  }

  function pushNoteDelete(noteId, before) {
    return enqueue(function () {
      return request('DELETE', '/api/notes/' + encodeURIComponent(noteId)).then(function (res) {
        return res && res.data;
      }, function (err) {
        restoreNote(before);
        throw err;
      });
    });
  }

  /* -------------------------------------------------------------- 接线 */

  /**
   * 把 Store 的三个写方法包一层：**先照原样同步执行**（界面立刻有反馈，
   * 和现在一模一样），成功后再异步推云端。所以 app.js 一行都不用改。
   *
   * 失败时：本地回滚 + status.lastError 有值 + 调 onError 回调（如果有）。
   * ⚠️ 本版**还没有界面级的失败提示**（横幅/toast），只写 console。
   *    所以「联网状态下正常用」没问题，但断网时用户只看得到 console——
   *    这一步的 UI 提示留到下一版，别假装已经有了。
   */
  function installHooks() {
    if (!enabled) return false;

    var S = global.Store;
    if (!S || S.__syncHooked) return false;

    var origAdd = S.addBook;
    var origUpdate = S.updateBook;
    var origDelete = S.deleteBook;
    var origGet = S.getBook;
    var origNoteAdd = S.addNote;
    var origNoteUpdate = S.updateNote;
    var origNoteDelete = S.deleteNote;
    origNoteMethods.add = origNoteAdd;
    origNoteMethods.update = origNoteUpdate;
    origNoteMethods.del = origNoteDelete;

    // 存下来给回滚用（回滚不能被自己的监听器捕获）
    origMethods.add = origAdd;
    origMethods.update = origUpdate;
    origMethods.del = origDelete;

    function report(err, what) {
      status.lastError = err;
      var msg = '「' + what + '」没同步到云端，已恢复原样：' + describeApiError(err);
      try {
        console.error('[sync] ' + msg);
      } catch (e) { /* console 不可用就算了 */ }
      showSyncError(msg);              // 界面必须看得见，不能只有 console
      refreshListIfVisible();          // 回滚后让列表跟本地数据对上
      if (typeof onError === 'function') {
        try { onError(err, what); } catch (e) { /* 回调自己炸了不该影响主流程 */ }
      }
    }

    S.addBook = function (input) {
      var r = origAdd(input);                       // 先本地，同步返回
      if (r && r.ok) {
        pushAdd(r.data).then(null, function (e) { report(e, '添加《' + r.data.title + '》'); });
      }
      return r;
    };

    S.updateBook = function (bookId, patch) {
      var snap = origGet(bookId);
      var before = snap && snap.ok ? JSON.parse(JSON.stringify(snap.data)) : null;
      var r = origUpdate(bookId, patch);            // 先本地
      if (r && r.ok) {
        // ★ Day 30 修：推给云端的是**本地存下来的那一份**，不是入参。
        //   Store 内部会做类型转换（"320" → 320）、trim、字段白名单，
        //   这些规范化之后的结果才是真正要同步的东西。
        //   之前直接推入参，表单来的字符串就原样发给后端，被 Number.isInteger 拒掉 ——
        //   表现就是「本地看着改好了，一刷新又变回去」。
        var after = origGet(bookId);
        var canonical = (after && after.ok && after.data) ? after.data : patch;
        pushUpdate(bookId, canonical, before).then(null, function (e) { report(e, '修改'); });
      }
      return r;
    };

    S.deleteBook = function (bookId) {
      var snap = origGet(bookId);
      var before = snap && snap.ok ? JSON.parse(JSON.stringify(snap.data)) : null;
      var r = origDelete(bookId);                   // 先本地
      if (r && r.ok) {
        pushDelete(bookId, before).then(null, function (e) { report(e, '删除'); });
      }
      return r;
    };

    // ---------- 笔记（Day 31） ----------
    // 和书单同一套规矩：先本地（同步返回，界面立刻有反馈），再推云端；推失败就把本地恢复原样。
    S.addNote = function (input) {
      var r = origNoteAdd(input);
      if (r && r.ok) {
        pushNoteAdd(r.data).then(null, function (e) { report(e, '添加笔记'); });
      }
      return r;
    };

    S.updateNote = function (noteId, patch) {
      var all = readLocalNotes();
      var before = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === noteId) { before = JSON.parse(JSON.stringify(all[i])); break; }
      }
      var r = origNoteUpdate(noteId, patch);
      if (r && r.ok) {
        pushNoteUpdate(noteId, patch, before).then(null, function (e) { report(e, '修改笔记'); });
      }
      return r;
    };

    S.deleteNote = function (noteId) {
      var all = readLocalNotes();
      var before = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === noteId) { before = JSON.parse(JSON.stringify(all[i])); break; }
      }
      var r = origNoteDelete(noteId);
      if (r && r.ok) {
        pushNoteDelete(noteId, before).then(null, function (e) { report(e, '删除笔记'); });
      }
      return r;
    };

    S.__syncHooked = true;
    return true;
  }

  /** 拆掉接线（排查问题用，正常别调）。 */
  function uninstallHooks() {
    // 没有保留原始引用就不能安全还原，所以这里只做标记撤销的提示，不真的改回去。
    // 真要还原，刷新页面最干净——这也说明接线本身是可逆的：不调 installHooks 就没有。
    return false;
  }

  var onError = null;
  function setErrorHandler(fn) { onError = typeof fn === 'function' ? fn : null; return true; }

  function getStatus() {
    return {
      enabled: enabled,
      pending: status.pending,
      sent: status.sent,
      failed: status.failed,
      lastError: status.lastError ? describeApiError(status.lastError) : null,
      lastOkAt: status.lastOkAt,
      hooked: !!(global.Store && global.Store.__syncHooked)
    };
  }

  /* --------------------------------------------- 失败提示（必须让人看见） */

  /*
   * 为什么非要有这个：
   *   同步失败时 sync.js 会把本地改动回滚。如果界面一句话都不说，用户看到的是
   *   「我明明点了保存，一刷新就没了」——这正是 PRD AC-23 要防的那类事：
   *   **出错可以，装作没出错不行。**
   *
   * 为什么自己造一个条，不借用 app.js 的提示：
   *   app.js 的 flashSaved() 只改按钮文字，而且它是在同步调用里发生的，
   *   那时候还不知道云端成不成功（推送是之后的事）。所以要一条独立的条。
   */

  var bannerEl = null;
  var bannerTextEl = null;
  var bannerTimer = null;
  var BANNER_MS = 12000;   // 12 秒后自动收起；也可以点「知道了」

  function hasDom() {
    return typeof document !== 'undefined' && document && document.body;
  }

  function ensureBanner() {
    if (!hasDom()) return null;
    if (bannerEl && bannerEl.parentNode) return bannerEl;

    var el = document.createElement('div');
    el.className = 'sync-banner';
    el.setAttribute('role', 'status');       // 读屏能读出来，但不打断用户
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;

    var text = document.createElement('span');
    text.className = 'sync-banner-text';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sync-banner-close';
    btn.textContent = '知道了';
    btn.addEventListener('click', hideSyncError);

    el.appendChild(text);
    el.appendChild(btn);
    document.body.appendChild(el);

    bannerEl = el;
    bannerTextEl = text;
    return el;
  }

  /**
   * 现在是不是已经滚到底部附近？
   *
   * 用途：决定弹条时要不要「替你滑那一下」。
   * 你正看着最后一张卡，条弹出来把它盖住——这时候自动往下推一段才有意义；
   * 你要是正在看上半部分，底部那块被盖住你根本没在看，硬推一下反而打断你。
   */
  function nearBottom() {
    try {
      var doc = global.document.documentElement || {};
      var y = global.pageYOffset || doc.scrollTop || 0;
      var vh = global.innerHeight || doc.clientHeight || 0;
      var sh = Math.max(
        (global.document.body && global.document.body.scrollHeight) || 0,
        doc.scrollHeight || 0
      );
      if (!sh) return false;
      return (y + vh) >= (sh - 60);
    } catch (e) {
      return false;
    }
  }

  /**
   * 弹一条同步失败提示。返回 true = 真的显示出来了；
   * false = 没有 DOM（比如 Node 里跑测试），此时只有 console。
   */
  function showSyncError(message) {
    var el = ensureBanner();
    if (!el) return false;
    if (bannerTextEl) bannerTextEl.textContent = message;
    el.hidden = false;

    // 两件事一起做，缺一件都不行：
    //   ① 给页面底部让出等高的空间（不然内容永远滚不出来）
    //   ② 如果你当时就在底部，替你把视图推上来一段（不然你还得自己滑）
    // 只做 ① 的结果就是真机上看到的：条还在挡，得手动往上滑才看得见。
    var h = el.offsetHeight + 26;
    var atBottom = nearBottom();
    reserveSpaceForBanner(h);
    if (atBottom) {
      try { global.scrollBy(0, h); } catch (e) { /* 滚不动就算了，别影响提示 */ }
    }

    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideSyncError, BANNER_MS);
    return true;
  }

  function hideSyncError() {
    if (bannerEl) bannerEl.hidden = true;
    reserveSpaceForBanner(0);
    if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
    return true;
  }

  /**
   * 设/撤 body 的底部内边距。
   * h = 0 表示撤掉（把原来的值还回去）。
   *
   * 为什么要存原值：有些页面本来就给 body 设了 padding-bottom，
   * 直接覆盖会把它抹掉；收起时应该还原成原样，而不是清空。
   */
  var bodyPadBackup = null;

  function reserveSpaceForBanner(h) {
    if (!hasDom()) return;
    var b = document.body;
    if (!b || !b.style) return;

    if (h > 0) {
      if (bodyPadBackup === null) {
        bodyPadBackup = b.style.paddingBottom || '';   // 记下原值（可能是空串）
      }
      b.style.paddingBottom = h + 'px';
    } else if (bodyPadBackup !== null) {
      b.style.paddingBottom = bodyPadBackup;
      bodyPadBackup = null;
    }
  }

  /**
   * 回滚之后让界面跟本地数据对上。
   *
   * 只在书单页重渲染：别的页面（详情页）贸然重绘会打断用户，也会出现
   * 「你正在看的这本书其实已经被撤掉了」这种更怪的场面。宁可让他自己刷新。
   */
  function refreshListIfVisible() {
    try {
      var h = (global.location && global.location.hash ? global.location.hash : '').replace(/^#/, '');
      var isList = (h === '' || h === '/' || h === '/shelf');
      if (isList && global.AppViews && typeof global.AppViews.enterList === 'function') {
        global.AppViews.enterList();
      }
    } catch (e) { /* 重绘失败不该影响主流程 */ }
  }

  /* ------------------------------------------------------------ 自动启动 */

  /**
   * 自动启动：把「打开页面」变成「接上同步 + 拉一次云端」。
   *
   * 为什么不能无条件启动（这是整个文件里最要紧的一条）：
   *   没迁移过的机器上，本地书的 id 还是 book_xxx，云端是 book-mvpa…，
   *   两边根本不是同一批对象。这时候先 fetchAll() 再 replaceBooks()，
   *   等于**用云端把本地覆盖掉**——本地那几本从没推上去的书就没了，
   *   而且看起来像"书丢了"，比报错更让人慌。
   *   所以钥匙是 isMigrated()：迁移过才敢动。
   *
   * 为什么拉取失败时绝对不碰本地缓存：
   *   断网打开页面，应该看到上次的书，而不是一片空白。
   *   fetchAll 抛了就走失败分支，只提示、不写缓存。
   *
   * 关掉的办法（不用改代码）：
   *   localStorage.setItem('reading:sync-auto', 'off')   // 下次打开不再自动连
   *   localStorage.removeItem('reading:sync-auto')       // 恢复
   */
  var KEY_AUTO_OFF = 'reading:sync-auto';

  function isAutoOff() {
    try { return global.localStorage.getItem(KEY_AUTO_OFF) === 'off'; } catch (e) { return false; }
  }

  function autoStart(options) {
    var opt = options || {};

    // force 只给排查用，正常情况下不该有人传
    if (opt.force !== true) {
      if (isAutoOff()) return Promise.resolve({ started: false, reason: 'turned-off' });
      if (!isMigrated()) return Promise.resolve({ started: false, reason: 'not-migrated' });
      // ★ Day 31：没登录就不同步。书单现在按人存，
      //   没凭证的请求服务端一律拒，硬发只会换来一串"请先登录"的红条。
      //   这种情况下继续用本地书单，体验和以前完全一样。
      if (!readToken()) return Promise.resolve({ started: false, reason: 'not-signed-in' });
    }

    // ★ 换人了吗？换了就先清掉本地书单和笔记，再去拉云端。
    //   不清的后果有两个，都很糟：
    //     ① B 会在自己的书单里看到 A 的书；
    //     ② 本地是"有书"状态，遇到云端为空时安全阀会拦住不让覆盖 —— 两头都错。
    //   注意"首次登录"（owner 还没写过）不算换人，那时的本地数据本来就是这个人自己的。
    var uid = readUid();
    var owner = readOwner();
    var switched = !!(uid && owner && owner !== uid);
    if (switched) {
      var S0 = global.Store;
      if (S0 && typeof S0.replaceBooks === 'function') S0.replaceBooks([]);
      if (S0 && typeof S0.replaceNotes === 'function') S0.replaceNotes([]);
    }
    if (uid) writeOwner(uid);

    enable();                       // installHooks 要求 enabled，顺序不能反
    var hooked = installHooks();

    // 书和笔记一起拉：书是笔记的前提（笔记挂在 bookId 上），所以书先到、笔记后到。
    // 笔记拉失败不该拖垮整个启动 —— 书能用就先让书能用。
    return Promise.all([
      fetchAll(),
      fetchAllNotes().then(null, function () { return null; }),
    ]).then(function (both) {
      var books = both[0];
      var notes = both[1];             // null = 笔记没拉到，保持本地不动
      var Store = global.Store;
      if (!Store || typeof Store.replaceBooks !== 'function') {
        return { started: true, hooked: hooked, pulled: 0, reason: 'store-cannot-write' };
      }
      // ★ 安全阀：云端是空的、本地却有书 —— 绝不覆盖。
      //   多账号之后这条变得很要紧：换个新账号登录，云端书单当然是空的，
      //   这时候要是无脑 replaceBooks，本地攒的书就被一次清空了。
      var local = readLocalBooks();
      if (books.length === 0 && local.length > 0) {
        return { started: true, hooked: hooked, pulled: 0, reason: 'cloud-empty-local-not' };
      }
      var w = Store.replaceBooks(books);
      if (!w || !w.ok) {
        return { started: true, hooked: hooked, pulled: 0, reason: 'cache-write-failed' };
      }
      var pulledNotes = 0;
      if (notes && typeof Store.replaceNotes === 'function') {
        var wn = Store.replaceNotes(notes);
        if (wn && wn.ok) pulledNotes = notes.length;
      }
      refreshListIfVisible();       // 界面可能已经画完了旧数据，得重画
      return {
        started: true,
        hooked: hooked,
        pulled: books.length,
        pulledNotes: pulledNotes,
        switched: switched,          // true = 这次是换了人，本地先被清空过
      };
    }, function (err) {
      // 失败分支：本地缓存保持原样，只把原因显示出来
      status.lastError = err;
      status.failed++;
      showSyncError('云端数据没拉下来，先显示本机缓存：' + describeApiError(err));
      return { started: true, hooked: hooked, pulled: 0, error: describeApiError(err) };
    });
  }

  /* -------------------------------------------------------------- 导出 */

  global.Sync = {
    isEnabled: isEnabled,
    enable: enable,
    disable: disable,

    fetchAll: fetchAll,
    readLocalBooks: readLocalBooks,

    diff: diff,
    needsMigrate: needsMigrate,
    sameBook: sameBook,

    migrateLocal: migrateLocal,
    isMigrated: isMigrated,
    markMigrated: markMigrated,
    clearMigratedFlag: clearMigratedFlag,
    backupJson: backupJson,

    readLocalNotes: readLocalNotes,
    remapNotes: remapNotes,

    installHooks: installHooks,
    uninstallHooks: uninstallHooks,
    autoStart: autoStart,
    isAutoOff: isAutoOff,
    KEY_AUTO_OFF: KEY_AUTO_OFF,
    setErrorHandler: setErrorHandler,
    getStatus: getStatus,
    settle: settle,

    pushAdd: pushAdd,
    pushUpdate: pushUpdate,
    pushDelete: pushDelete,

    showSyncError: showSyncError,
    hideSyncError: hideSyncError,

    describeApiError: describeApiError,
    API_BASE: API_BASE
  };

})(window);
