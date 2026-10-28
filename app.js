/* ============================================================================
 * app.js —— 界面层（第一部分：书单管理）
 *
 * 依据
 *   docs/TECH_DESIGN.md 2.6（代码分成几块）、2.7（三个视图怎么切）
 *   docs/PRD.md 3.1（书单管理的动作/结果/边界）、4.1（页面必备元素）
 *
 * 范围（对应验收标准 AC-1 ~ AC-18）
 *   书单管理：添加 / 编辑 / 删除书籍（删除时连带删笔记的确认）、
 *             三态切换、状态筛选、空状态、封面与首字占位 …… AC-1 ~ AC-10
 *   阅读进度：录入当前页、百分比实时算、改「已读」即显示「读完」… AC-11 ~ AC-14
 *   读书笔记：写 / 改 / 删，只属于所属那本书 ………………… AC-15 ~ AC-18
 *
 * 进度相关的两条实现约定
 *   1. 百分比不存进数据，每次按 currentPage ÷ totalPages 现算
 *      （TECH_DESIGN 2.5 / PRD 4.2「派生值」）
 *   2. 状态为「想读」时进度区整块隐藏；为「已读」时不显示录入框，
 *      因为那时进度就是「读完」（PRD 3.2 可观察结果）
 *
 * 一条硬约束（TECH_DESIGN 2.11）
 *   本文件是普通脚本，不能用 import / export。原因：用模块方式打开会白屏。
 * ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------ 元素引用 */

  function byId(id) { return document.getElementById(id); }

  var el = {
    appError: byId('app-error'),

    btnAddBook: byId('btn-add-book'),
    btnAddFirst: byId('btn-add-first'),
    filters: byId('filters'),
    bookList: byId('book-list'),
    emptyState: byId('empty-state'),
    filterEmpty: byId('filter-empty'),
    filterEmptyText: byId('filter-empty-text'),
    btnShowAll: byId('btn-show-all'),

    btnBack: byId('btn-back'),
    btnEditBook: byId('btn-edit-book'),
    btnDeleteBook: byId('btn-delete-book'),
    detailCover: byId('detail-cover'),
    detailTitle: byId('detail-title'),
    detailAuthor: byId('detail-author'),
    detailStatus: byId('detail-status'),
    detailFinished: byId('detail-finished'),

    // 进度区：想读时整块隐藏（PRD 4.1）
    progressBox: byId('progress-box'),
    progressView: byId('progress-view'),
    progressForm: byId('progress-box').querySelector('.progress-form'),
    inputCurrentPage: byId('input-current-page'),
    btnSaveProgress: byId('btn-save-progress'),
    progressHint: byId('progress-hint'),

    // 笔记区
    noteCount: byId('note-count'),
    btnAddNote: byId('btn-add-note'),
    noteEditor: byId('note-editor'),
    noteContent: byId('note-content'),
    notePage: byId('note-page'),
    btnCancelNote: byId('btn-cancel-note'),
    btnSaveNote: byId('btn-save-note'),
    noteList: byId('note-list'),
    noteEmpty: byId('note-empty'),

    modalBook: byId('modal-book'),
    modalTitle: byId('modal-title'),
    formBook: byId('form-book'),
    inputTitle: byId('input-title'),
    inputAuthor: byId('input-author'),
    inputCover: byId('input-cover'),
    inputTotal: byId('input-total'),
    formError: byId('form-error'),
    btnCancelBook: byId('btn-cancel-book')
  };

  /* ------------------------------------------------------------ 界面状态 */

  var STATUS_TEXT = { want: '想读', reading: '在读', finished: '已读' };
  var STATUS_ORDER = ['want', 'reading', 'finished'];

  var state = {
    filter: 'all',        // all / want / reading / finished
    currentBookId: null,  // 详情页正在看哪本
    editingBookId: null,  // 书籍弹窗在编辑哪本；null = 新增
    editingNoteId: null,  // 笔记编辑器在改哪条；null = 新写一条
    loadTimer: null       // 加载态的计时器（Day 13）
  };

  /* -------------------------------------------------------------- 小工具 */

  function showError(msg) {
    el.appError.textContent = msg;
    el.appError.hidden = false;
  }

  function clearError() {
    el.appError.textContent = '';
    el.appError.hidden = true;
  }

  /** 数据层返回 ok:false 时统一处理：提示用户，不静默（TECH_DESIGN 3.4） */
  function report(res) {
    showError(res && res.error ? res.error : '操作失败，请重试');
  }

  /** 书名首字，用作没有封面时的占位（PRD AC-4） */
  function firstChar(title) {
    var chars = Array.from(String(title || '').trim());
    return chars.length ? chars[0] : '书';
  }

  /** 2026 年 9 月 25 日 */
  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  /**
   * 「第 120 / 320 页 · 38%」；没填总页数时不给百分比（PRD 3.2：不瞎猜）。
   * 百分比是实时算的，不存进数据里（TECH_DESIGN 2.5）。
   */
  function progressText(book) {
    var cur = book.currentPage;
    var total = book.totalPages;
    if (cur === null || cur === undefined) return '';
    if (!total) return '第 ' + cur + ' 页';
    return '第 ' + cur + ' / ' + total + ' 页 · ' + Math.round(cur / total * 100) + '%';
  }

  /**
   * 往容器里放封面（TECH_DESIGN 2.8）。
   * - 没填网址 → 书名首字（AC-4）
   * - 网址打不开 → 同样回退成首字，不留破图（AC-5）
   */
  function fillCover(container, book) {
    container.textContent = '';
    var url = String(book.coverUrl || '').trim();

    if (!url) {
      container.textContent = firstChar(book.title);
      return;
    }

    var img = document.createElement('img');
    img.alt = '';
    img.src = url;
    img.onerror = function () {
      container.textContent = firstChar(book.title);
    };
    container.appendChild(img);
  }

  function statusBadge(status) {
    var span = document.createElement('span');
    span.className = 'badge badge-' + status;
    span.textContent = STATUS_TEXT[status] || STATUS_TEXT.want;
    return span;
  }

  function buildBar(book) {
    if (!book.totalPages || book.currentPage === null || book.currentPage === undefined) return null;
    var wrap = document.createElement('div');
    wrap.className = 'bar';
    var fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = Math.min(100, Math.round(book.currentPage / book.totalPages * 100)) + '%';
    wrap.appendChild(fill);
    return wrap;
  }

  /* ---------------------------------------------- 加载态的两条设定（Day 13）
     写在前面是有原因的：下面的 window.AppViews 要立刻把 LOADING_MS 导出去，
     而 var 赋值有时序 —— 写在后面的话导出的会是 undefined。

     LOADING_MS 是「演加载」的等待时长。本机读数据是瞬时的，靠它把这一态演出来。
     测试把它设成 0 → 变成同步渲染（见 _ac_test.js / _d2d_test.js）；
     截图时设得很大，就能把骨架屏定住拍下来。 */
  var LOADING_MS = typeof window.__LOADING_MS__ === 'number' ? window.__LOADING_MS__ : 300;
  var LOADING_NOTE = '正在加载…（本地演示：接入后端后，这里会是真实的等待）';

  /* ---------------------------------------- 与路由层的接口（Day 13）

     约定（改动时别破坏，否则会死循环）：
       enterList / enterDetail 只「往页面里填内容」，绝不自己切页面；
       切页面是 community.js 路由层（window.Router）唯一的职责。
       这里若再调 go()，就和路由互相调用 —— 死循环。

     Day 13 之前，视图显隐散在三处（app.js 的 showView + community.js 的
     switchView 与三个 switchViewXxx），现在统一收进路由的 showOnly。 */

  function enterList() {
    state.currentBookId = null;
    renderList();          // 状态可能刚改过，回来要刷新（AC-6）
    return true;
  }

  function enterDetail(id) {
    var res = Store.getBook(id);
    if (!res.ok) { report(res); return false; }
    if (!res.data) {
      showError('这本书不存在，可能已被删除');
      return false;        // 交给路由退回书单
    }
    state.currentBookId = id;
    closeNoteEditor();          // 每次进详情页，笔记编辑器都是收起的
    renderDetail(res.data);
    return true;
  }

  // 跳转别名：项目里其他代码一直叫这两个名字，内部改成走路由（Day 13）
  function goList() {
    if (window.Router) { window.Router.go('/'); return; }
    enterList();             // 路由层还没就绪（极早期调用）时，至少把内容渲染对
  }

  function openDetail(id) {
    if (window.Router) { window.Router.go('/book/' + encodeURIComponent(id)); return; }
    enterDetail(id);
  }

  // 暴露给 community.js：路由层 + 加载态（Day 13 起它才真正被用到）
  window.AppViews = {
    enterList: enterList,
    enterDetail: enterDetail,
    showSkeleton: showSkeleton,
    LOADING_MS: LOADING_MS,
    LOADING_NOTE: LOADING_NOTE
  };

  /* ---------------------------------------------------------- 书单渲染 */

  function buildCard(book) {
    var card = document.createElement('article');
    card.className = 'book-card';
    card.setAttribute('data-id', book.id);
    card.tabIndex = 0;                      // 键盘也能选中

    var cover = document.createElement('div');
    cover.className = 'cover';
    fillCover(cover, book);
    card.appendChild(cover);

    var body = document.createElement('div');
    body.className = 'book-card-body';

    var title = document.createElement('h3');
    title.className = 'book-title';
    title.textContent = book.title;
    body.appendChild(title);

    if (book.author) {
      var author = document.createElement('p');
      author.className = 'book-author';
      author.textContent = book.author;
      body.appendChild(author);
    }

    body.appendChild(statusBadge(book.status));

    // 在读的书才显示进度（PRD 4.1：卡片上「（在读时）进度」）
    if (book.status === 'reading') {
      var text = progressText(book);
      if (text) {
        var line = document.createElement('p');
        line.className = 'progress-line';
        line.textContent = text;
        body.appendChild(line);
        var bar = buildBar(book);
        if (bar) body.appendChild(bar);
      }
    }

    card.appendChild(body);
    return card;
  }

  // 筛选项高亮（从 renderList 里抽出来：切档时要「立刻」亮，不等加载完）
  function renderFilterActive() {
    var btns = el.filters.querySelectorAll('.filter');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-status') === state.filter;
      if (on) btns[i].classList.add('is-active');
      else btns[i].classList.remove('is-active');
    }
  }

  /* -------------------------------------- 加载态（Day 13 的第四种状态）
     本机读数据是瞬时完成的，根本来不及「加载」。这里用一段约 300ms 的占位
     把这一态演出来，好让「空 / 加载 / 错误 / 正常」四种都能在页面上看见。
     接上后端后：把 startListLoading 里的定时器换成「等请求回来」即可。 */
  function showSkeleton(container, count, note) {
    container.textContent = '';
    container.hidden = false;
    container.setAttribute('aria-busy', 'true');   // 告诉读屏软件「正忙」
    for (var i = 0; i < count; i++) {
      var card = document.createElement('div');
      card.className = 'skeleton-card';
      card.setAttribute('aria-hidden', 'true');    // 占位块本身不用念
      var cov = document.createElement('div');
      cov.className = 'skeleton-block skeleton-cover';
      card.appendChild(cov);
      var body = document.createElement('div');
      body.className = 'skeleton-body';
      var l1 = document.createElement('div');
      l1.className = 'skeleton-block skeleton-line is-wide';
      var l2 = document.createElement('div');
      l2.className = 'skeleton-block skeleton-line is-narrow';
      body.appendChild(l1);
      body.appendChild(l2);
      card.appendChild(body);
      container.appendChild(card);
    }
    var p = document.createElement('p');
    p.className = 'skeleton-note';
    p.setAttribute('role', 'status');              // 读屏软件会播报这句
    p.textContent = note || LOADING_NOTE;
    container.appendChild(p);
  }

  // 切筛选档 = 走一次「加载中」：先骨架，过一会儿再出内容
  function startListLoading() {
    renderFilterActive();          // 高亮立刻跟上，点了才有反馈
    el.emptyState.hidden = true;
    el.filterEmpty.hidden = true;
    if (LOADING_MS <= 0) { renderList(); return; }   // 测试环境：不演加载
    showSkeleton(el.bookList, 3);
    if (state.loadTimer) window.clearTimeout(state.loadTimer);
    state.loadTimer = window.setTimeout(function () {
      state.loadTimer = null;
      renderList();
    }, LOADING_MS);
  }

  function renderList() {
    var res = Store.listBooks();
    if (!res.ok) { report(res); return; }

    var all = res.data;
    var shown = all.filter(function (b) {
      return state.filter === 'all' || b.status === state.filter;
    });

    renderFilterActive();

    el.bookList.textContent = '';
    el.bookList.setAttribute('aria-busy', 'false');   // 加载态收尾（Day 13）
    for (var k = 0; k < shown.length; k++) {
      el.bookList.appendChild(buildCard(shown[k]));
    }

    // 两种「空」要分开（PRD 4.1）：
    //   一本都没有     → AC-9 的空状态（带「添加第一本书」）
    //   有书但这档没有 → 一句提示 + 一个「看全部」的出口
    //   （后者是 Day 7 补的：原本一片空白，会被当成页面坏了）
    var none = all.length === 0;
    var noneHere = !none && shown.length === 0;

    el.emptyState.hidden = !none;
    el.filterEmpty.hidden = !noneHere;
    if (noneHere) {
      el.filterEmptyText.textContent = '没有「' + STATUS_TEXT[state.filter] + '」的书。';
    }
    el.bookList.hidden = none || noneHere;
  }

  /* ---------------------------------------------------------- 详情渲染 */

  function renderDetail(book) {
    fillCover(el.detailCover, book);
    el.detailTitle.textContent = book.title;
    el.detailAuthor.textContent = book.author || '未填作者';

    // 三态切换：当前状态那颗按钮置灰
    el.detailStatus.textContent = '';
    for (var i = 0; i < STATUS_ORDER.length; i++) {
      var s = STATUS_ORDER[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-sm' + (book.status === s ? ' is-active' : '');
      btn.setAttribute('data-status', s);
      btn.textContent = STATUS_TEXT[s];
      btn.disabled = book.status === s;
      el.detailStatus.appendChild(btn);
    }

    // 完成日期：改成「已读」时自动记为今天（AC-14）
    if (book.status === 'finished' && book.finishedAt) {
      el.detailFinished.textContent = '读完于 ' + formatDate(book.finishedAt);
      el.detailFinished.hidden = false;
    } else {
      el.detailFinished.textContent = '';
      el.detailFinished.hidden = true;
    }

    renderProgress(book);
    renderNotes(book.id);
  }

  /* ---------------------------------------------------------- 进度渲染 */

  /**
   * 进度区（AC-11 ~ AC-14）。
   * - 想读：整块隐藏（还没开始读，进度没有意义）
   * - 在读：显示「第 120 / 320 页 · 38%」+ 进度条 + 录入框
   * - 已读：显示「读完」，收起录入框
   */
  function renderProgress(book) {
    if (book.status === 'want') {
      el.progressBox.hidden = true;
      return;
    }
    el.progressBox.hidden = false;

    var finished = book.status === 'finished';

    // --- 显示区 ---
    el.progressView.textContent = '';
    if (finished) {
      var strong = document.createElement('strong');
      strong.textContent = '读完';
      el.progressView.appendChild(strong);
      if (book.totalPages) {
        el.progressView.appendChild(document.createTextNode(' · 共 ' + book.totalPages + ' 页'));
      }
    } else if (book.currentPage === null || book.currentPage === undefined) {
      el.progressView.textContent = '还没记录进度。';
    } else {
      el.progressView.textContent = progressText(book);   // 百分比在这里现算
    }

    // --- 录入区 ---
    el.progressForm.hidden = finished;

    // 进度条每次重画，先清掉上一条，免得越堆越多
    var oldBar = el.progressForm.querySelector('.bar');
    if (oldBar) oldBar.parentNode.removeChild(oldBar);

    if (!finished) {
      var bar = buildBar(book);
      if (bar) el.progressForm.appendChild(bar);

      el.inputCurrentPage.value = (book.currentPage === null || book.currentPage === undefined)
        ? '' : String(book.currentPage);
    } else {
      el.inputCurrentPage.value = '';
    }

    // AC-12：没填总页数就不给百分比。这里说明一句为什么没有，
    // 免得看起来像页面坏了。
    var needTotal = !finished && !book.totalPages;
    if (needTotal) {
      el.progressHint.textContent = '这本书没填总页数，所以算不出百分比。可以在上方「编辑」里补上。';
      el.progressHint.hidden = false;
    } else {
      el.progressHint.textContent = '';
      el.progressHint.hidden = true;
    }
  }

  /* ---------------------------------------------------------- 笔记渲染 */

  function buildNoteItem(note) {
    var li = document.createElement('li');
    li.className = 'note-item';
    li.setAttribute('data-id', note.id);

    var body = document.createElement('p');
    body.className = 'note-body';
    body.textContent = note.content;
    li.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'note-foot';

    // 「第 88 页 · 2026 年 9 月 25 日」——页码没填就只显示日期
    var bits = [];
    if (note.page !== null && note.page !== undefined) bits.push('第 ' + note.page + ' 页');
    var created = formatDate(note.createdAt);
    if (created) bits.push(created);

    var meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = bits.join(' · ');
    foot.appendChild(meta);

    var row = document.createElement('div');
    row.className = 'btn-row';
    row.appendChild(noteButton('edit', '编辑'));
    row.appendChild(noteButton('del', '删除', 'btn-danger'));
    foot.appendChild(row);

    li.appendChild(foot);
    return li;
  }

  function noteButton(act, text, extraClass) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm' + (extraClass ? ' ' + extraClass : '');
    btn.setAttribute('data-act', act);
    btn.textContent = text;
    return btn;
  }

  /** 只重画笔记区（写完、改完、删完时用），不动整页 */
  function renderNotes(bookId) {
    var res = Store.listNotes(bookId);
    if (!res.ok) { report(res); return; }

    var notes = res.data;

    el.noteList.textContent = '';
    for (var i = 0; i < notes.length; i++) {
      el.noteList.appendChild(buildNoteItem(notes[i]));
    }

    el.noteEmpty.hidden = notes.length > 0;
    el.noteCount.textContent = notes.length > 0 ? '共 ' + notes.length + ' 条' : '';

    // 正在编辑的那条如果已经不存在了（比如在别处删掉了），把编辑器也收掉
    if (state.editingNoteId) {
      var still = false;
      for (var k = 0; k < notes.length; k++) {
        if (notes[k].id === state.editingNoteId) { still = true; break; }
      }
      if (!still) closeNoteEditor();
    }
  }

  /** 按 id 找一条笔记（数据层没有单独的 getNote，从本书笔记里找） */
  function findNote(bookId, noteId) {
    var res = Store.listNotes(bookId);
    if (!res.ok) { report(res); return null; }
    for (var i = 0; i < res.data.length; i++) {
      if (res.data[i].id === noteId) return res.data[i];
    }
    return null;
  }

  /* -------------------------------------------------------- 笔记编辑器 */

  /** note 传 null 表示新写一条 */
  function openNoteEditor(note) {
    state.editingNoteId = note ? note.id : null;
    el.noteContent.value = note ? note.content : '';
    el.notePage.value = (note && note.page !== null && note.page !== undefined)
      ? String(note.page) : '';
    el.btnSaveNote.textContent = note ? '保存修改' : '保存';
    el.noteEditor.hidden = false;
    el.noteContent.focus();
  }

  /** 取消：什么都不写回去，原内容自然保持不变（PRD 3.3 异常处理） */
  function closeNoteEditor() {
    el.noteEditor.hidden = true;
    el.noteContent.value = '';
    el.notePage.value = '';
    state.editingNoteId = null;
  }

  /* ------------------------------------------------------------ 弹窗 */

  function openBookModal(book) {
    state.editingBookId = book ? book.id : null;
    el.modalTitle.textContent = book ? '编辑书籍' : '添加书籍';
    el.inputTitle.value = book ? book.title : '';
    el.inputAuthor.value = book ? (book.author || '') : '';
    el.inputCover.value = book ? (book.coverUrl || '') : '';
    el.inputTotal.value = (book && book.totalPages !== null && book.totalPages !== undefined)
      ? String(book.totalPages) : '';
    el.formError.textContent = '';
    el.formError.hidden = true;
    el.modalBook.hidden = false;
    el.inputTitle.focus();
  }

  function closeBookModal() {
    el.modalBook.hidden = true;
    state.editingBookId = null;
  }

  /* ------------------------------------------------------------ 事件 */

  // 添加书籍（两处入口）
  el.btnAddBook.addEventListener('click', function () { openBookModal(null); });
  el.btnAddFirst.addEventListener('click', function () { openBookModal(null); });

  /**
   * 页数输入框的值 → 数字或 null（Day 30 修）。
   * input.value 永远是字符串；空串代表"没填"（null），不是 0。
   * 非数字原样返回，交给 Store 去报那句中文错误。
   */
  function toPageNumber(v) {
    var t = String(v === undefined || v === null ? '' : v).trim();
    if (t === '') return null;
    var n = Number(t);
    return (isFinite(n) && Math.floor(n) === n) ? n : t;
  }

  el.btnCancelBook.addEventListener('click', function () { closeBookModal(); });

  // 保存（新增或编辑共用）
  el.formBook.addEventListener('submit', function (e) {
    e.preventDefault();

    var editingId = state.editingBookId;
    var payload = {
      title: el.inputTitle.value,
      author: el.inputAuthor.value,
      coverUrl: el.inputCover.value,
      // Day 30 修：这里原来直接塞 input.value（字符串 "320"），服务端不认，总页数永远存不进云端
      totalPages: toPageNumber(el.inputTotal.value)
    };

    var res = editingId ? Store.updateBook(editingId, payload) : Store.addBook(payload);

    if (!res.ok) {
      // AC-2：弹窗不关闭，就地说明哪里不对
      el.formError.textContent = res.error || '保存失败';
      el.formError.hidden = false;
      return;
    }

    closeBookModal();
    clearError();

    if (editingId) {
      renderDetail(res.data);   // 详情页立刻更新（AC-8）
      renderList();             // 列表页也同步
    } else {
      // 新增后切回「全部」——AC-1 要求新书「立刻出现」，
      // 若停在「已读」等筛选档下就看不见它。
      state.filter = 'all';
      renderList();
      goList();                 // 回书单页，地址同步为 #/（Day 13 走路由）
      window.scrollTo(0, 0);
    }
  });

  // 点卡片进详情
  el.bookList.addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('.book-card') : null;
    if (card) openDetail(card.getAttribute('data-id'));
  });

  // 键盘回车／空格也能进（卡片带了 tabIndex）
  el.bookList.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest ? e.target.closest('.book-card') : null;
    if (!card) return;
    e.preventDefault();
    openDetail(card.getAttribute('data-id'));
  });

  // 筛选（切档走一次加载态：先骨架、过一会儿再出内容）
  el.filters.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.filter') : null;
    if (!btn) return;
    var s = btn.getAttribute('data-status');
    if (!s || s === state.filter) return;   // 点当前档不重来一遍（Day 13）
    state.filter = s;
    startListLoading();
  });

  // 「没有 XX 的书」那句提示里的出口
  el.btnShowAll.addEventListener('click', function () {
    if (state.filter === 'all') return;
    state.filter = 'all';
    startListLoading();
  });

  // 详情页：状态切换（AC-6）
  el.detailStatus.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-status]') : null;
    if (!btn || btn.disabled) return;

    var res = Store.updateBook(state.currentBookId, { status: btn.getAttribute('data-status') });
    if (!res.ok) { report(res); return; }

    clearError();
    renderDetail(res.data);
  });

  el.btnBack.addEventListener('click', goList);

  /* ---------------- 阅读进度（AC-11 ~ AC-14） ---------------- */

  // 保存进度：页数不合法就不写进去，并说明原因（AC-13）
  /* ---------------- 保存成功后的按钮反馈（Day 14）----------------
     Day 14 真人测试发现：点「保存进度」后按钮本身毫无变化，对方盯着按钮
     等回应，以为没保存上（原来的反馈在下面的百分比/进度条上，而他的视线
     在按钮上）。这里让按钮自己回一句「已保存」，1.5 秒后恢复。 */
  function flashSaved(btn) {
    if (!btn || !btn.classList) return;
    if (btn._savedTimer) window.clearTimeout(btn._savedTimer);
    var orig = btn.getAttribute('data-saved-orig');
    if (!orig) { orig = btn.textContent; btn.setAttribute('data-saved-orig', orig); }
    btn.textContent = '已保存 ✓';
    btn.disabled = true;
    btn.classList.add('is-saved');
    btn._savedTimer = window.setTimeout(function () {
      btn.textContent = orig;
      btn.disabled = false;
      btn.classList.remove('is-saved');
      btn._savedTimer = null;
    }, 1500);
  }

  el.btnSaveProgress.addEventListener('click', function () {
    if (!state.currentBookId) return;

    // Day 30 修：同样是从 input 拿的字符串，转成数字再交给 Store
    var res = Store.updateBook(state.currentBookId, { currentPage: toPageNumber(el.inputCurrentPage.value) });
    if (!res.ok) { showError(res.error || '进度没能保存'); return; }

    clearError();
    renderDetail(res.data);          // 页数与百分比立刻刷新（AC-11 / AC-12）
    flashSaved(el.btnSaveProgress);  // 按钮自己也回一句（Day 14 用户测试）
  });

  // 输入框里直接回车，等同于点「保存进度」
  el.inputCurrentPage.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    el.btnSaveProgress.click();
  });

  /* ---------------- 读书笔记（AC-15 ~ AC-18） ---------------- */

  el.btnAddNote.addEventListener('click', function () { openNoteEditor(null); });

  el.btnCancelNote.addEventListener('click', function () {
    closeNoteEditor();               // 取消不动数据，原内容保持不变
  });

  el.btnSaveNote.addEventListener('click', function () {
    var bookId = state.currentBookId;
    if (!bookId) return;

    var editingId = state.editingNoteId;
    var content = el.noteContent.value;
    var page = el.notePage.value;

    var res = editingId
      ? Store.updateNote(editingId, { content: content, page: page })   // AC-17：改原来那条
      : Store.addNote({ bookId: bookId, content: content, page: page });

    if (!res.ok) { showError(res.error || '笔记没能保存'); return; }

    closeNoteEditor();
    clearError();
    renderNotes(bookId);             // 最新的一条排在最上面（AC-15）
  });

  // 每条笔记上的「编辑」「删除」
  el.noteList.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;

    var li = btn.closest ? btn.closest('.note-item') : null;
    if (!li) return;

    var bookId = state.currentBookId;
    if (!bookId) return;
    var noteId = li.getAttribute('data-id');

    if (btn.getAttribute('data-act') === 'edit') {
      var note = findNote(bookId, noteId);
      if (!note) { showError('这条笔记不存在，可能已被删除'); renderNotes(bookId); return; }
      openNoteEditor(note);
      return;
    }

    // 删除笔记：先确认一次，避免误删（PRD 3.3 异常处理 / AC-22）
    // Day 30：换成站内弹窗，不再是浏览器那个灰框
    confirmDialog({
      title: '删除这条笔记？',
      message: '删除后无法恢复。',
      okText: '删除'
    }).then(function (yes) {
      if (!yes) return;

      var res = Store.deleteNote(noteId);
      if (!res.ok) { report(res); return; }

      clearError();
      renderNotes(bookId);
    });
  });

  // 编辑这本书（AC-8）
  el.btnEditBook.addEventListener('click', function () {
    var res = Store.getBook(state.currentBookId);
    if (!res.ok) { report(res); return; }
    if (!res.data) { showError('这本书不存在，可能已被删除'); return; }
    openBookModal(res.data);
  });

  // 删除这本书（AC-10：先确认，并写明会连带删掉几条笔记）
  el.btnDeleteBook.addEventListener('click', function () {
    var id = state.currentBookId;
    if (!id) return;

    var bookRes = Store.getBook(id);
    if (!bookRes.ok) { report(bookRes); return; }
    if (!bookRes.data) { showError('这本书不存在，可能已被删除'); goList(); return; }

    var cntRes = Store.countNotes(id);
    if (!cntRes.ok) { report(cntRes); return; }   // 数不出来就不删，免得提示不准确

    // Day 30：换成站内弹窗
    var noteCount = cntRes.data;
    confirmDialog({
      title: '删除《' + bookRes.data.title + '》？',
      message: noteCount > 0
        ? '这本书的 ' + noteCount + ' 条笔记会一并删除。删除后无法恢复。'
        : '删除后无法恢复。',
      okText: '删除'
    }).then(function (yes) {
      if (!yes) return;

      var res = Store.deleteBook(id);
      if (!res.ok) { report(res); return; }

      clearError();
      goList();
    });
  });

  /**
   * 站内确认弹窗（Day 30）。
   *
   * 为什么不用 window.confirm：
   *   它是浏览器画的原生框 —— 灰底、系统字体、按钮样式固定，跟星海主题完全是两张皮。
   *   移动端上更丑（直接顶在页面中间），而且它**会阻塞整个 JS 线程**。
   *
   * 这里复用站内已有的 .modal / .modal-card / .modal-foot 三个类，
   * 所以配色、圆角、阴影自动跟其他弹窗一致，主题换了它也跟着换。
   *
   * @returns Promise<boolean>  点了确定是 true，取消/按 Esc/点遮罩都是 false
   */
  function confirmDialog(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'modal';
      mask.setAttribute('role', 'dialog');
      mask.setAttribute('aria-modal', 'true');

      var card = document.createElement('div');
      card.className = 'modal-card';

      var title = document.createElement('h2');
      title.textContent = o.title || '确认';
      card.appendChild(title);

      if (o.message) {
        var text = document.createElement('p');
        text.className = 'dialog-text';
        text.textContent = o.message;
        card.appendChild(text);
      }

      var foot = document.createElement('div');
      foot.className = 'modal-foot';

      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.textContent = o.cancelText || '取消';

      var okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'btn ' + (o.danger === false ? 'btn-primary' : 'btn-danger');
      okBtn.textContent = o.okText || '确定';

      foot.appendChild(cancelBtn);
      foot.appendChild(okBtn);
      card.appendChild(foot);
      mask.appendChild(card);
      document.body.appendChild(mask);

      // 焦点先落在「取消」上：危险操作不该让一个回车就确认掉
      setTimeout(function () { cancelBtn.focus(); }, 0);

      var done = false;
      function close(result) {
        if (done) return;          // 连点/重复触发只认第一次
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        // 焦点困在弹窗里：Tab 只在两个按钮之间转（不跑到背后的页面上）
        if (e.key === 'Tab') {
          var first = cancelBtn, last = okBtn;
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }

      document.addEventListener('keydown', onKey, true);
      cancelBtn.addEventListener('click', function () { close(false); });
      okBtn.addEventListener('click', function () { close(true); });
      mask.addEventListener('click', function (e) {
        if (e.target === mask) close(false);   // 点空白遮罩 = 取消
      });
    });
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    if (!window.Store) {
      // 不白屏：至少告诉用户出了什么事（AC-23）
      showError('数据模块没能加载，页面无法使用，请刷新重试。');
      return;
    }

    if (!Store.isAvailable()) {
      showError('浏览器的本地存储不可用（可能开着无痕模式），数据将无法保存。');
    }

    // 进度区的显隐跟着状态走，由 renderProgress 决定；
    // 笔记区一直显示（没有笔记时由 renderNotes 给一句提示）。
    closeNoteEditor();

    renderList();
    // 视图显隐交给 community.js 的路由层（Day 13）：
    // 它会按地址栏的 hash 决定落到哪一页。
  }

  // 兜底：任何未预期的报错都不该让页面变成一片空白
  window.addEventListener('error', function (e) {
    showError('页面出错了：' + (e.message || '未知错误'));
  });

  init();

})();
