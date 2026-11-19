/* ============================================================
   轻账 · 本机密屉
   ------------------------------------------------------------
   数据只有一份真身：你的私有仓库。
   本机留的那份副本只是「离线缓存」，一律 AES-GCM 密文落盘，
   钥匙由仓库令牌派生成（PBKDF2-SHA256 / 15 万轮）——
   令牌不在，钥匙就不在，密文翻出来也只是噪声。
   没有令牌、令牌过期、换成别的仓库，钥匙都对不上：
   于是密文打不开，页面上就没有任何数据可渲染。
   ============================================================ */
(function () {
  'use strict';

  var NAMES = {
    ledger: 'qingzhang.vault.ledger.v1',
    cube: 'qingzhang.vault.cube.v1',
    /* 私有账单的加密快照：首屏先读它，网络那趟只做后台校正（v1.0.48） */
    seed: 'qingzhang.vault.seed.v1'
  };
  var subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
  var keys = {};

  function enc(s) { return new TextEncoder().encode(s); }
  function b64(buf) {
    var a = new Uint8Array(buf), bin = '';
    for (var i = 0; i < a.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function unb64(s) {
    var bin = atob(String(s).replace(/\s+/g, ''));
    var a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }

  /* 令牌 + 仓库名 → 一把 AES-GCM-256 钥匙。换仓库换令牌，钥匙就换了。 */
  function derive(token, salt) {
    if (!subtle) return Promise.reject(new Error('这个环境不支持 WebCrypto'));
    if (!token) return Promise.reject(new Error('没有令牌'));
    var id = token + '\u0000' + salt;
    if (keys[id]) return Promise.resolve(keys[id]);
    return subtle.importKey('raw', enc(String(token)), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: enc(String(salt)), iterations: 150000, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
      })
      .then(function (k) { keys[id] = k; return k; });
  }

  function sealStr(key, str) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc(str)).then(function (ct) {
      return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
    });
  }

  function openStr(key, blob) {
    var o = JSON.parse(blob);
    return subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.ct)).then(function (pt) {
      return new TextDecoder('utf-8').decode(pt);
    });
  }

  function save(key, name, value) {
    if (!key || !subtle) return Promise.resolve(false);
    var real = NAMES[name] || name;
    return sealStr(key, JSON.stringify(value)).then(function (blob) {
      try { localStorage.setItem(real, blob); } catch (e) { return false; }
      return true;
    }).catch(function () { return false; });
  }

  function load(key, name) {
    if (!key || !subtle) return Promise.resolve(null);
    var real = NAMES[name] || name, raw = '';
    try { raw = localStorage.getItem(real); } catch (e) { return Promise.resolve(null); }
    if (!raw) return Promise.resolve(null);
    return openStr(key, raw).then(function (s) { return JSON.parse(s); })
      .catch(function () { return null; });
  }

  function drop(name) {
    try { localStorage.removeItem(NAMES[name] || name); } catch (e) { /* 无痕模式静默 */ }
  }

  window.QZVault = {
    supported: !!subtle,
    NAMES: NAMES,
    derive: derive,
    sealStr: sealStr,
    openStr: openStr,
    save: save,
    load: load,
    drop: drop
  };
})();
