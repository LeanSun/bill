/* ============================================================
   轻账 · 离线加速层
   ------------------------------------------------------------
   背景：GitHub Pages 到国内的链路吞吐只有个位数 KB/s，
        首屏 560KB 要等半分钟以上。
   做法：
     · 带 ?v= 的资源（js/css）—— 版本变了 URL 就变，可以永久缓存
     · 其余静态资源 —— 先给缓存，后台顺手更新
     · 页面本身 —— 每次都走网络，保证发版立刻生效
       网络挂了才回退缓存（离线也能记账）
   注意：页面绝不缓存优先，避免出现「改了版本号却看到旧页面」
   ============================================================ */
var PREFIX = 'qz-';
var CACHE = 'qz-v1';
/* 版本戳：**每次发版都要跟着 ASSET_V 一起改**。
   浏览器判断「有没有新版本」只看这个文件本身有没有变字节 —— 只改
   app.js 的 ?v= 它是不认识的，于是 skipWaiting 永远不触发、页面里
   那条「有新版本」就永远弹不出来（v1.0.88 上线后一直没人见过它，
   原因就在这里）。改这一个字符，换版当天就能收到提示。 */
var BUILD = '1.11.1';
/* 超过这个体积就不进缓存：魔方历史快照有 18MB，塞进来只会挤占配额 */
var MAX_ENTRY = 6 * 1024 * 1024;
/* 明确不缓存的资源 */
var SKIP = ['cube-history'];

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf(PREFIX) === 0 && k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function save(cache, req, res) {
  if (!res || !res.ok || res.status !== 200) return;
  var len = parseInt(res.headers && res.headers.get('content-length'), 10);
  if (len > MAX_ENTRY) return;
  try { cache.put(req, res); } catch (err) { /* 配额满了就放弃，不影响页面 */ }
}

/* 版本化资源：命中即返回，没有才联网 */
function cacheFirst(req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        save(cache, req, res.clone());
        return res;
      });
    });
  });
}

/* 无版本号的资源：先给缓存，后台更新 */
function staleWhileRevalidate(req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        save(cache, req, res.clone());
        return res;
      }).catch(function () { return null; });
      if (hit) return hit;
      return net.then(function (res) {
        return res || Response.error();
      });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  /* 大件（历史快照）直接放行，不进缓存 */
  for (var i = 0; i < SKIP.length; i++) {
    if (url.pathname.indexOf(SKIP[i]) !== -1) return;
  }

  /* 页面：网络优先，失败才用缓存 */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { save(cache, req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || caches.match('./index.html', { ignoreSearch: true }) || Response.error();
        });
      })
    );
    return;
  }

  /* 带版本号：可以永久缓存 */
  if (url.search && url.search.indexOf('v=') !== -1) {
    e.respondWith(cacheFirst(req));
    return;
  }

  e.respondWith(staleWhileRevalidate(req));
});
