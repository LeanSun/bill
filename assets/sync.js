/* ============================================================
   轻账 · 云同步层
   后端接口见 server/server.js。
   模型：服务器保存"整份增量状态 + rev"。客户端本地改完 → 带 rev 推；
   rev 对不上就是冲突，交给用户二选一，绝不做隐式合并。
   ============================================================ */
(function () {
  'use strict';

  var CFG_KEY = 'qingzhang.sync.v2';
  var PUSH_DELAY = 1200;         // 连续编辑时合并成一次推送
  var PULL_IDLE = 20000;         // 切回标签页时，超过这个间隔才拉
  var TICK = 60000;              // 后台轮询间隔

  var cfg = loadCfg();
  var dirty = false;             // 本地有未推送的改动
  var applying = false;          // 正在写入应用层，期间产生的变更不算"本地改动"
  var busy = false;
  var pendingPush = null;
  var pendingConflict = null;
  var lastSync = 0;
  var conflictEl = null;

  /* ---------------- 配置 ---------------- */
  function loadCfg() {
    try {
      var o = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      return {
        url: typeof o.url === 'string' ? o.url : '',
        token: typeof o.token === 'string' ? o.token : '',
        exp: Number(o.exp) || 0,
        rev: Number.isFinite(Number(o.rev)) ? Number(o.rev) : -1
      };
    } catch (e) { return { url: '', token: '', exp: 0, rev: -1 }; }
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 无痕模式静默 */ }
  }
  function connected() { return !!(cfg.url && cfg.token && cfg.exp * 1000 > Date.now()); }
  function baseUrl() { return String(cfg.url || '').replace(/\/+$/, ''); }

  /* ---------------- 网络 ---------------- */
  function request(pathname, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (!opts.noAuth && cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, opts.timeout || 15000);
    return fetch(baseUrl() + pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      mode: 'cors',
      cache: 'no-store'
    }).then(function (r) {
      clearTimeout(to);
      return r.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data, raw: t };
      });
    }).catch(function (e) {
      clearTimeout(to);
      throw new Error(e && e.name === 'AbortError' ? '请求超时' : '连不上服务器');
    });
  }

  /* ---------------- 应用层桥 ---------------- */
  function api() { return window.QZ || null; }

  function localSnapshot() {
    var q = api();
    if (!q) return null;
    var s = q.getStore();
    return {
      added: s.added || [],
      edited: s.edited || {},
      deleted: s.deleted || [],
      theme: s.theme === 'dark' ? 'dark' : 'light'
    };
  }

  function adopt(remote) {
    var q = api();
    if (!q) return;
    applying = true;
    try {
      q.setStore(remote);
      if (remote.theme && remote.theme !== q.theme()) q.setTheme(remote.theme);
    } finally {
      setTimeout(function () { applying = false; }, 0);
    }
    cfg.rev = Number(remote.rev) || 0;
    dirty = false;
    lastSync = Date.now();
    saveCfg();
  }

  /* ---------------- 核心动作 ---------------- */
  function push(forceRev) {
    var snap = localSnapshot();
    if (!snap) return Promise.resolve();
    var rev = Number.isFinite(forceRev) ? forceRev : cfg.rev;
    return request('/api/state', { method: 'PUT', body: Object.assign({ rev: rev }, snap) })
      .then(function (r) {
        if (r.status === 200 && r.data) {
          cfg.rev = Number(r.data.rev) || cfg.rev + 1;
          dirty = false;
          lastSync = Date.now();
          saveCfg();
          setStatus('已同步 · rev ' + cfg.rev);
          return;
        }
        if (r.status === 409 && r.data && r.data.current) return askConflict(r.data.current);
        if (r.status === 401) return expire();
        throw new Error(errMsg(r));
      })
      .catch(function (e) { setStatus('推送失败：' + e.message, 'warn'); });
  }

  function pull(reason) {
    if (!connected() || busy) return Promise.resolve();
    busy = true;
    setStatus('同步中…');
    return request('/api/state')
      .then(function (r) {
        if (r.status === 401) return expire();
        if (r.status !== 200 || !r.data) throw new Error(errMsg(r));
        var s = r.data;
        if (!dirty) return adopt(s);
        if (Number(s.rev) === Number(cfg.rev)) return push();
        return askConflict(s);
      })
      .catch(function (e) { setStatus('拉取失败：' + e.message, 'warn'); })
      .then(function () { busy = false; refreshMeta(); });
  }

  function askConflict(serverState) {
    pendingConflict = serverState;
    setStatus('发现冲突：服务器 rev ' + serverState.rev + '，本地基线 rev ' + cfg.rev, 'warn');
    if (conflictEl) conflictEl.hidden = false;
    refreshMeta();
  }

  function expire() {
    cfg.token = '';
    cfg.exp = 0;
    saveCfg();
    setStatus('登录已过期，请重新连接', 'warn');
    render();
  }

  function errMsg(r) {
    if (r && r.data && r.data.error) return r.data.error;
    return 'HTTP ' + (r ? r.status : '?');
  }

  /* ---------------- 变更订阅 ---------------- */
  function onLocalChange() {
    if (applying) return;
    dirty = true;
    refreshMeta();
    if (!connected()) return;
    clearTimeout(pendingPush);
    pendingPush = setTimeout(function () {
      if (!connected() || pendingConflict) return;
      push();
    }, PUSH_DELAY);
  }

  /* ---------------- 界面 ---------------- */
  var $ = function (id) { return document.getElementById(id); };

  function setStatus(text, kind) {
    var el = $('syncStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'sync-status' + (kind ? ' is-' + kind : '');
    var dot = $('syncDot');
    if (dot) dot.className = 'sync-dot' + (kind === 'warn' ? ' is-warn' : (connected() ? ' is-on' : ''));
  }

  function refreshMeta() {
    var meta = $('syncMeta');
    if (!meta) return;
    var bits = [];
    bits.push(connected() ? '已连接' : '未连接');
    bits.push('本地 rev ' + cfg.rev);
    if (dirty) bits.push('有未推送的改动');
    if (lastSync) bits.push('上次同步 ' + new Date(lastSync).toLocaleTimeString('zh-CN', { hour12: false }));
    meta.textContent = bits.join(' · ');
    var now = $('syncNow');
    if (now) now.disabled = !connected();
    var out = $('syncDisconnect');
    if (out) out.disabled = !connected();
    if (conflictEl) conflictEl.hidden = !pendingConflict;
  }

  function render() {
    refreshMeta();
    if (!connected()) setStatus('未连接');
    else if (pendingConflict) refreshMeta();
    else setStatus('已连接 · rev ' + cfg.rev);
  }

  function open() {
    var mask = $('syncMask');
    if (!mask) return;
    if ($('syncUrl')) $('syncUrl').value = cfg.url || '';
    if ($('syncPw')) $('syncPw').value = '';
    pendingConflict = null;
    mask.hidden = false;
    mask.classList.add('is-on');
    render();
    setTimeout(function () { var u = $('syncUrl'); if (u) u.focus(); }, 60);
  }
  function close() {
    var mask = $('syncMask');
    if (!mask) return;
    mask.classList.remove('is-on');
    mask.hidden = true;
  }

  function connect() {
    var url = ($('syncUrl') && $('syncUrl').value || '').trim();
    var pw = ($('syncPw') && $('syncPw').value || '');
    if (!url) return setStatus('先填服务器地址', 'warn');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!pw) return setStatus('先填访问口令', 'warn');
    setStatus('正在连接…');
    cfg.url = url.replace(/\/+$/, '');
    cfg.token = '';
    cfg.exp = 0;
    return request('/api/login', { method: 'POST', body: { password: pw }, noAuth: true })
      .then(function (r) {
        if (r.status === 429) throw new Error('尝试过于频繁，等几分钟');
        if (r.status !== 200 || !r.data || !r.data.token) throw new Error(errMsg(r));
        cfg.token = r.data.token;
        cfg.exp = Number(r.data.exp) || 0;
        cfg.rev = -1;
        dirty = true;                                  // 首次连接：以本地为起点等一次比对
        saveCfg();
        setStatus('已登录，正在对齐数据…');
        return request('/api/state').then(function (s) {
          if (s.status !== 200 || !s.data) throw new Error(errMsg(s));
          /* 服务器是空的（rev 0）就直接把本地推上去；否则让用户决定谁覆盖谁 */
          if (Number(s.data.rev) === 0) {
            cfg.rev = 0;
            dirty = true;
            saveCfg();
            return push(0);
          }
          pendingConflict = s.data;
          dirty = true;
          setStatus('已连接。服务器上已有 rev ' + s.data.rev + ' 的数据，选择保留哪一份', 'warn');
          refreshMeta();
        });
      })
      .catch(function (e) { setStatus('连接失败：' + e.message, 'warn'); });
  }

  function keepServer() {
    if (!pendingConflict) return;
    var s = pendingConflict;
    pendingConflict = null;
    adopt(s);
    setStatus('已用服务器版本覆盖本地 · rev ' + cfg.rev);
    refreshMeta();
  }

  function keepLocal() {
    if (!pendingConflict) return;
    var rev = Number(pendingConflict.rev) || 0;
    pendingConflict = null;
    setStatus('正在用本地覆盖服务器…');
    dirty = true;
    push(rev);
  }

  function disconnect() {
    cfg = { url: '', token: '', exp: 0, rev: -1 };
    dirty = false;
    pendingConflict = null;
    saveCfg();
    setStatus('已断开，本地数据照旧保留');
    refreshMeta();
  }

  function exportBackup() {
    if (!connected()) return setStatus('未连接，无法导出服务器备份', 'warn');
    setStatus('正在打包…');
    request('/api/export', { timeout: 60000 }).then(function (r) {
      if (r.status !== 200 || !r.data) throw new Error(errMsg(r));
      var blob = new Blob([JSON.stringify({ type: 'qingzhang-backup', exportedAt: new Date().toISOString(), state: r.data }, null, 2)],
        { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'qingzhang-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      setStatus('备份已下载');
    }).catch(function (e) { setStatus('导出失败：' + e.message, 'warn'); });
  }

  function importBackup(file) {
    if (!file) return;
    if (!connected()) return setStatus('未连接，无法写入服务器', 'warn');
    var reader = new FileReader();
    reader.onload = function () {
      var doc;
      try { doc = JSON.parse(String(reader.result)); } catch (e) { return setStatus('文件不是合法 JSON', 'warn'); }
      var state = doc && doc.state ? doc.state : doc;
      setStatus('正在导入…');
      request('/api/import', { method: 'POST', body: { state: state } })
        .then(function (r) {
          if (r.status !== 200 || !r.data) throw new Error(errMsg(r));
          pendingConflict = null;
          adopt(r.data);
          setStatus('已导入 · rev ' + cfg.rev);
        })
        .catch(function (e) { setStatus('导入失败：' + e.message, 'warn'); });
    };
    reader.readAsText(file);
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    var q = api();
    if (q && typeof q.onStoreChange === 'function') q.onStoreChange(onLocalChange);

    var openBtn = $('syncBtn');
    if (openBtn) openBtn.addEventListener('click', open);
    var closeBtn = $('syncClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var mask = $('syncMask');
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mask && !mask.hidden) close();
    });

    conflictEl = $('syncConflict');
    var c = $('syncConnect');
    if (c) c.addEventListener('click', function (e) { e.preventDefault(); connect(); });
    var n = $('syncNow');
    if (n) n.addEventListener('click', function (e) { e.preventDefault(); pull('manual'); });
    var d = $('syncDisconnect');
    if (d) d.addEventListener('click', function (e) { e.preventDefault(); disconnect(); });
    var ex = $('syncExport');
    if (ex) ex.addEventListener('click', function (e) { e.preventDefault(); exportBackup(); });
    var im = $('syncImport');
    if (im) im.addEventListener('change', function () {
      if (this.files && this.files[0]) importBackup(this.files[0]);
      this.value = '';
    });
    var ks = $('syncKeepServer');
    if (ks) ks.addEventListener('click', function (e) { e.preventDefault(); keepServer(); });
    var kl = $('syncKeepLocal');
    if (kl) kl.addEventListener('click', function (e) { e.preventDefault(); keepLocal(); });

    /* 口令框回车 = 连接 */
    var pw = $('syncPw');
    if (pw) pw.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); connect(); }
    });

    render();

    /* 回到标签页就顺一次；断开状态什么都不做 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !connected()) return;
      if (Date.now() - lastSync < PULL_IDLE) return;
      pull('visible');
    });
    window.addEventListener('focus', function () {
      if (!connected() || Date.now() - lastSync < PULL_IDLE) return;
      pull('focus');
    });
    setInterval(function () {
      if (connected() && !pendingConflict && document.visibilityState === 'visible') pull('tick');
    }, TICK);

    /* 页面启动时如果已经连过，先拉一次 */
    if (connected()) setTimeout(function () { pull('boot'); }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  /* 调试口子：控制台里 QZSync.pull() 可以手动拉一次 */
  window.QZSync = { pull: pull, push: push, open: open, status: function () { return { cfg: cfg, dirty: dirty }; } };
})();
