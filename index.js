const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
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

function httpPost(url, postData, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const data = typeof postData === 'string' ? postData : JSON.stringify(postData);
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(options.headers || {})
      },
      timeout: options.timeout || 5000,
      signal: options.signal
    }, (res) => {
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
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Aborted'));
      });
    }
    req.write(data);
    req.end();
  });
}

// ==================== 环境变量 ====================
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const ARGO_PORT = Number(process.env.BACKEND_PORT || 8001);
let UUID = (process.env.APP_KEY || '').trim();
const ARGO_DOMAIN = (process.env.APP_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
let ARGO_AUTH = (process.env.API_TOKEN || '').trim();
const ARGO_PROTOCOL = (process.env.TUNNEL_PROTO || 'http2').toLowerCase();
const CFIP = process.env.CDN_HOST || 'saas.sin.fan';
const CFPORT = Number(process.env.CDN_PORT || 443);
const NAME = process.env.NAME || 'Vls';
const FILE_PATH = process.env.FILE_PATH || '.tmp';
const FP = process.env.FP || 'chrome';
const EDGE_IP_VERSION = process.env.EDGE_IP_VERSION || 'auto';

const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

if (!UUID) {
  UUID = crypto.randomUUID();
  console.log(`[system] APP_KEY (UUID) 未设置，已为您自动生成随机安全 UUID: ${UUID}`);
}
if (!ARGO_AUTH) { console.error('[fatal] API_TOKEN 未设置，不支持临时隧道'); process.exit(1); }

const SUB_PATH = (process.env.SUB_PATH || '').trim().replace(/^\/+|\/+$/g, '') || 'godeluoo';

const P_VL = Buffer.from('dmxlc3M=', 'base64').toString();
const P_TR = Buffer.from('dHJvamFu', 'base64').toString();

// ==================== 路径（全随机化） ====================
const RUN_DIR = path.resolve(FILE_PATH);
const botPath = path.join(RUN_DIR, 'cf-bin');
const tunnelJsonPath = path.join(RUN_DIR, `${rnd(4)}.json`);
const tunnelYmlPath = path.join(RUN_DIR, `${rnd(4)}.yml`);

// 阅后即焚清单（不留盘）
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
  if (f === 'cf-bin') return;
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

  // 2. 应急 DoH (DNS over HTTPS) 解析
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
    // DoH 解析也失败，保持原样
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

// ==================== 订阅生成 ====================
function buildSub(nodeName) {
  const host = ARGO_DOMAIN;
  if (!host) return '';

  const nTls = encodeURIComponent(`${nodeName}-TLS`);
  const nNoTls = encodeURIComponent(`${nodeName}-NoTLS`);

  // 1. 带 TLS (端口 443, 强加密, 支持 0-RTT, uTLS 伪装)
  const vlTls = `${P_VL}://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Fapi%2Fv3%2Ftelemetry&ed=2560#${nTls}`;
  const trTls = `${P_TR}://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${host}&fp=${FP}&type=ws&host=${host}&path=%2Fgraphql%2Fstream&ed=2560#${nTls}`;

  // 2. 不带 TLS (端口 80, 无 TLS 握手开销, 极速测速, 支持 0-RTT)
  const vlNoTls = `${P_VL}://${UUID}@${CFIP}:80?encryption=none&security=none&type=ws&host=${host}&path=%2Fapi%2Fv3%2Ftelemetry&ed=2560#${nNoTls}`;

  return [
    vlTls, trTls,
    vlNoTls
  ].join('\n');
}

// ==================== CS YAML 配置生成 ====================
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
  nameserver: [https://doh.pub/dns-query, https://dns.alidns.com/dns-query]

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
      path: /api/v3/telemetry
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
      path: /graphql/stream
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
      path: /api/v3/telemetry
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
        console.log('[cf] 本地已存在 cloudflared 二进制，跳过下载。');
        fs.chmodSync(botPath, 0o775);
        return;
      }
    } catch (e) {}
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
    if (label === 'cf') {
      console.error(`[cf] Argo Tunnel process closed with code ${code}. Retrying in 10 seconds...`);
      setTimeout(() => {
        if (!isShuttingDown) {
          try {
            startCloudflared();
          } catch (e) {
            console.error('[cf] Failed to auto-restart cloudflared:', e.message);
          }
        }
      }, 10000);
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
    fs.writeFileSync(tunnelJsonPath, ARGO_AUTH);
    fs.writeFileSync(tunnelYmlPath, [
      `tunnel: ${tid}`, `credentials-file: ${tunnelJsonPath}`, `protocol: ${ARGO_PROTOCOL}`,
      'ingress:', `  - hostname: ${ARGO_DOMAIN}`, `    service: http://127.0.0.1:${ARGO_PORT}`, '  - service: http_status:404',
    ].join('\n'));
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

      // 3. 配置/更新隧道 ingress 路由
      console.log(`[cf] 3. 正在配置隧道的 Ingress 规则，分流 Web 网页至 ${PORT}，WebSocket 拦截代理至 ${ARGO_PORT}...`);
      const ingressRes = await cfRequest('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: {
          ingress: [
            { hostname: ARGO_DOMAIN, path: '/api/v3/telemetry', service: `http://127.0.0.1:${ARGO_PORT}` },
            { hostname: ARGO_DOMAIN, path: '/graphql/stream', service: `http://127.0.0.1:${ARGO_PORT}` },
            { hostname: ARGO_DOMAIN, path: `/${SUB_PATH}`, service: `http://127.0.0.1:${PORT}` },
            { hostname: ARGO_DOMAIN, service: `http://127.0.0.1:${PORT}` },
            { service: 'http_status:404' }
          ],
          'warp-routing': { enabled: false }
        }
      });
      console.log('[cf] Ingress update success:', ingressRes.data && ingressRes.data.success);

      // 4. 自动管理 DNS CNAME 记录
      console.log(`[cf] 4. 正在查询根域名下 ${ARGO_DOMAIN} 的 DNS 记录...`);
      const dnsListRes = await cfRequest('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${ARGO_DOMAIN}`);
      console.log('[cf] DNS query response success:', dnsListRes.data && dnsListRes.data.success);
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
          console.log(`[cf] 发现不匹配的 DNS 记录 (指向 ${existingDns.content})，正在覆盖为新隧道指向...`);
          await cfRequest('PATCH', `/zones/${zoneId}/dns_records/${existingDns.id}`, dnsPayload);
        } else {
          console.log(`[cf] DNS CNAME 记录匹配，无需更改。`);
        }
      } else {
        console.log(`[cf] 未找到 DNS 记录，正在为您自动创建 CNAME 指向 ${tunnelId}.cfargotunnel.com ...`);
        await cfRequest('POST', `/zones/${zoneId}/dns_records`, dnsPayload);
      }

      // 5. 覆写全局变量，以真实 Tunnel Token 供下文启动
      if (realToken) {
        ARGO_AUTH = realToken;
        tunnelMode = 'token';
        console.log('[cf] Cloudflare API 自动配置托管成功完成！真实 Token 长度:', realToken.length);
      }
    } catch (e) {
      console.error('[cf] Cloudflare API 自动配置失败，回退到原模式:', e.message || e);
    }
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
    'Server': 'nginx/1.27.3',
    'Cache-Control': 'public, max-age=3600'
  });
  res.send(BLOG_HTML);
});

// 订阅路由：返回动态生成的SWR缓存订阅 (智能识别客户端下发顶配配置)
app.get(`/${SUB_PATH}`, async (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isClient = Buffer.from('c2hhZG93cm9ja2V0LHYycmF5LGNsYXNoLG5la28sc2luZy1ib3gscXVhbnR1bXVsdCxzdXJnZSxzdGFzaCxsb29uLG5zc3Vi', 'base64').toString().split(',').some(c => ua.includes(c));

  if (!isClient) {
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Server': 'nginx/1.27.3'
    });
    res.status(404).send(NGINX_404);
    return;
  }

  try {
    const pCS = Buffer.from('Y2xhc2g=', 'base64').toString();
    const isCS = [pCS, 'mihomo', 'stash'].some(c => ua.includes(c));
    if (isCS) {
      const isp = await getMetaInfoWithRace();
      const nodeName = NAME ? `${NAME}-${isp}` : isp;
      const csYaml = buildCSConfig(nodeName);
      res.set({
        'Content-Type': 'application/yaml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${pCS}.yaml"`,
        'Server': 'nginx/1.27.3'
      });
      res.send(csYaml);
    } else {
      const subData = await getDynamicSub();
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Server': 'nginx/1.27.3'
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
        // 模仿发送一段看似正常的网页响应数据给探测器，再强制断开
        ws.send(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nServer: nginx/1.27.3\r\n\r\n" + BLOG_HTML));
        ws.close();
      }
    } catch (e) {}
    throttleGC();
  }, delay);
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
          pipeline(duplex, this).catch(() => {});
          pipeline(this, duplex).catch(() => {});
        }).on('error', () => { ws.close(); });
      })
      .catch(() => {
        net.connect({ host, port }, function () {
          this.write(msg.slice(i));
          pipeline(duplex, this).catch(() => {});
          pipeline(this, duplex).catch(() => {});
        }).on('error', () => { ws.close(); });
      });
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

    resolveHost(host)
      .then(resolvedIP => {
        net.connect({ host: resolvedIP, port }, function () {
          if (offset < msg.length) {
            this.write(msg.slice(offset));
          }
          pipeline(duplex, this).catch(() => {});
          pipeline(this, duplex).catch(() => {});
        }).on('error', () => { ws.close(); });
      })
      .catch(() => {
        net.connect({ host, port }, function () {
          if (offset < msg.length) {
            this.write(msg.slice(offset));
          }
          pipeline(duplex, this).catch(() => {});
          pipeline(this, duplex).catch(() => {});
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
  const urlPath = req.url.split('?')[0];

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
      // 忽略标准协议名称，尝试解析 Base64/Base64url 格式的早期数据
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
      // 1. VL (/api/v3/telemetry)
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
      // 2. TR (/graphql/stream)
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
    ws.off('message', onMessage);
    throttleGC();
  });
});

async function startserver() {
  try {
    await refreshSubSync();
  } catch (e) {
    console.error('[startup] refreshSubSync error:', e.message || e);
  }

  argoHttpServer.listen(ARGO_PORT, '127.0.0.1', () => {
    console.log(`[INFO] Web Service backend initialized on port ${ARGO_PORT}.`);
  });

  try {
    // 自动托管 Cloudflare API Token 转换为真实 Tunnel Token
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
  
  // 退出前彻底删除二进制，保障零残留
  try { fs.rmSync(botPath, { force: true }); } catch (e) {}
  
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
