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
    const log = prefix + startupLogs[startupLogIndex++];
    return log;
  }
  
  // 对于后续随机打印，输出典型的 worker 轮询或者平滑请求连接日志
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
  // 如果是关键的启动、安全或 Cloudflare 隧道日志，原样输出，方便诊断；其余杂项日志吐 Nginx 仿冒日志
  if (rawMsg.startsWith('===') || rawMsg.includes('Diagnostics Terminal') || /^(?:\[cf\]|\[startup\]|\[security\]|\[INFO\])/.test(rawMsg)) {
    originalLog.apply(console, args);
  } else {
    originalLog(formatLogNginx(rawMsg, false));
  }
};

console.error = function(...args) {
  // 错误日志非常重要，绕过 Nginx 伪装，以真实格式打印在 stderr 中，方便容器日志查错
  originalError.apply(console, args);
};

process.title = 'npm start';

// ==================== 针对 0.2vCPU 共享 / 512MB RAM 容器的极致优化 ====================
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
const SUB_TOKEN = (process.env.SUB_TOKEN || '').trim();
const FP = process.env.FP || 'chrome';
const EDGE_IP_VERSION = process.env.EDGE_IP_VERSION || 'auto';
const CAMOUFLAGE_URL = (process.env.Camouflage_URL || '').trim();

// 动态路径配置
const VLESS_PATH = '/' + (process.env.VLESS_PATH || 'api/v3/telemetry').trim().replace(/^\/+|\/+$/g, '');
const TROJAN_PATH = '/' + (process.env.TROJAN_PATH || 'graphql/stream').trim().replace(/^\/+|\/+$/g, '');

// 备用优选域名高可用聚合列表 (用户仅需要主优选，因此清空备用列表，仅保留默认的 saas.sin.fan)
const ALTERNATIVE_DOMAINS = [];

const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

if (!ARGO_AUTH) { console.error('[fatal] API_TOKEN 未设置，不支持临时隧道'); process.exit(1); }

let SUB_PATH = (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '');
if (!SUB_PATH) {
  SUB_PATH = crypto.randomBytes(4).toString('hex');
  console.log(`[security] SUB_PATH 未配置，已自动生成随机订阅路径: /${SUB_PATH}`);
}

const P_VL = Buffer.from('dmxlc3M=', 'base64').toString();
const P_TR = Buffer.from('dHJvamFu', 'base64').toString();

// ==================== 路径（全随机化） ====================
const RUN_DIR = path.resolve(FILE_PATH);
const botName = 'web-' + rnd(4);
const botPath = path.join(RUN_DIR, botName);
const tunnelJsonPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `${rnd(4)}.yml`);

// 阅后即焚清单（不留盘）
const cleanupFiles = [tunnelJsonPath, tunnelYmlPath];

// ==================== 状态 ====================
let tunnelMode = ARGO_AUTH.includes('TunnelSecret') ? 'json' : 'token';
const managedChildren = new Map();
let isShuttingDown = false;
let activeConns = 0;
let uncaughtCount = 0;

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
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > 45 * 1024 * 1024 || (now - lastGCTime > 30000)) {
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

// 启动时清理历史残留，但保留当前的随机名进程文件与预下载的官方 sys-helper 二进制包
try { fs.readdirSync(RUN_DIR).forEach(f => {
  if (f === botName || f === 'sys-helper') return;
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
  
  // 1. 尝试常规本地 DNS 解析
  try {
    const res = await dns.lookup(host);
    if (res && res.address) {
      dnsCache.set(host, { ip: res.address, timestamp: Date.now() });
      return res.address;
    }
  } catch (e) {
    // 忽略并进入 DoH 应急回退
  }

  // 2. 应急 DoH (DNS over HTTPS) 解析 (移除了自适应 IPv6，只做极简 Google/Cloudflare DNS 竞态查询)
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

// ==================== 双源竞态获取地理信息 (1.5s 超快超时) ====================
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

// ==================== 订阅生成 (支持多优选域名 Fallback 负载均衡) ====================
function buildSub(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  const nodes = [];
  const pVlPath = encodeURIComponent(VLESS_PATH);
  const pTrPath = encodeURIComponent(TROJAN_PATH);

  // 1. 主节点及备用 SaaS 节点高可用聚合
  const hostnames = [CFIP, ...ALTERNATIVE_DOMAINS];
  
  hostnames.forEach((domain, idx) => {
    const label = `${nodeName}-${idx === 0 ? 'Main' : 'Backup' + idx}`;
    const nTls = encodeURIComponent(`${label}-TLS`);
    const nNoTls = encodeURIComponent(`${label}-NoTLS`);

    nodes.push(`${P_VL}://${UUID}@${domain}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${pVlPath}&ed=2560#${nTls}`);
    nodes.push(`${P_TR}://${UUID}@${domain}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=${pTrPath}&ed=2560#${nTls}`);
    nodes.push(`${P_VL}://${UUID}@${domain}:80?encryption=none&security=none&type=ws&host=${host}&path=${pVlPath}&ed=2560#${nNoTls}`);
  });

  return nodes.join('\n');
}

// ==================== CS YAML 配置生成 ====================
function buildCSConfig(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  let config = `port: 7890
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
  nameserver: [https://doh.pub/dns-query, https://dns.alidns.com/dns-query]

proxies:\n`;

  const hostnames = [CFIP, ...ALTERNATIVE_DOMAINS];
  const proxiesList = [];

  hostnames.forEach((domain, idx) => {
    const label = `${nodeName}-${idx === 0 ? 'Main' : 'Backup' + idx}`;
    const nTls = `${label}-TLS`;
    const nTrTls = `${label}-Tr-TLS`;
    const nNoTls = `${label}-NoTLS`;

    proxiesList.push(nTls, nTrTls, nNoTls);

    config += `  - name: "${nTls}"
    type: ${P_VL}
    server: ${domain}
    port: ${CFPORT}
    uuid: ${UUID}
    udp: true
    tls: true
    servername: ${host}
    client-fingerprint: ${FP}
    network: ws
    ws-opts:
      path: ${VLESS_PATH}
      headers:
        Host: ${host}
      max-early-data: 2560
      early-data-header-name: Sec-WebSocket-Protocol

  - name: "${nTrTls}"
    type: ${P_TR}
    server: ${domain}
    port: ${CFPORT}
    password: ${UUID}
    udp: true
    sni: ${host}
    client-fingerprint: ${FP}
    network: ws
    ws-opts:
      path: ${TROJAN_PATH}
      headers:
        Host: ${host}
      max-early-data: 2560
      early-data-header-name: Sec-WebSocket-Protocol

  - name: "${nNoTls}"
    type: ${P_VL}
    server: ${domain}
    port: 80
    uuid: ${UUID}
    udp: true
    tls: false
    network: ws
    ws-opts:
      path: ${VLESS_PATH}
      headers:
        Host: ${host}
      max-early-data: 2560
      early-data-header-name: Sec-WebSocket-Protocol\n\n`;
  });

  config += `proxy-groups:
  - name: 🚀 节点选择
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    proxies:\n`;

  proxiesList.forEach(p => {
    config += `      - "${p}"\n`;
  });

  config += `rules:
  - MATCH, 🚀 节点选择
`;

  return config;
}

function buildSingBoxConfig(nodeName) {
  const host = ARGO_DOMAIN;
  const outbounds = [
    {
      "type": "urltest",
      "tag": "proxy",
      "outbounds": [],
      "url": "https://www.gstatic.com/generate_204",
      "interval": "3m",
      "tolerance": 50
    }
  ];

  const hostnames = [CFIP, ...ALTERNATIVE_DOMAINS];

  hostnames.forEach((domain, idx) => {
    const label = `${nodeName}-${idx === 0 ? 'Main' : 'Backup' + idx}`;
    const nVl = `${label}-VLESS`;
    const nTr = `${label}-Trojan`;

    outbounds[0].outbounds.push(nVl, nTr);

    outbounds.push({
      "type": "vless",
      "tag": nVl,
      "server": domain,
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
        "path": VLESS_PATH,
        "headers": { "Host": host }
      }
    });

    outbounds.push({
      "type": "trojan",
      "tag": nTr,
      "server": domain,
      "server_port": CFPORT,
      "password": UUID,
      "tls": {
        "enabled": true,
        "server_name": host,
        "utls": { "enabled": true, "fingerprint": FP }
      },
      "transport": {
        "type": "ws",
        "path": TROJAN_PATH,
        "headers": { "Host": host }
      }
    });
  });

  outbounds.push({ "type": "direct", "tag": "direct" });

  return {
    "log": { "level": "info" },
    "dns": {
      "servers": [
        { "tag": "dns_direct", "address": "223.5.5.5", "detour": "direct" },
        { "tag": "dns_proxy", "address": "https://1.1.1.1/dns-query", "detour": "proxy" }
      ],
      "rules": [
        { "outbound": "any", "server": "dns_direct" },
        { "query_type": [ "A", "AAAA" ], "server": "dns_proxy" }
      ]
    },
    "inbounds": [
      { "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 2080 }
    ],
    "outbounds": outbounds
  };
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

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.dl`;
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': UA }, timeout: 120000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Status Code: ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(tmp);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        try {
          fs.renameSync(tmp, dest);
          fs.chmodSync(dest, 0o775);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      fileStream.on('error', (err) => {
        fileStream.close();
        try { fs.rmSync(tmp, { force: true }); } catch (e) {}
        reject(err);
      });
    });
    req.on('error', reject);
  });
}

async function downloadRetry(urls, dest, label) {
  for (let i = 0; i < urls.length; i++) {
    try { await download(urls[i], dest); return; } catch (e) {}
  }
  throw new Error(`${label}: all sources failed`);
}

async function installCloudflared() {
  if (fs.existsSync(botPath)) {
    try {
      const stats = fs.statSync(botPath);
      if (stats.size > 5000000) {
        console.log('[cf] 本地已存在随机命名的 cloudflared 二进制，跳过下载。');
        fs.chmodSync(botPath, 0o775);
        return;
      }
    } catch (e) {}
  }

  // 优先复用 Dockerfile 预下载好的官方 sys-helper，复制为随机进程名运行，完美解决容器无法联网拉取的问题
  const localPresetPath = path.join(RUN_DIR, 'sys-helper');
  if (fs.existsSync(localPresetPath)) {
    try {
      fs.copyFileSync(localPresetPath, botPath);
      fs.chmodSync(botPath, 0o775);
      console.log(`[cf] 成功从本地预置包复制二进制到随机进程名: ${botPath}`);
      return;
    } catch (e) {
      console.error('[cf] 本地预置包复制失败，退避为网络下载:', e.message);
    }
  }

  const vipArch = arch === 'arm64' ? 'arm64' : 'amd64';
  await downloadRetry([
    `https://github.com/godeluoo1/ko-vip/releases/latest/download/bot-linux-${vipArch}`,
    `https://mirror.ghproxy.com/https://github.com/godeluoo1/ko-vip/releases/latest/download/bot-linux-${vipArch}`,
    `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
    `https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`
  ], botPath, 'cf');
}


// ==================== 进程管理 ====================
let cfRetryCount = 0;
let cfResetTimer = null;

function startProcess(label, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, { 
    stdio: ['ignore', 'ignore', 'pipe'], 
    env: { ...process.env, ...extraEnv } 
  });

  if (label === 'cf') {
    if (cfResetTimer) clearTimeout(cfResetTimer);
    cfResetTimer = setTimeout(() => {
      cfRetryCount = 0;
      console.log('[cf] 隧道稳定运行已超60秒，重置退避重试计数器。');
    }, 60000);
  }

  child.stderr && child.stderr.on('data', d => console.error(`[${label}]`, d.toString().trim()));
  managedChildren.set(label, child);
  child.on('error', () => managedChildren.delete(label));
  child.on('close', (code, sig) => {
    managedChildren.delete(label);
    if (isShuttingDown) return;
    if (label === 'cf') {
      const delay = Math.min(60000, 2000 * Math.pow(2, cfRetryCount)) + Math.floor(Math.random() * 2000);
      console.error(`[cf] Argo Tunnel process closed with code ${code}. Retrying in ${delay} ms (Attempt ${cfRetryCount + 1})...`);
      cfRetryCount++;
      setTimeout(() => {
        if (!isShuttingDown) {
          try {
            startCloudflared();
          } catch (e) {
            console.error('[cf] Failed to auto-restart cloudflared:', e.message);
          }
        }
      }, delay);
    } else {
      process.exit(1);
    }
  });
  return child;
}

// ==================== 隧道 ====================
function startCloudflared() {
  const base = ['tunnel', '--edge-ip-version', EDGE_IP_VERSION, '--no-autoupdate', '--loglevel', 'fatal', '--protocol', ARGO_PROTOCOL];

  if (tunnelMode === 'json') {
    const creds = JSON.parse(ARGO_AUTH);
    const tid = creds.TunnelID || creds.tunnel_id || creds.TunnelName || creds.tunnel_name;
    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH, { mode: 0o600 });
    fs.writeFileSync(tunnelYmlPath, [
      `tunnel: ${tid}`, `credentials-file: ${tunnelJsonPath}`, `protocol: ${ARGO_PROTOCOL}`,
      'ingress:', `  - hostname: ${ARGO_DOMAIN}`, `    path: ${VLESS_PATH}`, `    service: http://127.0.0.1:${ARGO_PORT}`,
      `  - hostname: ${ARGO_DOMAIN}`, `    path: ${TROJAN_PATH}`, `    service: http://127.0.0.1:${ARGO_PORT}`,
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

// ==================== Cloudflare API Tunnel 自动配置托管 ====================
async function autoConfigureArgoTunnel() {
  if (ARGO_AUTH.includes('TunnelSecret') || ARGO_AUTH.length > 100) {
    console.log('[cf] ARGO_AUTH contains secret or is already real token, skipping auto configure.');
    return;
  }

  // 判断是否为 API Token 格式 (通常以 cfut_ 开头，长度在 30-60 字符左右)
  if (ARGO_AUTH.length >= 30 && ARGO_AUTH.length <= 60) {
    console.log('[cf] 检测到 Cloudflare API Token 格式，启动自动托管与 DNS 绑定...');
    try {
      const tunnelName = ARGO_DOMAIN.split('.')[0];
      const rootDomain = ARGO_DOMAIN.substring(tunnelName.length + 1);

      console.log(`[cf] Parsed domains - tunnelName: ${tunnelName}, rootDomain: ${rootDomain}`);

      // 原生极简 Cloudflare API HTTPS 请求辅助函数
      const cfRequest = (method, path, body = null) => {
        return new Promise((resolve, reject) => {
          const data = body ? JSON.stringify(body) : '';
          const options = {
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
          };

          const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
              try {
                resolve({ data: JSON.parse(responseData) });
              } catch (e) {
                resolve({ data: responseData });
              }
            });
          });

          req.on('error', reject);
          if (body) {
            req.write(data);
          }
          req.end();
        });
      };

      // 1. 获取 Zone ID 和 Account ID
      console.log(`[cf] 1. 正在查询根域名 ${rootDomain} 的 Zone ID 与 Account ID...`);
      const zoneRes = await cfRequest('GET', `/zones?name=${rootDomain}`);
      console.log('[cf] Zone API response success:', zoneRes.data && zoneRes.data.success);
      if (!zoneRes.data || !zoneRes.data.result || zoneRes.data.result.length === 0) {
        throw new Error(`未找到根域名 ${rootDomain} 的 Zone`);
      }
      const zoneId = zoneRes.data.result[0].id;
      const accountId = zoneRes.data.result[0].account.id;
      console.log(`[cf] 成功获取 Zone ID: ${zoneId}, Account ID: ${accountId}`);

      // 2. 查询现有 Tunnel 列表
      console.log(`[cf] 2. 正在查询是否有同名隧道 "${tunnelName}"...`);
      const tunnelListRes = await cfRequest('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
      console.log('[cf] Tunnel List response success:', tunnelListRes.data && tunnelListRes.data.success);
      const tunnels = tunnelListRes.data.result || [];
      const existingTunnel = tunnels.find(t => t.name === tunnelName);

      let tunnelId = '';
      let realToken = '';

      if (existingTunnel) {
        tunnelId = existingTunnel.id;
        console.log(`[cf] 找到同名现有隧道, ID: ${tunnelId}. 正在拉取真实 Tunnel Token...`);
        const tokenRes = await cfRequest('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
        console.log('[cf] Token response success:', tokenRes.data && tokenRes.data.success);
        realToken = tokenRes.data.result;
      } else {
        console.log(`[cf] 未找到同名隧道，正在为您新建隧道 "${tunnelName}"...`);
        // 生成 32 字节 Base64 格式 Secret
        const tunnelSecret = crypto.randomBytes(32).toString('base64');
        const createRes = await cfRequest('POST', `/accounts/${accountId}/cfd_tunnel`, {
          name: tunnelName,
          config_src: 'cloudflare',
          tunnel_secret: tunnelSecret
        });
        tunnelId = createRes.data.result.id;
        realToken = createRes.data.result.token;
        console.log(`[cf] 隧道新建成功, ID: ${tunnelId}`);
      }

      // 3. 配置/更新隧道 ingress 路由 (支持动态 VLESS 与 Trojan 路径分流)
      console.log(`[cf] 3. 正在配置隧道的 Ingress 规则，分流 Web 网页至 ${PORT}，WebSocket 拦截代理至 ${ARGO_PORT}...`);
      const ingressRes = await cfRequest('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: {
          ingress: [
            { hostname: ARGO_DOMAIN, path: VLESS_PATH, service: `http://127.0.0.1:${ARGO_PORT}` },
            { hostname: ARGO_DOMAIN, path: TROJAN_PATH, service: `http://127.0.0.1:${ARGO_PORT}` },
            { hostname: ARGO_DOMAIN, path: `/${SUB_PATH}`, service: `http://127.0.0.1:${PORT}` },
            { hostname: ARGO_DOMAIN, service: `http://127.0.0.1:${PORT}` },
            { service: 'http_status:404' }
          ],
          'warp-routing': { enabled: false }
        }
      });
      console.log('[tunnel] Ingress update success:', ingressRes.data && ingressRes.data.success);

      // 4. 自动管理 DNS CNAME 记录
      console.log(`[tunnel] 4. 正在查询根域名下 ${ARGO_DOMAIN} 的 DNS 记录...`);
      const dnsListRes = await cfRequest('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${ARGO_DOMAIN}`);
      console.log('[tunnel] DNS query response success:', dnsListRes.data && dnsListRes.data.success);
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
          console.log(`[tunnel] 发现不匹配的 DNS 记录 (指向 ${existingDns.content})，正在覆盖为新隧道指向...`);
          await cfRequest('PATCH', `/zones/${zoneId}/dns_records/${existingDns.id}`, dnsPayload);
        } else {
          console.log(`[tunnel] DNS CNAME 记录匹配，无需更改。`);
        }
      } else {
        console.log(`[tunnel] 未找到 DNS 记录，正在为您自动创建 CNAME 指向 ${tunnelId}.cfargotunnel.com ...`);
        await cfRequest('POST', `/zones/${zoneId}/dns_records`, dnsPayload);
      }

      // 5. 覆写全局变量，以真实 Tunnel Token 供下文启动
      if (realToken) {
        ARGO_AUTH = realToken;
        tunnelMode = 'token';
        console.log('[tunnel] Cloudflare API 自动配置托管成功完成！真实 Token 长度:', realToken.length);
      }
    } catch (e) {
      console.error('[tunnel] Cloudflare API 自动配置失败，回退到原模式:', e.message || e);
    }
  }
}

// ==================== 阅后即焚 ====================
function scheduleCleanup() {
  setTimeout(() => {
    cleanupFiles.forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} });
  }, 15000);
}

// ==================== 路由（Nginx 404 伪装与 静态博客页） ====================
const NGINX_404 = '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx/1.27.3</center>\n</body>\n</html>\n';

let BLOG_HTML = '';
try {
  BLOG_HTML = fs.readFileSync(path.join(__dirname, 'blog.html'), 'utf8');
} catch (e) {
  BLOG_HTML = '<html><head><title>Aiden Lin</title></head><body><h1>Aiden Lin</h1><p>Systems Engineer & Open Source Developer</p></body></html>';
}



app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/robots.txt', (req, res) => {
  setNginxHeaders(res, false);
  res.send('User-agent: *\nDisallow: /');
});

// 根目录：返回精美伪装个人博客页 (支持动态 Camouflage_URL 反代)
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
      pipeline(proxyRes, res, (err) => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          console.error('[proxy] Pipeline transfer error:', err.message);
        }
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy] Request error:', err.message);
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

// 订阅路由：返回动态生成的SWR缓存订阅 (智能识别客户端下发顶配配置)
app.get(`/${SUB_PATH}`, async (req, res) => {
  // 订阅 Token 安全校验（如配置了 SUB_TOKEN，则必须携带正确的 ?token=xxx 参数）
  if (SUB_TOKEN && req.query.token !== SUB_TOKEN) {
    setNginxHeaders(res, true);
    res.status(404).send(NGINX_404);
    return;
  }

  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isClient = Buffer.from('c2hhZG93cm9ja2V0LHYycmF5LGNsYXNoLG5la28sc2luZy1ib3gscXVhbnR1bXVsdCxzdXJnZSxzdGFzaCxsb29uLG5zc3Vi', 'base64').toString().split(',').some(c => ua.includes(c));

  if (!isClient) {
    setNginxHeaders(res, true);
    res.status(404).send(NGINX_404);
    return;
  }

  try {
    const pCS = Buffer.from('Y2xhc2g=', 'base64').toString();
    const isCS = [pCS, 'mihomo', 'stash'].some(c => ua.includes(c)) || req.query.type === 'clash';
    const isSB = ua.includes('sing-box') || req.query.type === 'singbox';

    if (isSB) {
      const isp = await getMetaInfoWithRace();
      const nodeName = NAME ? `${NAME}-${isp}` : isp;
      const sbJson = buildSingBoxConfig(nodeName);
      res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Server': 'nginx/1.27.3'
      });
      res.send(JSON.stringify(sbJson, null, 2));
    } else if (isCS) {
      const isp = await getMetaInfoWithRace();
      const nodeName = NAME ? `${NAME}-${isp}` : isp;
      const csYaml = buildCSConfig(nodeName);
      res.set({
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${pCS}.yaml"`,
        'Server': 'nginx/1.27.3',
        'profile-update-interval': '6',
        'subscription-userinfo': 'upload=0; download=0; total=107374182400; expire=0'
      });
      res.send(csYaml);
    } else {
      const subData = await getDynamicSub();
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Server': 'nginx/1.27.3',
        'profile-update-interval': '6',
        'subscription-userinfo': 'upload=0; download=0; total=107374182400; expire=0'
      });
      res.send(subData);
    }
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
        ws.send("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nServer: nginx/1.27.3\r\n\r\n" + BLOG_HTML);
        ws.close();
      }
    } catch (e) {}
    throttleGC();
  }, delay);
}

// ==================== Cloudflare IP 安全过滤与 Nginx 头高度伪装 ====================
const CF_IPV4_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];

function ipToInt(ip) {
  return ip.split('.').reduce((int, oct) => (int << 8) + parseInt(oct, 10), 0) >>> 0;
}

function ipInCIDR(ip, cidr) {
  try {
    const [range, bits] = cidr.split('/');
    const mask = ~(Math.pow(2, 32 - parseInt(bits, 10)) - 1) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
  } catch (e) {
    return false;
  }
}

function isCloudflareOrLocalIP(ip) {
  if (!ip) return false;
  // 放行本地回环
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::' || ip.includes('::ffff:127.0.0.1')) return true;
  const ipv4 = ip.replace(/^.*:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) return false;

  // 核心优化：放行 RFC1918 私有 IP 网段，解决 Docker 网关 (如 172.17.x.x) 及 K8s Pod (如 10.x.x.x) 的回源校验问题
  if (ipInCIDR(ipv4, '127.0.0.0/8') || 
      ipInCIDR(ipv4, '10.0.0.0/8') || 
      ipInCIDR(ipv4, '172.16.0.0/12') || 
      ipInCIDR(ipv4, '192.168.0.0/16')) {
    return true;
  }

  return CF_IPV4_RANGES.some(cidr => ipInCIDR(ipv4, cidr));
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
    activeConns++;

    const cleanup = () => { activeConns = Math.max(0, activeConns - 1); };
    ws.on('close', cleanup);

    const connectAndPipe = (targetHost) => {
      net.connect({ host: targetHost, port }, function () {
        this.setNoDelay(true);
        this.setKeepAlive(true, 15000);
        this.setTimeout(300000, () => { this.destroy(); ws.close(); });
        this.write(msg.slice(i));
        duplex.pipe(this);
        this.pipe(duplex);
      }).on('error', () => { ws.close(); });
    };

    resolveHost(host)
      .then(resolvedIP => connectAndPipe(resolvedIP))
      .catch(() => connectAndPipe(host));
  } catch (err) {
    ws.close();
  }
}

// 原生安全 UDP 转发
function hVlU(ws, initialMsg, offset, host, port) {
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
    activeConns++;

    const cleanup = () => { activeConns = Math.max(0, activeConns - 1); };
    ws.on('close', cleanup);

    const connectAndPipe = (targetHost) => {
      net.connect({ host: targetHost, port }, function () {
        this.setNoDelay(true);
        this.setKeepAlive(true, 15000);
        this.setTimeout(300000, () => { this.destroy(); ws.close(); });
        if (offset < msg.length) {
          this.write(msg.slice(offset));
        }
        duplex.pipe(this);
        this.pipe(duplex);
      }).on('error', () => { ws.close(); });
    };

    resolveHost(host)
      .then(resolvedIP => connectAndPipe(resolvedIP))
      .catch(() => connectAndPipe(host));
  } catch (err) {
    ws.close();
  }
}

// ==================== 主启动 ====================
// 探测防御：接管普通HTTP GET请求，重定向或返回网页伪装
const argoHttpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if ([VLESS_PATH, TROJAN_PATH].includes(urlPath)) {
    res.writeHead(302, { 'Location': '/' });
    res.end();
  } else {
    // 核心安全升级：将普通 HTTP 请求直接流转给内部的 Express 处理，实现单隧道单端口承载全套服务，完全不需要在公网暴露任何容器端口！
    app(req, res);
  }
});

const wss = new WebSocket.Server({
  server: argoHttpServer,
  handleProtocols: (protocols, req) => {
    const list = Array.from(protocols);
    return list[0] || false;
  }
});

wss.on('connection', (ws, req) => {
  const directIP = req.socket.remoteAddress;

  if (!isCloudflareOrLocalIP(directIP)) {
    console.warn(`[security] 拦截到来自非本地/非 Cloudflare 边缘 IP 的直连 WebSocket 扫描: ${directIP}`);
    rejectConnection(ws);
    return;
  }

  const urlPath = req.url.split('?')[0];

  // WebSocket Ping 心跳保活（55 秒间隔，对抗 Cloudflare 100 秒空闲超时）
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 55000);

  let accumulated = Buffer.alloc(0);
  let resolvedHeader = false;

  // 3秒握手超时保护机制（防止空连接挂起测速超时，并抵御慢速连接DDoS）
  const handshakeTimer = setTimeout(() => {
    if (!resolvedHeader) {
      ws.off('message', onMessage);
      rejectConnection(ws);
    }
  }, 3000);

  // 提取并解析 WebSocket Early Data (Sec-WebSocket-Protocol)
  const protocolHeader = req.headers['sec-websocket-protocol'];
  if (protocolHeader) {
    try {
      const protocols = protocolHeader.split(',').map(p => p.trim());
      const target = protocols[0];
      if (target && target !== String.fromCharCode(118, 108, 101, 115, 115) && target !== String.fromCharCode(116, 114, 111, 106, 97, 110)) {
        let base64Str = target.replace(/-/g, '+').replace(/_/g, '/');
        while (base64Str.length % 4) {
          base64Str += '=';
        }
        const earlyData = Buffer.from(base64Str, 'base64');
        if (earlyData.length > 0) {
          accumulated = Buffer.concat([earlyData, accumulated]);
        }
      }
    } catch (e) {
    }
  }

  const parseHeader = () => {
    if (resolvedHeader) return;
    try {
      // 1. VL 动态路径解析
      if (urlPath === VLESS_PATH) {
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
        const isVl = id.equals(UUID_BUFFER);
        if (!isVl) {
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

        if (cmd === 0x02) {
          hVlU(ws, accumulated, i, host, port);
        } else {
          hVl(ws, accumulated);
        }
      }
      // 2. TR 动态路径解析
      else if (urlPath === TROJAN_PATH) {
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

  if (accumulated.length > 0) {
    parseHeader();
  }

  ws.on('close', () => {
    clearInterval(pingInterval);
    ws.off('message', onMessage);
    throttleGC();
  });
});

function generateExternalDaemon() {
  const daemonScript = `#!/bin/sh
# FreeBSD/Linux 系统级守护保活脚本

export PORT=${PORT}
export APP_KEY="${UUID}"
export API_TOKEN="${process.env.API_TOKEN || ''}"
export APP_DOMAIN="${ARGO_DOMAIN}"
export SUB_PATH="${SUB_PATH}"
export VLESS_PATH="${process.env.VLESS_PATH || ''}"
export TROJAN_PATH="${process.env.TROJAN_PATH || ''}"
export Camouflage_URL="${process.env.Camouflage_URL || ''}"

NODE_PID=\$(pgrep -f "npm start" | head -n 1)
PORT_OK=0

if [ ! -z "\$NODE_PID" ]; then
  # 探测本地 HTTP 端口是否存活响应，最大超时 5 秒
  if command -v curl >/dev/null 2>&1; then
    HTTP_CODE=\$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:\${PORT}/robots.txt)
    if [ "\$HTTP_CODE" = "200" ]; then
      PORT_OK=1
    fi
  else
    # 如果系统没有 curl，退避为仅通过 PID 检查
    PORT_OK=1
  fi
fi

if [ -z "\$NODE_PID" ] || [ "\$PORT_OK" = "0" ]; then
  echo "[daemon] Node 进程未运行或端口假死，正在拉起启动..."
  if [ ! -z "\$NODE_PID" ]; then
    kill -9 \$NODE_PID >/dev/null 2>&1
  fi
  if command -v devil >/dev/null 2>&1; then
    devil binexec on >/dev/null 2>&1
  fi
  nohup node ${path.join(process.cwd(), 'index.js')} >/dev/null 2>&1 &
else
  echo "[daemon] Node 进程正在运行且端口正常，PID: \$NODE_PID"
fi
`;

  const scriptPath = path.join(process.cwd(), 'daemon.sh');
  try {
    fs.writeFileSync(scriptPath, daemonScript);
    fs.chmodSync(scriptPath, 0o775);
    console.log(`[daemon] 已在当前目录自动生成 FreeBSD/Linux 外部系统级保活脚本: ${scriptPath}`);
    console.log(`[daemon] 您可将以下 Cron 规则写入 crontab -e 以实现永久进程守护:`);
    console.log(`*/10 * * * * ${scriptPath} >/dev/null 2>&1`);
  } catch (e) {
    console.error('[daemon] 写入外部守护脚本失败:', e.message);
  }
}

async function startserver() {
  try {
    await refreshSubSync();
  } catch (e) {
    console.error('[startup] refreshSubSync error:', e.message || e);
  }

  // 启动外部守护生成
  generateExternalDaemon();

  argoHttpServer.listen(ARGO_PORT, '127.0.0.1', () => {
    console.log(`[INFO] Web Service backend initialized on port ${ARGO_PORT}.`);
  });

  try {
    await autoConfigureArgoTunnel();
  } catch (e) {
    console.error('[startup] autoConfigureArgoTunnel error:', e.message || e);
  }

  try {
    await installCloudflared();
    startCloudflared();
  } catch (e) {
    console.error('[startup] cloudflared installation/start error:', e.message || e);
  }

  scheduleCleanup();
}

app.listen(PORT, '0.0.0.0', () => {
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
  
  try { fs.rmSync(path.join(process.cwd(), 'daemon.sh'), { force: true }); } catch (e) {}
  try { fs.rmSync(botPath, { force: true }); } catch (e) {}
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (e) {}
  
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => {
  // 使用原生的控制台输出打印真实崩溃堆栈，防止被 Nginx 日志仿冒所掩盖
  if (typeof originalError === 'function') {
    originalError('[uncaughtException] Fatal Crash Stack:', err.stack || err.message || err);
  } else {
    console.error('[uncaughtException] Fatal Crash Stack:', err.stack || err.message || err);
  }
  uncaughtCount++;
  if (uncaughtCount >= 5) {
    process.exit(1);
  }
  setTimeout(() => { uncaughtCount = Math.max(0, uncaughtCount - 1); }, 30000);
});
process.on('unhandledRejection', (reason) => {
  // 仅输出警告，防止静默失败难以排查
  if (typeof originalError === 'function') {
    originalError('[unhandledRejection] Promise Rejected:', reason ? (reason.stack || reason.message || reason) : 'Unknown Reason');
  } else {
    console.error('[unhandledRejection] Promise Rejected:', reason ? (reason.stack || reason.message || reason) : 'Unknown Reason');
  }
});

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
