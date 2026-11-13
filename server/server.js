'use strict';
/* ============================================================
   轻账 · Ledger — 同步后端
   零依赖：只用 Node 内置模块，不需要 npm install。
   职责：
     1. 保存账户数据（新增 / 修改 / 删除 三层增量 + 主题），落 JSON 文件
     2. 单用户口令登录，签发 HMAC 令牌，30 天有效
     3. 冲突检测：PUT 必须带 rev，rev 对不上返回 409 与当前文档
     4. 备份：每次写入前把旧版本归档，保留最近 N 份
     5. 顺带把静态站点也发出去（一个进程 = 站点 + API）
   ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

/* ---------------- 配置 ---------------- */
const ROOT = path.resolve(__dirname, '..');                     // 站点根目录
const DATA_DIR = path.resolve(process.env.LEDGER_DATA || path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const PASS_FILE = path.join(DATA_DIR, 'password.txt');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN_TTL = Math.max(1, Number(process.env.TOKEN_TTL_DAYS || 30)) * 86400;
const MAX_BODY = Math.max(1, Number(process.env.MAX_BODY_MB || 8)) * 1024 * 1024;
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 20));
const QUIET = process.env.QUIET === '1';

/* 允许跨域的来源。线上静态站（GitHub Pages）要访问这里，必须列进来。
   ALLOWED_ORIGINS="https://leansun.github.io,http://127.0.0.1:8787" */
const ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ---------------- 口令与密钥 ---------------- */
function ensurePassword() {
  if (process.env.LEDGER_PASSWORD) return process.env.LEDGER_PASSWORD;
  if (fs.existsSync(PASS_FILE)) return fs.readFileSync(PASS_FILE, 'utf8').trim();
  const pw = crypto.randomBytes(9).toString('base64url');       // 12 位
  fs.writeFileSync(PASS_FILE, pw + '\n', { mode: 0o600 });
  console.log('\n[ledger] 首次运行，已生成访问口令：' + pw);
  console.log('[ledger] 已写入 ' + PASS_FILE + '，可随时改它或改用环境变量 LEDGER_PASSWORD\n');
  return pw;
}

function ensureSecret() {
  if (process.env.TOKEN_SECRET) return Buffer.from(process.env.TOKEN_SECRET);
  if (fs.existsSync(SECRET_FILE)) return Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'base64');
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, buf.toString('base64') + '\n', { mode: 0o600 });
  return buf;
}

let PASSWORD = ensurePassword();
const SECRET = ensureSecret();

/* ---------------- 存储 ---------------- */
const EMPTY = () => ({ rev: 0, updatedAt: null, added: [], edited: {}, deleted: [], theme: 'light' });

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const o = JSON.parse(raw);
    return {
      rev: Number(o.rev) || 0,
      updatedAt: o.updatedAt || null,
      added: Array.isArray(o.added) ? o.added : [],
      edited: (o.edited && typeof o.edited === 'object' && !Array.isArray(o.edited)) ? o.edited : {},
      deleted: Array.isArray(o.deleted) ? o.deleted : [],
      theme: o.theme === 'dark' ? 'dark' : 'light'
    };
  } catch (e) {
    return EMPTY();
  }
}

/* 原子写：先写临时文件再 rename，断电也不会留下半截 JSON */
function writeStateAtomic(state) {
  const tmp = STATE_FILE + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, STATE_FILE);
}

function backup(state) {
  if (!state.rev) return;                                       // 没有历史就没什么可备
  const name = 'state-r' + String(state.rev).padStart(4, '0') + '-' +
    new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  try {
    fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(state));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) {
    console.warn('[ledger] 备份失败（不影响写入）:', e.message);
  }
}

let STATE = readState();

/* ---------------- 校验 ---------------- */
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = { records: 60000, str: 120, amount: 1e9 };

function cleanRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const date = String(r.date || '');
  if (!RE_DATE.test(date)) return null;
  const type = r.type === 'income' ? 'income' : r.type === 'expense' ? 'expense' : null;
  if (!type) return null;
  const amount = Number(r.amount);
  if (!Number.isFinite(amount) || Math.abs(amount) > LIMITS.amount) return null;
  const s = (v, n) => String(v == null ? '' : v).slice(0, n || LIMITS.str);
  const rec = {
    date,
    type,
    amount: Math.round(amount * 100) / 100,
    category: s(r.category, 20),
    sub: s(r.sub, 20),
    note: s(r.note)
  };
  if (r.id) rec.id = s(r.id, 64);
  if (r.raw) rec.raw = s(r.raw, 20);
  return rec;
}

/* 整体校验：任何一条不合法就整体拒收，不做"部分写入"——
   半套数据比没有数据更难排查 */
function validatePayload(body) {
  if (!body || typeof body !== 'object') return { error: '请求体必须是 JSON 对象' };
  const added = Array.isArray(body.added) ? body.added : [];
  const deleted = Array.isArray(body.deleted) ? body.deleted.map(x => String(x).slice(0, 64)) : [];
  if (added.length > LIMITS.records) return { error: '记录数量超出上限' };
  if (deleted.length > LIMITS.records) return { error: '删除标记数量超出上限' };

  const outAdded = [];
  for (const r of added) {
    const c = cleanRecord(r);
    if (!c) return { error: '新增记录格式不合法：' + JSON.stringify(r).slice(0, 120) };
    outAdded.push(c);
  }

  const src = (body.edited && typeof body.edited === 'object' && !Array.isArray(body.edited)) ? body.edited : {};
  const outEdited = {};
  for (const k of Object.keys(src)) {
    const c = cleanRecord(src[k]);
    if (!c) return { error: '修改记录格式不合法：' + k };
    outEdited[String(k).slice(0, 64)] = c;
  }

  const theme = body.theme === 'dark' ? 'dark' : 'light';
  return { value: { added: outAdded, edited: outEdited, deleted, theme } };
}

/* ---------------- 令牌 ---------------- */
function b64(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch (e) { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
function issueToken() {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  return { token: sign({ exp, iat: Math.floor(Date.now() / 1000) }), exp };
}

/* ---------------- 登录限流 ---------------- */
const attempts = new Map();                                     // ip -> { n, reset }
const LIMIT_WINDOW = 5 * 60 * 1000;
const LIMIT_MAX = 8;

function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.reset < Date.now()) return false;
  return rec.n >= LIMIT_MAX;
}
function noteAttempt(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.reset < now) attempts.set(ip, { n: 1, reset: now + LIMIT_WINDOW });
  else rec.n += 1;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (rec.reset < now) attempts.delete(ip);
}, 60000).unref();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    /* 长度不等也要走一遍固定开销，避免用长度泄露信息 */
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------------- HTTP 小工具 ---------------- */
function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allow = ORIGINS.indexOf('*') >= 0 ? '*' : (ORIGINS.indexOf(origin) >= 0 ? origin : '');
  const h = {};
  if (allow) {
    h['Access-Control-Allow-Origin'] = allow;
    if (allow !== '*') h['Vary'] = 'Origin';
    h['Access-Control-Allow-Headers'] = 'authorization,content-type';
    h['Access-Control-Allow-Methods'] = 'GET,PUT,POST,OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

function sendJson(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, corsHeaders(req)));
  res.end(body);
}

function sendText(req, res, code, text) {
  const body = Buffer.from(String(text));
  res.writeHead(code, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length
  }, corsHeaders(req)));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('payload too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function auth(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? verify(m[1].trim()) : null;
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};
const GZIP_TYPES = /^(text\/|application\/(json|javascript))/;
const gzipCache = new Map();                                    // path -> { mtime, raw, gz }

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.indexOf('/server/') === 0 || rel.indexOf('/data/') === 0 ||
    rel.indexOf('/.git') === 0 || rel === '/server') {
    return sendText(req, res, 404, 'Not Found');
  }
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) return sendText(req, res, 404, 'Not Found');

  let st;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  if (!st || !st.isFile()) return sendText(req, res, 404, 'Not Found');

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = 'W/"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, Object.assign({ ETag: etag }, corsHeaders(req)));
    return res.end();
  }

  const headers = {
    'Content-Type': type,
    ETag: etag,
    /* 站点内容更新靠改名或换版本，不做长缓存；大文件单独放宽 */
    'Cache-Control': ext === '.html' ? 'no-cache' :
      (st.size > 300 * 1024 ? 'public, max-age=604800' : 'public, max-age=300'),
    'X-Content-Type-Options': 'nosniff'
  };
  Object.assign(headers, corsHeaders(req));

  const wantsGzip = GZIP_TYPES.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (wantsGzip) {
    let hit = gzipCache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs || hit.size !== st.size) {
      hit = { mtime: st.mtimeMs, size: st.size, raw: fs.readFileSync(file) };
      hit.gz = zlib.gzipSync(hit.raw, { level: 6 });
      gzipCache.set(file, hit);
      if (gzipCache.size > 40) gzipCache.delete(gzipCache.keys().next().value);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = hit.gz.length;
    headers['Vary'] = (headers['Vary'] ? headers['Vary'] + ', ' : '') + 'Accept-Encoding';
    res.writeHead(200, headers);
    return res.end(req.method === 'HEAD' ? undefined : hit.gz);
  }

  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      rev: STATE.rev,
      records: STATE.added.length,
      updatedAt: STATE.updatedAt,
      time: new Date().toISOString()
    });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (tooManyAttempts(ip)) return sendJson(req, res, 429, { error: '尝试过于频繁，5 分钟后再试' });
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(req, res, 400, { error: '请求体不是合法 JSON' }); }
    const ok = safeEqual(body.password || '', PASSWORD);
    noteAttempt(ip, ok);
    if (!ok) return sendJson(req, res, 401, { error: '口令不对' });
    const t = issueToken();
    console.log('[ledger] 登录成功 ' + new Date().toISOString());
    return sendJson(req, res, 200, { token: t.token, exp: t.exp });
  }

  /* 以下全部需要令牌 */
  if (pathname.indexOf('/api/') === 0) {
    const claims = auth(req);
    if (!claims) return sendJson(req, res, 401, { error: '未登录或令牌已过期' });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    return sendJson(req, res, 200, STATE);
  }

  if (pathname === '/api/state' && req.method === 'PUT') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(req, res, 400, { error: '请求体不是合法 JSON' }); }
    const check = validatePayload(body);
    if (check.error) return sendJson(req, res, 422, { error: check.error });

    const baseRev = Number(body.rev);
    if (!Number.isFinite(baseRev) || baseRev !== STATE.rev) {
      return sendJson(req, res, 409, {
        error: '版本冲突：服务器上的数据已被改动',
        conflict: true,
        current: STATE
      });
    }
    const next = Object.assign({}, check.value, {
      rev: STATE.rev + 1,
      updatedAt: new Date().toISOString()
    });
    backup(STATE);
    writeStateAtomic(next);
    STATE = next;
    if (!QUIET) console.log('[ledger] 写入 rev ' + next.rev + ' · +' + next.added.length + ' ~' + Object.keys(next.edited).length + ' -' + next.deleted.length);
    return sendJson(req, res, 200, STATE);
  }

  if (pathname === '/api/export' && req.method === 'GET') {
    const body = Buffer.from(JSON.stringify({ type: 'qingzhang-backup', exportedAt: new Date().toISOString(), state: STATE }, null, 2));
    res.writeHead(200, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Content-Disposition': 'attachment; filename="qingzhang-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
      'Cache-Control': 'no-store'
    }, corsHeaders(req)));
    return res.end(body);
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return sendJson(req, res, 400, { error: '请求体不是合法 JSON' }); }
    const src = body.state && typeof body.state === 'object' ? body.state : body;
    const check = validatePayload(src);
    if (check.error) return sendJson(req, res, 422, { error: check.error });
    const next = Object.assign({}, check.value, {
      rev: STATE.rev + 1,
      updatedAt: new Date().toISOString()
    });
    backup(STATE);
    writeStateAtomic(next);
    STATE = next;
    return sendJson(req, res, 200, STATE);
  }

  return sendJson(req, res, 404, { error: '没有这个接口' });
}

/* ---------------- 主循环 ---------------- */
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname;
  } catch (e) { /* 保持默认 */ }

  res.on('finish', () => {
    if (QUIET) return;
    const ms = Date.now() - started;
    if (pathname.indexOf('/api/') === 0) {
      console.log(req.method + ' ' + pathname + ' ' + res.statusCode + ' ' + ms + 'ms');
    }
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  try {
    if (pathname.indexOf('/api/') === 0) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(req, res, 405, 'Method Not Allowed');
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (e && e.code === 413) return sendJson(req, res, 413, { error: '请求体过大' });
    console.error('[ledger] 未捕获异常:', e);
    if (!res.headersSent) sendJson(req, res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('[ledger] 已启动 http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
  console.log('[ledger] 数据目录 ' + DATA_DIR + ' · 当前 rev ' + STATE.rev);
  console.log('[ledger] 允许来源 ' + (ORIGINS.join(', ') || '(无)'));
});

/* 收到退出信号先把当前数据刷一遍再关 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[ledger] 收到 ' + sig + '，正在退出…');
    try { writeStateAtomic(STATE); } catch (e) { /* noop */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
