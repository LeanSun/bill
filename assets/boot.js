/* ============================================================
   轻账 · 私人数据门禁（公开站点先行脚本）
   公开站点 build 里不再放任何账单 / 体重明细。启动时先看浏览器里
   有没有连到「主人那一个私有仓库」的有效凭证：
     · 没有 → 直接以空账本启动（别人看到的就是这个版本）
     · 有   → 用他自己的 token 从私有仓库读 private-data.json，
               读到了再交给 app.js 当种子数据
   凭证 / token 只留在浏览器 localStorage 的同步配置里，不写进本文件；
   没有 token 就是没有数据 —— 这是门禁，不是「藏起来」。
   ============================================================ */
(function () {
  'use strict';

  var OWNER = 'LeanSun';
  var REPO = 'bill-data';
  var DATA_FILE = 'private-data.json';
  var CFG_KEY = 'qingzhang.sync.v3';
  var LEGACY_KEY = 'qingzhang.sync.v2';
  var EMPTY = { records: [], weights: {}, pinyin: {}, generatedFrom: [], years: [] };

  var state = { active: false, error: '', from: '' };

  function readCfg() {
    var raw = '';
    try { raw = localStorage.getItem(CFG_KEY) || localStorage.getItem(LEGACY_KEY) || ''; } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* 门禁条件全部满足才算「链接了我的仓库」：
     GitHub 模式 + owner/repo 对得上 + token 在有效期内。
     只填了仓库名、令牌过期、换成自建服务器，都不放行。 */
  function gate(c) {
    if (!c || c.mode === 'http') return false;
    if (!c.token || !(Number(c.exp) * 1000 > Date.now())) return false;
    var o = String(c.owner || '').toLowerCase();
    var r = String(c.repo || '').toLowerCase();
    return o === OWNER.toLowerCase() && r === REPO.toLowerCase();
  }

  function decodeBase64(b64) {
    var clean = String(b64 || '').replace(/\s+/g, '');
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var j = 0; j < bytes.length; j++) s += String.fromCharCode(bytes[j]);
    return s;
  }

  function fetchPrivate(c) {
    var enc = function (s) { return encodeURIComponent(String(s)); };
    var url = 'https://api.github.com/repos/' + enc(c.owner) + '/' + enc(c.repo) +
      '/contents/' + enc(DATA_FILE) + '?ref=' + enc(c.branch || 'main');
    return fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + c.token
      },
      cache: 'no-store'
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error('凭证无效或权限不足');
      if (r.status === 404) throw new Error('私有仓库里没有 ' + DATA_FILE);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.encoding !== 'base64' || !j.content) throw new Error('数据文件格式不对');
      var d = JSON.parse(decodeBase64(j.content));
      if (!d || !Array.isArray(d.records)) throw new Error('数据文件里没有账单');
      return d;
    });
  }

  /* 魔方数据搭同一趟车：主账本已经拿着 token 要读私有仓库了，
     顺手把 cube-data.json 也取回来塞进它自己的 localStorage 键。
     等 iframe 起来时数据已经落地，不用再 fetch + reload 一次。 */
  function fetchCube(c) {
    var enc = function (x) { return encodeURIComponent(String(x)); };
    var url = 'https://api.github.com/repos/' + enc(c.owner) + '/' + enc(c.repo) +
      '/contents/cube-data.json?ref=' + enc(c.branch || 'main');
    return fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Authorization': 'Bearer ' + c.token
      },
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('cube HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var d = JSON.parse(decodeBase64(j.content));
      if (!d || !d.db || !Array.isArray(d.db.cubes)) return;
      var rev = Number(d.rev) || 1;
      try {
        var raw = localStorage.getItem('cubeLedger_v1');
        var cur = raw ? JSON.parse(raw) : null;
        if (cur && cur._privateOwner === 'LeanSun' && rev <= (Number(cur._rev) || 0)) return;
        var db = d.db;
        db._privateOwner = 'LeanSun';
        db._rev = rev;
        localStorage.setItem('cubeLedger_v1', JSON.stringify(db));
        localStorage.setItem('cubeLedger_remoteSha_v1', j.sha || '');
      } catch (e) { /* 无痕模式静默 */ }
    });
  }

  function settle(d, err) {
    var data = d || EMPTY;
    window.BILL_DATA = data;
    state.active = !!d;
    state.error = err || '';
    state.from = d ? OWNER + '/' + REPO + '/' + DATA_FILE : '';
    return data;
  }

  var cfg = readCfg();
  var ok = gate(cfg);

  /* 门禁状态是同步的：app.js 一加载就要知道该不该读本机副本 */
  window.QZGate = {
    ok: ok,
    owner: ok ? OWNER : '',
    repo: ok ? REPO : '',
    reason: ok ? '' : (cfg && cfg.token ? '凭证已过期' : '这台设备还没连上私有仓库')
  };
  /* 解密后的本机副本：只有门禁通过才可能有值 */
  window.QZ_CACHE = null;
  window.QZ_VAULT_KEY = null;

  /* 密屉钥匙：令牌 + 仓库名派生。拿不到就是 null，本机副本谁也打不开。 */
  function vaultKey() {
    if (!ok || !window.QZVault || !window.QZVault.supported) return Promise.resolve(null);
    return window.QZVault.derive(cfg.token, 'qingzhang::' + OWNER + '/' + REPO)
      .catch(function () { return null; });
  }

  /* 打开密屉，顺手把老版本明文搬家：读出来、重新封好、删掉明文键。
     搬家只发生在门禁通过的这一刻 —— 没连仓库的机器永远读不到明文。 */
  function hydrate(key) {
    if (!key) return Promise.resolve(null);
    window.QZ_VAULT_KEY = key;
    var vault = window.QZVault;
    var legacyStore = '', legacyPay = '';
    try {
      legacyStore = localStorage.getItem('qingzhang.ledger.v1') || '';
      legacyPay = localStorage.getItem('qingzhang.pay.v1') || '';
    } catch (e) { /* 无痕模式 */ }
    return Promise.all([vault.load(key, 'ledger'), vault.load(key, 'cube')]).then(function (r) {
      var store = r[0] || null, cube = r[1] || null;
      if (!store && legacyStore) {
        try { store = JSON.parse(legacyStore); } catch (e2) { store = null; }
        if (store && legacyPay) {
          try {
            var p = JSON.parse(legacyPay);
            if (p && typeof p === 'object' && !store.pay) store.pay = p;
          } catch (e3) { /* 坏数据丢掉 */ }
        }
        if (store) {
          vault.save(key, 'ledger', store);
          /* 刚搬完家：这份数据只在本地有过，云端还不知道，
             标记一下，让同步层把它当成「未推送的改动」，由用户决定以哪边为准 */
          window.__QZ_MIGRATED = true;
        }
      }
      /* 明文留在盘上就是漏洞，搬完即删 */
      if (legacyStore) { try { localStorage.removeItem('qingzhang.ledger.v1'); } catch (e4) {} }
      if (legacyPay) { try { localStorage.removeItem('qingzhang.pay.v1'); } catch (e5) {} }
      if (cube) window.__CUBE_SEED = cube;
      window.QZ_CACHE = { store: store, cube: cube };
      return store;
    }).catch(function () {
      window.QZ_CACHE = { store: null, cube: null };
      return null;
    });
  }

  /* 魔方 iframe 等这个标记再挂载，保证它启动那一刻本地数据已经落地 */
  window.__cubeDataReady = !ok;
  window.BILL_READY = new Promise(function (resolve) {
    if (!ok) {
      /* 没连仓库：不取、不读、不留 —— 本机就是一本空账本 */
      window.QZ_CACHE = null;
      resolve(settle(null, ''));
      return;
    }
    var boot = vaultKey().then(hydrate);
    /* 魔方那份只有 20KB，和账本并行取，但不让它拖住账本启动 */
    fetchCube(cfg).catch(function () { /* 取不到就留给子页自己取 */ })
      .then(function () { window.__cubeDataReady = true; });
    Promise.all([
      fetchPrivate(cfg).then(
        function (d) { return { d: d, err: '' }; },
        function (e) { return { d: null, err: (e && e.message) || '读取私有数据失败' }; }
      ),
      boot
    ]).then(function (r) {
      resolve(settle(r[0].d, r[0].err));
    });
  });

  /* 给同步层用：连上仓库后要不要刷新一次、断开后要不要立刻清空内存里的数据 */
  window.QZPrivate = {
    status: function () { return state; },
    needsReload: function (c) { return gate(c || readCfg()) && !state.active; },
    dropIfActive: function () {
      /* 断开那一刻：内存、密屉、明文，三样一起清。
         仓库里那份一个字不动，下次连上再取回来。 */
      var had = state.active || !!(window.QZ_CACHE && window.QZ_CACHE.store);
      state.active = false;
      window.BILL_DATA = EMPTY;
      window.QZ_CACHE = null;
      window.QZ_VAULT_KEY = null;
      if (window.QZVault) {
        window.QZVault.drop('ledger');
        window.QZVault.drop('cube');
      }
      try {
        localStorage.removeItem('qingzhang.ledger.v1');
        localStorage.removeItem('qingzhang.pay.v1');
      } catch (e) { /* 无痕模式 */ }
      return had;
    }
  };
})();
