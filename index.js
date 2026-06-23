const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { WebSocket, createWebSocketStream } = require('ws');

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

// ==================== 工具 ====================
function rnd(n = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyz', b = crypto.randomBytes(n);
  let r = ''; for (let i = 0; i < n; i++) r += c[b[i] % c.length]; return r;
}

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
let cachedSub = '';

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

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  try {
    const dnsQuery = `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`;
    const resp = await axios.get(dnsQuery, {
      timeout: 3000,
      headers: { 'Accept': 'application/dns-json' }
    });
    if (resp.data && resp.data.Status === 0 && resp.data.Answer && resp.data.Answer.length > 0) {
      const ip = resp.data.Answer.find(record => record.type === 1);
      if (ip) return ip.data;
    }
  } catch (e) {}
  return host; // 失败时退回原本 host，让 net.connect 利用系统 DNS 解析
}

// ==================== ISP 地理信息自动标注 ====================
async function getMetaInfo() {
  try {
    const resp = await axios.get('https://api.ip.sb/geoip', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000,
    });
    if (resp.data && resp.data.country_code && resp.data.isp) {
      return `${resp.data.country_code}-${resp.data.isp}`.replace(/\s+/g, '_');
    }
  } catch (e) {}

  try {
    const resp = await axios.get('http://ip-api.com/json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000,
    });
    if (resp.data && resp.data.status === 'success' && resp.data.countryCode && resp.data.org) {
      return `${resp.data.countryCode}-${resp.data.org}`.replace(/\s+/g, '_');
    }
  } catch (e) {}

  return 'Unknown';
}

// ==================== 订阅生成 ====================
function buildSub(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  const n = encodeURIComponent(nodeName);

  const vlessLine = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Fapi%2Fv3%2Ftelemetry%3Fed%3D2560#${n}`;

  const trojanLine = `trojan://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Fgraphql%2Fstream%3Fed%3D2560#${n}`;

  return [vlessLine, trojanLine].join('\n');
}

async function refreshSub() {
  const isp = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${isp}` : isp;
  cachedSub = Buffer.from(buildSub(nodeName)).toString('base64');
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

// ==================== 路由（Nginx 404 伪装） ====================
const NGINX_404 = '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx/1.27.3</center>\n</body>\n</html>\n';

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/robots.txt', (req, res) => {
  res.set('Server', 'nginx/1.27.3');
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

app.get('/', (req, res) => {
  setTimeout(() => {
    try { if (!res.headersSent) res.status(404).set({ 'Server': 'nginx/1.27.3', 'Content-Type': 'text/html', 'Connection': 'keep-alive' }).send(NGINX_404); } catch (e) {}
  }, 1 + Math.random() * 14);
});

app.get(`/${SUB_PATH}`, (req, res) => {
  if (!cachedSub) return res.status(503).send('not ready');
  res.type('text/plain; charset=utf-8').send(cachedSub);
});

app.use((req, res) => {
  setTimeout(() => {
    try { if (!res.headersSent) res.status(404).set({ 'Server': 'nginx/1.27.3', 'Content-Type': 'text/html', 'Connection': 'keep-alive' }).send(NGINX_404); } catch (e) {}
  }, 1 + Math.random() * 14);
});

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

function handleTrojan(ws, msg) {
  try {
    const receivedPasswordHash = msg.slice(0, 56).toString();
    const expectedHash = crypto.createHash('sha224').update(UUID).digest('hex');

    if (receivedPasswordHash !== expectedHash) {
      ws.close();
      return;
    }

    let offset = 56;
    if (msg[offset] === 0x0d && msg[offset + 1] === 0x0a) {
      offset += 2;
    }

    const cmd = msg[offset];
    if (cmd !== 0x01) {
      ws.close();
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
      ws.close();
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
const argoHttpServer = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server: argoHttpServer });
wss.on('connection', (ws, req) => {
  const urlPath = req.url.split('?')[0];

  ws.once('message', msg => {
    if (urlPath === '/api/v3/telemetry' && msg.length > 17 && msg[0] === 0) {
      const id = msg.slice(1, 17);
      const isVless = id.every((v, i) => v == parseInt(uuidClean.substr(i * 2, 2), 16));
      if (isVless) {
        handleVless(ws, msg);
      } else {
        ws.close();
      }
    }
    else if (urlPath === '/graphql/stream' && msg.length >= 58) {
      handleTrojan(ws, msg);
    } else {
      ws.close();
    }
  }).on('error', () => {});
});

async function startserver() {
  await refreshSub();

  argoHttpServer.listen(ARGO_PORT, '127.0.0.1', () => {
    console.log(`Argo backend listening locally on 127.0.0.1:${ARGO_PORT}`);
  });

  await installCloudflared();
  startCloudflared();

  scheduleCleanup();
}

app.listen(PORT, () => console.log(`http :${PORT} | sub /${SUB_PATH}`));

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
