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
        if (cur && cur._privateOwner === 'LeanSun' && rev <= (Number(cur._rev) || 0)) return false;
        var db = d.db;
        db._privateOwner = 'LeanSun';
        db._rev = rev;
        localStorage.setItem('cubeLedger_v1', JSON.stringify(db));
        localStorage.setItem('cubeLedger_remoteSha_v1', j.sha || '');
        return true;
      } catch (e) { return false; }
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
    return Promise.all([vault.load(key, 'ledger'), vault.load(key, 'cube'), vault.load(key, 'seed')]).then(function (r) {
      var store = r[0] || null, cube = r[1] || null, seed = r[2] || null;
      /* 早期版本只把魔方数据放在 cubeLedger_v1，密屉里没有那一份。
         门禁通过就直接拿它当本机副本，别让 iframe 卡在 3 秒网络等待上。 */
      if (!cube) {
        try {
          var plain = JSON.parse(localStorage.getItem('cubeLedger_v1') || 'null');
          if (plain && Array.isArray(plain.cubes) && Array.isArray(plain.competitions)) cube = plain;
        } catch (e5) { /* 坏数据当没有 */ }
      }
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
      if (cube) {
        window.__CUBE_SEED = cube;
        /* 魔方 iframe 只读 cubeLedger_v1 —— 先把密屉里的那份放回去，
           它起来那一刻就是完整数据，不用再等一趟 api.github.com */
        try { localStorage.setItem('cubeLedger_v1', JSON.stringify(cube)); } catch (e6) { /* 无痕模式 */ }
      }
      window.QZ_SEED = (seed && Array.isArray(seed.records)) ? seed : null;
      window.QZ_CACHE = { store: store, cube: cube };
      return store;
    }).catch(function () {
      window.QZ_CACHE = { store: null, cube: null };
      return null;
    });
  }

  /* v1.0.48：启动不再等在 api.github.com 上。
     密屉里本来就有一份加密的账单种子（seed）和魔方数据，解出来立刻放行 ——
     页面先按这份画完，远端那趟请求转到后台，回来再补一次差量刷新。
     门禁条件没变：拿不到令牌 / 仓库对不上，QZ_SEED 永远是 null。 */
  function seedSig(d) {
    if (!d) return '';
    try {
      var str = JSON.stringify(d), h = 0;
      for (var i = 0; i < str.length; i += 7) h = (h * 31 + str.charCodeAt(i)) | 0;
      return str.length + ':' + h;
    } catch (e) { return String((d.records || []).length); }
  }
  function cubeReload(updated) {
    if (!updated) return;
    try {
      var f = document.getElementById('cubeFrame');
      if (f && f.contentWindow) f.contentWindow.postMessage({ __cubeDataUpdated: true }, '*');
    } catch (e) { /* iframe 还没起来：它启动时自己读新的 localStorage */ }
  }

  window.__cubeDataReady = !ok;
  window.QZ_SEED = null;
  window.BILL_READY = new Promise(function (resolve) {
    if (!ok) {
      /* 没连仓库：不取、不读、不留 —— 本机就是一本空账本 */
      window.QZ_CACHE = null;
      resolve(settle(null, ''));
      return;
    }
    var boot = vaultKey().then(hydrate);
    boot.then(function () {
      /* 密屉解完就放行：本地这份已经足够把所有图表画出来 */
      window.__cubeDataReady = true;
      resolve(settle(window.QZ_SEED, ''));
    }, function () {
      window.__cubeDataReady = true;
      resolve(settle(null, ''));
    });

    /* 远端只做后台校正：拿到更新的快照就落密屉、通知页面与 iframe */
    Promise.all([
      fetchPrivate(cfg).then(
        function (d) { return { d: d, err: '' }; },
        function (e) { return { d: null, err: (e && e.message) || '读取私有数据失败' }; }
      ),
      fetchCube(cfg).catch(function () { return false; })
    ]).then(function (r) {
      var remote = r[0].d, changed = false, hadSeed = !!window.QZ_SEED;
      if (remote) {
        changed = seedSig(remote) !== seedSig(window.QZ_SEED);
        window.QZ_SEED = remote;
        window.QZ_DATA = remote;
        /* 没变就不重新加密一遍 —— 账单快照不小，没必要每次刷新都白忙 */
        if ((changed || !hadSeed) && window.QZ_VAULT_KEY && window.QZVault) {
          window.QZVault.save(window.QZ_VAULT_KEY, 'seed', remote);
        }
      }
      if (r[0].err) state.error = r[0].err;
      settle(window.QZ_SEED || null, state.error);
      if (changed && window.QZPrivate && window.QZPrivate.onRemote) {
        try { window.QZPrivate.onRemote(window.BILL_DATA); } catch (e) { /* 页面还没初始化完 */ }
      }
      cubeReload(!!r[1]);
      /* 把最新的魔方数据也封进密屉，下次刷新起就不必再等网络 */
      if (window.QZ_VAULT_KEY && window.QZVault) {
        try {
          var cubeNow = JSON.parse(localStorage.getItem('cubeLedger_v1') || 'null');
          if (cubeNow && Array.isArray(cubeNow.cubes)) {
            window.QZVault.save(window.QZ_VAULT_KEY, 'cube', cubeNow);
          }
        } catch (e7) { /* 无痕模式静默 */ }
      }
    });
  });

  /* 给同步层用：连上仓库后要不要刷新一次、断开后要不要立刻清空内存里的数据 */
  window.QZPrivate = {
    onRemote: null,
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
        window.QZVault.drop('seed');
        window.QZ_SEED = null;
      }
      try {
        localStorage.removeItem('qingzhang.ledger.v1');
        localStorage.removeItem('qingzhang.pay.v1');
      } catch (e) { /* 无痕模式 */ }
      return had;
    }
  };
})();
