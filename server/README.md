# 轻账 · 同步后端

零依赖。只用 Node 内置模块，不需要 `npm install`，没有数据库，没有构建步骤。

它做三件事：保存你的记账数据、签发登录令牌、顺带把静态站点也发出去（一个进程同时是站点和 API）。

---

## 一、本机跑起来

```bash
cd server
node server.js
```

首次启动会打印一串随机口令，并写进 `server/data/password.txt`：

```
[ledger] 首次运行，已生成访问口令：k7Qm2vXa9pLd
[ledger] 已启动 http://127.0.0.1:8787
```

打开 `http://127.0.0.1:8787` 就是站点本体（后端会把上级目录的静态文件一并发出）。左下角「云同步」→ 地址填 `http://127.0.0.1:8787`，口令填上面那串 → 连接。

想指定自己的口令，用环境变量：

```bash
LEDGER_PASSWORD='你的长口令' node server.js
```

---

## 二、部署到服务器

### 方案 A：VPS + Caddy（推荐，HTTPS 自动签）

静态站放在 GitHub Pages 上时，页面是 `https://`，后端也必须是 `https://`，否则浏览器按混合内容直接拦掉。Caddy 两行解决证书。

1. 把仓库传到服务器：

```bash
# 在服务器上
git clone https://github.com/LeanSun/bill.git /opt/qingzhang
```

2. 用 systemd 常驻：

```ini
# /etc/systemd/system/qingzhang.service
[Unit]
Description=Qingzhang ledger backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/qingzhang
ExecStart=/usr/bin/node server/server.js
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=LEDGER_DATA=/var/lib/qingzhang
Environment=LEDGER_PASSWORD=换成长口令
Environment=ALLOWED_ORIGINS=https://leansun.github.io
Restart=always
RestartSec=3
# 只允许写数据目录
ReadWritePaths=/var/lib/qingzhang
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/qingzhang && sudo chown www-data /var/lib/qingzhang
sudo systemctl daemon-reload
sudo systemctl enable --now qingzhang
sudo systemctl status qingzhang
```

3. Caddy 反代 + 自动 HTTPS：

```caddyfile
# /etc/caddy/Caddyfile
ledger.你的域名.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

验证：`curl https://ledger.你的域名.com/api/health` 应返回 `{"ok":true,...}`。

### 方案 B：Docker

仓库根目录有 `Dockerfile`：

```bash
docker build -t qingzhang .
docker run -d --name qingzhang \
  -p 8787:8787 \
  -e LEDGER_PASSWORD='你的长口令' \
  -e ALLOWED_ORIGINS='https://leansun.github.io' \
  -v qingzhang-data:/data \
  -e LEDGER_DATA=/data \
  qingzhang
```

前面同样建议套一层 Caddy / Nginx 做 TLS，别把 8787 明文暴露到公网。

### 方案 C：平台部署（Render / Fly / Railway）

都能直接吃 `Dockerfile` 或 `node server/server.js`。注意两点：

- 必须有持久磁盘，挂到 `LEDGER_DATA` 指的路径。容器重启后数据在内存里就没了。
- 平台给的域名本身就是 https，可以直接用，不用再配证书。

---

## 三、环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址。放在反代后面建议 `127.0.0.1` |
| `LEDGER_PASSWORD` | 首次随机生成 | 登录口令 |
| `TOKEN_SECRET` | 自动生成存盘 | 令牌签名密钥。换掉它 = 所有设备立刻掉线 |
| `TOKEN_TTL_DAYS` | `30` | 令牌有效期 |
| `ALLOWED_ORIGINS` | `*` | 允许跨域的来源，逗号分隔。**GitHub Pages 的站点必须写在这里** |
| `LEDGER_DATA` | `server/data` | 数据目录 |
| `MAX_BODY_MB` | `8` | 单次请求体上限 |
| `BACKUP_KEEP` | `20` | 备份保留份数 |
| `QUIET` | 关 | 设 `1` 关掉逐条请求日志 |

---

## 四、接口

除 `/api/health` 和 `/api/login` 外，全部要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 探活，返回当前 rev 与记录数 |
| POST | `/api/login` | `{password}` → `{token, exp}` |
| GET | `/api/state` | 取整份状态 |
| PUT | `/api/state` | `{rev, added, edited, deleted, theme}`。`rev` 不一致返回 `409` 和服务器当前文档 |
| GET | `/api/export` | 下载完整备份 JSON |
| POST | `/api/import` | 整份替换，rev 自增 |

`PUT` 是"全量提交 + 版本号乐观锁"，不是逐条合并：冲突时由前端让你二选一，不做隐式合并。个人多设备场景这样最不容易悄悄丢数据。

---

## 五、数据与备份

```
server/data/
├── state.json          当前数据（写入用 临时文件 + rename，断电不会留下半截 JSON）
├── secret.key          令牌签名密钥
├── password.txt        首次生成的口令（600 权限）
└── backups/            每次写入前的旧版本，保留最近 20 份
    └── state-r0007-2026-11-13T13-40-22-118Z.json
```

手工恢复某一版：停服务，把 `backups/` 里那份复制成 `state.json`，启动。

要异地备份，把 `server/data/` 整个目录丢进任何同步盘或 `rsync` 定时任务即可 —— 没有数据库，就是几个文件。

---

## 六、安全边界（说清楚，别自己骗自己）

- 单用户单口令。没有注册、找回、多账号。这是私人账本，不是 SaaS。
- 口令只存在服务端；令牌是 HMAC-SHA256 签名的，30 天过期，改 `TOKEN_SECRET` 可一键踢掉所有设备。
- 登录接口按 IP 限流：5 分钟内 8 次失败就锁。
- 传输层安全靠 HTTPS。**没配 TLS 就用公网 IP 明文跑，等于把口令发在广场上** —— 一定要套 Caddy/Nginx 或直接用平台域名。
- `ALLOWED_ORIGINS` 用 `*` 意味着任何网页都能带着你的令牌调接口（令牌存在浏览器里，只有你自己的页面能读到）。自己的服务器上写具体来源。
- 数据是明文 JSON 落盘。要更强，把数据目录放在加密卷上（LUKS / VeraCrypt / 云盘加密），别指望应用层加密。
