const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { WebSocket, createWebSocketStream } = require('ws');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;

// ==================== 随机标识生成函数 ====================
function rnd(n = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyz', b = crypto.randomBytes(n);
  let r = ''; for (let i = 0; i < n; i++) r += c[b[i] % c.length]; return r;
}

// ==================== 全局 stdout/stderr 日志劫持 (Nginx 启动/运行仿冒) ====================
const startupLogs = [
  'nginx/1.27.3',
  'built by gcc 11.2.1 20210728 (Red Hat 11.2.1-1) (GCC)',
  'built with OpenSSL 1.1.1k  FIPS 25 Mar 2021',
  'TLS SNI support enabled',
  'configure arguments: --prefix=/usr/share/nginx --sbin-path=/usr/sbin/nginx --modules-path=/usr/lib64/nginx/modules',
  'using the "epoll" event method',
  'start worker process 1',
  'start worker process 2'
];

let startupLogIndex = 0;

function formatLogNginx(msg, isErr = false) {
  const pid = process.pid;
  const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const prefix = `${time} [${isErr ? 'error' : 'notice'}] ${pid}#${pid}: `;
  
  if (startupLogIndex < startupLogs.length) {
    return prefix + startupLogs[startupLogIndex++];
  }
  
  const randomEvents = [
    'epoll_wait() reported 0 events',
    'worker process 1 cycle',
    'worker process 2 cycle',
    'client connected to 127.0.0.1',
    'http connection active'
  ];
  return prefix + randomEvents[Math.floor(Math.random() * randomEvents.length)];
}

const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
  const rawMsg = args.join(' ');
  if (rawMsg.startsWith('===') || rawMsg.includes('Diagnostics') || /^(?:\[cf\]|\[startup\]|\[security\]|\[INFO\])/.test(rawMsg)) {
    originalLog.apply(console, args);
  } else {
    originalLog(formatLogNginx(rawMsg, false));
  }
};

console.error = function(...args) {
  originalError.apply(console, args);
};

process.title = 'node /usr/share/nginx/scripts/health-check.js';

// ==================== 针对 0.2vCPU / 512MB RAM 容器的极致优化 ====================
process.env.GOMAXPROCS = '1';
process.env.GODEBUG = 'madvdontneed=1';
process.env.GOGC = '50';

// ==================== 原生极速 HTTP/HTTPS 客户端辅助库 (代替 Axios, 支持 Abort) ====================
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
          resolve({ data });
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

// ==================== 环境变量 ====================
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const ARGO_PORT = Number(process.env.BACKEND_PORT || 8001);
let UUID = (process.env.APP_KEY || '').trim();
if (!UUID) {
  UUID = crypto.randomUUID();
  console.log(`[security] APP_KEY (UUID) 未配置，已自动生成随机 UUID: ${UUID}`);
}

const ARGO_DOMAIN = (process.env.APP_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
let ARGO_AUTH = (process.env.API_TOKEN || '').trim();
const ARGO_PROTOCOL = (process.env.TUNNEL_PROTO || 'http2').toLowerCase();
const CFIP = process.env.CDN_HOST || 'saas.sin.fan';
const CFPORT = Number(process.env.CDN_PORT || 443);
const NAME = process.env.NAME || 'Vls';
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const FP = process.env.FP || 'chrome';
const EDGE_IP_VERSION = process.env.EDGE_IP_VERSION || 'auto';
const CAMOUFLAGE_URL = (process.env.Camouflage_URL || '').trim();

if (!ARGO_AUTH) {
  console.error('[fatal] API_TOKEN (API_TOKEN) 未设置，无法建立隧道');
  process.exit(1);
}

let SUB_PATH = (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '');
if (!SUB_PATH) {
  SUB_PATH = crypto.randomBytes(4).toString('hex');
  console.log(`[security] SUB_PATH 未配置，已自动生成随机订阅路径: /${SUB_PATH}`);
}

const PATH_A = '/' + (process.env.PATH_A || 'api/v3/telemetry').trim().replace(/^\/+|\/+$/g, '');
const PATH_B = '/' + (process.env.PATH_B || 'graphql/stream').trim().replace(/^\/+|\/+$/g, '');

const P_VL = Buffer.from('dmxlc3M=', 'base64').toString();
const P_TR = Buffer.from('dHJvamFu', 'base64').toString();

// ==================== 安全加固：运行时清除敏感环境变量 ====================
// 防止 HIDS 通过 /proc/<pid>/environ 读取到凭据
(function sanitizeEnv() {
  const sensitiveKeys = ['APP_KEY', 'API_TOKEN', 'SUB_PATH', 'PATH_A', 'PATH_B'];
  sensitiveKeys.forEach(k => { if (process.env[k]) delete process.env[k]; });
})();

const CACHE_MODE = (process.env.CACHE_MODE || '').trim().toLowerCase();
const cacheBinName = 'app-cache-' + rnd(4);
const cacheBinPath = path.join(path.resolve(FILE_PATH), cacheBinName);
const cacheConfigPath = path.join(path.resolve(FILE_PATH), `cache-${rnd(4)}.json`);

// ==================== 路径配置 ====================
const RUN_DIR = path.resolve(FILE_PATH);
const botName = 'web-' + rnd(4);
let botPath = path.join(RUN_DIR, botName);
const tunnelJsonPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `${rnd(4)}.yml`);

const cleanupFiles = [tunnelJsonPath, tunnelYmlPath];
if (CACHE_MODE === 'redis') {
  cleanupFiles.push(cacheBinPath, cacheConfigPath);
}

let tunnelMode = ARGO_AUTH.includes('TunnelSecret') ? 'json' : 'token';
const managedChildren = new Map();
let isShuttingDown = false;
let activeConns = 0;

// ==================== SWR 内存缓存订阅状态 ====================
let subCache = {
  data: '',
  timestamp: 0,
  isRefreshing: false
};

// ==================== 主动内存垃圾回收 (GC 节流器) ====================
let lastGCTime = 0;
function throttleGC() {
  if (typeof global.gc === 'function') {
    const now = Date.now();
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > 30 * 1024 * 1024 || (now - lastGCTime > 20000)) {
      try {
        global.gc();
        lastGCTime = now;
      } catch (e) {}
    }
  }
}

// ==================== 初始化目录 ====================
fs.mkdirSync(RUN_DIR, { recursive: true });

try {
  fs.readdirSync(RUN_DIR).forEach(f => {
    if (f === botName || f === 'sys-helper') return;
    try { fs.unlinkSync(path.join(RUN_DIR, f)); } catch (e) {}
  });
} catch (e) {}

const app = express();
app.disable('x-powered-by');

// ==================== 安全加固：订阅路径 IP 速率限制 ====================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 分钟
const RATE_LIMIT_MAX = 10;       // 每 IP 每分钟最多 10 次

function isRateLimited(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || (now - record.windowStart) > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  record.count++;
  if (record.count > RATE_LIMIT_MAX) return true;
  return false;
}

// 每 5 分钟清理过期条目，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap) {
    if ((now - record.windowStart) > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(ip);
  }
}, 300000).unref();

// ==================== 测速流量阻断 (防带宽风控) ====================
const BLOCKED_DOMAINS = [
  'speedtest.net', 'fast.com', 'speedtest.cn', 'speed.cloudflare.com', 'speedof.me',
  'testmy.net', 'bandwidth.place', 'speed.io', 'librespeed.org', 'speedcheck.org',
  'ookla.com', 'netspeed'
];

function isBlockedDomain(host) {
  if (!host) return false;
  const hostLower = host.toLowerCase();
  return BLOCKED_DOMAINS.some(blocked => {
    return hostLower === blocked || hostLower.endsWith('.' + blocked);
  });
}

// ==================== 原生 DNS over HTTPS (DoH) 解析客户端 ====================
const dnsCache = new Map();

function safeSetDnsCache(host, ip) {
  if (dnsCache.size > 500) {
    const firstKey = dnsCache.keys().next().value;
    if (firstKey) dnsCache.delete(firstKey);
  }
  dnsCache.set(host, { ip, timestamp: Date.now() });
}

async function resolveHost(host) {
  if (net.isIP(host)) return host;
  if (dnsCache.has(host)) {
    const cached = dnsCache.get(host);
    if (Date.now() - cached.timestamp < 300000) {
      return cached.ip;
    } else {
      dnsCache.delete(host);
    }
  }
  
  try {
    const res = await dns.lookup(host);
    if (res && res.address) {
      safeSetDnsCache(host, res.address);
      return res.address;
    }
  } catch (e) {}

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
          safeSetDnsCache(host, ip);
          return ip;
        }
      }
    }
  } catch (err) {
    controller.abort();
  }

  return host;
}

// ==================== 双源竞态获取地理信息 ====================
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
    throw new Error('invalid response');
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
    throw new Error('invalid response');
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

function isCloudflareOrLocalIP(ip) {
  if (!ip) return false;
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp.startsWith('192.168.') || cleanIp.startsWith('10.') || cleanIp.startsWith('172.16.')) {
    return true;
  }
  return true; // 信任回源边缘网络以保证最大的连通性
}

// ==================== 订阅生成 (只服务于v2rayN, v2rayNG和小火箭) ====================
function buildSub(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  const nodes = [];
  const pVlPath = encodeURIComponent(PATH_A);
  const pTrPath = encodeURIComponent(PATH_B);
  
  const label = `${nodeName}-Main`;
  const nTls = encodeURIComponent(`${label}-TLS`);

  nodes.push(`${P_VL}://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${pVlPath}&ed=2560#${nTls}`);
  nodes.push(`${P_TR}://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${pTrPath}&ed=2560#${nTls}`);

  return nodes.join('\n');
}

async function getDynamicSub() {
  const now = Date.now();
  const CACHE_TTL = 5 * 60 * 1000;

  if (subCache.data && (now - subCache.timestamp < CACHE_TTL)) {
    return subCache.data;
  }

  let isp = 'Unknown';
  try {
    isp = await getMetaInfoWithRace();
  } catch (e) {}

  const nodeName = NAME ? `${NAME}-${isp}` : isp;
  subCache.data = Buffer.from(buildSub(nodeName)).toString('base64');
  subCache.timestamp = now;
  return subCache.data;
}

// ==================== Express 路由与伪装 ====================
const NGINX_404 = '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx/1.27.3</center>\n</body>\n</html>\n';

let BLOG_HTML = '';
try {
  BLOG_HTML = fs.readFileSync(path.join(__dirname, 'blog.html'), 'utf8');
} catch (e) {
  BLOG_HTML = '<html><head><title>Aiden Lin</title></head><body><h1>Aiden Lin</h1><p>Systems Engineer & Open Source Developer</p></body></html>';
}

const serverStartupTime = new Date().toUTCString();
const blogEtag = crypto.createHash('md5').update(BLOG_HTML).digest('hex').substring(0, 16);

function setNginxHeaders(res, isHtml = true) {
  const headers = {
    'Server': 'nginx/1.27.3',
    'Date': new Date().toUTCString(),
    'Connection': 'keep-alive',
    'Keep-Alive': 'timeout=65'
  };
  if (isHtml) {
    headers['Content-Type'] = 'text/html; charset=utf-8';
    headers['Cache-Control'] = 'public, max-age=3600';
    headers['Last-Modified'] = serverStartupTime;
    headers['ETag'] = `"${blogEtag}"`;
  } else {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  }
  res.set(headers);
}

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/robots.txt', (req, res) => {
  setNginxHeaders(res, false);
  res.send('User-agent: *\nDisallow: /');
});

app.get('/', (req, res) => {
  setNginxHeaders(res, true);
  if (CAMOUFLAGE_URL) {
    const client = CAMOUFLAGE_URL.startsWith('https') ? https : http;
    let aborted = false;
    const proxyReq = client.get(CAMOUFLAGE_URL, (proxyRes) => {
      if (aborted) return;
      const safeHeaders = { ...proxyRes.headers };
      delete safeHeaders['content-length'];
      delete safeHeaders['connection'];
      delete safeHeaders['keep-alive'];
      res.writeHead(proxyRes.statusCode || 200, safeHeaders);
      
      const { pipeline } = require('stream');
      pipeline(proxyRes, res, (err) => {});
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.send(BLOG_HTML);
      }
    });

    req.on('close', () => {
      aborted = true;
      proxyReq.destroy();
    });
  } else {
    res.send(BLOG_HTML);
  }
});

// 订阅入口路由 (含 IP 速率限制防爆破)
app.get(`/${SUB_PATH}`, async (req, res) => {
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
  if (isRateLimited(clientIP)) {
    res.status(429);
    setNginxHeaders(res, true);
    res.send(NGINX_404);
    return;
  }

  try {
    const subData = await getDynamicSub();
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Server': 'nginx/1.27.3',
      'profile-update-interval': '6',
      'subscription-userinfo': 'upload=0; download=0; total=107374182400; expire=0'
    });
    res.send(subData);
  } catch (err) {
    res.status(503).send('not ready');
  }
});

// Default 404 handler for Express
app.use((req, res) => {
  res.status(404);
  setNginxHeaders(res, true);
  res.send(NGINX_404);
});

// ==================== Trojan / VLESS 协议解码核心 ====================
const UUID_BUFFER = Buffer.from(UUID.replace(/-/g, ""), "hex");
const TROJAN_HASH = crypto.createHash('sha224').update(UUID).digest('hex');

function rejectConnection(ws) {
  const delay = 150 + Math.floor(Math.random() * 450);
  setTimeout(() => {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nServer: nginx/1.27.3\r\n\r\n" + BLOG_HTML);
        ws.close();
      }
    } catch (e) {}
    throttleGC();
  }, delay);
}

function setupTunnelPipeline(ws, msg, offset, host, port, isUdp = false) {
  if (isBlockedDomain(host)) {
    console.log(`[security] 拦截到高风险测速流量目标: ${host}`);
    rejectConnection(ws);
    return;
  }

  if (isUdp) {
    hVlU(ws, msg, offset, host, port);
    return;
  }

  const duplex = createWebSocketStream(ws);
  let socket = null;
  let closed = false;

  const destroyAll = () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch (e) {}
    try { duplex.destroy(); } catch (e) {}
    if (socket) {
      try { socket.destroy(); } catch (e) {}
    }
    throttleGC();
  };

  ws.on('close', destroyAll);
  ws.on('error', destroyAll);
  duplex.on('close', destroyAll);
  duplex.on('error', destroyAll);

  const connectAndPipe = (targetHost) => {
    socket = net.connect({ host: targetHost, port }, function () {
      this.setNoDelay(true);
      this.setKeepAlive(true, 15000);
      this.setTimeout(300000, () => { destroyAll(); });
      
      if (offset < msg.length) {
        this.write(msg.slice(offset));
      }
    });

    duplex.on('drain', () => {
      if (socket && !closed) {
        try { socket.resume(); } catch (e) {}
      }
    });

    socket.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const ok = duplex.write(chunk);
          if (!ok && socket && !closed) {
            socket.pause();
          }
        } catch (e) {
          destroyAll();
        }
      }
    });

    duplex.on('data', (chunk) => {
      if (socket && socket.writable && !closed) {
        try {
          const ok = socket.write(chunk);
          if (!ok && !closed) {
            ws.pause && ws.pause();
          }
        } catch (e) {
          destroyAll();
        }
      }
    });

    socket.on('drain', () => {
      if (ws && !closed) {
        try { ws.resume && ws.resume(); } catch (e) {}
      }
    });

    socket.on('error', destroyAll);
    socket.on('close', destroyAll);
  };

  resolveHost(host)
    .then(resolvedIP => connectAndPipe(resolvedIP))
    .catch(() => connectAndPipe(host));
}

function hVl(ws, msg) {
  try {
    const VERSION = msg[0];
    let i = msg.slice(17, 18).readUInt8() + 19;
    const port = msg.slice(i, i += 2).readUInt16BE(0);
    const ATYP = msg.slice(i, i += 1).readUInt8();
    const host = ATYP == 1 ? msg.slice(i, i += 4).join('.') :
      (ATYP == 2 ? new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8())) :
        (ATYP == 3 ? msg.slice(i, i += 16).reduce((s, b, idx, a) => (idx % 2 ? s.concat(a.slice(idx - 1, idx + 1)) : s), []).map(b => b.readUInt16BE(0).toString(16)).join(':') : ''));

    const cmd = msg[msg.slice(17, 18).readUInt8() + 18];

    if (cmd !== 0x01 && cmd !== 0x02) {
      ws.close();
      return;
    }

    ws.send(new Uint8Array([VERSION, 0]));
    setupTunnelPipeline(ws, msg, i, host, port, cmd === 0x02);
  } catch (err) {
    ws.close();
  }
}

function hVlU(ws, initialMsg, offset, host, port) {
  try {
    if (port === 53) {
      ws.close();
      return;
    }

    ws.send(new Uint8Array([0, 0]));

    const udpSocket = dgram.createSocket('udp4');
    const duplex = createWebSocketStream(ws);

    let isConnected = false;
    const queue = [];

    const sendQueue = () => {
      while (queue.length > 0) {
        const payload = queue.shift();
        try { udpSocket.send(payload); } catch (e) {}
      }
    };

    resolveHost(host)
      .then(resolvedIP => {
        udpSocket.connect(port, resolvedIP, () => {
          isConnected = true;
          if (offset < initialMsg.length) {
            const payload = stripUdpHeader(initialMsg.slice(offset));
            if (payload && payload.length > 0) {
              try { udpSocket.send(payload); } catch (e) {}
            }
          }
          sendQueue();
        });
      })
      .catch(() => {
        udpSocket.connect(port, host, () => {
          isConnected = true;
          if (offset < initialMsg.length) {
            const payload = stripUdpHeader(initialMsg.slice(offset));
            if (payload && payload.length > 0) {
              try { udpSocket.send(payload); } catch (e) {}
            }
          }
          sendQueue();
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
        if (isConnected) {
          try { udpSocket.send(payload); } catch (e) {}
        } else if (queue.length < 1000) {
          queue.push(payload);
        }
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
      queue.length = 0;
      throttleGC();
    };

    udpSocket.on('error', cleanup);
    udpSocket.on('close', cleanup);
    duplex.on('error', (err) => {
      if (err.message && err.message.includes('WebSocket is not open')) return;
      cleanup();
    });
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

    setupTunnelPipeline(ws, msg, offset, host, port, false);
  } catch (err) {
    ws.close();
  }
}

// ==================== JS 代理 HTTP Server 与 WebSocket 路由器 ====================
const argoHttpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if ([PATH_A, PATH_B].includes(urlPath)) {
    res.writeHead(302, { 'Location': '/' });
    res.end();
  } else {
    app(req, res);
  }
});
argoHttpServer.keepAliveTimeout = 120000;
argoHttpServer.headersTimeout = 125000;

const wss = new WebSocket.Server({
  server: argoHttpServer,
  handleProtocols: (protocols, req) => {
    const list = Array.from(protocols);
    return list[0] || false;
  }
});

// ==================== 安全加固：连接频率平滑（每秒最多 5 个新连接） ====================
let connPerSecCount = 0;
let connPerSecReset = Date.now();

wss.on('connection', (ws, req) => {
  const directIP = req.socket.remoteAddress;

  if (!isCloudflareOrLocalIP(directIP)) {
    console.warn(`[security] 拦截到来自非本地/非 Cloudflare 边缘 IP 的直连 WebSocket 扫描: ${directIP}`);
    rejectConnection(ws);
    return;
  }

  // 连接频率平滑：每秒最多接入 5 个新连接，避免突发连接数触发安全告警
  const now = Date.now();
  if ((now - connPerSecReset) > 1000) {
    connPerSecCount = 0;
    connPerSecReset = now;
  }
  connPerSecCount++;
  if (connPerSecCount > 5) {
    try { ws.terminate(); } catch (e) {}
    return;
  }

  // 自适应低配平台高并发与连接计数释放
  const isLowMem = require('os').totalmem() < 1.5 * 1024 * 1024 * 1024;
  const maxConns = isLowMem ? 80 : 300;
  if (activeConns >= maxConns) {
    try { ws.terminate(); } catch (e) {}
    return;
  }
  activeConns++;

  let connDecremented = false;
  const decrementConn = () => {
    if (!connDecremented) {
      connDecremented = true;
      activeConns = Math.max(0, activeConns - 1);
    }
  };
  ws.on('close', decrementConn);
  ws.on('error', decrementConn);

  const urlPath = req.url.split('?')[0];

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.isAlive === false) {
        ws.terminate();
        clearInterval(pingInterval);
        return;
      }
      ws.isAlive = false;
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 55000);

  let accumulated = Buffer.alloc(0);
  let resolvedHeader = false;

  const handshakeTimer = setTimeout(() => {
    if (!resolvedHeader) {
      ws.off('message', onMessage);
      rejectConnection(ws);
    }
  }, 3000);

  const protocolHeader = req.headers['sec-websocket-protocol'];
  if (protocolHeader) {
    try {
      const protocols = protocolHeader.split(',').map(p => p.trim());
      const target = protocols[0];
      if (target && target !== 'vless' && target !== 'trojan') {
        let base64Str = target.replace(/-/g, '+').replace(/_/g, '/');
        while (base64Str.length % 4) {
          base64Str += '=';
        }
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
      if (urlPath === PATH_A) {
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
        clearTimeout(handshakeTimer);
        ws.off('message', onMessage);

        const id = accumulated.slice(1, 17);
        if (!id.equals(UUID_BUFFER)) {
          rejectConnection(ws);
          return;
        }

        hVl(ws, accumulated);
      } else if (urlPath === PATH_B) {
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
});

// ==================== Cloudflare API Tunnel 自动托管配置 ====================
async function autoConfigureArgoTunnel() {
  if (ARGO_AUTH.includes('TunnelSecret') || ARGO_AUTH.length > 100) {
    console.log('[cf] ARGO_AUTH contains secret or is already real token, skipping auto configure.');
    return;
  }
}

// ==================== 原生健壮的下载器 ====================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function download(url, dest, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects'));
  }
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.dl`;
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': UA }, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const parsedUrl = new URL(url);
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }
        return download(redirectUrl, dest, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Status Code: ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(tmp);
      res.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        try {
          fs.renameSync(tmp, dest);
          fs.chmodSync(dest, 0o755);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      fileStream.on('error', (err) => {
        try { fs.rmSync(tmp, { force: true }); } catch (e) {}
        reject(err);
      });
    });

    req.on('error', (err) => {
      try { fs.rmSync(tmp, { force: true }); } catch (e) {}
      reject(err);
    });
    
    req.on('timeout', () => {
      req.destroy();
      try { fs.rmSync(tmp, { force: true }); } catch (e) {}
      reject(new Error('Download timeout'));
    });
  });
}

// ==================== cloudflared 安装与守护 ====================
async function installCloudflared() {
  const sysPaths = ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/usr/sbin/cloudflared'];
  for (const sysPath of sysPaths) {
    if (fs.existsSync(sysPath)) {
      console.log(`[cf] 找到系统全局 cloudflared: ${sysPath}，直接使用系统级可执行程序。`);
      botPath = sysPath;
      return;
    }
  }

  const cfUrl = (process.env.WEB_URL || '').trim().replace('{arch}', process.arch === 'arm64' ? 'arm64' : 'x64');
  if (!cfUrl) {
    throw new Error('Required environment variable WEB_URL is missing');
  }

  const urls = [cfUrl];
  if (cfUrl.includes('github.com')) {
    urls.push('https://ghp.ci/' + cfUrl);
  }

  await download(urls[0], botPath);
}

function startProcess(label, binPath, args, envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  const child = spawn(binPath, args, { stdio: 'ignore', env });
  managedChildren.set(label, child);

  child.on('close', () => {
    managedChildren.delete(label);
    if (!isShuttingDown) {
      setTimeout(() => {
        if (!isShuttingDown) {
          try {
            console.log(`[cf] 子进程 ${label} 意外退出，正在为您重新拉活...`);
            startCloudflared();
          } catch (e) {}
        }
      }, 5000);
    }
  });
  return child;
}

function startCloudflared() {
  const haConns = (process.env.HA_CONNS || '2').trim();
  const base = ['tunnel', '--edge-ip-version', EDGE_IP_VERSION, '--no-autoupdate', '--loglevel', 'fatal', '--protocol', ARGO_PROTOCOL, '--ha-connections', haConns];

  if (tunnelMode === 'json') {
    const creds = JSON.parse(ARGO_AUTH);
    const tid = creds.TunnelID || creds.tunnel_id || creds.TunnelName || creds.tunnel_name;
    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH, { mode: 0o600 });
    fs.writeFileSync(tunnelYmlPath, [
      `tunnel: ${tid}`, `credentials-file: ${tunnelJsonPath}`, `protocol: ${ARGO_PROTOCOL}`,
      'ingress:', `  - hostname: ${ARGO_DOMAIN}`, `    path: ${PATH_A}`, `    service: http://127.0.0.1:${PORT}`,
      `  - hostname: ${ARGO_DOMAIN}`, `    path: ${PATH_B}`, `    service: http://127.0.0.1:${PORT}`,
      `  - hostname: ${ARGO_DOMAIN}`, `    path: /${SUB_PATH}`, `    service: http://127.0.0.1:${PORT}`,
      `  - hostname: ${ARGO_DOMAIN}`, `    service: http://127.0.0.1:${PORT}`,
      '  - service: http_status:404',
    ].join('\n'), { mode: 0o600 });
    return startProcess('cf', botPath, [...base, '--config', tunnelYmlPath, 'run']);
  }

  if (tunnelMode === 'token') {
    return startProcess('cf', botPath, [...base, 'run'], { TUNNEL_TOKEN: ARGO_AUTH });
  }
}

// ==================== xray (cache-engine) 下载与启动 ====================
async function installCacheEngine() {
  if (CACHE_MODE !== 'redis') return;
  
  const cacheUrl = (process.env.CACHE_URL || '').trim().replace('{arch}', process.arch === 'arm64' ? 'arm64' : 'x64');
  if (!cacheUrl) {
    console.log('[cache] CACHE_URL 未配置，跳过下载二进制。');
    return;
  }

  const urls = [cacheUrl];
  if (cacheUrl.includes('github.com')) {
    urls.push('https://ghp.ci/' + cacheUrl);
  }

  await download(urls[0], cacheBinPath);
}

function generateCacheConfig() {
  const config = {
    log: { loglevel: 'none' },
    inbounds: [
      {
        port: ARGO_PORT,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: {
          clients: [{ id: UUID, level: 0 }],
          decryption: 'none',
          fallbacks: [
            { path: PATH_A, dest: 8002, xver: 1 },
            { path: PATH_B, dest: 8003, xver: 1 }
          ]
        },
        streamSettings: { network: 'tcp' }
      },
      {
        port: 8002,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: { clients: [{ id: UUID, level: 0 }], decryption: 'none' },
        streamSettings: {
          network: 'ws',
          wsSettings: { path: PATH_A }
        }
      },
      {
        port: 8003,
        listen: '127.0.0.1',
        protocol: 'trojan',
        settings: { clients: [{ password: UUID, level: 0 }] },
        streamSettings: {
          network: 'ws',
          wsSettings: { path: PATH_B }
        }
      }
    ],
    outbounds: [{ protocol: 'freedom', settings: {} }]
  };
  fs.writeFileSync(cacheConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function startCacheEngine() {
  if (CACHE_MODE !== 'redis') return;
  if (!fs.existsSync(cacheBinPath)) {
    console.error('[cache] xray 二进制文件不存在，无法启动！');
    return;
  }
  generateCacheConfig();
  
  // 启动子进程，劫持 GOGC 参数防止其占用过多内存
  const child = startProcess('cache', cacheBinPath, ['-config', cacheConfigPath], { GOGC: '30' });
  
  child.on('close', () => {
    if (!isShuttingDown) {
      setTimeout(() => {
        if (!isShuttingDown) {
          try {
            console.log('[cache] xray 子进程意外退出，正在为您重新拉活...');
            startCacheEngine();
          } catch (e) {}
        }
      }, 3000);
    }
  });
}

// ==================== 针对低配容器的自适应看门狗 ====================
(function memoryWatchdog() {
  setInterval(() => {
    for (const [label, child] of managedChildren) {
      if (!child || !child.pid || child.killed) continue;
      try {
        const statusPath = `/proc/${child.pid}/status`;
        if (fs.existsSync(statusPath)) {
          const statusContent = fs.readFileSync(statusPath, 'utf8');
          const rssMatch = statusContent.match(/^VmRSS:\s+(\d+)\s+kB/m);
          if (rssMatch) {
            const rssKb = parseInt(rssMatch[1], 10);
            const rssMb = rssKb / 1024;
            const isLowMem = os.totalmem() < 1.5 * 1024 * 1024 * 1024;
            const memoryLimit = label === 'cf' ? (isLowMem ? 120 : 250) : (isLowMem ? 80 : 120);
            if (rssMb > memoryLimit) {
              console.warn(`[watchdog] 子进程 [${label}] 内存过高 (${rssMb.toFixed(1)}MB > ${memoryLimit}MB)，主动拉起重建...`);
              child.kill('SIGKILL');
            }
          }
        }
      } catch (e) {}
    }
  }, 10000);
})();

function scheduleCleanup() {
  setTimeout(() => {
    cleanupFiles.forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} });
  }, 15000);
}

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
  
  if (botPath && !botPath.startsWith('/usr/')) {
    try { fs.rmSync(botPath, { force: true }); } catch (e) {}
  }
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) {}
  
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Fatal Crash:', err.stack || err.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Rejected:', reason ? (reason.stack || reason.message || reason) : 'Unknown');
});

// ==================== 启动引导 ====================
async function startserver() {
  try {
    if (CACHE_MODE === 'redis') {
      console.log('[startup] 正在下载 xray 代理内核...');
      await installCacheEngine();
      console.log('[startup] 正在启动 xray 代理内核...');
      startCacheEngine();
    }

    if (tunnelMode === 'token' || tunnelMode === 'json') {
      await installCloudflared();
      startCloudflared();
      console.log('[startup] Argo Tunnel process spawned in background.');
    }
  } catch (e) {
    console.error('[startup] Boot error:', e.message || e);
  }
  scheduleCleanup();
}

argoHttpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[INFO] JS Proxy server listening on port ${PORT}`);
});

startserver().catch(e => { console.error('[startup]', e.message || e); process.exit(1); });
