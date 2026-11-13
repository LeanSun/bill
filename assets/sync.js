/* ============================================================
   轻账 · 云同步层
   两个后端，同一个面板：
     github — 私有仓库里的一个 state.json，走 GitHub Contents API。
              每次保存就是一个 commit，历史版本 = 备份。
     http   — 自建服务器（server/server.js），整份状态 + rev 乐观锁。
   两者共用的约定：
     本地改完 → 带上"基线版本"（http 是 rev，github 是文件 sha）推；
     基线对不上就是冲突，交给用户二选一，绝不做隐式合并。
   ============================================================ */
(function () {
  'use strict';

  var CFG_KEY = 'qingzhang.sync.v3';
  var OLD_KEY = 'qingzhang.sync.v2';
  var PUSH_DELAY = 1200;         // 连续编辑时合并成一次推送
  var PULL_IDLE = 20000;         // 切回标签页时，超过这个间隔才拉
  var TICK = 60000;              // 后台轮询间隔
  var GH_API = 'https://api.github.com';

  var cfg = loadCfg();
  var dirty = false;             // 本地有未推送的改动
  var applying = false;          // 正在写入应用层，期间产生的变更不算"本地改动"
  var busy = false;
  var pendingPush = null;
  var pendingConflict = null;
  var pendingConflictSha = null;
  var lastSync = 0;
  var conflictEl = null;

  /* ---------------- 配置 ---------------- */
  function loadCfg() {
    var base = {
      mode: 'github', url: '', owner: '', repo: '', branch: 'main', path: 'state.json',
      token: '', exp: 0, rev: -1, sha: ''
    };
    var o = {};
    try { o = JSON.parse(localStorage.getItem(CFG_KEY) || 'null') || {}; } catch (e) { o = {}; }
    if (!o || !o.mode) {
      /* 老版本只有 url/token，迁过来继续可用 */
      try {
        var old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');
        if (old && old.url) o = Object.assign({}, old, { mode: 'http' });
      } catch (e2) { /* 忽略 */ }
    }
    var out = Object.assign(base, o);
    out.mode = out.mode === 'http' ? 'http' : 'github';
    out.rev = Number.isFinite(Number(out.rev)) ? Number(out.rev) : -1;
    out.exp = Number(out.exp) || 0;
    return out;
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) { /* 无痕模式静默 */ }
  }
  function connected() {
    if (!cfg.token || !(cfg.exp * 1000 > Date.now())) return false;
    if (cfg.mode === 'http') return !!cfg.url;
    return !!(cfg.owner && cfg.repo);
  }
  function baseUrl() { return String(cfg.url || '').replace(/\/+$/, ''); }
  function remoteName() { return cfg.mode === 'github' ? '仓库' : '服务器'; }

  /* ---------------- 传输小工具 ---------------- */
  function netFail(e) {
    var msg = e && e.name === 'AbortError' ? '请求超时' : '网络不通';
    return { ok: false, code: 'net', message: msg };
  }
  function timeoutSignal(ms) {
    if (typeof AbortController === 'undefined') return { signal: undefined, done: function () {} };
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms || 15000);
    return { signal: ctrl.signal, done: function () { clearTimeout(t); } };
  }
  function parseJson(text) {
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }

  /* 自建服务器用的请求封装 */
  function request(pathname, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (!opts.noAuth && cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    var sig = timeoutSignal(opts.timeout || 15000);
    return fetch(baseUrl() + pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: sig.signal,
      mode: 'cors',
      cache: 'no-store'
    }).then(function (r) {
      sig.done();
      return r.text().then(function (t) {
        return { status: r.status, data: parseJson(t), raw: t };
      });
    }).catch(function (e) { sig.done(); throw e; });
  }

  /* UTF-8 安全的 base64（btoa 只吃单字节，中文会炸） */
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* ---------------- GitHub 驱动 ---------------- */
  function contentPath() {
    return '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
      '/contents/' + String(cfg.path || 'state.json').split('/').map(encodeURIComponent).join('/');
  }

  function ghCall(method, pathname, body, opts) {
    opts = opts || {};
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + cfg.token
    };
    if (body) headers['Content-Type'] = 'application/json';
    var sig = timeoutSignal(opts.timeout || 20000);
    return fetch(GH_API + pathname, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: sig.signal,
      cache: 'no-store'
    }).then(function (r) {
      sig.done();
      var remaining = r.headers.get('x-ratelimit-remaining');
      return r.text().then(function (t) {
        return { status: r.status, data: parseJson(t), remaining: remaining };
      });
    }).catch(function (e) { sig.done(); throw e; });
  }

  function ghExplain(r) {
    if (r.status === 401) return '令牌无效或已过期';
    if (r.status === 403) {
      return String(r.remaining) === '0' ? '接口额度用尽，等一小时' : '令牌权限不足（需要 Contents 读写）';
    }
    if (r.status === 404) return '仓库或文件找不到（私有仓库还需要令牌有 Contents 读权限）';
    return 'HTTP ' + r.status + (r.data && r.data.message ? ' · ' + r.data.message : '');
  }

  function ghRead() {
    return ghCall('GET', contentPath() + '?ref=' + encodeURIComponent(cfg.branch || 'main'))
      .then(function (r) {
        if (r.status === 404) return { ok: true, state: null, sha: '' };   // 文件还没建
        if (r.status === 401 || r.status === 403) return { ok: false, code: 'auth', message: ghExplain(r) };
        if (r.status !== 200 || !r.data) return { ok: false, code: 'other', message: ghExplain(r) };
        var text = '';
        if (r.data.encoding === 'base64' && r.data.content) {
          text = b64decode(r.data.content);
        }
        if (!text) {
          /* 超过 1MB 的大文件不给 base64，改拿 raw */
          return ghCall('GET', contentPath() + '?ref=' + encodeURIComponent(cfg.branch || 'main'),
            null, { timeout: 30000 }).then(function (raw) {
            if (raw.status !== 200) return { ok: false, code: 'other', message: ghExplain(raw) };
            return { ok: true, state: null, sha: r.data.sha, rawUnsupported: true };
          });
        }
        var state = parseJson(text);
        if (!state) return { ok: false, code: 'other', message: 'state.json 不是合法 JSON' };
        state.rev = Number(state.rev) || 0;
        return { ok: true, state: state, sha: r.data.sha };
      }, netFail);
  }

  function ghCommitMessage(state) {
    var a = (state.added || []).length;
    var e = Object.keys(state.edited || {}).length;
    var d = (state.deleted || []).length;
    var stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    return 'sync: ' + stamp + ' · rev ' + state.rev + ' · +' + a + ' ~' + e + ' -' + d;
  }

  function ghWrite(state, ctx) {
    var body = {
      message: ghCommitMessage(state),
      content: b64encode(JSON.stringify(state, null, 2) + '\n'),
      branch: cfg.branch || 'main'
    };
    if (ctx && ctx.sha) body.sha = ctx.sha;
    return ghCall('PUT', contentPath(), body, { timeout: 30000 }).then(function (r) {
      if ((r.status === 200 || r.status === 201) && r.data && r.data.content) {
        return { ok: true, state: state, sha: r.data.content.sha };
      }
      if (r.status === 409 || r.status === 422) {
        return ghRead().then(function (cur) {
          return {
            ok: false, code: 'conflict',
            current: cur.ok ? cur.state : null,
            sha: cur.ok ? cur.sha : ''
          };
        });
      }
      if (r.status === 401 || r.status === 403) return { ok: false, code: 'auth', message: ghExplain(r) };
      return { ok: false, code: 'other', message: ghExplain(r) };
    }, netFail);
  }

  /* ---------------- 自建服务器驱动 ---------------- */
  var httpDriver = {
    read: function () {
      return request('/api/state').then(function (r) {
        if (r.status === 401) return { ok: false, code: 'auth', message: '登录已过期' };
        if (r.status !== 200 || !r.data) return { ok: false, code: 'other', message: 'HTTP ' + r.status };
        return { ok: true, state: r.data, sha: '' };
      }, netFail);
    },
    write: function (state, ctx) {
      return request('/api/state', {
        method: 'PUT',
        body: Object.assign({ rev: ctx && Number.isFinite(Number(ctx.rev)) ? Number(ctx.rev) : 0 }, state)
      }).then(function (r) {
        if (r.status === 200 && r.data) return { ok: true, state: r.data, sha: '' };
        if (r.status === 409 && r.data && r.data.current) {
          return { ok: false, code: 'conflict', current: r.data.current, sha: '' };
        }
        if (r.status === 401) return { ok: false, code: 'auth', message: '登录已过期' };
        return { ok: false, code: 'other', message: 'HTTP ' + r.status };
      }, netFail);
    }
  };

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
  function hasContent(s) {
    if (!s) return false;
    return (s.added || []).length > 0 ||
      Object.keys(s.edited || {}).length > 0 ||
      (s.deleted || []).length > 0;
  }

  function adopt(remote, sha) {
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
    if (sha !== undefined && sha !== null) cfg.sha = sha;
    dirty = false;
    lastSync = Date.now();
    saveCfg();
  }

  /* ---------------- 核心动作 ---------------- */
  function push(baseRev, baseSha) {
    var snap = localSnapshot();
    if (!snap) return Promise.resolve();
    if (!connected()) return Promise.resolve();

    var rev = Number.isFinite(Number(baseRev)) ? Number(baseRev) : cfg.rev;
    var sha = baseSha !== undefined ? baseSha : cfg.sha;
    var next = Object.assign({ rev: (Number.isFinite(rev) ? rev : 0) + 1, updatedAt: new Date().toISOString() }, snap);

    var job = cfg.mode === 'github'
      ? ghWrite(next, { sha: sha })
      : httpDriver.write(next, { rev: rev });

    return job.then(function (res) {
      if (res.ok) {
        cfg.rev = Number(res.state && res.state.rev) || next.rev;
        if (res.sha) cfg.sha = res.sha;
        dirty = false;
        lastSync = Date.now();
        saveCfg();
        setStatus('已同步 · rev ' + cfg.rev);
        refreshMeta();
        return;
      }
      if (res.code === 'conflict') {
        return askConflict(res.current, res.sha);
      }
      if (res.code === 'auth') return expire(res.message);
      setStatus('推送失败：' + (res.message || '未知错误'), 'warn');
    });
  }

  function pull(reason) {
    if (!connected() || busy) return Promise.resolve();
    busy = true;
    setStatus('同步中…');
    var job = cfg.mode === 'github' ? ghRead() : httpDriver.read();
    return job.then(function (res) {
      if (!res.ok) {
        if (res.code === 'auth') return expire(res.message);
        throw new Error(res.message || '读取失败');
      }
      var s = res.state;
      if (!s || !s.rev) {                       // 云端还没有数据
        if (dirty) return push(0, res.sha || '');
        setStatus('云端还没有数据');
        return;
      }
      if (!dirty) return adopt(s, res.sha);
      if (Number(s.rev) === Number(cfg.rev)) return push(cfg.rev, res.sha);
      return askConflict(s, res.sha);
    }).catch(function (e) { setStatus('拉取失败：' + e.message, 'warn'); })
      .then(function () { busy = false; refreshMeta(); });
  }

  function askConflict(cloudState, sha) {
    pendingConflict = cloudState || null;
    pendingConflictSha = sha === undefined ? null : sha;
    var rev = cloudState ? cloudState.rev : '?';
    setStatus('发现冲突：云端 rev ' + rev + '，本地基线 rev ' + cfg.rev, 'warn');
    refreshMeta();
  }

  function expire(msg) {
    cfg.token = '';
    cfg.exp = 0;
    saveCfg();
    setStatus(msg || '凭证已失效，请重新连接', 'warn');
    render();
  }

  /* ---------------- 变更订阅 ---------------- */
  function onLocalChange() {
    if (applying) return;
    dirty = true;
    refreshMeta();
    if (!connected() || pendingConflict) return;
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
    /* 窄屏顶栏图标同步状态：连接后挂绿点 */
    var mb = $('syncBtnM');
    if (mb) mb.classList.toggle('is-on', connected());
  }

  function refreshMeta() {
    var meta = $('syncMeta');
    if (!meta) return;
    var bits = [];
    bits.push(connected() ? '已连接 · ' + remoteName() : '未连接');
    bits.push('本地 rev ' + cfg.rev);
    if (cfg.mode === 'github' && cfg.sha) bits.push('文件 ' + String(cfg.sha).slice(0, 7));
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
    applyMode();
    refreshMeta();
    if (!connected()) setStatus('未连接');
    else if (pendingConflict) refreshMeta();
    else setStatus('已连接 · rev ' + cfg.rev);
  }

  /* 面板字段随模式切换 */
  function applyMode() {
    var card = $('syncCard');
    var mode = cfg.mode === 'http' ? 'http' : 'github';
    if (card) card.setAttribute('data-sync-mode', mode);
    var segs = document.querySelectorAll('.sync-seg-btn');
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('is-on', segs[i].getAttribute('data-mode') === mode);
      segs[i].setAttribute('aria-selected', segs[i].getAttribute('data-mode') === mode ? 'true' : 'false');
    }
    var pwLabel = $('syncPwLabel');
    if (pwLabel) pwLabel.textContent = mode === 'github' ? '访问令牌' : '访问口令';
    var pw = $('syncPw');
    if (pw) {
      pw.placeholder = mode === 'github' ? 'github_pat_… （只给这一个仓库的 Contents 读写）'
        : '服务器首次启动时生成的那串口令';
    }
    if ($('syncRepo')) $('syncRepo').value = (cfg.owner && cfg.repo) ? (cfg.owner + '/' + cfg.repo) : 'LeanSun/bill-data';
    if ($('syncBranch') && !$('syncBranch').value) $('syncBranch').value = cfg.branch || 'main';
    if ($('syncPath') && !$('syncPath').value) $('syncPath').value = cfg.path || 'state.json';
    if ($('syncUrl') && !$('syncUrl').value) $('syncUrl').value = cfg.url || '';
  }

  function activeMode() {
    var on = document.querySelector('.sync-seg-btn.is-on');
    return on && on.getAttribute('data-mode') === 'http' ? 'http' : 'github';
  }

  function open() {
    var mask = $('syncMask');
    if (!mask) return;
    if ($('syncUrl')) $('syncUrl').value = cfg.url || '';
    if ($('syncPw')) $('syncPw').value = '';
    if ($('syncBranch')) $('syncBranch').value = cfg.branch || 'main';
    if ($('syncPath')) $('syncPath').value = cfg.path || 'state.json';
    if ($('syncRepo')) $('syncRepo').value = (cfg.owner && cfg.repo) ? (cfg.owner + '/' + cfg.repo) : 'LeanSun/bill-data';
    pendingConflict = null;
    pendingConflictSha = null;
    mask.hidden = false;
    mask.classList.add('is-on');
    render();
    setTimeout(function () {
      var f = cfg.mode === 'github' ? $('syncRepo') : $('syncUrl');
      if (f) f.focus();
    }, 60);
  }
  function close() {
    var mask = $('syncMask');
    if (!mask) return;
    mask.classList.remove('is-on');
    mask.hidden = true;
  }

  /* 连接后统一的首次对齐 */
  function align(remote, sha) {
    cfg.sha = sha || '';
    if (!remote || !Number(remote.rev)) {
      /* 云端空白：本地直接成为第一版 */
      cfg.rev = 0;
      dirty = true;
      saveCfg();
      return push(0, cfg.sha);
    }
    var local = localSnapshot();
    if (!hasContent(local)) {
      adopt(remote, sha);
      setStatus('已连接，已拉取云端数据 · rev ' + cfg.rev);
      refreshMeta();
      return;
    }
    pendingConflict = remote;
    pendingConflictSha = sha || '';
    dirty = true;
    setStatus('已连接。云端已有 rev ' + remote.rev + ' 的数据，选择保留哪一份', 'warn');
    refreshMeta();
  }

  function connectGithub(repo, token, branch, path) {
    var parts = repo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('仓库写成 owner/repo');
    cfg.owner = parts[0].trim();
    cfg.repo = parts[1].trim();
    cfg.branch = (branch || 'main').trim();
    cfg.path = (path || 'state.json').trim().replace(/^\/+/, '');
    cfg.token = token;
    cfg.exp = Math.floor(Date.now() / 1000) + 365 * 86400;
    cfg.rev = -1;
    cfg.sha = '';
    saveCfg();

    setStatus('正在核对仓库…');
    return ghCall('GET', '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo))
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error(ghExplain(r));
        if (r.status === 404) throw new Error('仓库不存在，或令牌没有访问它的权限');
        if (r.status !== 200 || !r.data) throw new Error(ghExplain(r));
        if (r.data.private !== true) throw new Error('这个仓库是公开的 —— 换私有仓库再连，否则账本谁都能看');
        var full = r.data.full_name || (cfg.owner + '/' + cfg.repo);
        if (full.toLowerCase() !== (cfg.owner + '/' + cfg.repo).toLowerCase()) {
          cfg.owner = full.split('/')[0];
          cfg.repo = full.split('/')[1];
          saveCfg();
        }
        setStatus('已连上 ' + full + '，正在对齐…');
        return ghRead().then(function (res) {
          if (!res.ok) throw new Error(res.message || '读取失败');
          if (res.rawUnsupported) throw new Error('state.json 超过 1MB，请换回自建服务器');
          return align(res.state, res.sha);
        });
      });
  }

  function connectHttp(url, pw) {
    cfg.url = url.replace(/\/+$/, '');
    cfg.token = '';
    cfg.exp = 0;
    cfg.rev = -1;
    cfg.sha = '';
    return request('/api/login', { method: 'POST', body: { password: pw }, noAuth: true })
      .then(function (r) {
        if (r.status === 429) throw new Error('尝试过于频繁，等几分钟');
        if (r.status !== 200 || !r.data || !r.data.token) throw new Error('口令不对');
        cfg.token = r.data.token;
        cfg.exp = Number(r.data.exp) || 0;
        cfg.rev = -1;
        saveCfg();
        setStatus('已登录，正在对齐数据…');
        return httpDriver.read().then(function (res) {
          if (!res.ok) throw new Error(res.message || '读取失败');
          return align(res.state, '');
        });
      });
  }

  function connect() {
    var mode = activeMode();
    cfg.mode = mode;
    var pw = ($('syncPw') && $('syncPw').value || '').trim();
    if (!pw) return setStatus(mode === 'github' ? '先填访问令牌' : '先填访问口令', 'warn');

    setStatus('正在连接…');
    var job;
    if (mode === 'github') {
      var repo = ($('syncRepo') && $('syncRepo').value || '').trim();
      var branch = ($('syncBranch') && $('syncBranch').value || 'main').trim();
      var path = ($('syncPath') && $('syncPath').value || 'state.json').trim();
      if (!repo) return setStatus('先填仓库，形如 owner/repo', 'warn');
      try { job = connectGithub(repo, pw, branch, path); }
      catch (e) { return setStatus('连接失败：' + e.message, 'warn'); }
    } else {
      var url = ($('syncUrl') && $('syncUrl').value || '').trim();
      if (!url) return setStatus('先填服务器地址', 'warn');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      job = connectHttp(url, pw);
    }
    return job.catch(function (e) {
      /* 令牌/口令错就把 token 清掉，避免"看起来连着其实用不了" */
      if (/令牌|口令|权限|过期/.test(e.message || '')) { cfg.token = ''; cfg.exp = 0; saveCfg(); }
      setStatus('连接失败：' + e.message, 'warn');
    });
  }

  function keepServer() {
    if (!pendingConflict) {
      /* 云端本来就没有数据（首次连接但云端空白的那种边角） */
      return push(0, '');
    }
    var s = pendingConflict;
    var sha = pendingConflictSha;
    pendingConflict = null;
    pendingConflictSha = null;
    adopt(s, sha);
    setStatus('已用云端版本覆盖本地 · rev ' + cfg.rev);
    refreshMeta();
  }

  function keepLocal() {
    if (!pendingConflict) return;
    var s = pendingConflict;
    var sha = pendingConflictSha;
    pendingConflict = null;
    pendingConflictSha = null;
    setStatus('正在用本地覆盖云端…');
    dirty = true;
    push(Number(s.rev) || 0, sha || '');
  }

  function disconnect() {
    cfg = {
      mode: cfg.mode, url: '', owner: '', repo: '', branch: 'main', path: 'state.json',
      token: '', exp: 0, rev: -1, sha: ''
    };
    dirty = false;
    pendingConflict = null;
    pendingConflictSha = null;
    saveCfg();
    setStatus('已断开，本地数据照旧保留');
    render();
  }

  function download(obj, name) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function exportBackup() {
    if (!connected()) return setStatus('未连接，没有可导出的云端数据', 'warn');
    setStatus('正在打包…');
    var job = cfg.mode === 'github' ? ghRead() : request('/api/export', { timeout: 60000 }).then(function (r) {
      if (r.status !== 200 || !r.data) return { ok: false, message: 'HTTP ' + r.status };
      return { ok: true, state: r.data };
    });
    job.then(function (res) {
      if (!res.ok || !res.state) throw new Error(res.message || '云端还没有数据');
      download({
        type: 'qingzhang-backup',
        exportedAt: new Date().toISOString(),
        source: cfg.mode === 'github' ? (cfg.owner + '/' + cfg.repo + '/' + cfg.path) : cfg.url,
        state: res.state
      }, 'qingzhang-' + new Date().toISOString().slice(0, 10) + '.json');
      setStatus('备份已下载');
    }).catch(function (e) { setStatus('导出失败：' + e.message, 'warn'); });
  }

  function importBackup(file) {
    if (!file) return;
    if (!connected()) return setStatus('未连接，没有可写入的地方', 'warn');
    var reader = new FileReader();
    reader.onload = function () {
      var doc;
      try { doc = JSON.parse(String(reader.result)); } catch (e) { return setStatus('文件不是合法 JSON', 'warn'); }
      var state = doc && doc.state ? doc.state : doc;
      if (!state || typeof state !== 'object') return setStatus('文件里没有可导入的数据', 'warn');
      setStatus('正在导入…');
      if (cfg.mode === 'github') {
        var next = {
          rev: (Number(cfg.rev) || 0) + 1,
          updatedAt: new Date().toISOString(),
          added: Array.isArray(state.added) ? state.added : [],
          edited: (state.edited && typeof state.edited === 'object') ? state.edited : {},
          deleted: Array.isArray(state.deleted) ? state.deleted : [],
          theme: state.theme === 'dark' ? 'dark' : 'light'
        };
        return ghWrite(next, { sha: cfg.sha }).then(function (res) {
          if (!res.ok) throw new Error(res.summary || res.message || '写入失败');
          cfg.rev = next.rev;
          cfg.sha = res.sha || cfg.sha;
          saveCfg();
          adopt(next, cfg.sha);
          setStatus('已导入 · rev ' + cfg.rev);
        }).catch(function (e) { setStatus('导入失败：' + e.message, 'warn'); });
      }
      request('/api/import', { method: 'POST', body: { state: state } })
        .then(function (r) {
          if (r.status !== 200 || !r.data) throw new Error('HTTP ' + r.status);
          pendingConflict = null;
          adopt(r.data, '');
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

    /* 两个入口：侧栏「云同步」+ 窄屏顶栏图标（手机侧栏脚部被隐藏） */
    var openBtns = document.querySelectorAll('#syncBtn, #syncBtnM');
    for (var bi = 0; bi < openBtns.length; bi++) openBtns[bi].addEventListener('click', open);
    var closeBtn = $('syncClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var mask = $('syncMask');
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mask && !mask.hidden) close();
    });

    conflictEl = $('syncConflict');

    /* 模式切换 */
    var segs = document.querySelectorAll('.sync-seg-btn');
    for (var i = 0; i < segs.length; i++) {
      segs[i].addEventListener('click', function () {
        var m = this.getAttribute('data-mode');
        cfg.mode = m;
        saveCfg();
        applyMode();
        setStatus(connected() ? '已连接 · rev ' + cfg.rev : '未连接');
        var f = m === 'github' ? $('syncRepo') : $('syncUrl');
        if (f) f.focus();
      });
    }

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

    /* 令牌框回车 = 连接 */
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

  /* 调试口子 */
  window.QZSync = {
    pull: pull, push: push, open: open,
    status: function () { return { cfg: cfg, dirty: dirty, conflict: !!pendingConflict }; }
  };
})();
