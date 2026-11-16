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

  function settle(d, err) {
    var data = d || EMPTY;
    window.BILL_DATA = data;
    state.active = !!d;
    state.error = err || '';
    state.from = d ? OWNER + '/' + REPO + '/' + DATA_FILE : '';
    return data;
  }

  var cfg = readCfg();
  window.BILL_READY = new Promise(function (resolve) {
    if (!gate(cfg)) { resolve(settle(null, '')); return; }
    fetchPrivate(cfg).then(
      function (d) { resolve(settle(d, '')); },
      function (e) { resolve(settle(null, e && e.message || '读取私有数据失败')); }
    );
  });

  /* 给同步层用：连上仓库后要不要刷新一次、断开后要不要立刻清空内存里的数据 */
  window.QZPrivate = {
    status: function () { return state; },
    needsReload: function (c) { return gate(c || readCfg()) && !state.active; },
    dropIfActive: function () {
      if (!state.active) return false;
      state.active = false;
      window.BILL_DATA = EMPTY;
      return true;
    }
  };
})();
