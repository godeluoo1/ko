const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline, Transform } = require('stream');
const { WebSocket, createWebSocketStream } = require('ws');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;
const os = require('os');

// ==================== 13. V8 垃圾回收限制与 GC 参数自适应优化 ====================
const args = process.argv.slice(1);
const execArgs = process.execArgv;
if (!execArgs.includes('--expose-gc') || !execArgs.includes('--max-old-space-size=256')) {
  console.log('[gc] 未检测到 V8 GC 优化参数，正在以暴露 GC 与限制内存参数重新拉起进程...');
  const newExecArgs = [...execArgs, '--expose-gc', '--max-old-space-size=256'];
  const child = spawn(process.argv[0], [...newExecArgs, ...args], {
    stdio: 'inherit',
    env: process.env
  });
  child.on('close', code => process.exit(code));
  return; // 结束当前未优化进程的运行
}

process.title = 'npm start';

// ==================== 针对 0.2vCPU 共享 / 512MB RAM 容器的极致优化 ====================
process.env.GOMAXPROCS = '1';
process.env.GODEBUG = 'madvdontneed=1';
process.env.GOGC = '50';

// ==================== 原生极速 HTTP/HTTPS 客户端辅助库 ====================
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: options.headers || {},
      timeout: options.timeout || 5000,
      signal: options.signal
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(data) });
        } catch (e) {
          resolve({ data: data });
        }
      });
    });
    req.on('error', reject);
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Aborted'));
      });
    }
  });
}

// ==================== 环境变量初始化 ====================
let PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
let UUID = (process.env.APP_KEY || '').trim();
let ARGO_DOMAIN = (process.env.APP_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
let ARGO_AUTH = (process.env.API_TOKEN || '').trim();
const ARGO_PROTOCOL = (process.env.TUNNEL_PROTO || 'http2').toLowerCase();
const CFIP = process.env.CDN_HOST || 'saas.sin.fan';
const CFPORT = Number(process.env.CDN_PORT || 443);
const NAME = process.env.NAME || 'Vls';
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const FP = process.env.FP || 'chrome';
const EDGE_IP_VERSION = process.env.EDGE_IP_VERSION || 'auto';

// 9. 单环境变量 Base64 极简导入
if (process.env.CONFIG_BASE64) {
  try {
    const rawConfig = Buffer.from(process.env.CONFIG_BASE64, 'base64').toString('utf-8');
    const parsed = JSON.parse(rawConfig);
    if (parsed.key) UUID = parsed.key.trim();
    if (parsed.token) ARGO_AUTH = parsed.token.trim();
    if (parsed.domain) ARGO_DOMAIN = parsed.domain.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (parsed.subPath) process.env.SUB_PATH = parsed.subPath.trim();
  } catch (e) {
    console.error('[config] CONFIG_BASE64 解析失败:', e.message);
  }
}

// 15. UUID 关联衍生 WS 混淆路径 & UUID 缺失自愈
if (!UUID) {
  UUID = crypto.randomUUID();
  console.log(`[security] APP_KEY (UUID) 未设置，已自动生成安全 UUID: ${UUID}`);
}

// 若未指定 SUB_PATH，自动截取 UUID 去除连字符后的前 8 位作为 WS 连接路径
const SUB_PATH = (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '') || UUID.replace(/-/g, '').substring(0, 8);
console.log(`[config] 代理 WS 路径与服务订阅路径已确定为: /${SUB_PATH}`);

const P_VL = Buffer.from('dmxlc3M=', 'base64').toString(); // vless
const P_TR = Buffer.from('dHJvamFu', 'base64').toString(); // trojan

// ==================== 1. 宿主平台自适应 ====================
const platform = os.platform();
const isLinux = platform === 'linux';
const arch = os.arch() === 'x64' ? 'amd64' : os.arch();

// 20. Linux 内存无盘执行检测 (/dev/shm 内存虚拟盘)
const memoryDiskPath = '/dev/shm';
const useMemoryDisk = isLinux && fs.existsSync(memoryDiskPath);
const RUN_DIR = useMemoryDisk ? path.join(memoryDiskPath, `ko-${crypto.randomBytes(4).toString('hex')}`) : path.resolve(FILE_PATH);

fs.mkdirSync(RUN_DIR, { recursive: true });

// 7. 二进制重命名与进程启动参数伪装
const botPath = path.join(RUN_DIR, 'node-helper'); // 伪装为 node-helper
const tunnelJsonPath = path.join(RUN_DIR, `tun-${crypto.randomBytes(2).toString('hex')}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `tun-${crypto.randomBytes(2).toString('hex')}.yml`);

// 8. 优雅退出清理清单
const cleanupFiles = [tunnelJsonPath, tunnelYmlPath];

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

// ==================== 11. 内存阈值监控与主动 GC 节流自愈 (200MB 熔断) ====================
let lastGCTime = 0;
function throttleGC() {
  const rss = process.memoryUsage().rss;
  if (rss > 200 * 1024 * 1024) { // 内存大于 200MB 自熔断，防御平台强杀并重连
    console.error(`[security] 内存超标 (${(rss / 1024 / 1024).toFixed(2)} MB)，执行自我熔断重启...`);
    shutdown();
    return;
  }

  if (typeof global.gc === 'function') {
    const now = Date.now();
    if (now - lastGCTime > 30000) {
      try {
        global.gc();
        lastGCTime = now;
      } catch (e) {}
    }
  }
}

// 8. SIGTERM 优雅退出与磁盘零残留
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[shutdown] 接收到退出信号，正在执行磁盘零残留清理并结束子进程...');

  try { server.close(); } catch (e) {}

  const ps = [];
  for (const [, child] of managedChildren) {
    if (child && !child.killed) {
      ps.push(new Promise(r => {
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} r(); }, 4000);
        child.once('close', () => { clearTimeout(t); r(); });
        try { child.kill('SIGTERM'); } catch (e) {}
      }));
    }
  }
  await Promise.all(ps);

  // 彻底删除临时文件与二进制程序
  cleanupFiles.forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} });
  try { fs.rmSync(botPath, { force: true }); } catch (e) {}
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) {}

  console.log('[shutdown] 内存与磁盘清理完毕，进程优雅退出。');
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => {
  console.error('[fatal] 未处理的异常:', e.message);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] 未处理的 Promise 拒绝:', e.message);
  process.exit(1);
});

// ==================== 5. 动态端口检测与占用规避 ====================
function findFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(findFreePort(startPort + 1));
      } else {
        resolve(startPort);
      }
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(startPort);
      });
    });
    server.listen(startPort, '0.0.0.0');
  });
}

// ==================== Express 网关与 14. 客户端 IP 匿名化 ====================
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  delete req.headers['x-forwarded-for'];
  delete req.headers['cf-connecting-ip'];
  delete req.headers['true-client-ip'];
  delete req.headers['x-real-ip'];
  next();
});

// ==================== 10. DoH (DNS over HTTPS) 解析与 11. 测速阻断 ====================
const BLOCKED_DOMAINS = [
  'speedtest.net', 'fast.com', 'speedtest.cn', 'speed.cloudflare.com', 'speedof.me',
  'testmy.net', 'bandwidth.place', 'speed.io', 'librespeed.org', 'speedcheck.org'
];

function isBlockedDomain(host) {
  if (!host) return false;
  const hostLower = host.toLowerCase();
  return BLOCKED_DOMAINS.some(blocked => hostLower === blocked || hostLower.endsWith('.' + blocked));
}

const dnsCache = new Map();

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  if (dnsCache.has(host)) {
    const cached = dnsCache.get(host);
    if (Date.now() - cached.timestamp < 300000) {
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

  // DoH 并发应急解析
  const controller = new AbortController();
  const { signal } = controller;
  try {
    const dohQueries = [
      httpGet(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, { timeout: 3000, signal }),
      httpGet(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, { headers: { 'Accept': 'application/dns-json' }, timeout: 3000, signal })
    ];
    const response = await Promise.any(dohQueries);
    controller.abort();
    const data = response.data;
    if (data && data.Status === 0 && data.Answer && data.Answer.length > 0) {
      const aRecord = data.Answer.find(record => record.type === 1);
      if (aRecord && aRecord.data) {
        const ip = aRecord.data.trim();
        if (net.isIP(ip)) {
          dnsCache.set(host, { ip, timestamp: Date.now() });
          return ip;
        }
      }
    }
  } catch (err) {
    controller.abort();
  }

  return host;
}

async function getMetaInfoWithRace() {
  const controller = new AbortController();
  const { signal } = controller;

  const fetchSB = async () => {
    const resp = await httpGet('https://api.ip.sb/geoip', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 1500,
      signal
    });
    if (resp.data && resp.data.country_code && resp.data.isp) {
      return `${resp.data.country_code}-${resp.data.isp}`.replace(/\s+/g, '_');
    }
    throw new Error('failed');
  };

  const fetchAPI = async () => {
    const resp = await httpGet('http://ip-api.com/json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 1500,
      signal
    });
    if (resp.data && resp.data.status === 'success' && resp.data.countryCode && resp.data.org) {
      return `${resp.data.countryCode}-${resp.data.org}`.replace(/\s+/g, '_');
    }
    throw new Error('failed');
  };

  try {
    const result = await Promise.any([fetchSB(), fetchAPI()]);
    controller.abort();
    return result;
  } catch (e) {
    controller.abort();
    return 'Unknown';
  }
}

// ==================== 16. 本地多格式订阅直接生成 & 22. DNS 自防污染 ====================
function buildSub(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  const nTls = encodeURIComponent(`${nodeName}-TLS`);
  const nNoTls = encodeURIComponent(`${nodeName}-NoTLS`);

  const vlTls = `${P_VL}://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2F${SUB_PATH}%3Fed%3D2560#${nTls}`;
  const trTls = `${P_TR}://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2F${SUB_PATH}%2Dtr%3Fed%3D2560#${nTls}`;
  const vlNoTls = `${P_VL}://${UUID}@${CFIP}:80?encryption=none&security=none&type=ws&host=${host}&path=%2F${SUB_PATH}%3Fed%3D2560#${nNoTls}`;

  return [vlTls, trTls, vlNoTls].join('\n');
}

function buildCSConfig(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  return `port: 7890
socks-port: 7891
allow-lan: true
mode: rule
log-level: info
ipv6: false

dns:
  enable: true
  ipv6: false
  default-nameserver: [223.5.5.5, 119.29.29.29]
  enhanced-mode: redir-host
  nameserver: [https://dns.alidns.com/dns-query, https://cloudflare-dns.com/dns-query]

proxies:
  - name: "${nodeName}-TLS"
    type: ${P_VL}
    server: ${CFIP}
    port: ${CFPORT}
    uuid: ${UUID}
    udp: true
    tls: true
    servername: ${host}
    client-fingerprint: ${FP}
    network: ws
    ws-opts:
      path: /${SUB_PATH}
      headers:
        Host: ${host}
      max-early-data: 2560
      early-data-header-name: Sec-WebSocket-Protocol

  - name: "${nodeName}-Tr-TLS"
    type: ${P_TR}
    server: ${CFIP}
    port: ${CFPORT}
    password: ${UUID}
    udp: true
    sni: ${host}
    client-fingerprint: ${FP}
    network: ws
    ws-opts:
      path: /${SUB_PATH}-tr
      headers:
        Host: ${host}
      max-early-data: 2560
      early-data-header-name: Sec-WebSocket-Protocol

  - name: "${nodeName}-NoTLS"
    type: ${P_VL}
    server: ${CFIP}
    port: 80
    uuid: ${UUID}
    udp: true
    tls: false
    network: ws
    ws-opts:
      path: /${SUB_PATH}
      headers:
        Host: ${host}
      max-early-data: 2560
      early-data-header-name: Sec-WebSocket-Protocol

proxy-groups:
  - name: 🚀 节点选择
    type: select
    proxies:
      - "${nodeName}-TLS"
      - "${nodeName}-Tr-TLS"
      - "${nodeName}-NoTLS"
      - DIRECT

rules:
  - MATCH, 🚀 节点选择
`;
}

function buildSingBoxConfig(nodeName) {
  const host = ARGO_DOMAIN;
  return {
    "log": { "level": "info" },
    "dns": {
      "servers": [
        { "tag": "dns_direct", "address": "223.5.5.5", "detour": "direct" },
        { "tag": "dns_proxy", "address": "https://cloudflare-dns.com/dns-query", "detour": "proxy" }
      ],
      "rules": [
        { "outbound": "any", "server": "dns_direct" },
        { "query_type": [ "A", "AAAA" ], "server": "dns_proxy" }
      ]
    },
    "inbounds": [
      { "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2080 }
    ],
    "outbounds": [
      {
        "type": "selector",
        "tag": "proxy",
        "outbounds": [ `${nodeName}-VLESS`, `${nodeName}-Trojan`, "direct" ]
      },
      {
        "type": "vless",
        "tag": `${nodeName}-VLESS`,
        "server": CFIP,
        "server_port": CFPORT,
        "uuid": UUID,
        "flow": "",
        "tls": {
          "enabled": true,
          "server_name": host,
          "utls": { "enabled": true, "fingerprint": FP }
        },
        "transport": {
          "type": "ws",
          "path": `/${SUB_PATH}`,
          "headers": { "Host": host }
        }
      },
      {
        "type": "trojan",
        "tag": `${nodeName}-Trojan`,
        "server": CFIP,
        "server_port": CFPORT,
        "password": UUID,
        "tls": {
          "enabled": true,
          "server_name": host,
          "utls": { "enabled": true, "fingerprint": FP }
        },
        "transport": {
          "type": "ws",
          "path": `/${SUB_PATH}-tr`,
          "headers": { "Host": host }
        }
      },
      { "type": "direct", "tag": "direct" }
    ]
  };
}

async function getDynamicSub() {
  const now = Date.now();
  if (subCache.data && (now - subCache.timestamp < 300000)) {
    return subCache.data;
  }
  try {
    const isp = await getMetaInfoWithRace();
    const nodeName = NAME ? `${NAME}-${isp}` : isp;
    subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
    subCache.timestamp = now;
  } catch (e) {
    const nodeName = NAME ? `${NAME}-Unknown` : 'Unknown';
    subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
    subCache.timestamp = now;
  }
  return subCache.data;
}

async function refreshSubSync() {
  const now = Date.now();
  try {
    const isp = await getMetaInfoWithRace();
    const nodeName = NAME ? `${NAME}-${isp}` : isp;
    subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
    subCache.timestamp = now;
  } catch (e) {
    const nodeName = NAME ? `${NAME}-Unknown` : 'Unknown';
    subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
    subCache.timestamp = now;
  }
}

// ==================== 18. 动态反向代理网页伪装（灾备降级机制） ====================
const CAMOUFLAGE_URL = 'https://caniuse.com';
const NGINX_404 = '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx/1.27.3</center>\n</body>\n</html>\n';
const BLOG_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aiden Lin | Creative Developer</title>
  <style>
    body { background-color: #09090b; color: #f4f4f5; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: rgba(20, 20, 25, 0.6); padding: 3rem; border-radius: 15px; border: 1px solid rgba(255, 215, 0, 0.1); text-align: center; }
    h1 { color: #ffd700; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Aiden.L | Web Architect</h1>
    <p>专注于构建极速、安全与高可扩展的微服务系统。</p>
  </div>
</body>
</html>`;

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/robots.txt', (req, res) => {
  res.set('Server', 'nginx/1.27.3');
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

app.get('/', async (req, res) => {
  res.set({ 'Server': 'nginx/1.27.3' });
  try {
    const targetUrl = new URL(req.url, CAMOUFLAGE_URL).toString();
    const parsedUrl = new URL(targetUrl);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = client.request(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        host: parsedUrl.host,
        'accept-encoding': 'identity'
      }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      res.set({ 'Content-Type': 'text/html; charset=utf-8' });
      res.send(BLOG_HTML);
    });
    req.pipe(proxyReq);
  } catch (err) {
    res.set({ 'Content-Type': 'text/html; charset=utf-8' });
    res.send(BLOG_HTML);
  }
});

// 订阅服务路由（自动分发 Clash YAML / SingBox JSON 格式）
app.get(`/${SUB_PATH}-sub`, async (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const subType = (req.query.type || '').toLowerCase();
  const isClient = subType === 'singbox' || subType === 'clash' || Buffer.from('c2hhZG93cm9ja2V0LHYycmF5LGNsYXNoLG5la28sc2luZy1ib3gscXVhbnR1bXVsdCxzdXJnZSxzdGFzaCxsb29uLG5zc3Vi', 'base64').toString().split(',').some(c => ua.includes(c));

  if (!isClient) {
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Server': 'nginx/1.27.3' });
    res.status(404).send(NGINX_404);
    return;
  }

  try {
    const isp = await getMetaInfoWithRace();
    const nodeName = NAME ? `${NAME}-${isp}` : isp;

    if (subType === 'singbox' || ua.includes('sing-box')) {
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Server': 'nginx/1.27.3' });
      res.send(JSON.stringify(buildSingBoxConfig(nodeName), null, 2));
    } else if (subType === 'clash' || ['clash', 'mihomo', 'stash'].some(c => ua.includes(c))) {
      res.set({
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Disposition': `attachment; filename="clash.yaml"`,
        'Server': 'nginx/1.27.3'
      });
      res.send(buildCSConfig(nodeName));
    } else {
      const subData = await getDynamicSub();
      res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Server': 'nginx/1.27.3' });
      res.send(subData);
    }
  } catch (err) {
    res.status(503).send('not ready');
  }
});

// ==================== 主动探测伪装阻断 ====================
function rejectConnection(ws) {
  const delay = 150 + Math.floor(Math.random() * 450);
  setTimeout(() => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nServer: nginx/1.27.3\r\n\r\n" + BLOG_HTML));
        ws.close();
      }
    } catch (e) {}
    throttleGC();
  }, delay);
}

// ==================== 19. 流量包长度随机化填充（指纹干扰） ====================
class FragmentTransform extends Transform {
  _transform(chunk, encoding, callback) {
    let pos = 0;
    while (pos < chunk.length) {
      const size = 150 + Math.floor(Math.random() * 1150);
      this.push(chunk.slice(pos, pos + size));
      pos += size;
    }
    callback();
  }
}

// ==================== 原生协议解析核心 ====================
const UUID_BUFFER = Buffer.from(UUID.replace(/-/g, ""), "hex");
const TROJAN_HASH = crypto.createHash('sha224').update(UUID).digest('hex');

function hVl(ws, msg) {
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
          // 21. Node.js 异步流回压控制 (基于 pipeline)
          pipeline(duplex, new FragmentTransform(), this, () => {});
          pipeline(this, new FragmentTransform(), duplex, () => {});
        }).on('error', () => { ws.close(); });
      })
      .catch(() => {
        net.connect({ host, port }, function () {
          this.write(msg.slice(i));
          pipeline(duplex, new FragmentTransform(), this, () => {});
          pipeline(this, new FragmentTransform(), duplex, () => {});
        }).on('error', () => { ws.close(); });
      });
  } catch (err) {
    ws.close();
  }
}

function hVlU(ws, initialMsg, offset, host, port) {
  try {
    if (isBlockedDomain(host) || port === 53) {
      ws.close();
      return;
    }

    ws.send(new Uint8Array([0, 0]));

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

function hTr(ws, msg) {
  try {
    const receivedPasswordHash = msg.slice(0, 56).toString();
    if (receivedPasswordHash !== TROJAN_HASH) {
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
          pipeline(duplex, new FragmentTransform(), this, () => {});
          pipeline(this, new FragmentTransform(), duplex, () => {});
        }).on('error', () => { ws.close(); });
      })
      .catch(() => {
        net.connect({ host, port }, function () {
          if (offset < msg.length) {
            this.write(msg.slice(offset));
          }
          pipeline(duplex, new FragmentTransform(), this, () => {});
          pipeline(this, new FragmentTransform(), duplex, () => {});
        }).on('error', () => { ws.close(); });
      });
  } catch (err) {
    ws.close();
  }
}

// ==================== 17. 单端口全服务复用 (合并 Express & WS) ====================
const server = http.createServer(app);

// 12. HTTP 服务连接超时限制 (防御 Slowloris DDoS)
server.headersTimeout = 30000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 30000;

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const urlPath = req.url.split('?')[0];
  if ([`/${SUB_PATH}`, `/${SUB_PATH}-tr`].includes(urlPath)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const urlPath = req.url.split('?')[0];
  let accumulated = Buffer.alloc(0);
  let resolvedHeader = false;

  // 23. WebSocket 连接握手 3 秒硬超时保护
  const handshakeTimer = setTimeout(() => {
    if (!resolvedHeader) {
      ws.off('message', onMessage);
      rejectConnection(ws);
    }
  }, 3000);

  // 解析 WebSocket Early Data (0-RTT)
  const protocolHeader = req.headers['sec-websocket-protocol'];
  if (protocolHeader) {
    try {
      const protocols = protocolHeader.split(',').map(p => p.trim());
      const target = protocols[0];
      if (target && target !== 'vless' && target !== 'trojan') {
        let base64Str = target.replace(/-/g, '+').replace(/_/g, '/');
        while (base64Str.length % 4) base64Str += '=';
        const earlyData = Buffer.from(base64Str, 'base64');
        if (earlyData.length > 0) {
          accumulated = Buffer.concat([earlyData, accumulated]);
        }
      }
    } catch (e) {}
  }

  const parseHeader = () => {
    if (resolvedHeader) return;
    try {
      if (urlPath === `/${SUB_PATH}`) {
        if (accumulated.length < 18) return;
        const addonsLen = accumulated[17];
        const headerMin = 22 + addonsLen;
        if (accumulated.length < headerMin) return;

        const cmd = accumulated[18 + addonsLen];
        const atyp = accumulated[headerMin - 1];
        let fullHeaderLen = headerMin;

        if (atyp === 1) fullHeaderLen += 4;
        else if (atyp === 2) {
          if (accumulated.length < headerMin + 1) return;
          fullHeaderLen += 1 + accumulated[headerMin];
        } else if (atyp === 3) fullHeaderLen += 16;
        else {
          ws.off('message', onMessage);
          rejectConnection(ws);
          return;
        }

        if (accumulated.length < fullHeaderLen) return;

        resolvedHeader = true;
        clearTimeout(handshakeTimer);
        ws.off('message', onMessage);

        const id = accumulated.slice(1, 17);
        if (!id.equals(UUID_BUFFER)) {
          rejectConnection(ws);
          return;
        }

        let i = addonsLen + 19;
        const port = accumulated.slice(i, i += 2).readUInt16BE(0);
        const ATYP = accumulated.slice(i, i += 1).readUInt8();
        const host = ATYP == 1 ? accumulated.slice(i, i += 4).join('.') :
          (ATYP == 2 ? new TextDecoder().decode(accumulated.slice(i + 1, i += 1 + accumulated.slice(i, i + 1).readUInt8())) :
            (ATYP == 3 ? accumulated.slice(i, i += 16).reduce((s, b, i, a) => (i % 2 ? s.concat(a.slice(i - 1, i + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));

        if (cmd !== 0x01 && cmd !== 0x02) {
          ws.close();
          return;
        }

        if (cmd === 0x02) hVlU(ws, accumulated, i, host, port);
        else hVl(ws, accumulated);
      }
      else if (urlPath === `/${SUB_PATH}-tr`) {
        if (accumulated.length < 58) return;
        let offset = 56;
        if (accumulated[offset] === 0x0d && accumulated[offset + 1] === 0x0a) offset += 2;
        if (accumulated.length < offset + 2) return;

        const cmd = accumulated[offset];
        const atyp = accumulated[offset + 1];
        offset += 2;

        let fullLen = offset;
        if (atyp === 0x01) fullLen += 6;
        else if (atyp === 0x03) {
          if (accumulated.length < offset + 1) return;
          fullLen += 1 + accumulated[offset] + 2;
        } else if (atyp === 0x04) fullLen += 18;
        else {
          ws.off('message', onMessage);
          rejectConnection(ws);
          return;
        }

        if (accumulated.length < fullLen) return;

        resolvedHeader = true;
        clearTimeout(handshakeTimer);
        ws.off('message', onMessage);

        hTr(ws, accumulated);
      } else {
        ws.off('message', onMessage);
        rejectConnection(ws);
      }
    } catch (err) {
      ws.off('message', onMessage);
      rejectConnection(ws);
    }
  };

  const onMessage = msg => {
    if (resolvedHeader) return;
    accumulated = Buffer.concat([accumulated, msg]);
    parseHeader();
  };

  ws.on('message', onMessage);
  if (accumulated.length > 0) parseHeader();

  ws.on('close', () => {
    ws.off('message', onMessage);
    throttleGC();
  });
});

// ==================== 下载 ====================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': UA }, timeout: 120000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Status Code: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

let cloudflaredBuffer = null;

async function installCloudflared() {
  if (cloudflaredBuffer) return;
  const vipArch = arch === 'arm64' ? 'arm64' : 'amd64';
  const urls = [
    `https://github.com/godeluoo1/ko-vip/releases/latest/download/bot-linux-${vipArch}`,
    `https://mirror.ghproxy.com/https://github.com/godeluoo1/ko-vip/releases/latest/download/bot-linux-${vipArch}`,
    `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
    `https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`
  ];

  for (let i = 0; i < urls.length; i++) {
    try {
      cloudflaredBuffer = await downloadToBuffer(urls[i]);
      console.log(`[cf] 二进制数据成功下载至内存，缓存大小: ${cloudflaredBuffer.length} 字节。`);
      return;
    } catch (e) {
      console.error(`[cf] 下载源 ${urls[i]} 失败，切换重试...`);
    }
  }
  throw new Error('cloudflared: 所有的二进制下载源均失败');
}

// ==================== 20. Linux 内存无盘执行 (memfd_create RAM Execution) ====================
function startProcess(label, args, extraEnv = {}) {
  let child;
  const combinedEnv = { ...process.env, ...extraEnv };

  // 检测宿主 Python3 是否可用以及是否具有 memfd_create 系统调用
  const hasPythonMemfd = (() => {
    try {
      require('child_process').execSync('python3 -c "import os; hasattr(os, \\"memfd_create\\")"', { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  })();

  if (isLinux && hasPythonMemfd && cloudflaredBuffer) {
    console.log('[cf] Linux 环境且支持 memfd_create，启动 RAM 内存匿名描述符无盘执行模式 (fexecve 仿制)...');

    // 通过 Python 执行，将 stdin 里的二进制流读入 memfd_create 并 execve 执行
    const pyScript = `import os, sys
fd = os.memfd_create("node-helper")
os.write(fd, sys.stdin.buffer.read())
os.execve(f"/proc/self/fd/{fd}", ["node-helper"] + sys.argv[1:], os.environ)
`;
    child = spawn('python3', ['-c', pyScript, ...args], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: combinedEnv,
      detached: true
    });

    // 写入内存中的二进制数据到管道
    child.stdin.write(cloudflaredBuffer);
    child.stdin.end();
  } else {
    // 降级回退到 /dev/shm 内存虚拟盘执行（或正常磁盘临时运行）
    console.log('[cf] 降级至内存虚拟盘 /dev/shm 或本地临时目录执行...');
    try {
      fs.writeFileSync(botPath, cloudflaredBuffer);
      fs.chmodSync(botPath, 0o755);
    } catch (e) {
      console.error('[cf] 二进制写入内存虚拟盘失败，尝试写入本地磁盘临时目录:', e.message);
    }

    child = spawn(botPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: combinedEnv,
      detached: true
    });
    child.unref();

    // 运行期二进制阅后即焚 (Unlink on Spawn) —— 启动 10 秒后强制物理销毁物理文件，防止静态扫描
    setTimeout(() => {
      try {
        if (fs.existsSync(botPath)) {
          fs.unlinkSync(botPath);
          console.log('[cf] 运行期二进制阅后即焚：已安全擦除磁盘物理文件 cf-bin。');
        }
      } catch (e) {
        console.warn('[cf] 物理文件销毁异常:', e.message);
      }
    }, 10000);
  }

  child.stderr && child.stderr.on('data', d => {
    const msg = d.toString();
    console.error(`[${label}]`, msg.trim());

    // 10. 临时隧道动态域名自动提取并写入内存订阅 (trycloudflare 动态正则抓取)
    const match = msg.match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/);
    if (match && match[1]) {
      ARGO_DOMAIN = match[1];
      console.log(`[cf] 动态 Quick Tunnel 域名自动提取成功: ${ARGO_DOMAIN}`);
      refreshSubSync().catch(() => {});
    }
  });

  child.unref();
  if (label === 'cf') {
    scheduleUnlink();
  }

  managedChildren.set(label, child);
  child.on('error', () => managedChildren.delete(label));
  child.on('close', (code) => {
    managedChildren.delete(label);
    if (isShuttingDown) return;
    if (label === 'cf') {
      console.error(`[cf] Argo Tunnel 异常退出 (Code: ${code})，10秒后自愈重试...`);
      setTimeout(() => {
        if (!isShuttingDown) {
          startCloudflared().catch(() => {});
        }
      }, 10000);
    } else {
      process.exit(1);
    }
  });
  return child;
}

// 阅后即焚：成功启动 30 秒后删除磁盘文件并清空内存缓存
let cleanupTimer = null;
function scheduleUnlink() {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    try {
      if (fs.existsSync(botPath)) {
        fs.unlinkSync(botPath);
        console.log('[cf] 运行期文件销毁成功，磁盘无残留。');
      }
    } catch (e) {
      console.error('[cf] 运行期文件销毁失败:', e.message);
    }
    if (cloudflaredBuffer) {
      cloudflaredBuffer = null;
      console.log('[cf] 运行期内存二进制缓存已清空。');
      if (global.gc) {
        try { global.gc(); } catch (e) {}
      }
    }
  }, 30000);
}

async function startCloudflared() {
  try {
    await installCloudflared();
  } catch (e) {
    console.error('[cf] 二进制下载失败，10秒后重试:', e.message);
    setTimeout(() => {
      if (!isShuttingDown) startCloudflared().catch(() => {});
    }, 10000);
    return;
  }

  const base = ['tunnel', '--edge-ip-version', EDGE_IP_VERSION, '--no-autoupdate', '--loglevel', 'fatal', '--protocol', ARGO_PROTOCOL];

  if (tunnelMode === 'json') {
    const creds = JSON.parse(ARGO_AUTH);
    const tid = creds.TunnelID || creds.tunnel_id || creds.TunnelName || creds.tunnel_name;
    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);
    fs.writeFileSync(tunnelYmlPath, [
      `tunnel: ${tid}`, `credentials-file: ${tunnelJsonPath}`, `protocol: ${ARGO_PROTOCOL}`,
      'ingress:', `  - hostname: ${ARGO_DOMAIN}`, `    service: http://127.0.0.1:${PORT}`, '  - service: http_status:404',
    ].join('\n'));
    return startProcess('cf', [...base, '--config', tunnelYmlPath, 'run']);
  }

  if (tunnelMode === 'token') {
    // 7. 二进制参数隐蔽伪装，通过环境变量传递 token，防 ps -aux 嗅探
    return startProcess('cf', [...base, 'run'], { TUNNEL_TOKEN: ARGO_AUTH });
  }
}

async function autoConfigureArgoTunnel() {
  if (ARGO_AUTH.includes('TunnelSecret') || ARGO_AUTH.length > 100) return;

  if (ARGO_AUTH.length >= 30 && ARGO_AUTH.length <= 60) {
    console.log('[cf] 启动 Cloudflare API 自动配置与 DNS CNAME 记录托管绑定...');
    try {
      const tunnelName = ARGO_DOMAIN.split('.')[0];
      const rootDomain = ARGO_DOMAIN.substring(tunnelName.length + 1);

      const cfRequest = (method, path, body = null) => {
        return new Promise((resolve, reject) => {
          const data = body ? JSON.stringify(body) : '';
          const req = https.request({
            hostname: 'api.cloudflare.com',
            port: 443,
            path: '/client/v4' + path,
            method: method,
            headers: {
              'Authorization': `Bearer ${ARGO_AUTH}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data)
            },
            timeout: 15000
          }, (res) => {
            let resData = '';
            res.on('data', chunk => resData += chunk);
            res.on('end', () => {
              try { resolve({ data: JSON.parse(resData) }); } catch (e) { resolve({ data: resData }); }
            });
          });
          req.on('error', reject);
          if (body) req.write(data);
          req.end();
        });
      };

      const zoneRes = await cfRequest('GET', `/zones?name=${rootDomain}`);
      if (!zoneRes.data || !zoneRes.data.result || zoneRes.data.result.length === 0) {
        throw new Error(`未找到根域名 ${rootDomain} 对应的 Zone ID`);
      }
      const zoneId = zoneRes.data.result[0].id;
      const accountId = zoneRes.data.result[0].account.id;

      const tunnelListRes = await cfRequest('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
      const tunnels = tunnelListRes.data.result || [];
      const existingTunnel = tunnels.find(t => t.name === tunnelName);

      let tunnelId = '';
      let realToken = '';

      if (existingTunnel) {
        tunnelId = existingTunnel.id;
        const tokenRes = await cfRequest('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
        realToken = tokenRes.data.result;
      } else {
        const tunnelSecret = crypto.randomBytes(32).toString('base64');
        const createRes = await cfRequest('POST', `/accounts/${accountId}/cfd_tunnel`, {
          name: tunnelName,
          config_src: 'cloudflare',
          tunnel_secret: tunnelSecret
        });
        tunnelId = createRes.data.result.id;
        realToken = createRes.data.result.token;
      }

      // 17. 单端口合并分流，全域名 Ingress 简化路由
      await cfRequest('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: {
          ingress: [
            { hostname: ARGO_DOMAIN, service: `http://127.0.0.1:${PORT}` },
            { service: 'http_status:404' }
          ]
        }
      });

      const dnsListRes = await cfRequest('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${ARGO_DOMAIN}`);
      const dnsRecords = dnsListRes.data.result || [];
      const existingDns = dnsRecords[0];
      const dnsPayload = {
        name: ARGO_DOMAIN,
        type: 'CNAME',
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true
      };

      if (existingDns) {
        if (existingDns.content !== `${tunnelId}.cfargotunnel.com`) {
          await cfRequest('PATCH', `/zones/${zoneId}/dns_records/${existingDns.id}`, dnsPayload);
        }
      } else {
        await cfRequest('POST', `/zones/${zoneId}/dns_records`, dnsPayload);
      }

      if (realToken) {
        ARGO_AUTH = realToken;
        tunnelMode = 'token';
        console.log('[cf] Cloudflare API 自动配置与 DNS CNAME 成功托管！');
      }
    } catch (e) {
      console.error('[cf] API 自动接管配置失败，回退为手动或 Quick 隧道模式:', e.message);
    }
  }
}

function scheduleCleanup() {
  setTimeout(() => {
    cleanupFiles.forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} });
  }, 15000);
}

// ==================== 主启动服务 ====================
async function startserver() {
  // 5. 动态端口检测与占用规避
  PORT = await findFreePort(PORT);
  console.log(`[startup] 动态侦测绑定端口已确定为: ${PORT}`);

  try {
    await refreshSubSync();
  } catch (e) {}

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[INFO] 原生单端口服务合并成功。网关与 Websocket 服务已在端口 ${PORT} 上线运行。`);
  });

  await autoConfigureArgoTunnel();

  try {
    if (process.env.NO_ARGO !== '1') {
      await startCloudflared();
    } else {
      console.log('[cf] 检测到 NO_ARGO=1，已跳过 Argo 隧道拉起。');
    }
  } catch (e) {
    console.error('[startup] 隧道启动异常:', e.message);
  }

  scheduleCleanup();
}

startserver().catch(e => { console.error('[startup] 启动异常:', e.message); process.exit(1); });

// ==================== 4. 随机化内部防休眠自保活 & 6. 冷启动保活延迟 ====================
const KEEP_ALIVE_PATHS = ['/', '/robots.txt', `/${SUB_PATH}-sub`];

setTimeout(() => {
  (function keepAlive() {
    const lo = 4 * 60000, hi = 8 * 60000;
    (function tick() {
      setTimeout(() => {
        if (isShuttingDown) return;
        const randomPath = KEEP_ALIVE_PATHS[Math.floor(Math.random() * KEEP_ALIVE_PATHS.length)];
        http.get(`http://127.0.0.1:${PORT}${randomPath}`, r => r.resume()).on('error', () => {});
        tick();
      }, lo + Math.floor(Math.random() * (hi - lo)));
    })();
  })();
}, 10000); // 冷启动异步延迟 10 秒后执行保活，防止开机瞬间触发系统网络安全规则
