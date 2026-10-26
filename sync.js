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

    describeApiError: describeApiError,
    API_BASE: API_BASE
  };

})(window);
