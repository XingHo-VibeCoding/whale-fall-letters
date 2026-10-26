/* ============================================================================
 * store.js —— 数据层（本项目唯一直接读写浏览器本地存储的文件）
 *
 * 依据
 *   docs/TECH_DESIGN.md 2.5（数据格式与唯一出入口）、2.6（代码分成几块）
 *   docs/PRD.md 4.2（书籍字段）、4.3（笔记字段）、3.1~3.3（边界规则）
 *
 * 三条约定
 *   1. 界面代码永远不直接碰 localStorage，只调用本文件的方法。
 *      ——这样第 23 天换数据库时，只改这一个文件（附录 A 第 1 行）。
 *   2. 所有方法都返回 { ok: true, data } 或 { ok: false, error: "中文提示" }。
 *      ——错误不能静默（TECH_DESIGN 3.4）。界面拿到 ok:false 必须提示用户，
 *        不能装作存上了。
 *   3. 存储只用三个键：reading:books / reading:notes / reading:likes。
 *      ——阅读进度不单独存，它是书的一部分；百分比也不存，实时算。
 *      ——reading:likes 是 Day 11 加的：记「我点过赞的评论 id」，同样带前缀防撞名。
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ 常量 */

  var KEY_BOOKS = 'reading:books';
  var KEY_NOTES = 'reading:notes';
  var KEY_LIKES = 'reading:likes';
  // 私信会话的「已读」记录。键名带 conv- 是为了和书单里的「已读(finished)」区分开，
  // 两者含义完全不同，别混。
  var KEY_READS = 'reading:conv-reads';

  var STATUS = {
    WANT: 'want',          // 想读
    READING: 'reading',    // 在读
    FINISHED: 'finished'   // 已读
  };

  /* -------------------------------------------------------------- 结果包装 */

  function ok(data) { return { ok: true, data: data }; }
  function fail(error) { return { ok: false, error: error }; }

  /* ------------------------------------------------------------------ 工具 */

  function nowIso() {
    return new Date().toISOString();
  }

  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function cleanText(v) {
    return typeof v === 'string' ? v.trim() : '';
  }

  function indexOfId(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return i;
    }
    return -1;
  }

  /**
   * 解析「可选整数」字段（总页数、当前页、页码）。
   * 返回 { has: 有没有填, value: 数值或 null, valid: 填了的话合不合法 }
   */
  function parseOptionalInt(v) {
    if (v === null || v === undefined || v === '') {
      return { has: false, value: null, valid: true };
    }
    var n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n) {
      return { has: true, value: null, valid: false };
    }
    return { has: true, value: n, valid: true };
  }

  /* -------------------------------------------------------------- 底层读写 */

  /** 本地存储是否可用（隐私模式、被浏览器禁用时会失败） */
  function isAvailable() {
    try {
      var probe = '__reading_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 读一个键，返回数组。没有数据 = 空数组（不是错误）。 */
  function readList(key) {
    if (!isAvailable()) {
      return fail('浏览器本地存储不可用，数据无法保存');
    }
    var raw;
    try {
      raw = global.localStorage.getItem(key);
    } catch (e) {
      return fail('数据读取失败，请刷新重试');   // 对应 PRD AC-23：不白屏
    }
    if (raw === null || raw === '') {
      return ok([]);                            // 第一次使用，还没有数据
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return fail('数据读取失败，请刷新重试');
    }
    if (!Array.isArray(parsed)) {
      return fail('数据读取失败，请刷新重试');
    }
    return ok(parsed);
  }

  /** 写一个键。失败必须能被界面感知到。 */
  function writeList(key, list) {
    if (!isAvailable()) {
      return fail('浏览器本地存储不可用，数据无法保存');
    }
    try {
      global.localStorage.setItem(key, JSON.stringify(list));
      return ok(true);
    } catch (e) {
      return fail('保存失败：可能是存储空间已满，或浏览器处于隐私模式');
    }
  }

  function readBooks() { return readList(KEY_BOOKS); }
  function readNotes() { return readList(KEY_NOTES); }

  /**
   * 用外部数据整体替换书单（Day 29 数据互通加）。
   *
   * 给谁用：sync.js 从云端拉到全量之后，要把结果写回本地缓存。
   * ⚠️ 界面代码不要直接调——它会**覆盖**整份书单，没有任何确认。
   *    （这就是为什么它放在 store.js 里：碰存储的地方只能有一个。）
   *
   * 为什么不在 sync.js 里直接写 localStorage：
   *   store.js 第 9 行那条约定——界面代码永远不直接碰 localStorage。
   *   同步层也算「不直接碰」，否则 Key 会散成两处，以后换存储方案要改两个文件。
   *
   * 返回 { ok:true, data:{ count } } 或 { ok:false, error }
   */
  function replaceBooks(list) {
    if (Object.prototype.toString.call(list) !== '[object Array]') {
      return fail('替换书单失败：需要传入数组');   // 防止手滑传 null 把书单清空
    }
    var written = writeList(KEY_BOOKS, list);
    if (!written.ok) return written;
    return ok({ count: list.length });
  }

  /**
   * 用外部数据整体替换笔记（Day 29 数据互通加）。
   *
   * 给谁用：迁移时书的 id 会从「本地生成的 book_xxx」换成「云端生成的 book-mvpa…」，
   * 笔记里的 bookId 如果不同步改，页面上就查不到它了——数据还在，但看不见。
   * 那个现象比丢数据更吓人（用户会以为笔记没了）。
   *
   * ⚠️ 同 replaceBooks：整体覆盖，界面代码不要直接调。
   */
  function replaceNotes(list) {
    if (Object.prototype.toString.call(list) !== '[object Array]') {
      return fail('替换笔记失败：需要传入数组');
    }
    var written = writeList(KEY_NOTES, list);
    if (!written.ok) return written;
    return ok({ count: list.length });
  }

  /* ------------------------------------------------------------ 书籍：校验 */

  /**
   * 校验并规范化书籍输入。
   * @param input 用户提交的字段（可以只给一部分）
   * @param base  已有记录（新增时传 null）；缺的字段从它取
   * 返回 { ok:true, data:{title,author,coverUrl,status,totalPages,currentPage} }
   */
  function normalizeBookInput(input, base) {
    function pick(name) {
      if (input[name] !== undefined) return input[name];
      return base ? base[name] : undefined;
    }

    var title = cleanText(pick('title'));
    if (!title) {
      return fail('书名不能为空');                       // PRD 3.1 边界
    }

    var total = parseOptionalInt(pick('totalPages'));
    if (!total.valid) return fail('总页数要填一个整数');
    if (total.has && total.value <= 0) {
      return fail('总页数要大于 0');                      // PRD 3.1 边界
    }

    var current = parseOptionalInt(pick('currentPage'));
    if (!current.valid) return fail('当前页数要填一个整数');
    if (current.has && current.value < 0) {
      return fail('当前页数不能是负数');                   // PRD 3.2 边界
    }
    if (total.has && current.has && current.value > total.value) {
      return fail('当前页数不能超过总页数');                // PRD 3.2 边界 / AC-13
    }

    var status = pick('status');
    if (status !== STATUS.WANT && status !== STATUS.READING && status !== STATUS.FINISHED) {
      status = base ? base.status : STATUS.WANT;         // 新书默认「想读」
    }

    return ok({
      title: title,
      author: cleanText(pick('author')),
      coverUrl: cleanText(pick('coverUrl')),
      status: status,
      totalPages: total.has ? total.value : null,
      currentPage: current.has ? current.value : null
    });
  }

  /* ------------------------------------------------------------ 书籍：接口 */

  /** 新增一本书。状态默认「想读」。 */
  function addBook(input) {
    var books = readBooks();
    if (!books.ok) return books;

    var norm = normalizeBookInput(input || {}, null);
    if (!norm.ok) return norm;

    var ts = nowIso();
    var book = norm.data;
    book.id = newId('book');
    book.createdAt = ts;
    book.updatedAt = ts;
    book.startedAt = book.status === STATUS.READING ? ts : null;
    book.finishedAt = book.status === STATUS.FINISHED ? ts : null;

    books.data.push(book);
    var written = writeList(KEY_BOOKS, books.data);
    if (!written.ok) return written;
    return ok(book);
  }

  /** 列出全部书籍，最近添加的排在前面。 */
  function listBooks() {
    var books = readBooks();
    if (!books.ok) return books;

    var wrapped = [];
    for (var i = 0; i < books.data.length; i++) {
      wrapped.push({ item: books.data[i], seq: i });
    }
    // 先按创建时间倒序；时间相同（同一毫秒内连续添加）时，
    // 以写入顺序为准——后写进来的排前面。不能拿 id 比较，
    // id 里的随机部分不反映先后顺序。
    wrapped.sort(function (a, b) {
      var c = String(b.item.createdAt || '').localeCompare(String(a.item.createdAt || ''));
      return c !== 0 ? c : b.seq - a.seq;
    });

    return ok(wrapped.map(function (x) { return x.item; }));
  }

  /** 按 id 取一本书。找不到返回 data:null（不是错误）。 */
  function getBook(id) {
    var books = readBooks();
    if (!books.ok) return books;
    var i = indexOfId(books.data, id);
    return ok(i < 0 ? null : books.data[i]);
  }

  /** 修改一本书。只传要改的字段即可。 */
  function updateBook(id, patch) {
    var books = readBooks();
    if (!books.ok) return books;

    var i = indexOfId(books.data, id);
    if (i < 0) return fail('这本书不存在，可能已被删除');

    var base = books.data[i];
    var norm = normalizeBookInput(patch || {}, base);
    if (!norm.ok) return norm;

    var next = norm.data;
    var ts = nowIso();

    var merged = {
      id: base.id,
      createdAt: base.createdAt,
      title: next.title,
      author: next.author,
      coverUrl: next.coverUrl,
      status: next.status,
      totalPages: next.totalPages,
      currentPage: next.currentPage,
      updatedAt: ts,
      // startedAt：状态「首次」变为在读时写入，之后保留（PRD 4.2）
      startedAt: base.startedAt || null,
      // finishedAt：跟随「已读」状态
      finishedAt: null
    };

    if (next.status === STATUS.READING && !merged.startedAt) {
      merged.startedAt = ts;
    }

    var becameFinished = next.status === STATUS.FINISHED && base.status !== STATUS.FINISHED;
    if (becameFinished) {
      merged.finishedAt = ts;                          // 完成日期记为今天（AC-14）
    } else if (next.status === STATUS.FINISHED) {
      merged.finishedAt = base.finishedAt || ts;       // 本来就已读，保留原日期
    }
    // 改回想读 / 在读：清掉完成日期，因为还没读完

    books.data[i] = merged;
    var written = writeList(KEY_BOOKS, books.data);
    if (!written.ok) return written;
    return ok(merged);
  }

  /**
   * 删除一本书，并级联删除它的全部笔记（TECH_DESIGN 2.9 / PRD AC-18）。
   * 返回 { deletedNotes: 连带删掉的笔记条数 }，供确认框显示（AC-10）。
   */
  function deleteBook(id) {
    var books = readBooks();
    if (!books.ok) return books;

    var i = indexOfId(books.data, id);
    if (i < 0) return fail('这本书不存在，可能已被删除');

    var notes = readNotes();
    if (!notes.ok) return notes;

    var kept = [];
    var removed = 0;
    for (var k = 0; k < notes.data.length; k++) {
      if (notes.data[k].bookId === id) removed++;
      else kept.push(notes.data[k]);
    }

    books.data.splice(i, 1);
    var writtenBooks = writeList(KEY_BOOKS, books.data);
    if (!writtenBooks.ok) return writtenBooks;

    if (removed > 0) {
      var writtenNotes = writeList(KEY_NOTES, kept);
      if (!writtenNotes.ok) return writtenNotes;
    }

    return ok({ deletedNotes: removed });
  }

  /** 数一本书有几条笔记（删书确认框要用，PRD AC-10）。 */
  function countNotes(bookId) {
    var notes = readNotes();
    if (!notes.ok) return notes;
    var n = 0;
    for (var k = 0; k < notes.data.length; k++) {
      if (notes.data[k].bookId === bookId) n++;
    }
    return ok(n);
  }

  /* ------------------------------------------------------------ 笔记：接口 */

  /** 新增一条笔记。必须属于一本存在的书。 */
  function addNote(input) {
    input = input || {};

    var content = cleanText(input.content);
    if (!content) {
      return fail('笔记内容不能为空');                    // PRD 3.3 边界
    }

    var bookId = input.bookId;
    if (!bookId) return fail('笔记必须属于一本书');

    var books = readBooks();
    if (!books.ok) return books;
    if (indexOfId(books.data, bookId) < 0) {
      return fail('这本书不存在，可能已被删除');
    }

    var page = parseOptionalInt(input.page);
    if (!page.valid) return fail('页码要填一个整数');
    if (page.has && page.value < 0) return fail('页码不能是负数');

    var notes = readNotes();
    if (!notes.ok) return notes;

    var ts = nowIso();
    var note = {
      id: newId('note'),
      bookId: bookId,
      content: content,
      page: page.has ? page.value : null,
      createdAt: ts,
      updatedAt: ts
    };

    notes.data.push(note);
    var written = writeList(KEY_NOTES, notes.data);
    if (!written.ok) return written;
    return ok(note);
  }

  /** 列出某本书的笔记，最新的在最上面（PRD 3.3 / AC-15）。 */
  function listNotes(bookId) {
    var notes = readNotes();
    if (!notes.ok) return notes;

    var wrapped = [];
    for (var k = 0; k < notes.data.length; k++) {
      if (notes.data[k].bookId === bookId) {
        wrapped.push({ item: notes.data[k], seq: k });
      }
    }
    // 同 listBooks：时间倒序，同一毫秒内以写入顺序为准（后写的在前）。
    wrapped.sort(function (a, b) {
      var c = String(b.item.createdAt || '').localeCompare(String(a.item.createdAt || ''));
      return c !== 0 ? c : b.seq - a.seq;
    });

    return ok(wrapped.map(function (x) { return x.item; }));
  }

  /** 修改一条笔记。只传要改的字段即可。 */
  function updateNote(id, patch) {
    var notes = readNotes();
    if (!notes.ok) return notes;

    var i = indexOfId(notes.data, id);
    if (i < 0) return fail('这条笔记不存在，可能已被删除');

    var base = notes.data[i];
    patch = patch || {};

    var content = patch.content !== undefined ? cleanText(patch.content) : base.content;
    if (!content) return fail('笔记内容不能为空');

    var pageRaw = patch.page !== undefined ? patch.page : base.page;
    var page = parseOptionalInt(pageRaw);
    if (!page.valid) return fail('页码要填一个整数');
    if (page.has && page.value < 0) return fail('页码不能是负数');

    var merged = {
      id: base.id,
      bookId: base.bookId,
      content: content,
      page: page.has ? page.value : null,
      createdAt: base.createdAt,       // 创建时间不变，保证列表顺序稳定
      updatedAt: nowIso()
    };

    notes.data[i] = merged;
    var written = writeList(KEY_NOTES, notes.data);
    if (!written.ok) return written;
    return ok(merged);
  }

  /** 删除一条笔记。 */
  function deleteNote(id) {
    var notes = readNotes();
    if (!notes.ok) return notes;

    var i = indexOfId(notes.data, id);
    if (i < 0) return fail('这条笔记不存在，可能已被删除');

    var removed = notes.data.splice(i, 1)[0];
    var written = writeList(KEY_NOTES, notes.data);
    if (!written.ok) return written;
    return ok(removed);
  }

  /* ------------------------------------------------------------ 点赞：接口 */

  /**
   * 列出「我点过赞的评论 id」，返回 string 数组。
   * 没有数据 = 空数组（不是错误），和 listBooks 一致。
   * 只存 id、不存整个评论：评论正文属于社区（将来在后端），
   * 这里记的只是「我在本机的点赞痕迹」。
   */
  function listLikes() {
    return readList(KEY_LIKES);
  }

  /**
   * 点赞 / 取消点赞一条评论（同一条再点一次就是取消）。
   * 返回 { liked: true } = 现在是已赞，{ liked: false } = 已取消。
   */
  function toggleLike(commentId) {
    var id = cleanText(commentId);
    if (!id) return fail('评论标识不能为空');

    var likes = readList(KEY_LIKES);
    if (!likes.ok) return likes;

    var list = likes.data;
    var i = list.indexOf(id);
    var liked;
    if (i >= 0) {
      list.splice(i, 1);
      liked = false;
    } else {
      list.push(id);
      liked = true;
    }

    var written = writeList(KEY_LIKES, list);
    if (!written.ok) return written;
    return ok({ liked: liked });
  }

  /**
   * 已读的私信会话 id 列表。
   * 只记 id，不存会话正文——正文属于社区（将来在后端），
   * 这里只留「我在本机读过哪些会话」这一笔痕迹。
   * 没有记录 = 空数组（不是错误）。
   */
  function listReads() {
    return readList(KEY_READS);
  }

  /**
   * 把一个会话标记为已读。
   * 幂等：同一个会话重复标记不会重复入列，也不会报错。
   */
  function markRead(convId) {
    var id = cleanText(convId);
    if (!id) return fail('会话标识不能为空');

    var reads = readList(KEY_READS);
    if (!reads.ok) return reads;

    var list = reads.data;
    // 注意：这里存的是 id 字符串（不是对象），所以用 indexOf，
    // 不能用给对象数组准备的 indexOfId（它会读 list[i].id，对字符串恒为 -1）。
    if (list.indexOf(id) < 0) list.push(id);

    var written = writeList(KEY_READS, list);
    if (!written.ok) return written;
    return ok({ read: true });
  }

  /* -------------------------------------------------------------- 对外暴露 */

  global.Store = {
    STATUS: STATUS,
    KEY_BOOKS: KEY_BOOKS,
    KEY_NOTES: KEY_NOTES,
    KEY_LIKES: KEY_LIKES,
    KEY_READS: KEY_READS,

    isAvailable: isAvailable,

    addBook: addBook,
    listBooks: listBooks,
    getBook: getBook,
    updateBook: updateBook,
    deleteBook: deleteBook,
    countNotes: countNotes,

    // 只给 sync.js 的同步层用（整体覆盖书单/笔记，无确认）。界面代码别调。
    replaceBooks: replaceBooks,
    replaceNotes: replaceNotes,

    addNote: addNote,
    listNotes: listNotes,
    updateNote: updateNote,
    deleteNote: deleteNote,

    listLikes: listLikes,
    toggleLike: toggleLike,

    listReads: listReads,
    markRead: markRead
  };

})(window);
