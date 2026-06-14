const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

process.title = 'npm start';

// ==================== 针对 0.2vCPU 共享 / 512MB RAM 容器的极致优化 ====================
// 1. 限制 Go 运行时最大线程数为 1，防止在 0.2vCPU 环境下因宿主机多核导致并发线程过多，产生严重 CPU 上下文切换损耗
process.env.GOMAXPROCS = '1';
// 2. 强制 Go 运行时在垃圾回收后立即将闲置物理内存归还给操作系统，防止内存在 512MB 容器中虚高被 OOM 杀掉
process.env.GODEBUG = 'madvdontneed=1';
// 3. 将 Go 垃圾回收触发阈值降低为 50（默认 100），使 xray/cloudflared 更频繁地回收内存，确保内存水位处于极低状态
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

// 必须手动设置 UUID，不提供默认值
if (!UUID) { console.error('[fatal] APP_KEY 未设置，请配置环境变量 APP_KEY'); process.exit(1); }

// 必须配置 ARGO_AUTH，禁止临时隧道
if (!ARGO_AUTH) { console.error('[fatal] API_TOKEN 未设置，不支持临时隧道'); process.exit(1); }

// SUB_PATH: 用户自定义 > 固定默认值
const SUB_PATH = (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '') || 'godeluoo';

// ==================== 工具 ====================
function rnd(n = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyz', b = crypto.randomBytes(n);
  let r = ''; for (let i = 0; i < n; i++) r += c[b[i] % c.length]; return r;
}

// ==================== 路径（全随机化） ====================
const RUN_DIR = path.resolve(FILE_PATH);
const webPath = path.join(RUN_DIR, rnd());
const botPath = path.join(RUN_DIR, rnd());
const cfgPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelJsonPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `${rnd(4)}.yml`);

// 阅后即焚清单（sub.txt 也包含在内，不留盘）
const cleanupFiles = [webPath, botPath, cfgPath, tunnelJsonPath, tunnelYmlPath];

// ==================== 状态 ====================
let tunnelMode = ARGO_AUTH.includes('TunnelSecret') ? 'json' : 'token';
const managedChildren = new Map();
let isShuttingDown = false;
let cachedSub = '';

// ==================== 初始化 ====================
fs.mkdirSync(RUN_DIR, { recursive: true });

// 启动时清理历史残留（容器重启后上次的二进制/配置可能还在）
try { fs.readdirSync(RUN_DIR).forEach(f => {
  try { fs.unlinkSync(path.join(RUN_DIR, f)); } catch (e) {}
}); } catch (e) {}

const app = express();
app.disable('x-powered-by');

// ==================== Xray 配置（多协议：VLESS-TCP + VLESS-WS + VMess-WS + Trojan-WS） ====================
function generateConfig() {
  fs.writeFileSync(cfgPath, JSON.stringify({
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      // 主入口：VLESS-TCP，通过 fallback 将不同 path 分流到不同协议
      {
        port: ARGO_PORT,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: {
          clients: [{ id: UUID, flow: 'xtls-rprx-vision' }],
          decryption: 'none',
          fallbacks: [
            { dest: 3001 },                          // 默认回落
            { path: '/vless-argo', dest: 3002 },     // VLESS-WS
            { path: '/vmess-argo', dest: 3003 },     // VMess-WS
            { path: '/trojan-argo', dest: 3004 },    // Trojan-WS
          ],
        },
        streamSettings: { network: 'tcp' },
      },
      // 回落目标：纯 TCP VLESS
      {
        port: 3001,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: { network: 'tcp', security: 'none' },
      },
      // VLESS-WS
      {
        port: 3002,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: { clients: [{ id: UUID, level: 0 }], decryption: 'none' },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/vless-argo' } },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], metadataOnly: false },
      },
      // VMess-WS
      {
        port: 3003,
        listen: '127.0.0.1',
        protocol: 'vmess',
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: { network: 'ws', wsSettings: { path: '/vmess-argo' } },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], metadataOnly: false },
      },
      // Trojan-WS
      {
        port: 3004,
        listen: '127.0.0.1',
        protocol: 'trojan',
        settings: { clients: [{ password: UUID }] },
        streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/trojan-argo' } },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], metadataOnly: false },
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
  }));
}

// ==================== ISP 地理信息自动标注（双源回退） ====================
async function getMetaInfo() {
  // 主源：api.ip.sb
  try {
    const resp = await axios.get('https://api.ip.sb/geoip', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000,
    });
    if (resp.data && resp.data.country_code && resp.data.isp) {
      return `${resp.data.country_code}-${resp.data.isp}`.replace(/\s+/g, '_');
    }
  } catch (e) {}

  // 备源：ip-api.com
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

// ==================== 订阅（内存缓存，不留盘；多协议） ====================
function buildSub(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  const n = encodeURIComponent(nodeName);

  // VLESS-WS
  const vlessLine = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Fvless-argo%3Fed%3D2560#${n}`;

  // VMess-WS（标准 vmess 链接格式：base64 编码的 JSON）
  const vmessObj = {
    v: '2',
    ps: nodeName,
    add: CFIP,
    port: CFPORT,
    id: UUID,
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'none',
    host: host,
    path: '/vmess-argo?ed=2560',
    tls: 'tls',
    sni: host,
    alpn: '',
    fp: FP,
  };
  const vmessLine = `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`;

  // Trojan-WS
  const trojanLine = `trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Ftrojan-argo%3Fed%3D2560#${n}`;

  return [vlessLine, vmessLine, trojanLine].join('\n');
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

// ==================== 安装 ====================
async function installCore() {
  await downloadRetry([
    'https://github.com/godeluoo1/ko-vip/releases/latest/download/web-linux-amd64',
  ], webPath, 'core');
}

async function installCloudflared() {
  await downloadRetry([
    'https://github.com/godeluoo1/ko-vip/releases/latest/download/bot-linux-amd64',
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
    // 子进程挂了 → 直接退出，让平台重启容器
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
    // 修复点：改用环境变量 TUNNEL_TOKEN 隐式传递，由 cloudflared 自动读取
    return startProcess('cf', botPath, [...base, 'run'], { TUNNEL_TOKEN: ARGO_AUTH });
  }
}

// ==================== 阅后即焚（15秒后清除磁盘痕迹） ====================
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

// ==================== 主启动 ====================
async function startserver() {
  generateConfig();
  await refreshSub();   // 改为 await，因为 refreshSub 现在是异步 of（获取 ISP 信息）

  await installCore();
  startProcess('core', webPath, ['run', '-c', cfgPath]);

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
