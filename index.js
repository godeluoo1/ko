const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { WebSocket, createWebSocketStream } = require('ws');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;

process.title = 'npm start';

// ==================== 针对 0.2vCPU 共享 / 512MB RAM 容器的极致优化 ====================
process.env.GOMAXPROCS = '1';
process.env.GODEBUG = 'madvdontneed=1';
process.env.GOGC = '50';

// ==================== 环境变量 ====================
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const ARGO_PORT = Number(process.env.BACKEND_PORT || 8001);
const UUID = (process.env.APP_KEY || '').trim();
const ARGO_DOMAIN = (process.env.APP_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
const ARGO_AUTH = (process.env.API_TOKEN || '').trim();
const ARGO_PROTOCOL = (process.env.TUNNEL_PROTO || 'http2').toLowerCase();
const CFIP = process.env.CDN_HOST || 'saas.sin.fan';
const CFPORT = String(process.env.CDN_PORT || '443');
const NAME = process.env.NAME || 'Vls';
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const FP = process.env.FP || 'chrome';
const EDGE_IP_VERSION = process.env.EDGE_IP_VERSION || 'auto';

const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

if (!UUID) { console.error('[fatal] APP_KEY 未设置，请配置环境变量 APP_KEY'); process.exit(1); }
if (!ARGO_AUTH) { console.error('[fatal] API_TOKEN 未设置，不支持临时隧道'); process.exit(1); }

const SUB_PATH = (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '') || 'godeluoo';

// ==================== 路径（全随机化） ====================
const RUN_DIR = path.resolve(FILE_PATH);
const botPath = path.join(RUN_DIR, rnd());
const tunnelJsonPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `${rnd(4)}.yml`);

// 阅后即焚清单（不留盘）
const cleanupFiles = [botPath, tunnelJsonPath, tunnelYmlPath];

// ==================== 状态 ====================
let tunnelMode = ARGO_AUTH.includes('TunnelSecret') ? 'json' : 'token';
const managedChildren = new Map();
let isShuttingDown = false;

// ==================== SWR 内存缓存订阅状态 ====================
let subCache = {
  data: '',
  timestamp: 0,
  isRefreshing: false
};

// ==================== 主动内存垃圾回收 (GC节流器) ====================
let lastGCTime = 0;
function throttleGC() {
  if (typeof global.gc === 'function') {
    const now = Date.now();
    // 限制每 30 秒执行一次 GC，防止过于频繁消耗 CPU 算力
    if (now - lastGCTime > 30000) {
      try {
        global.gc();
        lastGCTime = now;
      } catch (e) {}
    }
  }
}

// ==================== 工具 ====================
function rnd(n = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyz', b = crypto.randomBytes(n);
  let r = ''; for (let i = 0; i < n; i++) r += c[b[i] % c.length]; return r;
}

// ==================== 初始化 ====================
fs.mkdirSync(RUN_DIR, { recursive: true });

// 启动时清理历史残留
try { fs.readdirSync(RUN_DIR).forEach(f => {
  try { fs.unlinkSync(path.join(RUN_DIR, f)); } catch (e) {}
}); } catch (e) {}

const app = express();
app.disable('x-powered-by');

// ==================== 测速域名过滤与 DoH 解析 ====================
const BLOCKED_DOMAINS = [
  'speedtest.net', 'fast.com', 'speedtest.cn', 'speed.cloudflare.com', 'speedof.me',
  'testmy.net', 'bandwidth.place', 'speed.io', 'librespeed.org', 'speedcheck.org'
];

function isBlockedDomain(host) {
  if (!host) return false;
  const hostLower = host.toLowerCase();
  return BLOCKED_DOMAINS.some(blocked => {
    return hostLower === blocked || hostLower.endsWith('.' + blocked);
  });
}

const dnsCache = new Map();

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  if (dnsCache.has(host)) {
    const cached = dnsCache.get(host);
    if (Date.now() - cached.timestamp < 300000) { // 5 mins cache
      return cached.ip;
    }
  }
  try {
    const res = await dns.lookup(host);
    if (res && res.address) {
      dnsCache.set(host, { ip: res.address, timestamp: Date.now() });
      return res.address;
    }
  } catch (e) {}
  return host;
}

// ==================== 双源竞态获取地理信息 (1.5s 超快超时) ====================
async function getMetaInfoWithRace() {
  const fetchSB = async () => {
    const resp = await axios.get('https://api.ip.sb/geoip', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 1500,
    });
    if (resp.data && resp.data.country_code && resp.data.isp) {
      return `${resp.data.country_code}-${resp.data.isp}`.replace(/\s+/g, '_');
    }
    throw new Error('invalid response');
  };

  const fetchAPI = async () => {
    const resp = await axios.get('http://ip-api.com/json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 1500,
    });
    if (resp.data && resp.data.status === 'success' && resp.data.countryCode && resp.data.org) {
      return `${resp.data.countryCode}-${resp.data.org}`.replace(/\s+/g, '_');
    }
    throw new Error('invalid response');
  };

  try {
    return await Promise.any([fetchSB(), fetchAPI()]);
  } catch (e) {
    return 'Unknown';
  }
}

// ==================== 订阅生成 ====================
function buildSub(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  const nTls = encodeURIComponent(`${nodeName}-TLS`);
  const nNoTls = encodeURIComponent(`${nodeName}-NoTLS`);

  // 1. 带 TLS (端口 443, 高安全性)
  const vlessTls = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Fapi%2Fv3%2Ftelemetry#${nTls}`;
  const trojanTls = `trojan://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Fgraphql%2Fstream#${nTls}`;
  const ssMethodPassword = Buffer.from(`none:${UUID}`).toString('base64');
  const ssTls = `ss://${ssMethodPassword}@${CFIP}:${CFPORT}?plugin=v2ray-plugin;mode=websocket;host=${host};path=/assets/media/stream;tls;sni=${host}#${nTls}`;

  // 2. 不带 TLS (端口 80, 无握手延迟开销, 极速测速体验)
  const vlessNoTls = `vless://${UUID}@${CFIP}:80?encryption=none&security=none&type=ws&host=${host}&path=%2Fapi%2Fv3%2Ftelemetry#${nNoTls}`;
  const ssNoTls = `ss://${ssMethodPassword}@${CFIP}:80?plugin=v2ray-plugin;mode=websocket;host=${host};path=/assets/media/stream#${nNoTls}`;

  return [
    vlessTls, trojanTls, ssTls,
    vlessNoTls, ssNoTls
  ].join('\n');
}

// ==================== SWR 内存缓存订阅拉取核心 ====================
async function getDynamicSub() {
  const now = Date.now();
  const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

  if (subCache.data && (now - subCache.timestamp < CACHE_TTL)) {
    return subCache.data;
  }

  if (subCache.data && !subCache.isRefreshing) {
    subCache.isRefreshing = true;
    refreshSubAsync().catch(() => {}).finally(() => { subCache.isRefreshing = false; });
    return subCache.data;
  }

  await refreshSubSync();
  return subCache.data;
}

async function refreshSubAsync() {
  const isp = await getMetaInfoWithRace();
  const nodeName = NAME ? `${NAME}-${isp}` : isp;
  subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
  subCache.timestamp = Date.now();
}

async function refreshSubSync() {
  try {
    const isp = await getMetaInfoWithRace();
    const nodeName = NAME ? `${NAME}-${isp}` : isp;
    subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
    subCache.timestamp = Date.now();
  } catch (e) {
    const nodeName = NAME ? `${NAME}-Unknown` : 'Unknown';
    subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
    subCache.timestamp = Date.now();
  }
}

// ==================== 下载 ====================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function download(url, dest) {
  const tmp = `${dest}.dl`;
  fs.rmSync(tmp, { force: true });
  const r = await axios({ method: 'get', url, responseType: 'stream', timeout: 120000,
    headers: { 'User-Agent': UA }, validateStatus: s => s >= 200 && s < 300 });
  await pipeline(r.data, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o775);
}

async function downloadRetry(urls, dest, label) {
  for (let i = 0; i < urls.length; i++) {
    try { await download(urls[i], dest); return; } catch (e) {}
  }
  throw new Error(`${label}: all sources failed`);
}

async function installCloudflared() {
  await downloadRetry([
    `https://github.com/godeluoo1/ko-vip/releases/latest/download/bot-linux-${arch}`,
  ], botPath, 'cf');
}

// ==================== 进程管理 ====================
function startProcess(label, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, { 
    stdio: ['ignore', 'ignore', 'pipe'], 
    env: { ...process.env, ...extraEnv } 
  });
  child.stderr && child.stderr.on('data', d => console.error(`[${label}]`, d.toString().trim()));
  managedChildren.set(label, child);
  child.on('error', () => managedChildren.delete(label));
  child.on('close', (code, sig) => {
    managedChildren.delete(label);
    if (isShuttingDown) return;
    process.exit(1);
  });
  return child;
}

// ==================== 隧道 ====================
function startCloudflared() {
  const base = ['tunnel', '--edge-ip-version', EDGE_IP_VERSION, '--no-autoupdate', '--loglevel', 'fatal', '--protocol', ARGO_PROTOCOL];

  if (tunnelMode === 'json') {
    const creds = JSON.parse(ARGO_AUTH);
    const tid = creds.TunnelID || creds.tunnel_id || creds.TunnelName || creds.tunnel_name;
    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);
    fs.writeFileSync(tunnelYmlPath, [
      `tunnel: ${tid}`, `credentials-file: ${tunnelJsonPath}`, `protocol: ${ARGO_PROTOCOL}`,
      'ingress:', `  - hostname: ${ARGO_DOMAIN}`, `    service: http://localhost:${ARGO_PORT}`, '  - service: http_status:404',
    ].join('\n'));
    return startProcess('cf', botPath, [...base, '--config', tunnelYmlPath, 'run']);
  }

  if (tunnelMode === 'token') {
    return startProcess('cf', botPath, [...base, 'run'], { TUNNEL_TOKEN: ARGO_AUTH });
  }
}

// ==================== 阅后即焚 ====================
function scheduleCleanup() {
  setTimeout(() => {
    cleanupFiles.forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} });
  }, 15000);
}

// ==================== 路由（Nginx 404 伪装与 Glassmorphism 静态博客页） ====================
const NGINX_404 = '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx/1.27.3</center>\n</body>\n</html>\n';

const BLOG_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aiden Lin | Creative Developer & Architect</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Playfair+Display:ital,wght@0,600;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --card-bg: rgba(20, 20, 25, 0.6);
      --card-border: rgba(255, 215, 0, 0.1);
      --primary: #ffd700;
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --glow: rgba(255, 215, 0, 0.15);
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      overflow-x: hidden;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .bg-glow {
      position: absolute;
      top: -20%;
      left: 30%;
      width: 600px;
      height: 600px;
      background: radial-gradient(circle, var(--glow) 0%, transparent 70%);
      pointer-events: none;
      z-index: -1;
      filter: blur(80px);
    }
    header {
      max-width: 1200px;
      width: 90%;
      margin: 0 auto;
      padding: 2rem 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.05em;
      background: linear-gradient(135deg, #fff 0%, var(--primary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    nav a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.95rem;
      margin-left: 2rem;
      transition: color 0.3s;
    }
    nav a:hover {
      color: var(--primary);
    }
    main {
      max-width: 1200px;
      width: 90%;
      margin: 4rem auto;
      flex: 1;
    }
    .hero {
      text-align: center;
      max-width: 800px;
      margin: 0 auto 6rem;
    }
    .hero h1 {
      font-family: 'Playfair Display', serif;
      font-size: clamp(2.5rem, 6vw, 4.5rem);
      line-height: 1.1;
      font-weight: 400;
      margin-bottom: 1.5rem;
    }
    .hero h1 span {
      font-style: italic;
      color: var(--primary);
    }
    .hero p {
      font-size: clamp(1rem, 2vw, 1.25rem);
      color: var(--text-muted);
      line-height: 1.6;
      font-weight: 300;
    }
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 2rem;
      margin-top: 4rem;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 2.5rem;
      transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }
    .card::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 20px;
      padding: 1px;
      background: linear-gradient(135deg, var(--primary) 0%, transparent 50%);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      opacity: 0;
      transition: opacity 0.4s;
    }
    .card:hover {
      transform: translateY(-8px);
      border-color: rgba(255, 215, 0, 0.3);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), 0 0 30px rgba(255, 215, 0, 0.05);
    }
    .card:hover::before {
      opacity: 1;
    }
    .card-tag {
      font-size: 0.75rem;
      color: var(--primary);
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-bottom: 1rem;
      font-weight: 600;
    }
    .card h3 {
      font-size: 1.4rem;
      margin-bottom: 1rem;
      font-weight: 600;
    }
    .card p {
      color: var(--text-muted);
      line-height: 1.6;
      font-size: 0.95rem;
      font-weight: 300;
    }
    footer {
      max-width: 1200px;
      width: 90%;
      margin: 0 auto;
      padding: 3rem 0;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text-muted);
      font-size: 0.85rem;
    }
    .socials a {
      color: var(--text-muted);
      text-decoration: none;
      margin-left: 1.5rem;
      transition: color 0.3s;
    }
    .socials a:hover {
      color: var(--primary);
    }
    @media (max-width: 768px) {
      header, footer {
        flex-direction: column;
        gap: 1.5rem;
        text-align: center;
      }
      nav a {
        margin: 0 1rem;
      }
      .socials a {
        margin: 0 0.75rem;
      }
    }
  </style>
</head>
<body>
  <div class="bg-glow"></div>
  <header>
    <div class="logo">Aiden.L</div>
    <nav>
      <a href="#projects">项目</a>
      <a href="#blog">博客</a>
      <a href="#about">关于</a>
    </nav>
  </header>
  <main>
    <div class="hero">
      <h1>Sleek Designs, <br><span>Scalable Systems.</span></h1>
      <p>林艾登是一名全栈工程师和系统架构师。致力于开发极佳体验的 Web 应用与高性能后端微服务系统，用工程美学编织数字化世界。</p>
    </div>
    <div class="cards-grid" id="projects">
      <div class="card">
        <div class="card-tag">Golang / Microservice</div>
        <h3>Lite-RPC</h3>
        <p>一款基于 HTTP/2 协议开发的轻量级高性能 RPC 框架。支持自适应服务治理、动态负载均衡以及毫秒级心跳保活检测。</p>
      </div>
      <div class="card">
        <div class="card-tag">TypeScript / Network</div>
        <h3>Fast-Proxy</h3>
        <p>部署在云原生边界的高性能边缘网关。手写网络协议栈拦截分流，大幅缩短端到端的延迟并内置动态 DoH 缓存机制。</p>
      </div>
      <div class="card">
        <div class="card-tag">Rust / Compiler</div>
        <h3>WebCompiler</h3>
        <p>基于 Rust 开发的零配置前端代码构建器。内置极速 CSS/JS 解析器，利用多核多线程实现百兆代码秒级打包输出。</p>
      </div>
    </div>
  </main>
  <footer>
    <div>© 2026 Aiden Lin. All rights reserved.</div>
    <div class="socials">
      <a href="#">GitHub</a>
      <a href="#">Twitter</a>
      <a href="#">Email</a>
    </div>
  </footer>
</body>
</html>`;

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/robots.txt', (req, res) => {
  res.set('Server', 'nginx/1.27.3');
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

// 根目录：返回精美伪装个人博客页
app.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Server': 'nginx/1.27.3'
  });
  res.send(BLOG_HTML);
});

// 订阅路由：返回动态生成的SWR缓存订阅
app.get(`/${SUB_PATH}`, async (req, res) => {
  try {
    const subData = await getDynamicSub();
    res.type('text/plain; charset=utf-8').send(subData);
  } catch (err) {
    res.status(503).send('not ready');
  }
});

// ==================== 主动探测伪装阻断 ====================
function rejectConnection(ws) {
  const delay = 150 + Math.floor(Math.random() * 450); // 随机 150ms~600ms 延迟
  setTimeout(() => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        // 模仿发送一段看似正常的网页响应数据给探测器，再强制断开
        ws.send(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nServer: nginx/1.27.3\r\n\r\n" + BLOG_HTML));
        ws.close();
      }
    } catch (e) {}
    throttleGC();
  }, delay);
}

// ==================== 原生协议解析核心 ====================
const uuidClean = UUID.replace(/-/g, "");

function handleVless(ws, msg) {
  try {
    const [VERSION] = msg;
    let i = msg.slice(17, 18).readUInt8() + 19;
    const port = msg.slice(i, i += 2).readUInt16BE(0);
    const ATYP = msg.slice(i, i += 1).readUInt8();
    const host = ATYP == 1 ? msg.slice(i, i += 4).join('.') :
      (ATYP == 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) :
        (ATYP == 3 ? msg.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));

    if (isBlockedDomain(host)) {
      ws.close();
      return;
    }

    ws.send(new Uint8Array([VERSION, 0]));
    const duplex = createWebSocketStream(ws);

    resolveHost(host)
      .then(resolvedIP => {
        net.connect({ host: resolvedIP, port }, function () {
          this.write(msg.slice(i));
          duplex.on('error', () => { }).pipe(this).on('error', () => { }).pipe(duplex);
        }).on('error', () => { ws.close(); });
      })
      .catch(() => {
        net.connect({ host, port }, function () {
          this.write(msg.slice(i));
          duplex.on('error', () => { }).pipe(this).on('error', () => { }).pipe(duplex);
        }).on('error', () => { ws.close(); });
      });
  } catch (err) {
    ws.close();
  }
}

// 原生安全 UDP 转发
function handleVlessUdp(ws, initialMsg, offset, host, port) {
  try {
    if (isBlockedDomain(host) || port === 53) {
      ws.close();
      return;
    }

    ws.send(new Uint8Array([0, 0])); // 握手成功响应

    const udpSocket = dgram.createSocket('udp4');
    const duplex = createWebSocketStream(ws);

    resolveHost(host)
      .then(resolvedIP => {
        udpSocket.connect(port, resolvedIP, () => {
          if (offset < initialMsg.length) {
            const payload = stripUdpHeader(initialMsg.slice(offset));
            if (payload && payload.length > 0) udpSocket.send(payload);
          }
        });
      })
      .catch(() => {
        udpSocket.connect(port, host, () => {
          if (offset < initialMsg.length) {
            const payload = stripUdpHeader(initialMsg.slice(offset));
            if (payload && payload.length > 0) udpSocket.send(payload);
          }
        });
      });

    function stripUdpHeader(buf) {
      if (buf.length < 2) return null;
      const len = buf.readUInt16BE(0);
      return buf.slice(2, 2 + len);
    }

    duplex.on('data', chunk => {
      let pos = 0;
      while (pos < chunk.length) {
        if (chunk.length - pos < 2) break;
        const len = chunk.readUInt16BE(pos);
        if (chunk.length - pos < 2 + len) break;
        const payload = chunk.slice(pos + 2, pos + 2 + len);
        udpSocket.send(payload);
        pos += 2 + len;
      }
    });

    udpSocket.on('message', msg => {
      if (ws.readyState === WebSocket.OPEN) {
        const header = Buffer.alloc(2);
        header.writeUInt16BE(msg.length, 0);
        ws.send(Buffer.concat([header, msg]), { binary: true });
      }
    });

    const cleanup = () => {
      try { udpSocket.close(); } catch(e) {}
      ws.close();
      throttleGC();
    };

    udpSocket.on('error', cleanup);
    udpSocket.on('close', cleanup);
    duplex.on('error', cleanup);
    duplex.on('close', cleanup);
  } catch (err) {
    ws.close();
  }
}

function handleTrojan(ws, msg) {
  try {
    const receivedPasswordHash = msg.slice(0, 56).toString();
    const expectedHash = crypto.createHash('sha224').update(UUID).digest('hex');

    if (receivedPasswordHash !== expectedHash) {
      rejectConnection(ws);
      return;
    }

    let offset = 56;
    if (msg[offset] === 0x0d && msg[offset + 1] === 0x0a) {
      offset += 2;
    }

    const cmd = msg[offset];
    if (cmd !== 0x01) {
      rejectConnection(ws);
      return;
    }
    offset += 1;

    const atyp = msg[offset];
    offset += 1;

    let host, port;
    if (atyp === 0x01) {
      host = msg.slice(offset, offset + 4).join('.');
      offset += 4;
    } else if (atyp === 0x03) {
      const hostLen = msg[offset];
      offset += 1;
      host = msg.slice(offset, offset + hostLen).toString();
      offset += hostLen;
    } else if (atyp === 0x04) {
      host = msg.slice(offset, offset + 16).reduce((s, b, i, a) =>
        (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), [])
        .map(b => b.readUInt16BE(0).toString(16)).join(':');
      offset += 16;
    } else {
      rejectConnection(ws);
      return;
    }

    port = msg.readUInt16BE(offset);
    offset += 2;

    if (offset < msg.length && msg[offset] === 0x0d && msg[offset + 1] === 0x0a) {
      offset += 2;
    }

    if (isBlockedDomain(host)) {
      ws.close();
      return;
    }

    const duplex = createWebSocketStream(ws);

    resolveHost(host)
      .then(resolvedIP => {
        net.connect({ host: resolvedIP, port }, function () {
          if (offset < msg.length) {
            this.write(msg.slice(offset));
          }
          duplex.on('error', () => { }).pipe(this).on('error', () => { }).pipe(duplex);
        }).on('error', () => { ws.close(); });
      })
      .catch(() => {
        net.connect({ host, port }, function () {
          if (offset < msg.length) {
            this.write(msg.slice(offset));
          }
          duplex.on('error', () => { }).pipe(this).on('error', () => { }).pipe(duplex);
        }).on('error', () => { ws.close(); });
      });
  } catch (err) {
    ws.close();
  }
}

// ==================== 主启动 ====================
// 探测防御：接管普通HTTP GET请求，重定向或返回网页伪装
const argoHttpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (['/api/v3/telemetry', '/graphql/stream'].includes(urlPath)) {
    // 302重定向至PORT
    res.writeHead(302, { 'Location': '/' });
    res.end();
  } else {
    res.writeHead(404, { 'Server': 'nginx/1.27.3', 'Content-Type': 'text/html; charset=utf-8' });
    res.end(NGINX_404);
  }
});

const wss = new WebSocket.Server({ server: argoHttpServer });
wss.on('connection', (ws, req) => {
  const urlPath = req.url.split('?')[0];
  console.log(`[DEBUG] New WS connection path: ${urlPath} from ${req.socket.remoteAddress}`);

  let accumulated = Buffer.alloc(0);
  let resolvedHeader = false;

  const onMessage = msg => {
    if (resolvedHeader) return;
    accumulated = Buffer.concat([accumulated, msg]);

    try {
      // 1. VLESS (/api/v3/telemetry)
      if (urlPath === '/api/v3/telemetry') {
        if (accumulated.length < 18) return;
        const addonsLen = accumulated[17];
        const headerMin = 22 + addonsLen;
        if (accumulated.length < headerMin) return;

        const cmd = accumulated[18 + addonsLen];
        const atyp = accumulated[headerMin - 1];
        let fullHeaderLen = headerMin;

        if (atyp === 1) {
          fullHeaderLen += 4;
        } else if (atyp === 2) {
          if (accumulated.length < headerMin + 1) return;
          const hostLen = accumulated[headerMin];
          fullHeaderLen += 1 + hostLen;
        } else if (atyp === 3) {
          fullHeaderLen += 16;
        } else {
          ws.off('message', onMessage);
          rejectConnection(ws);
          return;
        }

        if (accumulated.length < fullHeaderLen) return;

        resolvedHeader = true;
        ws.off('message', onMessage);

        const id = accumulated.slice(1, 17);
        const isVless = id.every((v, i) => v == parseInt(uuidClean.substr(i * 2, 2), 16));
        if (!isVless) {
          rejectConnection(ws);
          return;
        }

        let i = addonsLen + 19;
        const port = accumulated.slice(i, i += 2).readUInt16BE(0);
        const ATYP = accumulated.slice(i, i += 1).readUInt8();
        const host = ATYP == 1 ? accumulated.slice(i, i += 4).join('.') :
          (ATYP == 2 ? new TextDecoder().decode(accumulated.slice(i + 1, i += 1 + accumulated.slice(i, i + 1).readUInt8())) :
            (ATYP == 3 ? accumulated.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));

        console.log(`[DEBUG] VLESS: cmd=${cmd}, host=${host}, port=${port}`);

        if (cmd === 0x02) {
          handleVlessUdp(ws, accumulated, i, host, port);
        } else {
          handleVless(ws, accumulated);
        }
      }
      // 2. Trojan (/graphql/stream)
      else if (urlPath === '/graphql/stream') {
        if (accumulated.length < 58) return;
        let offset = 56;
        if (accumulated[offset] === 0x0d && accumulated[offset + 1] === 0x0a) {
          offset += 2;
        }
        if (accumulated.length < offset + 2) return;

        const cmd = accumulated[offset];
        const atyp = accumulated[offset + 1];
        offset += 2;

        let fullLen = offset;
        if (atyp === 0x01) {
          fullLen += 4 + 2;
        } else if (atyp === 0x03) {
          if (accumulated.length < offset + 1) return;
          const hostLen = accumulated[offset];
          fullLen += 1 + hostLen + 2;
        } else if (atyp === 0x04) {
          fullLen += 16 + 2;
        } else {
          ws.off('message', onMessage);
          rejectConnection(ws);
          return;
        }

        if (accumulated.length < fullLen) return;

        resolvedHeader = true;
        ws.off('message', onMessage);

        handleTrojan(ws, accumulated);
      } else {
        console.log(`[DEBUG] Unknown path ${urlPath}, rejecting.`);
        ws.off('message', onMessage);
        rejectConnection(ws);
      }
    } catch (err) {
      console.error(`[DEBUG] WS message handle error:`, err);
      ws.off('message', onMessage);
      rejectConnection(ws);
    }
  };

  ws.on('message', onMessage);

  ws.on('close', () => {
    console.log(`[DEBUG] WS socket closed.`);
    ws.off('message', onMessage);
    throttleGC();
  });
});

async function startserver() {
  await refreshSubSync();

  argoHttpServer.listen(ARGO_PORT, '127.0.0.1', () => {
    console.log(`[INFO] Web Service backend initialized on port ${ARGO_PORT}.`);
  });

  await installCloudflared();
  startCloudflared();

  scheduleCleanup();
}

app.listen(PORT, () => {
  console.log(`[INFO] Server listening on port ${PORT}`);
  console.log(`[INFO] Camouflage blog static pages pre-rendered successfully.`);
});

startserver().catch(e => { console.error('[startup]', e.message || e); process.exit(1); });

// ==================== 优雅退出 ====================
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  try { argoHttpServer.close(); } catch(e) {}
  
  const ps = [];
  for (const [, child] of managedChildren) {
    if (child && !child.killed) {
      ps.push(new Promise(r => {
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} r(); }, 5000);
        child.once('close', () => { clearTimeout(t); r(); });
        try { child.kill('SIGTERM'); } catch (e) {}
      }));
    }
  }
  await Promise.all(ps);
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', () => process.exit(1));
process.on('unhandledRejection', () => process.exit(1));

// ==================== 防休眠 ====================
const KEEP_ALIVE_PATHS = ['/', '/index.html', '/about', '/contact', '/api/status'];

(function keepAlive() {
  const lo = 4 * 60000, hi = 8 * 60000;
  (function tick() {
    setTimeout(() => {
      const randomPath = KEEP_ALIVE_PATHS[Math.floor(Math.random() * KEEP_ALIVE_PATHS.length)];
      http.get(`http://127.0.0.1:${PORT}${randomPath}`, r => r.resume()).on('error', () => {});
      tick();
    }, lo + Math.floor(Math.random() * (hi - lo)));
  })();
})();
