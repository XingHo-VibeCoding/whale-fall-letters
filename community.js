/* ============================================================================
 * community.js —— 阅读社区层（Day 11 新增）
 *
 * 依据 docs/COMMUNITY_DESIGN.md：把「鲸落书简」从个人记录本升级为公开阅读社区。
 * 本文件负责：顶部导航切换、登录/注册（mock）、论坛帖子流、热门书籍排行、
 *            帖子详情与评论、私信（一对一对话）、「我的」页。
 *
 * ⚠️ 本轮边界（COMMUNITY_DESIGN.md 第 11 节）：
 *   - 只做前端界面 + 数据 mock，涉及后端的一律不做。
 *   - 数据暂存内存（刷新即清空），后端就绪后把 data.* 换成接口调用即可。
 *   - 沿用 {ok, data|error} 返回约定，错误码按文档 3.x 预留。
 *
 * 硬约束：普通 <script>，不能用 import/export（file:// 会白屏）。
 * 加载顺序：store.js → app.js → community.js（要读 window.AppViews）。
 * ========================================================================== */

(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  /* =============================================================
   * 0. mock 数据（刷新即清空；后端就绪后换成接口）
   * ============================================================= */

  // 预设头像色板（色块头像可选）
  var AVATAR_COLORS = ['#1f6f6b', '#b3261e', '#7a6a4f', '#2f6b3a', '#5b5bd6', '#b0643a', '#8a3ab0', '#3a7a8a'];

  // 已注册账号（模拟数据库 users 表）。密码只存明文做演示，
  // 真实后端会存哈希（COMMUNITY_DESIGN.md 4.2），这里绝不照搬。
  // avatar：字符串——色块颜色值（如 '#1f6f6b'）或图片 dataURL；空=用首字占位
  // shelves：该用户的书单，四类：want 想读 / reading 在读 / finished 已读 / favorite 喜欢
  var MOCK_USERS = [
    {
      id: 'user_1', username: '阿澈', avatar: '', bio: '喜欢科幻和推理',
      shelves: {
        want: ['沙丘', '银河帝国'],
        reading: ['三体'],
        finished: ['球状闪电', '献给阿尔吉侬的花束'],
        favorite: ['三体', '银河系漫游指南']
      }
    },
    {
      id: 'user_2', username: '小林', avatar: '', bio: '在读历史类',
      shelves: {
        want: ['万历十五年'],
        reading: ['明朝那些事儿'],
        finished: ['人类简史'],
        favorite: ['明朝那些事儿']
      }
    },
    {
      id: 'user_3', username: '月白', avatar: '', bio: '什么都读一点',
      shelves: {
        want: ['百年孤独'],
        reading: [],
        finished: ['围城', '活着'],
        favorite: ['百年孤独', '活着']
      }
    }
  ];

  // 帖子（模拟 posts 表）
  var MOCK_POSTS = [
    {
      id: 'post_1', authorId: 'user_1', title: '三体', author: '刘慈欣',
      coverUrl: '', content: '读完第二遍了，黑暗森林法则越想越冷。你们觉得宇宙社会学成立吗？',
      createdAt: '2026-09-30T10:00:00', comments: [
        { id: 'c1', authorId: 'user_2', content: '成立，但那是零和博弈下的推演。', createdAt: '2026-09-30T10:20:00' },
        { id: 'c2', authorId: 'user_3', content: '我更喜欢死神永生里的二向箔。', createdAt: '2026-09-30T11:05:00' }
      ]
    },
    {
      id: 'post_2', authorId: 'user_2', title: '明朝那些事儿', author: '当年明月',
      coverUrl: '', content: '把历史写活了的典范，轻松又好读，适合入门。',
      createdAt: '2026-09-29T21:00:00', comments: [
        { id: 'c3', authorId: 'user_1', content: '确实，我三天看完了前三册。', createdAt: '2026-09-29T21:40:00' }
      ]
    },
    {
      id: 'post_3', authorId: 'user_3', title: '百年孤独', author: '加西亚·马尔克斯',
      coverUrl: '', content: '人名太难记了，但读进去之后放不下。有人同感吗？',
      createdAt: '2026-09-28T14:30:00', comments: []
    }
  ];

  // 全站收藏量（mock）。按「书名」存而不是按帖子 —— 同一本书有多个帖子时，
  // 收藏量必须是同一个数，不能各算各的。
  var MOCK_FAVORITES = {
    '三体': 128,
    '明朝那些事儿': 96,
    '百年孤独': 342
  };

  // 每条评论的点赞量（mock）。按评论 id 存；用户新发的评论不在表里，基数算 0。
  // 显示出来的数 = 这里的基数 + 我自己点没点过（我是第 1 个赞就 +1）。
  var MOCK_COMMENT_LIKES = {
    'c1': 12,
    'c2': 5,
    'c3': 8
  };

  // 私信会话（模拟 conversations / messages）
  // unread: true = 对方发来的、我还没读的那条。
  // 「我读过了没有」不写在这里 —— 它存在本机（Store 的 reading:conv-reads），
  // 所以刷新页面之后已读状态还在。
  var MOCK_CONVERSATIONS = [
    {
      id: 'conv_1', peerId: 'user_2', peerName: '小林',
      messages: [
        { fromId: 'user_2', content: '你也喜欢三体啊！', createdAt: '2026-09-30T11:00:00' },
        { fromId: 'me', content: '是啊，刚看完第二部。', createdAt: '2026-09-30T11:02:00' },
        { fromId: 'user_2', content: '要不要聊聊黑暗森林？', createdAt: '2026-09-30T11:03:00', unread: true }
      ]
    },
    {
      id: 'conv_2', peerId: 'user_3', peerName: '月白',
      messages: [
        { fromId: 'me', content: '你那本《百年孤独》看完了吗？', createdAt: '2026-09-30T14:20:00' },
        { fromId: 'user_3', content: '刚看完，结尾那阵风一来，我整个人都愣住了。', createdAt: '2026-09-30T14:22:00', unread: true }
      ]
    }
  ];

  // 运行期状态
  var state = {
    currentUser: null,          // 登录用户（null=未登录）
    currentRange: 'day',        // 热门档位
    hotTimer: null,             // 榜单加载态的计时器（Day 13）
    currentPostId: null,        // 正在看的帖子
    currentConvId: null,        // 正在聊的会话
    openConvOnEnter: false,     // 进私信页时是否要直接展开某段对话（「私信 TA」入口）
    authMode: 'login',          // login / register
    avatarColor: null,          // 注册时选中的色块头像颜色（null=未选）
    avatarImage: null,          // 注册时上传的图片头像 dataURL（null=未传）
    postFromBook: false,        // 帖子详情是从「同书列表」进来的吗
    lastBookTitle: null,        // 最近一次点热门书看的是哪本（返回时用）
    profileUserId: null         // 正在看的个人主页属于谁（null=未打开）
  };

  /* =============================================================
   * 1. 小工具
   * ============================================================= */

  function firstChar(s) {
    var chars = Array.from(String(s || '').trim());
    return chars.length ? chars[0] : '书';
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var diff = Math.floor((now - d) / 1000);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function usernameById(id) {
    if (id === 'me') return state.currentUser ? state.currentUser.username : '我';
    for (var i = 0; i < MOCK_USERS.length; i++) {
      if (MOCK_USERS[i].id === id) return MOCK_USERS[i].username;
    }
    return '读者';
  }

  function userById(id) {
    if (id === 'me') return state.currentUser;
    for (var i = 0; i < MOCK_USERS.length; i++) {
      if (MOCK_USERS[i].id === id) return MOCK_USERS[i];
    }
    return null;
  }

  // 某用户发的帖子（按时间倒序）
  function postsByUser(userId) {
    var out = [];
    for (var i = 0; i < MOCK_POSTS.length; i++) {
      if (MOCK_POSTS[i].authorId === userId) out.push(MOCK_POSTS[i]);
    }
    out.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    return out;
  }

  // 某用户发的评论（按时间倒序），附带所属帖子标题方便跳转
  function commentsByUser(userId) {
    var out = [];
    for (var i = 0; i < MOCK_POSTS.length; i++) {
      var p = MOCK_POSTS[i];
      if (!p.comments) continue;
      for (var j = 0; j < p.comments.length; j++) {
        if (p.comments[j].authorId === userId) {
          out.push({ comment: p.comments[j], postTitle: p.title, postId: p.id });
        }
      }
    }
    out.sort(function (a, b) { return new Date(b.comment.createdAt) - new Date(a.comment.createdAt); });
    return out;
  }

  /**
   * 统一头像渲染：avatar 可能是
   *   - 空字符串 → 首字占位（默认墨绿渐变）
   *   - '#xxxxxx' 色值 → 色块底 + 首字
   *   - data:image/... 或 http(s) URL → 直接放 <img>
   */
  function renderAvatar(container, username, avatar) {
    container.textContent = '';
    var name = username || '';
    var av = String(avatar || '').trim();

    if (av && av.indexOf('data:') === 0) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = av;
      container.appendChild(img);
      return;
    }
    if (av && av.indexOf('http') === 0) {
      var img2 = document.createElement('img');
      img2.alt = '';
      img2.src = av;
      img2.onerror = function () { container.textContent = firstChar(name); };
      container.appendChild(img2);
      return;
    }
    if (av && av.charAt(0) === '#') {
      container.textContent = firstChar(name);
      container.style.background = av;
      return;
    }
    container.textContent = firstChar(name);
    container.style.background = '';
  }

  function showError(msg) {
    var box = byId('app-error');
    box.textContent = msg;
    box.hidden = false;
  }
  function clearError() {
    var box = byId('app-error');
    box.textContent = '';
    box.hidden = true;
  }

  // 成功提示条：几秒后自动消失（注册/登录成功等正向反馈）
  var successTimer = null;
  function showSuccess(msg) {
    var box = byId('app-success');
    if (!box) return;
    box.textContent = msg;
    box.hidden = false;
    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(function () { box.hidden = true; }, 3000);
  }
  function clearSuccess() {
    var box = byId('app-success');
    if (box) { box.textContent = ''; box.hidden = true; }
  }

  /* =============================================================
   * 2. 路由（Day 13）
   *
   * 地址栏里 # 后面那截，就是「现在在哪一页」。用 hash 而不是普通路径，
   * 是因为本项目要能双击 index.html（file://）打开 —— 实测在 file:// 下
   * history.pushState 改路径会直接抛 SecurityError（origin 是 null），
   * 而改 hash 与 location.hash 赋值都正常。
   *
   *   #/                  书单（首页）
   *   #/forum             论坛
   *   #/messages          私信
   *   #/me                我的
   *   #/login             登录 / 注册
   *   #/book/:id          书详情
   *   #/post/:id          帖子详情
   *   #/book-posts/:标题  同书讨论
   *   #/user/:id          个人主页
   *
   * 三条约定（改动时别破坏，否则会死循环或连跳两次）：
   *   1. go()         只改地址，不碰页面
   *   2. applyRoute() 是唯一决定「显示哪个页面」的地方
   *   3. enterXxx()   只往页面里填内容，绝不自己切页面
   * ============================================================= */

  var VIEW_IDS = ['view-list', 'view-detail', 'view-forum', 'view-post', 'view-book-posts', 'view-messages', 'view-me', 'view-auth', 'view-profile', 'view-api-demo'];

  // 导航栏按钮的 data-nav 值 → 路由路径
  var NAV_PATH = {
    home: '/',
    forum: '/forum',
    messages: '/messages',
    me: '/me',
    login: '/login',
    api: '/api-demo'   // Day 17：接口数据只读演示页
  };

  // 地址里的参数可能是编码过的（中文书名），解不开就按原样用，不要抛错
  function decodeParam(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  // fallback：地址里的东西不存在（书/帖/用户已删）时退到哪一级
  var ROUTES = [
    { re: /^\/book-posts\/(.+)$/, view: 'view-book-posts', nav: null, fallback: '/forum', enter: function (m) { return enterBookPosts(decodeParam(m[1])); } },
    { re: /^\/book\/([^\/]+)$/, view: 'view-detail', nav: null, fallback: '/', enter: function (m) { return window.AppViews.enterDetail(decodeParam(m[1])); } },
    { re: /^\/post\/([^\/]+)$/, view: 'view-post', nav: null, fallback: '/forum', enter: function (m) { return enterPost(decodeParam(m[1])); } },
    { re: /^\/user\/([^\/]+)$/, view: 'view-profile', nav: null, fallback: '/forum', enter: function (m) { return enterProfile(decodeParam(m[1])); } },
    { re: /^\/forum$/, view: 'view-forum', nav: 'forum', enter: function () { renderForum(); return true; } },
    { re: /^\/messages$/, view: 'view-messages', nav: 'messages', enter: function () { enterMessages(); return true; } },
    { re: /^\/me$/, view: 'view-me', nav: 'me', enter: function () { renderMe(); renderGuard(); return true; } },
    { re: /^\/login$/, view: 'view-auth', nav: 'login', enter: function () { renderAuth(); return true; } },
    { re: /^\/api-demo$/, view: 'view-api-demo', nav: 'api', enter: function () { enterApiDemo(); return true; } },
    { re: /^\/(shelf)?$/, view: 'view-list', nav: 'home', enter: function () { window.AppViews.enterList(); renderGuard(); return true; } }
  ];

  function parseRoute(hash) {
    var path = String(hash || '').replace(/^#/, '');
    if (path === '') path = '/';
    for (var i = 0; i < ROUTES.length; i++) {
      var m = path.match(ROUTES[i].re);
      if (m) return { def: ROUTES[i], params: m };
    }
    return null;
  }

  // 唯一的「显示哪个视图」实现（原来散在三套切换函数里，Day 13 合并）
  function showOnly(viewId) {
    for (var i = 0; i < VIEW_IDS.length; i++) {
      var v = byId(VIEW_IDS[i]);
      if (v) v.hidden = (VIEW_IDS[i] !== viewId);
    }
  }

  function highlightNav(navName) {
    var links = document.querySelectorAll('.site-nav-link');
    for (var i = 0; i < links.length; i++) {
      var on = !!navName && links[i].getAttribute('data-nav') === navName;
      if (on) links[i].classList.add('is-active');
      else links[i].classList.remove('is-active');
    }
  }

  // 只改地址。地址没变时（已在目标页）手动重放一次，保证内容是最新的。
  function go(path) {
    var target = '#' + path;
    if (location.hash === target) { applyRoute(false); return; }
    location.hash = target;   // 触发 hashchange → applyRoute
  }

  // isBoot = true：启动阶段。这时不能擦掉 app.js 刚设的「存储不可用」告警
  // （Day 12 修复的 bug，别改回去）。
  //
  // skipClear：兜底跳转（地址不认识 / 内容已删）时用。跳转本身会再触发一次
  // applyRoute，若那时照常 clearError，就会把刚给用户的提示擦掉 ——
  // Day 13 实测踩到：乱输地址时提示条一闪就没。
  var skipClear = false;

  function applyRoute(isBoot) {
    var r = parseRoute(location.hash);
    if (!r) {
      skipClear = true;
      go('/');
      if (!isBoot) showError('找不到这个地址，已回到书单。');
      return;
    }
    showOnly(r.def.view);
    highlightNav(r.def.nav);
    if (!isBoot && !skipClear) clearError();
    skipClear = false;
    var entered = r.def.enter(r.params);
    if (entered === false) {
      // 内容不存在（书/帖/人已删）：enter 里已给出具体原因，跳走时别擦掉它
      skipClear = true;
      go(r.def.fallback || '/');
      return;
    }
    renderNavBadge();
    window.scrollTo(0, 0);
  }

  // 暴露给 app.js：它那边的 goList() / openDetail() 改成走路由
  window.Router = {
    go: function (path) { go(path); },
    apply: function () { applyRoute(false); }
  };

  window.addEventListener('hashchange', function () { applyRoute(false); });

  function bindNav() {
    document.addEventListener('click', function (e) {
      // e.target 可能是文本节点，统一先取元素再 closest，避免空引用
      var t = e.target;
      var el = t && t.nodeType === 1 ? t : (t && t.parentNode ? t.parentNode : null);
      var nav = el && el.closest ? el.closest('[data-nav]') : null;
      if (!nav) return;
      var name = nav.getAttribute('data-nav');
      // 登录按钮和导航里的登录入口共用 data-nav="login"
      go(NAV_PATH[name] || '/');
    });
  }

  /* =============================================================
   * 3. 封面渲染（复用首字占位；Google Books 真接等后端打卡）
   * ============================================================= */

  function fillCover(container, title, url) {
    container.textContent = '';
    var u = String(url || '').trim();
    if (!u) {
      container.textContent = firstChar(title);
      return;
    }
    var img = document.createElement('img');
    img.alt = '';
    img.src = u;
    img.onerror = function () { container.textContent = firstChar(title); };
    container.appendChild(img);
  }

  /* =============================================================
   * 4. 论坛：热门排行 + 帖子流
   * ============================================================= */

  // 讨论量 = 帖子数 + 评论数（COMMUNITY_DESIGN.md 6.1）
  function postHeat(post) {
    return 1 + (post.comments ? post.comments.length : 0);
  }

  // 按书名聚合讨论量（COMMUNITY_DESIGN.md 6.3）
  function aggregateHot() {
    var map = {};
    for (var i = 0; i < MOCK_POSTS.length; i++) {
      var p = MOCK_POSTS[i];
      if (!map[p.title]) map[p.title] = { title: p.title, author: p.author, coverUrl: p.coverUrl, heat: 0 };
      map[p.title].heat += postHeat(p);
    }
    var arr = [];
    for (var k in map) arr.push(map[k]);
    arr.sort(function (a, b) { return b.heat - a.heat; });
    return arr;
  }

  function renderHot() {
    var list = byId('hot-list');
    var empty = byId('hot-empty');
    list.textContent = '';
    list.setAttribute('aria-busy', 'false');   // 加载态收尾（Day 13）

    var hot = aggregateHot();
    if (hot.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;

    for (var i = 0; i < hot.length; i++) {
      var item = hot[i];
      var li = document.createElement('li');
      li.className = 'hot-item';
      li.setAttribute('data-title', item.title);

      var rank = document.createElement('span');
      rank.className = 'hot-rank' + (i < 3 ? ' hot-rank-top' : '');
      rank.textContent = String(i + 1);
      li.appendChild(rank);

      var cover = document.createElement('div');
      cover.className = 'cover cover-sm';
      fillCover(cover, item.title, item.coverUrl);
      li.appendChild(cover);

      var body = document.createElement('div');
      body.className = 'hot-body';

      // 书名与收藏按钮同一行（与论坛帖子卡片保持一致）
      var titleRow = document.createElement('div');
      titleRow.className = 'hot-title-row';

      var t = document.createElement('p');
      t.className = 'hot-title';
      t.textContent = item.title;
      titleRow.appendChild(t);

      var fav = document.createElement('button');
      fav.type = 'button';
      fav.className = 'fav-btn';
      renderFavButton(fav, item);
      (function (btn, data) {
        btn.addEventListener('click', function (e) { onFavClick(e, btn, data); });
      })(fav, item);
      titleRow.appendChild(fav);

      body.appendChild(titleRow);

      // 作者名单独包一层：悬停要弹作者卡，而和「N 次讨论」拼在一段纯文本里挂不了事件
      var meta = document.createElement('p');
      meta.className = 'muted sub';
      if (item.author) {
        var authorEl = document.createElement('span');
        authorEl.className = 'hot-author';
        authorEl.textContent = item.author;
        meta.appendChild(authorEl);
        meta.appendChild(document.createTextNode(' · '));
      }
      meta.appendChild(document.createTextNode(item.heat + ' 次讨论'));
      body.appendChild(meta);
      li.appendChild(body);

      var go = document.createElement('span');
      go.className = 'hot-go';
      go.textContent = '去讨论 ›';
      li.appendChild(go);

      list.appendChild(li);
    }
  }

  function renderPosts() {
    var list = byId('post-list');
    var empty = byId('post-empty');
    list.textContent = '';

    if (MOCK_POSTS.length === 0) { empty.hidden = false; return; }
    empty.hidden = true;

    var posts = MOCK_POSTS.slice().sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    for (var i = 0; i < posts.length; i++) {
      list.appendChild(buildPostCard(posts[i]));
    }
  }

  /* =============================================================
   * 4.1 收藏按钮（Day 11 新增）
   *
   * 反馈的落点：点一下，按钮自己的「星芒形状 + 文字 + 数字」三处同时变，
   * 反馈正落在用户的视线里，不用他去别处找提示（交互反馈原理）。
   *
   * 数据侧：收藏 = 把这本书写进本地书架（Store.addBook，状态「想读」）。
   * 这是 community.js 第一次调用 Store —— 社区层与本地书架从此打通。
   *
   * 连续操作的三条防线：
   *   ① 处理中 data-busy=1 + disabled，重复点击直接 return；
   *   ② 已在书架但状态不是「想读」时，点击只提示、绝不删除；
   *   ③ Store 读不出来（存储被禁 / 数据损坏）时走失败路径，不静默失败。
   * ============================================================= */

  // 星芒路径：外半径 6、内半径 2.4，中心 (10,10)
  var STAR_D = 'M10,4 L11.41,8.06 L15.71,8.15 L12.28,10.74 L13.53,14.85 L10,12.4 L6.47,14.85 L7.72,10.74 L4.29,8.15 L8.59,8.06 Z';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function baseFavorites(title) {
    var n = MOCK_FAVORITES[title];
    return typeof n === 'number' ? n : 0;
  }

  function statusLabel(s) {
    return s === 'reading' ? '在读' : (s === 'finished' ? '已读' : '想读');
  }

  // 星芒图标：一圈轨道 + 一颗星 + 轨道上的小点（已收藏时才亮出来）
  function favIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', 'fav-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    var orbit = document.createElementNS(SVG_NS, 'circle');
    orbit.setAttribute('cx', '10');
    orbit.setAttribute('cy', '10');
    orbit.setAttribute('r', '8');
    orbit.setAttribute('class', 'fav-orbit');
    svg.appendChild(orbit);

    var dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', '18');
    dot.setAttribute('cy', '10');
    dot.setAttribute('r', '1.7');
    dot.setAttribute('class', 'fav-dot');
    svg.appendChild(dot);

    var star = document.createElementNS(SVG_NS, 'path');
    star.setAttribute('d', STAR_D);
    star.setAttribute('class', 'fav-star');
    svg.appendChild(star);

    return svg;
  }

  // 这本书在本地书架里是什么情况。readable=false 表示存储读不出来。
  function favStateOf(title) {
    if (typeof Store === 'undefined' || !Store || typeof Store.listBooks !== 'function') {
      return { readable: false, inShelf: false, status: null, bookId: null };
    }
    var res = Store.listBooks();
    if (!res.ok) return { readable: false, inShelf: false, status: null, bookId: null };

    var books = res.data || [];
    for (var i = 0; i < books.length; i++) {
      if (books[i].title === title) {
        return { readable: true, inShelf: true, status: books[i].status, bookId: books[i].id };
      }
    }
    return { readable: true, inShelf: false, status: null, bookId: null };
  }

  // 按钮的子节点顺序固定：0=图标 1=文字 2=数字
  function favPart(btn, i) { return btn.childNodes[i] || null; }

  /**
   * 按当前数据把按钮画成对应状态。
   * @param justOn 传 true 时才播「收藏成功」的弹一下动画，
   *               否则每次刷新列表都会跟着弹（那是假反馈）。
   */
  function renderFavButton(btn, post, justOn) {
    var st = favStateOf(post.title);
    var count = baseFavorites(post.title) + (st.inShelf ? 1 : 0);
    var cls = 'fav-btn';
    var text;

    if (!st.readable) {
      text = '收藏';
    } else if (st.inShelf && st.status === 'want') {
      cls += ' is-on';
      if (justOn) cls += ' is-just-on';
      text = '已收藏';
    } else if (st.inShelf) {
      cls += ' is-locked';
      text = '已在书架';
    } else {
      text = '收藏';
    }

    btn.className = cls;
    // 标记是哪本书的按钮：同一本书在页面上可能有两处按钮（热门榜 + 帖子卡片），
    // 靠这个属性把它们找齐、一起刷新
    btn.setAttribute('data-book-title', post.title);
    btn.textContent = '';
    btn.appendChild(favIcon());

    var label = document.createElement('span');
    label.className = 'fav-label';
    label.textContent = text;
    btn.appendChild(label);

    var num = document.createElement('span');
    num.className = 'fav-count';
    num.textContent = String(count);
    btn.appendChild(num);

    btn.setAttribute('aria-pressed', (st.inShelf && st.status === 'want') ? 'true' : 'false');

    if (!st.readable) {
      btn.title = '读不到本地书架（浏览器存储不可用或数据损坏）';
    } else if (st.inShelf && st.status === 'want') {
      btn.title = '已收藏，点一下取消';
    } else if (st.inShelf) {
      btn.title = '这本书在你的书架里是「' + statusLabel(st.status) + '」';
    } else {
      btn.title = '收藏到想读';
    }

    return st;
  }

  function setFavBusy(btn, text) {
    btn.setAttribute('data-busy', '1');
    btn.disabled = true;
    btn.classList.add('is-busy');
    var label = favPart(btn, 1);
    if (label) label.textContent = text;
  }

  function clearFavBusy(btn) {
    btn.removeAttribute('data-busy');
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }

  /**
   * 同一本书在页面上可能有两处按钮（热门榜一处、帖子卡片一处）。
   * 改动其中一处后，把其余的也刷成同一个状态——否则用户点了热门榜的收藏，
   * 往下滚到帖子卡片还是「收藏」，会以为刚才那下没生效。
   * @param except 跳过这一个（它自己刚渲染过，还要播动画，不必重画）
   */
  function syncFavButtons(title, post, except) {
    var all = document.querySelectorAll('.fav-btn');
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b === except) continue;
      if (b.getAttribute('data-book-title') === title) renderFavButton(b, post);
    }
  }

  function onFavClick(e, btn, post) {
    if (e) { e.preventDefault(); e.stopPropagation(); }   // 别连带触发「点卡片进详情」
    if (btn.getAttribute('data-busy') === '1') return;    // ① 处理中不重复响应

    var st = favStateOf(post.title);

    // ③ 读不出来：给失败提示，不静默
    if (!st.readable) {
      showError('收藏失败：读不到本地书架，浏览器存储可能被禁用或数据已损坏');
      return;
    }

    // ② 已在书架但不是「想读」：只提示，绝不删掉用户自己的书
    if (st.inShelf && st.status !== 'want') {
      showSuccess('《' + post.title + '》已经在你的书架里（' + statusLabel(st.status) + '），不用再收藏');
      return;
    }

    var removing = st.inShelf;
    setFavBusy(btn, removing ? '取消中…' : '收藏中…');

    // 模拟一点处理耗时；接后端后这里就是真实的请求等待时间
    setTimeout(function () {
      var res;
      try {
        res = removing
          ? Store.deleteBook(st.bookId)
          : Store.addBook({
              title: post.title,
              author: post.author,
              coverUrl: post.coverUrl,
              status: 'want'
            });
      } catch (err) {
        // Store 若因存储写满等原因直接抛异常，这里兜住并转成看得懂的失败提示
        // （store.js 开头的约定：错误不能静默）
        res = { ok: false, error: '浏览器存储写入失败，可能是空间已满' };
      }

      clearFavBusy(btn);
      if (res.ok) {
        renderFavButton(btn, post, !removing);
        syncFavButtons(post.title, post, btn);   // 热门榜与帖子卡片两处按钮保持一致
        showSuccess(removing
          ? '已取消收藏，从书架移除了'
          : '已把《' + post.title + '》加入想读');
      } else {
        renderFavButton(btn, post);   // 退回点击前的样子，让用户可重试
        showError('收藏失败：' + res.error);
      }
    }, 500);
  }

  function buildPostCard(post) {
    var card = document.createElement('article');
    card.className = 'post-card';
    card.setAttribute('data-id', post.id);

    var cover = document.createElement('div');
    cover.className = 'cover cover-sm';
    fillCover(cover, post.title, post.coverUrl);
    card.appendChild(cover);

    var body = document.createElement('div');
    body.className = 'post-card-body';

    // 书名与收藏按钮同一行：按钮紧贴书名右边
    var titleRow = document.createElement('div');
    titleRow.className = 'post-title-row';

    var t = document.createElement('h3');
    t.className = 'post-title';
    t.textContent = post.title;
    titleRow.appendChild(t);

    var fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'fav-btn';
    renderFavButton(fav, post);
    fav.addEventListener('click', function (e) { onFavClick(e, fav, post); });
    titleRow.appendChild(fav);

    body.appendChild(titleRow);

    var meta = document.createElement('p');
    meta.className = 'post-meta';
    var authorName = document.createElement('a');
    authorName.className = 'user-link';
    authorName.textContent = usernameById(post.authorId);
    authorName.href = '#';
    (function (uid) {
      authorName.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();   // 别触发帖子卡片的点击进详情
        openProfile(uid);
      });
    })(post.authorId);
    meta.appendChild(authorName);
    meta.appendChild(document.createTextNode(' · ' + timeAgo(post.createdAt)));
    body.appendChild(meta);

    var excerpt = document.createElement('p');
    excerpt.className = 'post-excerpt';
    excerpt.textContent = post.content;
    body.appendChild(excerpt);

    var foot = document.createElement('div');
    foot.className = 'post-foot';
    var cc = document.createElement('span');
    cc.className = 'muted';
    cc.textContent = '💬 ' + (post.comments ? post.comments.length : 0) + ' 条评论';
    foot.appendChild(cc);
    body.appendChild(foot);

    card.appendChild(body);
    return card;
  }

  function renderForum() {
    renderHot();
    renderPosts();
  }

  // 打开发帖弹窗（清空上次残留）
  function openComposer() {
    byId('compose-title-input').value = '';
    byId('compose-author').value = '';
    byId('compose-cover').value = '';
    byId('compose-content').value = '';
    var err = byId('compose-error');
    err.hidden = true;
    err.textContent = '';
    byId('modal-compose').hidden = false;
  }

  // 提交发帖
  function submitCompose() {
    var title = byId('compose-title-input').value.trim();
    var author = byId('compose-author').value.trim();
    var cover = byId('compose-cover').value.trim();
    var content = byId('compose-content').value.trim();
    var err = byId('compose-error');

    if (!title) { err.textContent = '书名不能为空'; err.hidden = false; return; }
    if (title.length > 100) { err.textContent = '书名太长（最多 100 字）'; err.hidden = false; return; }
    if (!content) { err.textContent = '感受 / 看法不能为空'; err.hidden = false; return; }

    var post = {
      id: 'post_' + Date.now(),
      authorId: state.currentUser.id,   // 用真实 id，保证「我的」页聚合能查到
      title: title,
      author: author || '',
      coverUrl: cover,
      content: content,
      createdAt: new Date().toISOString(),
      comments: []
    };
    MOCK_POSTS.push(post);

    byId('modal-compose').hidden = true;
    renderForum();
    showSuccess('发布成功！');
    // 直接打开刚发的帖子详情
    openPost(post.id);
  }

  /* =============================================================
   * 4b. 同书帖子列表（点热门书进来看这本书的所有讨论）
   * ============================================================= */

  function postsByTitle(title) {
    var out = [];
    for (var i = 0; i < MOCK_POSTS.length; i++) {
      if (MOCK_POSTS[i].title === title) out.push(MOCK_POSTS[i]);
    }
    out.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    return out;
  }

  // 跳转：把地址改到「这本书的讨论」（渲染交给 enterBookPosts）
  function openBookPosts(title) {
    go('/book-posts/' + encodeURIComponent(title));
  }

  // 渲染：只往页面里填内容，不切页面（切页面由路由统一做）
  function enterBookPosts(title) {
    var posts = postsByTitle(title);
    if (posts.length === 0) { showError('这本书还没有讨论'); return false; }
    state.postFromBook = true;
    state.lastBookTitle = title;

    // 头部：封面 + 书名 + 作者 + 帖子数
    var head = byId('book-posts-head');
    head.textContent = '';
    var cover = document.createElement('div');
    cover.className = 'cover cover-lg';
    fillCover(cover, posts[0].title, posts[0].coverUrl);
    head.appendChild(cover);
    var meta = document.createElement('div');
    meta.className = 'detail-meta';
    var h2 = document.createElement('h2');
    h2.textContent = title;
    meta.appendChild(h2);
    var p = document.createElement('p');
    p.className = 'muted';
    var author = posts[0].author || '';
    var totalComments = 0;
    for (var i = 0; i < posts.length; i++) totalComments += posts[i].comments ? posts[i].comments.length : 0;
    p.textContent = (author ? author + ' · ' : '') + posts.length + ' 篇讨论 · ' + totalComments + ' 条评论';
    meta.appendChild(p);
    head.appendChild(meta);

    // 帖子列表（长度 0 的情况已在上面拦掉，这里一定有内容）
    var list = byId('book-posts-list');
    var empty = byId('book-posts-empty');
    list.textContent = '';
    empty.hidden = true;
    for (var k = 0; k < posts.length; k++) {
      list.appendChild(buildPostCard(posts[k]));
    }
    return true;
  }

  /* =============================================================
   * 5. 帖子详情 + 评论
   * ============================================================= */

  function findPost(id) {
    for (var i = 0; i < MOCK_POSTS.length; i++) {
      if (MOCK_POSTS[i].id === id) return MOCK_POSTS[i];
    }
    return null;
  }

  // 跳转：把地址改到这篇帖子（渲染交给 enterPost）
  function openPost(id) {
    go('/post/' + encodeURIComponent(id));
  }

  // 渲染：只填内容，不切页面。帖子不存在时返回 false，由路由退回论坛。
  // postFromBook（返回时回论坛还是回同书列表）由「从哪点进来」决定：
  // 论坛帖子流点进来是 false，同书列表点进来保持 true。
  function enterPost(id) {
    var post = findPost(id);
    if (!post) { showError('这篇帖子不存在或已删除'); return false; }
    state.currentPostId = id;
    renderPostDetail(post);
    return true;
  }

  function renderPostDetail(post) {
    var box = byId('post-detail');
    box.textContent = '';

    // 头部：封面 + 书名 + 作者 + 发帖人
    var head = document.createElement('div');
    head.className = 'detail-head';
    var cover = document.createElement('div');
    cover.className = 'cover cover-lg';
    fillCover(cover, post.title, post.coverUrl);
    head.appendChild(cover);
    var meta = document.createElement('div');
    meta.className = 'detail-meta';
    var h2 = document.createElement('h2');
    h2.textContent = post.title;
    meta.appendChild(h2);
    var author = document.createElement('p');
    author.className = 'muted';
    if (post.author) {
      author.appendChild(document.createTextNode(post.author + ' · '));
    }
    author.appendChild(document.createTextNode('由 '));
    var authorLink = document.createElement('a');
    authorLink.className = 'user-link';
    authorLink.textContent = usernameById(post.authorId);
    authorLink.href = '#';
    (function (uid) {
      authorLink.addEventListener('click', function (e) {
        e.preventDefault();
        openProfile(uid);
      });
    })(post.authorId);
    author.appendChild(authorLink);
    author.appendChild(document.createTextNode(' 分享'));

    // 私信作者（非本人时显示）
    if (!state.currentUser || state.currentUser.id !== post.authorId) {
      var msgBtn = document.createElement('button');
      msgBtn.className = 'btn btn-ghost btn-sm';
      msgBtn.type = 'button';
      msgBtn.textContent = '私信';
      (function (pid) {
        msgBtn.addEventListener('click', function () {
          openChatWith(pid, usernameById(pid));
        });
      })(post.authorId);
      author.appendChild(document.createTextNode(' '));
      author.appendChild(msgBtn);
    }
    meta.appendChild(author);
    head.appendChild(meta);
    box.appendChild(head);

    // 正文
    var content = document.createElement('div');
    content.className = 'box';
    content.textContent = post.content;
    box.appendChild(content);

    // 评论区
    var commentBox = document.createElement('div');
    commentBox.className = 'box';
    var cbHead = document.createElement('div');
    cbHead.className = 'box-head';
    var cbTitle = document.createElement('h3');
    cbTitle.className = 'box-title';
    cbTitle.textContent = '评论 ' + (post.comments ? post.comments.length : 0);
    cbHead.appendChild(cbTitle);
    commentBox.appendChild(cbHead);

    var ul = document.createElement('ul');
    ul.className = 'comment-list';
    if (post.comments && post.comments.length) {
      for (var i = 0; i < post.comments.length; i++) {
        ul.appendChild(buildComment(post.comments[i]));
      }
    } else {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = '还没有评论，来发表你的看法吧。';
      ul.appendChild(empty);
    }
    commentBox.appendChild(ul);

    // 发表看法（登录后才能评；未登录给提示）
    var editor = document.createElement('div');
    editor.className = 'comment-editor';
    var ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = '说说你对这本书的看法…';
    ta.disabled = !state.currentUser;
    editor.appendChild(ta);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = state.currentUser ? '发表' : '登录后发表';
    btn.disabled = !state.currentUser;
    btn.addEventListener('click', function () {
      if (!state.currentUser) { go('/login'); return; }
      if (!ta.value.trim()) { showError('评论不能为空'); return; }
      post.comments.push({ id: 'c' + Date.now(), authorId: state.currentUser.id, content: ta.value.trim(), createdAt: new Date().toISOString() });
      ta.value = '';
      renderPostDetail(post);
      renderForum();
    });
    editor.appendChild(btn);
    commentBox.appendChild(editor);

    box.appendChild(commentBox);
  }

  /* =============================================================
   * 4.2 评论点赞按钮（Day 11 Step 3）
   *   ① 白色小心心 → 点一下变红 + 数字 +1，再点即取消；
   *   ② 处理中禁用，连点不会重复计数；
   *   ③ 点赞记录存进 store.js 的 reading:likes（刷新后仍是红的）。
   *   成功不弹提示条 —— 心变红正好发生在用户视线里，再弹一条反而吵；
   *   只有失败才弹（失败必须说得出原因，不能静默）。
   * ============================================================= */

  // 心形路径：宽 14、高约 13.8，中心 (10,10)
  var HEART_D = 'M10,16.8 C6.4,13.9 3,10.9 3,7.6 C3,5 5,3 7.4,3 C8.7,3 9.6,3.7 10,4.4 C10.4,3.7 11.3,3 12.6,3 C15,3 17,5 17,7.6 C17,10.9 13.6,13.9 10,16.8 Z';

  function baseCommentLikes(commentId) {
    var n = MOCK_COMMENT_LIKES[commentId];
    return typeof n === 'number' ? n : 0;
  }

  function likeIcon() {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', 'like-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    var heart = document.createElementNS(SVG_NS, 'path');
    heart.setAttribute('d', HEART_D);
    heart.setAttribute('class', 'like-heart');
    svg.appendChild(heart);

    return svg;
  }

  // 这条评论我赞过没有。readable=false 表示存储读不出来。
  function likeStateOf(commentId) {
    if (typeof Store === 'undefined' || !Store || typeof Store.listLikes !== 'function') {
      return { readable: false, liked: false };
    }
    var res = Store.listLikes();
    if (!res.ok) return { readable: false, liked: false };
    var list = res.data || [];
    return { readable: true, liked: list.indexOf(commentId) >= 0 };
  }

  // 按钮的子节点顺序固定：0=图标 1=数字
  function likePart(btn, i) { return btn.childNodes[i] || null; }

  /**
   * 按当前数据把心心画成对应状态。
   * @param justOn 传 true 时才播「刚点赞成功」的弹一下动画，
   *               否则每次重渲染都会跟着弹（那是假反馈）。
   */
  function renderLikeButton(btn, comment, justOn) {
    var st = likeStateOf(comment.id);
    var count = baseCommentLikes(comment.id) + (st.liked ? 1 : 0);
    var cls = 'like-btn';

    if (st.liked) {
      cls += ' is-liked';
      if (justOn) cls += ' is-just-liked';
    }

    btn.className = cls;
    // 标记是哪条评论的按钮：同一批评论在页面上可能出现两处
    // （帖子详情 + 个人主页），靠它把同一条的按钮找齐、一起刷新
    btn.setAttribute('data-comment-id', comment.id);
    btn.textContent = '';
    btn.appendChild(likeIcon());

    var num = document.createElement('span');
    num.className = 'like-count';
    num.textContent = String(count);
    btn.appendChild(num);

    btn.setAttribute('aria-pressed', st.liked ? 'true' : 'false');
    btn.setAttribute('aria-label', (st.liked ? '取消点赞' : '点赞') + '，当前 ' + count + ' 个赞');
    btn.title = !st.readable
      ? '读不到本地记录（浏览器存储不可用或数据损坏）'
      : (st.liked ? '已点赞，点一下取消' : '点赞');

    return st;
  }

  function setLikeBusy(btn) {
    btn.setAttribute('data-busy', '1');
    btn.disabled = true;
    btn.classList.add('is-busy');
  }

  function clearLikeBusy(btn) {
    btn.removeAttribute('data-busy');
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }

  /**
   * 同一条评论在页面上可能有两处按钮（帖子详情一处、个人主页一处）。
   * 改动其中一处后，把其余的也刷成同一状态 —— 否则会出现
   * 「详情页的心是红的，翻到个人主页还是白的」，用户以为没生效。
   * @param except 跳过这一个（它自己刚渲染过，还要播动画）
   */
  function syncLikeButtons(commentId, comment, except) {
    var all = document.querySelectorAll('.like-btn');
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b === except) continue;
      if (b.getAttribute('data-comment-id') === commentId) renderLikeButton(b, comment);
    }
  }

  function onLikeClick(e, btn, comment) {
    if (e) { e.preventDefault(); e.stopPropagation(); }   // 别连带触发外层元素的点击
    if (btn.getAttribute('data-busy') === '1') return;    // ① 处理中不重复响应

    var st = likeStateOf(comment.id);

    // 存储读不出来：给失败提示，不静默失败
    if (!st.readable) {
      showError('点赞失败：读不到本地记录，浏览器存储可能被禁用或数据已损坏');
      return;
    }

    setLikeBusy(btn);

    // 模拟一点处理耗时；接后端后这里就是真实的请求等待时间
    setTimeout(function () {
      var res;
      try {
        res = Store.toggleLike(comment.id);
      } catch (err) {
        // Store 若因存储写满等原因直接抛异常，这里兜住并转成看得懂的失败提示
        // （store.js 开头的约定：错误不能静默）
        res = { ok: false, error: '浏览器存储写入失败，可能是空间已满' };
      }

      clearLikeBusy(btn);
      if (res.ok) {
        renderLikeButton(btn, comment, res.data.liked);
        syncLikeButtons(comment.id, comment, btn);
        // 成功不弹提示条：心变红就在用户视线里，再弹一条反而吵（Step 3 定的口径）
      } else {
        renderLikeButton(btn, comment);   // 退回点击前的样子，让用户可重试
        showError('点赞失败：' + res.error);
      }
    }, 500);
  }

  /* ---------------------------------------------------------------
   * 4.3 悬停三件套（Day 11 Step 4）
   *
   * 悬停封面 → 翻转露出「高赞评论关键词」
   * 悬停书名 → 浮出简介卡（类型 · 年份 + 一句话简介）
   * 悬停作者 → 浮出作者卡（介绍 + 他写过的其他书）
   *
   * ⚠️ 下面两张表里的一切都是**手工写死在代码里的 mock**：
   *    现在没有后端也没有 AI，程序既读不懂评论、也总结不出关键词。
   *    接上后端后这两张表整体删掉，改成接口返回。
   *    没配到的书/作者会走降级 —— 浮层里写「暂无…」，不是空白框。
   *
   * 窄屏（≤560px）没有 hover：改成点一下展开、再点收起。
   * ------------------------------------------------------------- */

  // keywords 的顺序 = 高赞排序：第 1 条就是点赞量最高的那条（论坛卡片只显示它）
  var MOCK_BOOK_INFO = {
    '三体': {
      genre: '科幻小说', year: '2006',
      intro: '文化大革命期间，天体物理学家叶文洁向宇宙发出了地球的第一声呼唤。四光年外，一个濒临毁灭的文明收到了它。半个世纪后，纳米学者汪淼在一连串科学家自杀案里发现了倒计时，人类才意识到：宇宙不是寂静的，它一直在听。',
      highlight: '看点：从文革到宇宙尽头的宏大跨度，硬科幻的入门首选',
      keywords: ['黑暗森林', '人类渺小', '宇宙社会学']
    },
    '明朝那些事儿': {
      genre: '历史通俗读物', year: '2006',
      intro: '从朱元璋在皇觉寺出家说起，到崇祯在煤山自缢结束，二百七十六年、十六位皇帝。作者用讲故事的口吻把正史掰开揉碎，让胡惟庸、张居正、戚继光这些名字不再是考点，而是一个个有脾气、会犯错的活人。',
      highlight: '看点：把两百多年正史讲成评书，历史小白也能一口气读完',
      keywords: ['草根皇帝', '权谋', '幽默笔法']
    },
    '百年孤独': {
      genre: '魔幻现实主义', year: '1967',
      intro: '马孔多是个只有二十户人家的小镇。布恩迪亚家族在这里繁衍生息，七代人重复着相似的名字、相似的执拗和相似的孤独。当你翻到最后一页会明白：这个家族的历史，是一段早已写定、无人能改的预言。',
      highlight: '看点：魔幻现实主义的代表作，读完会想从头再读一遍',
      keywords: ['家族宿命', '循环', '魔幻现实']
    }
  };

  var MOCK_AUTHOR_INFO = {
    '刘慈欣': {
      bio: '山西阳泉人，高级工程师出身，中国科幻走向世界的代表人物。《三体》拿下雨果奖最佳长篇，是亚洲作家第一次获此奖。',
      works: ['球状闪电', '流浪地球', '超新星纪元', '赡养人类', '乡村教师']
    },
    '当年明月': {
      bio: '本名石悦，湖北宜昌人。以轻松笔法写正史起家，把历史读物从学术书架推上畅销榜，也带出了后来一大批「通俗说史」的写作者。',
      works: ['明朝那些事儿·洪武大帝', '明朝那些事儿·帝国飘摇', '明朝那些事儿·大结局']
    },
    '加西亚·马尔克斯': {
      bio: '哥伦比亚记者、作家，1982 年诺贝尔文学奖得主。他把拉丁美洲的百年苦难写成一则巨大的寓言，魔幻现实主义自此成为世界文学的关键词。',
      works: ['百年孤独', '霍乱时期的爱情', '没有人给他写信的上校', '一桩事先张扬的凶杀案', '族长的秋天']
    }
  };

  var NARROW_QUERY = '(max-width: 560px)';

  function isNarrow() {
    return !!(window.matchMedia && window.matchMedia(NARROW_QUERY).matches);
  }

  // 全站共用一个浮层、挂在 body 上 —— 放进卡片内部会被卡片的 overflow 切掉半截
  var hoverTip = null;
  var tipAnchor = null;
  var hideTimer = null;

  function cancelHide() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function hideTip() {
    cancelHide();
    if (hoverTip && hoverTip.parentNode) hoverTip.parentNode.removeChild(hoverTip);
    hoverTip = null;
    tipAnchor = null;
  }

  // 鼠标从锚点移到浮层之间会经过几个像素的空隙，
  // 所以不立刻关，留 200 毫秒缓冲；期间鼠标进到浮层里就把定时器撤掉。
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(hideTip, 200);
  }

  function positionTip(tip, anchor) {
    var r = anchor.getBoundingClientRect();
    var tr = tip.getBoundingClientRect();
    var left = r.left;
    if (left + tr.width > window.innerWidth - 12) left = window.innerWidth - 12 - tr.width;
    if (left < 12) left = 12;
    var top = r.bottom + 6;
    if (top + tr.height > window.innerHeight - 12) top = r.top - tr.height - 6;
    if (top < 12) top = 12;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function showTip(anchor, node) {
    cancelHide();
    if (hoverTip && hoverTip.parentNode) hoverTip.parentNode.removeChild(hoverTip);
    document.body.appendChild(node);
    positionTip(node, anchor);
    hoverTip = node;
    tipAnchor = anchor;
    node.addEventListener('mouseenter', cancelHide);
    node.addEventListener('mouseleave', scheduleHide);
  }

  function buildTitleTip(title) {
    var tip = document.createElement('div');
    tip.className = 'hover-tip';

    var info = MOCK_BOOK_INFO[title];
    if (!info) {
      var none = document.createElement('p');
      none.className = 'hover-tip-none';
      none.textContent = '暂无这本书的简介';
      tip.appendChild(none);
      return tip;
    }

    var head = document.createElement('p');
    head.className = 'hover-tip-head';
    head.textContent = [info.genre, info.year].filter(Boolean).join(' · ');
    tip.appendChild(head);

    var body = document.createElement('p');
    body.className = 'hover-tip-body';
    body.textContent = info.intro;
    tip.appendChild(body);

    if (info.highlight) {
      var hl = document.createElement('p');
      hl.className = 'hover-tip-highlight';
      hl.textContent = info.highlight;
      tip.appendChild(hl);
    }

    return tip;
  }

  function buildAuthorTip(name) {
    var tip = document.createElement('div');
    tip.className = 'hover-tip';

    var info = MOCK_AUTHOR_INFO[name];
    if (!info) {
      var none = document.createElement('p');
      none.className = 'hover-tip-none';
      none.textContent = '暂无这位作者的资料';
      tip.appendChild(none);
      return tip;
    }

    var body = document.createElement('p');
    body.className = 'hover-tip-body';
    body.textContent = info.bio;
    tip.appendChild(body);

    if (info.works && info.works.length) {
      var works = document.createElement('p');
      works.className = 'hover-tip-works';
      works.textContent = '还写过：《' + info.works.join('》《') + '》';
      tip.appendChild(works);
    }

    return tip;
  }

  // 从卡片上取书名：帖子卡 .post-title / 首页书卡 .book-title / 热门榜 .hot-title
  function cardTitleOf(cardEl) {
    var t = cardEl.querySelector('.post-title')
         || cardEl.querySelector('.book-title')
         || cardEl.querySelector('.hot-title');
    return t ? t.textContent : '';
  }

  /**
   * 把 <div class="cover"> 裹进可翻转的 3D 结构（正面 = 原封面，背面 = 关键词）。
   *
   * 为什么不做成"渲染时就带翻转结构"：首页书卡是 app.js 渲染的，
   * 改那边会把这个功能劈成两半。改成"第一次碰到才包装"，
   * app.js 一行不用动；卡片重渲染后标记没了，下次悬停会自动重包。
   */
  function ensureFlippable(cover) {
    if (cover.getAttribute('data-flip') === '1') return;
    var card = cover.closest ? cover.closest('.post-card, .book-card, .hot-item') : null;
    if (!card) return;
    cover.setAttribute('data-flip', '1');

    var info = MOCK_BOOK_INFO[cardTitleOf(card)];

    // 论坛帖子卡片：卡片本身信息多、封面比首页小，背面只放最热的那 1 条关键词，
    // 3 条挤在一起反而看不清（Day 11 大帅拍板）。首页书卡与热门榜放全部。
    var single = !!(card.classList && card.classList.contains('post-card'));

    var wrap = document.createElement('div');
    wrap.className = 'flip-wrap';
    // 尺寸必须跟原封面完全一致，否则会把卡片的排布挤变形
    var cs = window.getComputedStyle(cover);
    wrap.style.width = cs.width;
    wrap.style.height = cs.height;
    // 44×60 的小封面（论坛卡片、热榜）放不下「高赞关键词」这行标题，交给 CSS 收掉
    if (parseInt(cs.width, 10) < 60) wrap.classList.add('is-tiny');

    var inner = document.createElement('div');
    inner.className = 'flip-inner';

    var back = document.createElement('div');
    back.className = 'cover-back';
    back.style.borderRadius = cs.borderRadius;   // 跟原封面一致，翻转过去不露直角

    var label = document.createElement('span');
    label.className = 'cover-back-label';
    label.textContent = '高赞关键词';
    back.appendChild(label);

    if (info && info.keywords && info.keywords.length) {
      if (single) wrap.classList.add('is-single');
      var words = single ? [info.keywords[0]] : info.keywords;
      for (var i = 0; i < words.length; i++) {
        var chip = document.createElement('span');
        chip.className = 'cover-back-chip';
        chip.textContent = words[i];
        back.appendChild(chip);
      }
    } else {
      var none = document.createElement('span');
      none.className = 'cover-back-chip is-none';
      none.textContent = '暂无';
      back.appendChild(none);
    }

    cover.parentNode.insertBefore(wrap, cover);
    inner.appendChild(cover);
    inner.appendChild(back);
    wrap.appendChild(inner);
  }

  /**
   * 给一个容器挂上三件套的悬停行为。
   * 用事件委托 —— 卡片重渲染（增删书、换筛选）之后不用重新绑定。
   */
  function bindHoverSuite(root) {
    if (!root) return;

    root.addEventListener('mouseover', function (e) {
      if (isNarrow()) return;
      var t = e.target;
      if (!t || !t.closest) return;

      var cover = t.closest('.cover');
      if (cover && root.contains(cover)) {
        // 在封面内部挪动（文字→边框）不算重新进入
        if (cover.contains(e.relatedTarget)) return;
        ensureFlippable(cover);
        return;
      }

      var titleEl = t.closest('.post-title, .book-title, .hot-title');
      if (titleEl && root.contains(titleEl)) {
        if (titleEl.contains(e.relatedTarget)) return;
        showTip(titleEl, buildTitleTip(titleEl.textContent));
        return;
      }

      var authorEl = t.closest('.book-author, .hot-author');
      if (authorEl && root.contains(authorEl)) {
        if (authorEl.contains(e.relatedTarget)) return;
        showTip(authorEl, buildAuthorTip(authorEl.textContent));
        return;
      }
    });

    root.addEventListener('mouseout', function (e) {
      if (isNarrow()) return;
      var t = e.target;
      if (!t || !t.closest) return;

      var titleEl = t.closest('.post-title, .book-title, .hot-title');
      if (titleEl && !titleEl.contains(e.relatedTarget)) { scheduleHide(); return; }

      var authorEl = t.closest('.book-author, .hot-author');
      if (authorEl && !authorEl.contains(e.relatedTarget)) scheduleHide();
    });
  }

  /**
   * 窄屏点按：没有 hover，改成点一下展开、再点收起。
   *
   * 必须挂在捕获阶段并用 stopPropagation：
   * app.js 也监听 #book-list 的点击（进详情页），同元素上的两个冒泡监听器
   * 互相拦不住，只有在捕获阶段先拦下来才可靠。
   * 点卡片的其它区域（状态标签、进度条、留白）照旧进详情页。
   */
  function bindNarrowTap() {
    document.addEventListener('click', function (e) {
      if (!isNarrow()) return;
      var t = e.target;
      if (!t || !t.closest) return;

      var cover = t.closest('.cover');
      if (cover) {
        e.preventDefault();
        e.stopPropagation();
        if (hoverTip) hideTip();
        ensureFlippable(cover);                       // 第一次点：先包装
        var w = cover.closest('.flip-wrap');
        if (w) w.classList.toggle('is-flipped');
        return;
      }

      var titleEl = t.closest('.post-title, .book-title, .hot-title');
      if (titleEl) {
        e.preventDefault();
        e.stopPropagation();
        if (hoverTip && tipAnchor === titleEl) { hideTip(); return; }
        showTip(titleEl, buildTitleTip(titleEl.textContent));
        return;
      }

      var authorEl = t.closest('.book-author, .hot-author');
      if (authorEl) {
        e.preventDefault();
        e.stopPropagation();
        if (hoverTip && tipAnchor === authorEl) { hideTip(); return; }
        showTip(authorEl, buildAuthorTip(authorEl.textContent));
      }
    }, true);
  }

  function buildComment(c) {
    var li = document.createElement('li');
    li.className = 'comment-item';
    var head = document.createElement('div');
    head.className = 'comment-head';
    var name = document.createElement('a');
    name.className = 'comment-name user-link';
    name.textContent = usernameById(c.authorId);
    name.href = '#';
    (function (uid) {
      name.addEventListener('click', function (e) {
        e.preventDefault();
        openProfile(uid);
      });
    })(c.authorId);
    head.appendChild(name);

    // 私信评论作者（非本人时显示）
    if (!state.currentUser || state.currentUser.id !== c.authorId) {
      var msgBtn = document.createElement('button');
      msgBtn.className = 'btn btn-ghost btn-sm';
      msgBtn.type = 'button';
      msgBtn.textContent = '私信';
      (function (cid) {
        msgBtn.addEventListener('click', function () {
          openChatWith(cid, usernameById(cid));
        });
      })(c.authorId);
      head.appendChild(msgBtn);
    }

    var time = document.createElement('span');
    time.className = 'muted sub';
    time.textContent = timeAgo(c.createdAt);
    head.appendChild(time);

    // 点赞心心：放在评论头部这一行的右端（靠 CSS margin-left:auto 推过去），
    // 不另起一行，视觉上就是「这条评论的附属操作」
    var like = document.createElement('button');
    like.type = 'button';
    like.className = 'like-btn';
    renderLikeButton(like, c);
    like.addEventListener('click', function (e) { onLikeClick(e, like, c); });
    head.appendChild(like);

    li.appendChild(head);
    var body = document.createElement('p');
    body.className = 'comment-body';
    body.textContent = c.content;
    li.appendChild(body);
    return li;
  }

  /* =============================================================
   * 6. 私信（一对一对话）
   *
   * 已读怎么算（本轮）：
   *   - 会话列表右边的红色数字 = 对方发来、我还没读的条数。
   *   - 点开一个会话 = 已读，同时把「这个会话我读过了」写进本机
   *     （Store.markRead → reading:conv-reads），所以刷新后不会再变未读。
   *   - 已读是「按会话」记的：读掉一个，另一个的红点还在。
   *   - 导航栏「私信」上的数字 = 所有会话未读数之和；没登录就不显示。
   * ============================================================= */

  // 本机记的「已读会话 id」。读不出来（存储被禁 / 数据损坏）就当空 = 全部未读：
  // 界面照常能用，只是刷新后红点会回来。
  function readConvIds() {
    if (typeof Store === 'undefined' || !Store || typeof Store.listReads !== 'function') return [];
    var res = Store.listReads();
    return (res && res.ok && res.data) ? res.data : [];
  }

  function isConvRead(convId) {
    return readConvIds().indexOf(convId) >= 0;
  }

  // 一个会话的未读条数：读过的算 0；否则数对方发来的、标了 unread 的消息。
  // 自己发的不算未读 —— 那是自己打的字。
  function unreadCountOf(conv) {
    if (isConvRead(conv.id)) return 0;
    var n = 0;
    for (var i = 0; i < conv.messages.length; i++) {
      if (conv.messages[i].fromId !== 'me' && conv.messages[i].unread) n++;
    }
    return n;
  }

  function totalUnread() {
    var n = 0;
    for (var i = 0; i < MOCK_CONVERSATIONS.length; i++) {
      n += unreadCountOf(MOCK_CONVERSATIONS[i]);
    }
    return n;
  }

  // 导航栏「私信」上的未读数字徽标。未登录不显示（没登录就收不到私信）。
  function renderNavBadge() {
    var btn = document.querySelector('.site-nav-link[data-nav="messages"]');
    if (!btn) return;

    var n = state.currentUser ? totalUnread() : 0;
    var badge = btn.querySelector('.nav-badge');

    if (n <= 0) {
      if (badge) badge.hidden = true;
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      btn.appendChild(badge);
    }
    badge.hidden = false;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.setAttribute('aria-label', '未读私信 ' + n + ' 条');
  }

  // 把一个会话标记为已读：清掉内存里的未读标记，并写进本机记录。
  // 返回 Store 的结果；写盘失败时界面照样算已读（否则人会以为没点上）。
  function markConvRead(conv) {
    for (var i = 0; i < conv.messages.length; i++) {
      conv.messages[i].unread = false;
    }
    if (typeof Store === 'undefined' || !Store || typeof Store.markRead !== 'function') {
      return { ok: false, error: '本机存储不可用' };
    }
    return Store.markRead(conv.id);
  }

  function renderConversations() {
    var list = byId('conversation-list');
    var empty = byId('conversation-empty');
    list.textContent = '';

    if (!state.currentUser) {
      empty.hidden = false;
      empty.textContent = '登录后才能收发私信。';
      return;
    }
    if (MOCK_CONVERSATIONS.length === 0) {
      empty.hidden = false;
      empty.textContent = '还没有私信。去论坛找本喜欢的书，认识个读者吧。';
      return;
    }
    empty.hidden = true;

    for (var i = 0; i < MOCK_CONVERSATIONS.length; i++) {
      list.appendChild(buildConversationItem(MOCK_CONVERSATIONS[i]));
    }
  }

  function buildConversationItem(conv) {
    var item = document.createElement('div');
    item.className = 'conversation-item';
    item.setAttribute('data-id', conv.id);

    var peer = userById(conv.peerId);

    var avatar = document.createElement('span');
    avatar.className = 'avatar avatar-link';
    renderAvatar(avatar, conv.peerName, peer ? peer.avatar : '');
    if (peer) {
      (function (pid) {
        avatar.addEventListener('click', function (e) {
          e.stopPropagation();
          openProfile(pid);
        });
      })(peer.id);
    }
    item.appendChild(avatar);

    var body = document.createElement('div');
    body.className = 'conversation-body';
    var name = document.createElement('p');
    name.className = 'conversation-name';
    name.textContent = conv.peerName;
    if (peer) {
      name.classList.add('user-link');
      (function (pid) {
        name.addEventListener('click', function (e) {
          e.stopPropagation();
          openProfile(pid);
        });
      })(peer.id);
    }
    body.appendChild(name);

    var last = conv.messages[conv.messages.length - 1];
    var preview = document.createElement('p');
    preview.className = 'muted';
    preview.textContent = last ? last.content : '（还没有消息，打个招呼吧）';
    body.appendChild(preview);
    item.appendChild(body);

    // 未读数字徽标：有几条显示几；读过的会话没有这一颗
    var unread = unreadCountOf(conv);
    if (unread > 0) {
      var dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.textContent = unread > 99 ? '99+' : String(unread);
      dot.setAttribute('aria-label', '未读 ' + unread + ' 条');
      item.appendChild(dot);
    }

    return item;
  }

  function findConversation(id) {
    for (var i = 0; i < MOCK_CONVERSATIONS.length; i++) {
      if (MOCK_CONVERSATIONS[i].id === id) return MOCK_CONVERSATIONS[i];
    }
    return null;
  }

  // 打开某个会话。私信页的内部状态不占地址（Day 13 决定），
  // 所以这里只记下「进去后要展开哪一条」，渲染交给 enterMessages。
  function openConversation(id) {
    var conv = findConversation(id);
    if (!conv) return;

    // 防重复：这一项正在处理中，连点不生效
    var row = document.querySelector('.conversation-item[data-id="' + id + '"]');
    if (row && row.classList.contains('is-busy')) return;
    if (row) row.classList.add('is-busy');

    state.currentConvId = id;
    state.openConvOnEnter = true;

    var res = markConvRead(conv);   // 打开会话 = 已读
    renderNavBadge();
    go('/messages');                // 已在私信页则原地重放，不在就跳过来

    // 界面这时已经变成已读了；只有写盘失败才需要补一句提醒 ——
    // 这一次管用，但刷新之后红点会回来。
    if (!res || !res.ok) {
      showError('已读状态没能存到本机：刷新页面后这个会话可能又显示未读。');
    }
  }

  // 找到（或新建）与某个用户的一对一会话，返回会话对象
  function getOrCreateConversation(peerId, peerName) {
    for (var i = 0; i < MOCK_CONVERSATIONS.length; i++) {
      if (MOCK_CONVERSATIONS[i].peerId === peerId) return MOCK_CONVERSATIONS[i];
    }
    var conv = { id: 'conv_' + Date.now(), peerId: peerId, peerName: peerName, messages: [] };
    MOCK_CONVERSATIONS.unshift(conv);
    return conv;
  }

  // 从任意入口发起私信：找到/新建会话并打开对话窗口
  function openChatWith(peerId, peerName) {
    if (!state.currentUser) { go('/login'); return; }
    if (state.currentUser.id === peerId) { showError('不能给自己发私信'); return; }
    var conv = getOrCreateConversation(peerId, peerName);
    state.currentConvId = conv.id;
    state.openConvOnEnter = true;
    var res = markConvRead(conv);   // 打开会话 = 已读
    renderNavBadge();
    go('/messages');
    if (!res || !res.ok) {
      showError('已读状态没能存到本机：刷新页面后这个会话可能又显示未读。');
    }
  }

  // 渲染：进私信页。默认显示会话列表；
  // 若是从别处点「私信 TA」过来的（openConvOnEnter），直接展开那段对话。
  function enterMessages() {
    var conv = null;
    if (state.openConvOnEnter && state.currentConvId) conv = findConversation(state.currentConvId);
    state.openConvOnEnter = false;
    if (conv) { renderChat(conv); return; }
    state.currentConvId = null;
    renderConversations();
  }

  function renderChat(conv) {
    var box = byId('conversation-list');
    box.textContent = '';

    var header = document.createElement('div');
    header.className = 'chat-head';
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost';
    back.textContent = '← 返回列表';
    back.addEventListener('click', function () { state.currentConvId = null; state.openConvOnEnter = false; renderConversations(); });
    header.appendChild(back);
    var title = document.createElement('strong');
    title.textContent = conv.peerName;
    var peer = userById(conv.peerId);
    if (peer) {
      title.className = 'user-link';
      title.addEventListener('click', function () { openProfile(peer.id); });
    }
    header.appendChild(title);
    box.appendChild(header);

    var log = document.createElement('div');
    log.className = 'chat-log';
    for (var i = 0; i < conv.messages.length; i++) {
      var m = conv.messages[i];
      var line = document.createElement('div');
      line.className = 'chat-msg ' + (m.fromId === 'me' ? 'chat-msg-me' : 'chat-msg-peer');
      line.textContent = m.content;
      log.appendChild(line);
    }
    box.appendChild(log);

    var input = document.createElement('div');
    input.className = 'chat-input';
    var ta = document.createElement('input');
    ta.type = 'text';
    ta.placeholder = '发消息…';
    var send = document.createElement('button');
    send.type = 'button';
    send.className = 'btn btn-primary';
    send.textContent = '发送';
    function doSend() {
      if (!ta.value.trim()) return;
      conv.messages.push({ fromId: 'me', content: ta.value.trim(), createdAt: new Date().toISOString() });
      ta.value = '';
      renderChat(conv);
    }
    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSend();
    });
    input.appendChild(ta);
    input.appendChild(send);
    box.appendChild(input);
  }

  /* =============================================================
   * 7. 登录 / 注册
   * ============================================================= */

  function renderAuth() {
    var title = byId('auth-title');
    var submitBtn = byId('btn-auth-submit');
    var avatarField = byId('auth-avatar-field');
    var avatarPicker = byId('auth-avatar-picker');
    var hint = document.querySelector('.auth-hint');
    var tabLogin = byId('auth-tab-login');
    var tabRegister = byId('auth-tab-register');

    // tab 高亮跟随当前模式
    if (state.authMode === 'login') {
      tabLogin.classList.add('is-active');
      tabRegister.classList.remove('is-active');
      title.textContent = '登录';
      submitBtn.textContent = '登录';
      avatarField.hidden = true;
      avatarPicker.hidden = true;
      hint.textContent = '登录后可以发帖、评论、私信。';
    } else {
      tabRegister.classList.add('is-active');
      tabLogin.classList.remove('is-active');
      title.textContent = '注册';
      submitBtn.textContent = '注册';
      avatarField.hidden = false;
      avatarPicker.hidden = false;
      hint.textContent = '注册不需要手机号、不需要邮箱，只填账号名和密码。头像可选，不选就用首字占位。';
      renderAvatarColors();
      refreshAvatarPreview();
    }
  }

  // 渲染头像色板
  function renderAvatarColors() {
    var box = byId('avatar-colors');
    box.textContent = '';
    for (var i = 0; i < AVATAR_COLORS.length; i++) {
      var swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'avatar-swatch';
      swatch.setAttribute('data-color', AVATAR_COLORS[i]);
      swatch.style.background = AVATAR_COLORS[i];
      if (state.avatarColor === AVATAR_COLORS[i]) swatch.classList.add('is-active');
      box.appendChild(swatch);
    }
  }

  // 刷新头像预览（按当前选中的色块 / 上传图 / 首字）
  function refreshAvatarPreview() {
    var preview = byId('avatar-preview');
    var name = byId('auth-username').value.trim() || '海';
    var clearBtn = byId('btn-avatar-clear');

    if (state.avatarImage) {
      renderAvatar(preview, name, state.avatarImage);
      clearBtn.hidden = false;
      return;
    }
    if (state.avatarColor) {
      renderAvatar(preview, name, state.avatarColor);
      clearBtn.hidden = false;
      return;
    }
    renderAvatar(preview, name, '');
    clearBtn.hidden = true;
  }

  // 清空登录/注册表单（切 tab 时调用，避免残留上次输入与错误提示）
  function resetAuthForm() {
    byId('auth-username').value = '';
    byId('auth-password').value = '';
    byId('auth-error').hidden = true;
    byId('auth-error').textContent = '';
    // 头像选择状态也一并重置，避免登录页残留上次注册的色块
    state.avatarColor = null;
    state.avatarImage = null;
  }

  function doAuth() {
    var name = byId('auth-username').value.trim();
    var pwd = byId('auth-password').value;
    var err = byId('auth-error');
    // 校验（COMMUNITY_DESIGN.md 4.1）
    if (!name) { err.textContent = '账号名不能为空'; err.hidden = false; return; }
    if (name.length < 2 || name.length > 20) { err.textContent = '账号名需 2~20 个字符'; err.hidden = false; return; }
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]+$/.test(name)) { err.textContent = '账号名只能含中文、字母、数字、下划线'; err.hidden = false; return; }
    if (!pwd || pwd.length < 6) { err.textContent = '密码至少 6 位'; err.hidden = false; return; }

    if (state.authMode === 'register') {
      // 账号名占用校验（大帅点名要求：相同账号名无法注册，明确提示）
      for (var i = 0; i < MOCK_USERS.length; i++) {
        if (MOCK_USERS[i].username === name) {
          err.textContent = '该账号名已被使用，无法注册';
          err.hidden = false;
          return;
        }
      }
      var avatar = state.avatarImage || state.avatarColor || '';
      var newUser = { id: 'user_' + Date.now(), username: name, avatar: avatar, bio: '' };
      MOCK_USERS.push(newUser);
      state.currentUser = newUser;
      // 重置头像选择状态，避免下次注册残留
      state.avatarColor = null;
      state.avatarImage = null;
      err.hidden = true;
      clearError();
      clearSuccess();
      updateNavUser();
      go('/');
      showSuccess('注册成功，欢迎 ' + newUser.username + '！');
      return;
    }

    // 登录：查账号名是否存在（mock 只查账号名，不校验密码——真实后端会校验）
    var found = null;
    for (var j = 0; j < MOCK_USERS.length; j++) {
      if (MOCK_USERS[j].username === name) { found = MOCK_USERS[j]; break; }
    }
    if (!found) { err.textContent = '账号名或密码错误'; err.hidden = false; return; }
    state.currentUser = found;
    err.hidden = true;
    clearError();
    clearSuccess();
    updateNavUser();
    go('/');
    showSuccess('欢迎回来，' + found.username + '！');
  }

  function updateNavUser() {
    var loginBtn = byId('btn-nav-login');
    var userBox = byId('nav-user');
    if (state.currentUser) {
      loginBtn.hidden = true;
      userBox.hidden = false;
      renderAvatar(byId('nav-user-avatar'), state.currentUser.username, state.currentUser.avatar);
      byId('nav-user-name').textContent = state.currentUser.username;
    } else {
      loginBtn.hidden = false;
      userBox.hidden = true;
    }
    // 登录 / 退出都会走这里：顺带把「私信」的未读数字对上
    renderNavBadge();
  }

  /* =============================================================
   * 8. 我的 / 个人主页
   * ============================================================= */

  // 书单区块：把 {want/reading/finished/favorite} 渲染成四行
  function buildShelves(user) {
    var box = document.createElement('div');
    box.className = 'shelves';
    var shelves = user && user.shelves ? user.shelves : { want: [], reading: [], finished: [], favorite: [] };

    var defs = [
      { key: 'reading', label: '在读', icon: '📖' },
      { key: 'want', label: '想读', icon: '🔖' },
      { key: 'finished', label: '已读', icon: '✅' },
      { key: 'favorite', label: '喜欢', icon: '❤️' }
    ];
    for (var i = 0; i < defs.length; i++) {
      var row = document.createElement('div');
      row.className = 'shelf-row';
      var lab = document.createElement('span');
      lab.className = 'shelf-label';
      lab.textContent = defs[i].icon + ' ' + defs[i].label;
      row.appendChild(lab);
      var val = document.createElement('span');
      val.className = 'shelf-books';
      var list = shelves[defs[i].key] || [];
      val.textContent = list.length ? list.join('、') : '（暂无）';
      row.appendChild(val);
      box.appendChild(row);
    }
    return box;
  }

  // 聚合区块：帖子 + 评论（个人主页和「我的」共用）
  function buildActivity(userId) {
    var box = document.createElement('div');
    box.className = 'profile-activity';

    var posts = postsByUser(userId);
    var comments = commentsByUser(userId);

    var postBox = document.createElement('div');
    postBox.className = 'box';
    var ph = document.createElement('div');
    ph.className = 'box-head';
    var pt = document.createElement('h3');
    pt.className = 'box-title';
    pt.textContent = '发布的帖子 ' + posts.length;
    ph.appendChild(pt);
    postBox.appendChild(ph);
    if (posts.length) {
      for (var i = 0; i < posts.length; i++) {
        var pc = buildPostCard(posts[i]);
        postBox.appendChild(pc);
      }
    } else {
      var pe = document.createElement('p');
      pe.className = 'muted';
      pe.textContent = '还没有发过帖子。';
      postBox.appendChild(pe);
    }
    box.appendChild(postBox);

    var cmtBox = document.createElement('div');
    cmtBox.className = 'box';
    var ch = document.createElement('div');
    ch.className = 'box-head';
    var ct = document.createElement('h3');
    ct.className = 'box-title';
    ct.textContent = '发表的评论 ' + comments.length;
    ch.appendChild(ct);
    cmtBox.appendChild(ch);
    if (comments.length) {
      var ul = document.createElement('ul');
      ul.className = 'comment-list';
      for (var j = 0; j < comments.length; j++) {
        var li = buildComment(comments[j].comment);
        // 附上「来自《书名》」的跳转入口
        var src = document.createElement('span');
        src.className = 'comment-source';
        src.textContent = '来自《' + comments[j].postTitle + '》';
        src.style.cursor = 'pointer';
        (function (pid) {
          src.addEventListener('click', function () { openPost(pid); });
        })(comments[j].postId);
        li.appendChild(src);
        ul.appendChild(li);
      }
      cmtBox.appendChild(ul);
    } else {
      var ce = document.createElement('p');
      ce.className = 'muted';
      ce.textContent = '还没有发过评论。';
      cmtBox.appendChild(ce);
    }
    box.appendChild(cmtBox);

    return box;
  }

  // 简介区：本人可编辑，别人只读
  function buildBioCard(user, isSelf) {
    var card = document.createElement('div');
    card.className = 'box me-card';
    var avatar = document.createElement('span');
    avatar.className = 'avatar avatar-lg';
    renderAvatar(avatar, user.username, user.avatar);
    card.appendChild(avatar);
    var name = document.createElement('h2');
    name.textContent = user.username;
    card.appendChild(name);

    var bioWrap = document.createElement('div');
    bioWrap.className = 'bio-wrap';

    if (isSelf) {
      // 本人：显示简介 + 编辑按钮
      var bioText = document.createElement('p');
      bioText.className = 'muted bio-text';
      bioText.textContent = user.bio || '这个人还没有写简介。';
      bioWrap.appendChild(bioText);

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-sm';
      editBtn.type = 'button';
      editBtn.textContent = '编辑简介';
      editBtn.addEventListener('click', function () {
        // 就地切换成编辑态
        bioText.hidden = true;
        editBtn.hidden = true;
        bioText.parentNode.insertBefore(buildBioEditor(user, bioText, editBtn), bioText);
      });
      bioWrap.appendChild(editBtn);
    } else {
      var bioView = document.createElement('p');
      bioView.className = 'muted bio-text';
      bioView.textContent = user.bio || '这个人还没有写简介。';
      bioWrap.appendChild(bioView);

      // 非本人：加「发私信」按钮（聊得来就私信）
      var msgBtn = document.createElement('button');
      msgBtn.className = 'btn btn-primary';
      msgBtn.type = 'button';
      msgBtn.textContent = '发私信';
      (function (u) {
        msgBtn.addEventListener('click', function () {
          openChatWith(u.id, u.username);
        });
      })(user);
      card.appendChild(msgBtn);
    }
    card.appendChild(bioWrap);

    if (isSelf) {
      var logout = document.createElement('button');
      logout.className = 'btn btn-danger';
      logout.type = 'button';
      logout.textContent = '退出登录';
      logout.addEventListener('click', function () {
        state.currentUser = null;
        updateNavUser();
        go('/');
      });
      card.appendChild(logout);
    }
    return card;
  }

  // 简介编辑框（内联）
  function buildBioEditor(user, bioText, editBtn) {
    var editor = document.createElement('div');
    editor.className = 'bio-editor';

    var ta = document.createElement('textarea');
    ta.rows = 3;
    ta.placeholder = '介绍一下自己，比如喜欢的书、读书的口味…';
    ta.value = user.bio || '';
    editor.appendChild(ta);

    var row = document.createElement('div');
    row.className = 'bio-editor-actions';

    var save = document.createElement('button');
    save.className = 'btn btn-primary btn-sm';
    save.type = 'button';
    save.textContent = '保存';
    save.addEventListener('click', function () {
      var v = ta.value.trim();
      if (v.length > 200) { showError('简介最多 200 字'); return; }
      user.bio = v;
      // 退出编辑态
      editor.remove();
      bioText.textContent = v || '这个人还没有写简介。';
      bioText.hidden = false;
      editBtn.hidden = false;
      showSuccess('简介已更新');
    });
    row.appendChild(save);

    var cancel = document.createElement('button');
    cancel.className = 'btn btn-sm';
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', function () {
      editor.remove();
      bioText.hidden = false;
      editBtn.hidden = false;
    });
    row.appendChild(cancel);

    editor.appendChild(row);
    return editor;
  }

  function renderMe() {
    var box = byId('me-content');
    box.textContent = '';

    if (!state.currentUser) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      var t = document.createElement('p');
      t.className = 'empty-title';
      t.textContent = '还没登录';
      empty.appendChild(t);
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '登录后可以看自己的资料，也可以去论坛发帖交流。';
      empty.appendChild(p);
      var btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.type = 'button';
      btn.textContent = '去登录 / 注册';
      btn.addEventListener('click', function () { go('/login'); });
      empty.appendChild(btn);
      box.appendChild(empty);
      return;
    }

    var me = state.currentUser;
    box.appendChild(buildBioCard(me, true));

    // 书单（本人）
    var shelfBox = document.createElement('div');
    shelfBox.className = 'box';
    var sh = document.createElement('div');
    sh.className = 'box-head';
    var st = document.createElement('h3');
    st.className = 'box-title';
    st.textContent = '我的书单';
    sh.appendChild(st);
    shelfBox.appendChild(sh);
    shelfBox.appendChild(buildShelves(me));
    box.appendChild(shelfBox);

    // 帖子 + 评论
    box.appendChild(buildActivity(me.id));
  }

  // 打开别人主页
  // 跳转：把地址改到这个人的主页（渲染交给 enterProfile）
  function openProfile(userId) {
    go('/user/' + encodeURIComponent(userId));
  }

  // 渲染：只填内容，不切页面
  function enterProfile(userId) {
    var user = userById(userId);
    if (!user) { showError('这个用户不存在'); return false; }
    state.profileUserId = userId;
    renderProfile(user);
    return true;
  }

  function renderProfile(user) {
    var box = byId('profile-content');
    box.textContent = '';

    box.appendChild(buildBioCard(user, false));

    // 书单
    var shelfBox = document.createElement('div');
    shelfBox.className = 'box';
    var sh = document.createElement('div');
    sh.className = 'box-head';
    var st = document.createElement('h3');
    st.className = 'box-title';
    st.textContent = user.username + ' 的书单';
    sh.appendChild(st);
    shelfBox.appendChild(sh);
    shelfBox.appendChild(buildShelves(user));
    box.appendChild(shelfBox);

    // 帖子 + 评论
    box.appendChild(buildActivity(user.id));
  }

  /* =============================================================
   * 9. 事件绑定 + 启动
   * ============================================================= */

  function bindEvents() {
    // 发帖按钮：打开发帖弹窗（登录后才可发）
    byId('btn-new-post').addEventListener('click', function () {
      if (!state.currentUser) { go('/login'); return; }
      openComposer();
    });

    // 发帖弹窗：取消 / 提交
    byId('btn-cancel-compose').addEventListener('click', function () {
      byId('modal-compose').hidden = true;
    });
    byId('form-compose').addEventListener('submit', function (e) {
      e.preventDefault();
      submitCompose();
    });

    // 热门档位切换
    byId('hot-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.filter') : null;
      if (!btn) return;
      var range = btn.getAttribute('data-range');
      if (!range || range === state.currentRange) return;   // 点当前档不重来一遍（Day 13）
      state.currentRange = range;
      var tabs = byId('hot-tabs').querySelectorAll('.filter');
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i] === btn) tabs[i].classList.add('is-active');
        else tabs[i].classList.remove('is-active');
      }
      // 加载态：先骨架、过一会儿再出内容（本地演示，说明见 app.js 的 showSkeleton）
      byId('hot-empty').hidden = true;
      if (window.AppViews.LOADING_MS <= 0) { renderHot(); return; }   // 测试环境：不演加载
      window.AppViews.showSkeleton(byId('hot-list'), 3);
      if (state.hotTimer) window.clearTimeout(state.hotTimer);
      state.hotTimer = window.setTimeout(function () {
        state.hotTimer = null;
        // 本轮 mock：三档数据暂用同一份；后端就绪后按 range 拉不同窗口
        renderHot();
      }, window.AppViews.LOADING_MS);
    });

    // 帖子流点击进详情（收藏按钮自己处理，别连带跳进详情页）
    byId('post-list').addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.fav-btn')) return;
      var card = e.target.closest ? e.target.closest('.post-card') : null;
      if (!card) return;
      state.postFromBook = false;
      openPost(card.getAttribute('data-id'));
    });

    // 热门榜点击：进「这本书的所有讨论」（点收藏按钮时不跳，交给按钮自己处理）
    byId('hot-list').addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.fav-btn')) return;
      var item = e.target.closest ? e.target.closest('.hot-item') : null;
      if (item) openBookPosts(item.getAttribute('data-title'));
    });

    // 悬停三件套（Day 11 Step 4）：首页书单 + 论坛里的三处书籍列表
    bindHoverSuite(byId('book-list'));
    bindHoverSuite(byId('post-list'));
    bindHoverSuite(byId('book-posts-list'));
    bindHoverSuite(byId('hot-list'));
    bindNarrowTap();

    // 同书帖子列表里，点某条帖子进详情（postFromBook 保持 true）
    byId('book-posts-list').addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.fav-btn')) return;
      var card = e.target.closest ? e.target.closest('.post-card') : null;
      if (card) openPost(card.getAttribute('data-id'));
    });

    // 返回：帖子详情根据来源回「同书列表」或「论坛」
    byId('btn-post-back').addEventListener('click', function () {
      if (state.postFromBook && state.lastBookTitle) {
        openBookPosts(state.lastBookTitle);
      } else {
        go('/forum');
      }
    });
    byId('btn-book-posts-back').addEventListener('click', function () { state.postFromBook = false; go('/forum'); });

    // 个人主页返回（回论坛）
    byId('btn-profile-back').addEventListener('click', function () { go('/forum'); });

    // 会话列表点击进对话
    byId('conversation-list').addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.conversation-item') : null;
      if (item) openConversation(item.getAttribute('data-id'));
    });

    // 登录/注册 tab 切换（切换时清空表单残留 + 错误提示，避免串台）
    byId('auth-tab-login').addEventListener('click', function () {
      state.authMode = 'login';
      resetAuthForm();
      renderAuth();
    });
    byId('auth-tab-register').addEventListener('click', function () {
      state.authMode = 'register';
      resetAuthForm();
      renderAuth();
    });

    // 头像色块点击
    byId('avatar-colors').addEventListener('click', function (e) {
      var sw = e.target.closest ? e.target.closest('.avatar-swatch') : null;
      if (!sw) return;
      state.avatarColor = sw.getAttribute('data-color');
      state.avatarImage = null;   // 选色块就清掉图片
      renderAvatarColors();
      refreshAvatarPreview();
    });

    // 上传头像图片
    byId('btn-avatar-upload').addEventListener('click', function () {
      byId('avatar-file-input').click();
    });
    byId('avatar-file-input').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        state.avatarImage = ev.target.result;
        state.avatarColor = null;
        renderAvatarColors();
        refreshAvatarPreview();
      };
      reader.readAsDataURL(file);
    });

    // 清除头像
    byId('btn-avatar-clear').addEventListener('click', function () {
      state.avatarColor = null;
      state.avatarImage = null;
      renderAvatarColors();
      refreshAvatarPreview();
    });

    // 账号名输入变化时，头像预览跟着变（首字随名字走）
    byId('auth-username').addEventListener('input', function () {
      if (state.authMode === 'register') refreshAvatarPreview();
    });

    // Day 17：接口数据页的「刷新」按钮。
    // ⚠️ 必须判空：_ac_test/_d2d_test 的迷你 DOM 里没有这个节点，判空才不会把测试整组带崩
    var apiDemoRefresh = byId('btn-api-demo-refresh');
    if (apiDemoRefresh) {
      apiDemoRefresh.addEventListener('click', function () { loadApiDemo(); });
    }

    // 提交登录/注册
    byId('form-auth').addEventListener('submit', function (e) {
      e.preventDefault();
      doAuth();
    });
  }

  /* =============================================================
   * Day 17 · 接口数据（只读演示）
   * -------------------------------------------------------------
   * 这是什么：GET /api/books（api-contract.md 3.1）的可视化验证。
   * 数据链路：浏览器 → CloudBase HTTP 网关 → books 云函数 →
   *           PG HTTP API → 真库 books 表。不是 localStorage 假数据。
   * 只读：本视图没有任何写操作（写入接口 Day 18 起）。
   * 注意：地址是硬编码的网关地址（契约 1.1）。跨域由 HTTP 网关放行
   * （Day 20 实测：带本环境静态托管域名发 GET，网关回 access-control-allow-origin，
   *  OPTIONS 预检 204 放行 POST；GitHub Pages 域名不在白名单，分享链接用 CloudBase）。
   * 旧地址 …-1385227197.ap-shanghai.app.tcloudbase.com（带地域段）Day 19 起报
   *  INVALID_ENV，已弃用——域名一律从控制台复制，不许手抄。
   * 测试钩子：本地验证时可用 window.__API_DEMO_URL__ 覆盖地址
   * （与 app.js 的 window.__LOADING_MS__ 同一套路，生产代码不设它）。
   * ============================================================= */
  var API_DEMO_URL = typeof window.__API_DEMO_URL__ === 'string'
    ? window.__API_DEMO_URL__
    : 'https://reading-sea-d7gd8l7o78b7304ae.service.tcloudbase.com/api/books';
  // 状态中文文案：与 app.js 的 STATUS_TEXT 保持同值（app.js 里那份不对外暴露，这里就地定义）
  var API_DEMO_STATUS = { want: '想读', reading: '在读', finished: '已读' };
  // Day 20 余力加练：检查台的「最后更新时间」。只在成功抓取后更新，
  // 失败时保留上一次的成功时间；存模块变量是为了切走再切回来不丢。
  var apiDemoLastUpdated = '';

  function setApiDemoUpdated() {
    apiDemoLastUpdated = '最后更新：' + new Date().toLocaleString();
    var u = byId('api-demo-updated');
    if (u) u.textContent = apiDemoLastUpdated;
  }

  function enterApiDemo() {
    // 铁规矩：enterXxx 只填内容，不切页面
    var t = byId('api-demo-table');
    if (t) t.textContent = '';
    var u = byId('api-demo-updated');
    if (u) u.textContent = apiDemoLastUpdated; // 先还原上次的成功时间，抓取成功后再刷新
    setStatus('正在从真库加载…', false);
    loadApiDemo();
  }

  function setStatus(text, isError) {
    var s = byId('api-demo-status');
    if (!s) return;
    s.textContent = text;
    s.classList.toggle('is-error', !!isError);
  }

  // ===== Day 23：把三类裸报错翻成人话 =====
  // fetch 失败有三种完全不同的原因，浏览器给的却可能是同一句英文：
  //   ① 网络层：请求根本没送出去       → TypeError: Failed to fetch（连状态码都没有）
  //   ② HTTP 层：送到了，对端回非 2xx  → 以前只显示 "HTTP 502"，看不出该找谁
  //   ③ 业务层：对端正常答话但说"不行" → 后端给的中文本来就是人话，原样透传
  // 三种该做的事完全不同（查网络 / 等一会重试 / 改输入），所以不能糊成一句"加载失败"。
  // 铁律：原始错误对象只进 console（给自己排查），绝不拼进给用户看的文案。
  function apiError(kind, message, status) {
    var e = new Error(message || '');
    e.kind = kind;
    if (status) e.status = status;
    return e;
  }

  function describeApiError(err) {
    // ① 网络层：fetch 自己 reject 了，异常上不会有 kind 标记
    if (!err || !err.kind) {
      return '网络连不上服务器，请检查网络后重试（本地书单不受影响）';
    }
    // ② HTTP 层：有响应但不是 2xx，或者回来的根本不是 JSON（典型是网关的 HTML 报错页）
    if (err.kind === 'http') {
      return '服务器暂时没响应（HTTP ' + err.status + '），请稍后重试（本地书单不受影响）';
    }
    // ③ 业务层：后端的中文原样给用户，不套壳、不翻译
    return err.message;
  }

  function loadApiDemo() {
    fetch(API_DEMO_URL)
      .then(function (r) {
        // 先取文本而不是直接 r.json()：网关回错误页时是 HTML，
        // r.json() 会抛「Unexpected token '<' ...」，既看不懂也指不出是谁的问题。
        return r.text().then(function (text) {
          return { httpStatus: r.status, text: text };
        });
      })
      .then(function (res) {
        if (res.httpStatus < 200 || res.httpStatus >= 300) {
          throw apiError('http', '', res.httpStatus);
        }
        var body;
        try {
          body = JSON.parse(res.text);
        } catch (e) {
          throw apiError('http', '', res.httpStatus); // 回了非 JSON，同样归 HTTP 层
        }
        // 契约 1.2：成败只看 ok 字段；失败时 error 是给人看的中文
        if (!body || body.ok !== true) {
          throw apiError('biz', (body && body.error) || '接口拒绝了这次请求');
        }
        renderApiDemoTable((body.data && body.data.books) || []);
      })
      .catch(function (err) {
        // 原始错误只给开发者看，用户只看到人话
        if (window.console && window.console.error) {
          window.console.error('[api-demo] 原始错误（只给自己排查用）：', err);
        }
        setStatus(describeApiError(err), true);
      });
  }

  function renderApiDemoTable(books) {
    var t = byId('api-demo-table');
    if (!t) return;
    setStatus('真库返回 ' + books.length + ' 本书 · ' + new Date().toLocaleTimeString() + ' 抓取', false);
    setApiDemoUpdated(); // Day 20 余力：成功抓取才刷新「最后更新时间」

    if (!books.length) {
      var p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '真库里还没有书。去控制台 SQL 编辑器跑一遍 db/seed.sql 就有数据了。';
      t.appendChild(p);
      return;
    }

    // 全部用 createElement + textContent（和社区层一致，不拼 HTML 字符串，天然防注入）
    var table = document.createElement('table');
    table.className = 'api-table';

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['书名', '作者', '状态', '进度（页）', '创建日期'].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      th.scope = 'col';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    books.forEach(function (b) {
      var tr = document.createElement('tr');

      var tdTitle = document.createElement('td');
      tdTitle.textContent = b.title || '（无书名）';
      tr.appendChild(tdTitle);

      var tdAuthor = document.createElement('td');
      tdAuthor.textContent = b.author || '—';
      tr.appendChild(tdAuthor);

      var tdStatus = document.createElement('td');
      tdStatus.textContent = API_DEMO_STATUS[b.status] || b.status || '—';
      tr.appendChild(tdStatus);

      var tdProgress = document.createElement('td');
      tdProgress.textContent = (b.currentPage == null || b.totalPages == null)
        ? '—'
        : (b.currentPage + ' / ' + b.totalPages);
      tr.appendChild(tdProgress);

      var tdDate = document.createElement('td');
      tdDate.textContent = b.createdAt ? String(b.createdAt).slice(0, 10) : '—';
      tr.appendChild(tdDate);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    t.textContent = '';
    t.appendChild(table);
  }

  /* =============================================================
   * Day 20+ · 星海模块（守护鲸养成 / 形态图鉴 / 数据小卡 / 今日一句）
   * -------------------------------------------------------------
   * 干什么：把「书架里有多少本书」翻译成鲸的形态，一处数据驱动四处显示——
   *   ① 首页守护鲸面板：形态徽章 + 体型 + 装备 + 进化文案 + 进度提示
   *   ② 我的页形态图鉴：两段成就墙（1~30 本 / 双鲸纪元）的点亮
   *   ③ 首页数据小卡：在读 / 书简 / 藏书，全部是 store.js 的真数据
   *   ④ 首页今日一句：每次打开随机一句读书名言
   * 数据来源：Store.listBooks / Store.countNotes，**零新增存储键**。
   * 进化分两阶段：1~30 本第一头鲸长到「完全体 · 鲸星」（25 本封顶，
   *   30 本为阶段终点）；31 本起第二头鲸以完全体为起点继续升级（双鲸纪元）。
   * 触发时机：首次加载 / 进首页 / 进我的 / 任何书籍与笔记的写操作之后。
   * 与预览稿的区别：这里没有演示按钮，形态完全由真实数据推导。
   * 测试友好：所有 DOM 查找都判空（_ac_test / _d2d_test 的迷你 DOM 里
   *   没有这些节点，判空才不会把测试整组带崩）。
   * ============================================================= */

  /* 进化表：min = 需要书数，scale = 体型，gears = 已解锁装备 */
  var GUARD_STAGES = [
    { min: 0,  key: 'sleep', name: '沉睡',                scale: 0.4,  gears: [],
      copy: '每收藏一本书，它就长大一点。第一本书会唤醒它。' },
    { min: 1,  key: 'baby',  name: '苏醒 · 幼鲸',          scale: 0.42, gears: [],
      copy: '书架有了第一本书，它开始游动。' },
    { min: 3,  key: 'grow',  name: '成长',                scale: 0.56, gears: ['trail'],
      copy: '它认得你了，尾迹拖出了星光。' },
    { min: 5,  key: 'teen',  name: '少年鲸',              scale: 0.68, gears: ['trail'],
      copy: '星轨爬上它的背脊。' },
    { min: 8,  key: 'adult', name: '成年鲸',              scale: 0.82, gears: ['trail'],
      copy: '它长成了能载动书架的模样。' },
    { min: 11, key: 'armor', name: '装备 I · 星骨装甲',    scale: 0.9,  gears: ['trail', 'armor'],
      copy: '第一件装备上身——星骨装甲，冷光沿着脊线亮起。' },
    { min: 14, key: 'core',  name: '装备 II · 能量核心',   scale: 0.94, gears: ['trail', 'armor', 'core'],
      copy: '胸腔里点亮了一枚能量核心，每一次呼吸都在蓄能。' },
    { min: 17, key: 'sats',  name: '装备 III · 环轨卫星',  scale: 0.98, gears: ['trail', 'armor', 'core', 'sats'],
      copy: '两颗环轨卫星开始绕它巡游。' },
    { min: 20, key: 'flame', name: '装备 IV · 等离子尾焰', scale: 1.02, gears: ['trail', 'armor', 'core', 'sats', 'flame'],
      copy: '尾后燃起等离子尾焰，它穿星海如履平地。' },
    { min: 25, key: 'star',  name: '完全体 · 鲸星',        scale: 1.08, gears: ['trail', 'armor', 'core', 'sats', 'flame', 'halo'],
      copy: '它已能横渡星海——你的书简，是它的星图。' }
  ];
  var GUARD_SHORT = ['幼鲸', '成长', '少年鲸', '成年鲸', '星骨装甲', '能量核心', '环轨卫星', '等离子尾焰', '鲸星'];

  /* 第二阶段：双鲸纪元（31 本起，第二头鲸以完全体为起点继续升级） */
  var GUARD_STAGES2 = [
    { min: 31, key: 'd1', name: '双鲸纪元 · Ⅰ',   scale: 0.72, gears: ['trail', 'armor', 'core', 'sats', 'flame', 'halo'],
      copy: '第二条鲸自星海深处而来——它以完全体为起点。' },
    { min: 35, key: 'd2', name: '双鲸纪元 · Ⅱ',   scale: 0.78, gears: ['trail', 'armor', 'core', 'sats', 'flame', 'halo', 'warp'],
      copy: '它展开了第一道时空折跃环。' },
    { min: 40, key: 'd3', name: '双鲸纪元 · Ⅲ',   scale: 0.84, gears: ['trail', 'armor', 'core', 'sats', 'flame', 'halo', 'warp', 'matrix'],
      copy: '星核矩阵点亮——三颗星核绕体运转。' },
    { min: 45, key: 'd4', name: '双鲸纪元 · Ⅳ',   scale: 0.9,  gears: ['trail', 'armor', 'core', 'sats', 'flame', 'halo', 'warp', 'matrix', 'wings'],
      copy: '银河之翼展开，它带着整片星海游动。' },
    { min: 50, key: 'd5', name: '鲸群 · 星海之王', scale: 0.96, gears: ['trail', 'armor', 'core', 'sats', 'flame', 'halo', 'warp', 'matrix', 'wings'],
      copy: '两鲸同游，你的书简已成星图。' }
  ];
  var GUARD_SHORT2 = ['双鲸·Ⅰ', '双鲸·Ⅱ', '双鲸·Ⅲ', '双鲸·Ⅳ', '星海之王'];
  var GEARS_1 = ['trail', 'armor', 'core', 'sats', 'flame', 'halo'];
  var GEARS_2 = GEARS_1.concat(['warp', 'matrix', 'wings']);

  /* 今日一句：每次打开随机挑一句（不落存储，纯现场随机） */
  var QUOTES = [
    { t: '读书是在别人思想的帮助下，建立起自己的思想。', f: '鲁巴金' },
    { t: '书山有路勤为径，学海无涯苦作舟。',             f: '韩愈' },
    { t: '问渠那得清如许，为有源头活水来。',             f: '朱熹《观书有感》' },
    { t: '腹有诗书气自华。',                             f: '苏轼' },
    { t: '读书破万卷，下笔如有神。',                     f: '杜甫' },
    { t: '一鲸落，万物生——读过的书，终会成为你的海底山脉。', f: '鲸落书简' }
  ];

  /* 迷你 DOM 兼容三件套：_ac_test/_d2d_test 的测试桩里
     classList 没有 toggle、style 没有 setProperty、也没有 createTextNode，
     真浏览器全都支持——所以统一走这三个安全包装，测试和浏览器都不炸。 */
  function toggleClass(el, name, on) {
    if (!el || !el.classList) return;
    if (typeof el.classList.toggle === 'function') { el.classList.toggle(name, !!on); return; }
    if (on) { if (typeof el.classList.add === 'function') el.classList.add(name); }
    else if (typeof el.classList.remove === 'function') el.classList.remove(name);
  }

  function setVar(el, name, value) {
    if (!el || !el.style) return;
    if (typeof el.style.setProperty === 'function') el.style.setProperty(name, value);
    else { try { el.style[name] = value; } catch (e) { /* 测试桩：忽略 */ } }
  }

  function metaText(text) {
    var span = document.createElement('span');
    span.textContent = text;
    return span;
  }

  var codexBuilt = false;

  /* 从书里取三个数：藏书数、在读数、笔记数。
     ⚠️ store.js 的真实返回形状（别按印象取值）：
       Store.listBooks()      → { ok:true, data: [书, 书, ...] }   data 本身就是数组
       Store.countNotes(id)   → { ok:true, data: 数字 }            data 就是条数
     （Day 20+ 踩过：一开始按 { data:{ books:[...] } } 取，结果永远读到 0 本） */
  function guardData() {
    var books = [];
    if (typeof Store !== 'undefined' && Store && typeof Store.listBooks === 'function') {
      var res = Store.listBooks();
      if (res && res.ok && res.data && typeof res.data.length === 'number') books = res.data;
    }
    var reading = 0;
    var notes = 0;
    for (var i = 0; i < books.length; i++) {
      if (books[i].status === 'reading') reading++;
      if (typeof Store !== 'undefined' && Store && typeof Store.countNotes === 'function') {
        var c = Store.countNotes(books[i].id);
        if (c && c.ok && typeof c.data === 'number') notes += c.data;
      }
    }
    return { books: books.length, reading: reading, notes: notes };
  }

  function stageAt(list, count) {
    var s = list[0];
    for (var i = 0; i < list.length; i++) { if (count >= list[i].min) s = list[i]; }
    return s;
  }

  function nextStageAt(list, count) {
    for (var i = 0; i < list.length; i++) { if (list[i].min > count) return list[i]; }
    return null;
  }

  /* 图鉴骨架：只建一次，之后只改状态 */
  function buildCodex() {
    if (codexBuilt) return;
    var g1 = byId('cx-grid');
    var g2 = byId('cx-grid2');
    if (!g1 && !g2) return;         // 迷你 DOM 里没有图鉴，直接跳过
    if (g1) {
      for (var i = 1; i < GUARD_STAGES.length; i++) {
        var t = document.createElement('div');
        t.className = 'cx-tile';
        t.setAttribute('data-stage', 'cx-' + GUARD_STAGES[i].key);
        var b = document.createElement('b');
        b.textContent = GUARD_SHORT[i - 1];
        t.appendChild(b);
        t.appendChild(metaText('需 ' + GUARD_STAGES[i].min + ' 本'));
        g1.appendChild(t);
      }
    }
    if (g2) {
      for (var j = 0; j < GUARD_STAGES2.length; j++) {
        var t2 = document.createElement('div');
        t2.className = 'cx-tile';
        t2.setAttribute('data-stage', 'c2-' + GUARD_STAGES2[j].key);
        var b2 = document.createElement('b');
        b2.textContent = GUARD_SHORT2[j];
        t2.appendChild(b2);
        t2.appendChild(metaText('需 ' + GUARD_STAGES2[j].min + ' 本'));
        g2.appendChild(t2);
      }
    }
    codexBuilt = true;
  }

  function renderGuard() {
    var data = guardData();
    var n = data.books;
    var s1 = stageAt(GUARD_STAGES, n);
    var dual = n >= 31;
    var s2 = dual ? stageAt(GUARD_STAGES2, n) : null;

    /* ① 面板 */
    var panel = byId('guard-panel');
    if (panel) {
      toggleClass(panel, 'sleep', n === 0);
      toggleClass(panel, 'dual', dual);
      var stage = byId('whale-stage');
      if (stage) {
        setVar(stage, '--s', n === 0 ? 1 : s1.scale);
        for (var i = 0; i < GEARS_1.length; i++) {
          toggleClass(stage, 'g-' + GEARS_1[i], n > 0 && s1.gears.indexOf(GEARS_1[i]) > -1);
        }
      }
      var stage2 = byId('whale-stage2');
      if (stage2 && dual) {
        setVar(stage2, '--s2', s2.scale);
        for (var j = 0; j < GEARS_2.length; j++) {
          toggleClass(stage2, 'g2-' + GEARS_2[j], s2.gears.indexOf(GEARS_2[j]) > -1);
        }
      }
      var badge = byId('stage-badge');
      if (badge) badge.textContent = dual ? s2.name : s1.name;
      var title = byId('guard-title');
      if (title) title.textContent = n === 0 ? '守护鲸在沉睡' : (dual ? '双鲸纪元' : '你的鲸醒来了');
      var sub = byId('guard-sub');
      if (sub) sub.textContent = dual ? s2.copy : s1.copy;
      var countEl = byId('stage-count');
      if (countEl) {
        if (n === 0) {
          countEl.textContent = '';
        } else if (dual) {
          var nx2 = nextStageAt(GUARD_STAGES2, n);
          countEl.textContent = '已收藏 ' + n + ' 本 · 第二头鲸已入场' +
            (nx2 ? ' · 距「' + nx2.name + '」还差 ' + (nx2.min - n) + ' 本' : ' · 鲸群已成形');
        } else {
          var nx1 = nextStageAt(GUARD_STAGES, n);
          countEl.textContent = '已收藏 ' + n + ' 本 · ' +
            (nx1 ? '距「' + nx1.name + '」还差 ' + (nx1.min - n) + ' 本'
                 : '已至完全体（30 本开启双鲸纪元）');
        }
      }
    }

    /* ② 图鉴 */
    buildCodex();
    var tiles = (typeof document.querySelectorAll === 'function') ? document.querySelectorAll('.cx-tile') : [];
    for (var k = 0; k < tiles.length; k++) {
      var el = tiles[k];
      var id = el.getAttribute('data-stage') || '';
      var def = null;
      var isTier2 = id.indexOf('c2-') === 0;
      var key = id.replace(/^c2-/, '').replace(/^cx-/, '');
      var list = isTier2 ? GUARD_STAGES2 : GUARD_STAGES;
      for (var m = 0; m < list.length; m++) { if (list[m].key === key) def = list[m]; }
      if (!def) continue;
      toggleClass(el, 'on', n >= def.min);
      toggleClass(el, 'now', isTier2 ? (dual && s2.key === def.key) : (!dual && s1.key === def.key));
    }

    /* ③ 数据小卡 */
    var sr = byId('stat-reading');
    if (sr) sr.textContent = String(data.reading);
    var sn = byId('stat-notes');
    if (sn) sn.textContent = String(data.notes);
    var sb = byId('stat-books');
    if (sb) sb.textContent = String(data.books);
  }

  /* 今日一句：每次打开换一句 */
  function renderQuote() {
    var el = byId('quote-text');
    var from = byId('quote-from');
    if (!el && !from) return;
    var q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    if (el) el.textContent = '「' + q.t + '」';
    if (from) from.textContent = '—— ' + q.f + ' · 每次打开换一句';
  }

  /* 开场：让整页轻轻一震（只在允许动画时加这个类） */
  function startOpening() {
    if (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    toggleClass(document.body, 'opening-shake', true);
  }

  /* 把 Store 的写方法包一层：任何书/笔记变动后都重算一次鲸与统计。
     这样不用改 app.js 的每一处渲染调用，也不漏掉任何一条写入路径。 */
  function hookStoreMutations() {
    if (typeof Store === 'undefined' || !Store) return;
    var names = ['addBook', 'updateBook', 'deleteBook', 'addNote', 'updateNote', 'deleteNote', 'toggleLike'];
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        var orig = Store[name];
        if (typeof orig !== 'function') return;
        Store[name] = function () {
          var out = orig.apply(Store, arguments);
          setTimeout(renderGuard, 0);   // 等本轮渲染画完再刷
          return out;
        };
      })(names[i]);
    }
  }

  function initStarSea() {
    renderGuard();
    renderQuote();
    hookStoreMutations();
    startOpening();
  }

  // 对外暴露（自动化测试 _starsea_test.js 用；以后别的模块要读进化表也从这拿）
  window.StarSea = {
    render: renderGuard,
    stages: GUARD_STAGES,
    stages2: GUARD_STAGES2,
    data: guardData
  };

  function init() {
    bindNav();
    bindEvents();
    updateNavUser();
    // Day 20+：星海模块（守护鲸/图鉴/数据卡/今日一句/开场轻震）
    initStarSea();
    // 按地址栏的 hash 落到对应页面（Day 13）。
    // 参数 true = 启动阶段：不擦掉 app.js 刚设的「存储不可用」等全局告警
    //（Day 12 修复的 bug，别改回去）。
    applyRoute(true);
  }

  init();
})();
