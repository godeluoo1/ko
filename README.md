# ko

极致精简的高防封容器代理节点方案 — 原生 Node.js 内存分流，VLESS-WS + Trojan-WS + Early Data 0-RTT，智能 Clash/Stash 顶配订阅 YAML 生成，Argo 隧道自愈防崩溃，零磁盘残留。

## 架构

```
┌────────┐      ┌────────┐      ┌─────────────┐      ┌───────────┐      ┌────────┐
│ Client │─TLS─▶│ CF CDN │─────▶│ CF Tunnel   │─────▶│  Node.js  │─────▶│ Target │
│        │      │        │      │(cloudflared)│      │(内存分流) │      │        │
└────────┘      └────────┘      └─────────────┘      └───────────┘      └────────┘
                                                       127.0.0.1:8001
```

## 核心设计原则

| 原则 | 实现 |
|------|------|
| **极致性能与无痕** | 纯 Node.js 内存拦截解析 VLESS / Trojan 协议，免去任何底层代理二进制写盘，零文件特征残留，极度轻量。 |
| **极致稳定 (防重启)** | Argo 隧道进程异常退出退避守护（10秒后台自愈重连），Node 进程常驻运行在外部映射端口（如 3008），彻底切断因隧道网络瞬断而导致的容器无限重启和代码丢失。 |
| **极致防风控 (多路复用)** | 客户端分享链接追加 `mux=1`；智能识别 Clash/Stash UA，**直接下发顶配 YAML**，在配置中强行开启多路复用（smux/h2mux），大幅隐蔽 TLS 频繁握手的指纹特征。 |
| **0-RTT 极速启动** | 服务端原生提取 WebSocket 的 `Sec-WebSocket-Protocol` 头部，进行 Base64 早期数据解码与前置拼包合流，让首包时延直接砍半。 |
| **主动探测防御** | 对非法探测流量执行随机 150ms~600ms 的伪装延迟，并回吐高端拟物静态个人博客 HTML，零漏入特征。 |

## 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `APP_KEY` | VLESS/Trojan UUID（必须手动设置，无默认值） |
| `API_TOKEN` | Cloudflare Tunnel Token 或 JSON 凭证（不支持临时隧道） |
| `APP_DOMAIN` | Tunnel 绑定的域名（如 `proxy.example.com`） |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | Web 订阅和伪装服务监听端口 |
| `BACKEND_PORT` | `8001` | 隧道流量分流端口 |
| `TUNNEL_PROTO` | `http2` | Tunnel 传输协议（`http2` / `quic`） |
| `CDN_HOST` | `saas.sin.fan` | 优选 IP / 域名 |
| `CDN_PORT` | `443` | 优选端口 |
| `NAME` | `Vls` | 节点备注名 |
| `SUB_PATH` | `godeluoo` | 订阅路径（无前导 `/`） |
| `FILE_PATH` | `.tmp` | 运行时临时目录 |
| `FP` | `chrome` | TLS 浏览器指纹 |
| `EDGE_IP_VERSION` | `auto` | Tunnel 边缘 IP 版本 |

## 订阅地址

```
https://<APP_DOMAIN>/<SUB_PATH>
```

默认路径：`/godeluoo`。服务会进行客户端 User-Agent 自适应识别：
1. **普通客户端（小火箭等）**：返回 Base64 编码的节点列表（包含 `ed=2560` 早期数据长度，`mux=1` 多路复用和 `fp=chrome` 指纹）。
2. **Clash 客户端（Clash/Mihomo/Stash）**：直接返回配置了 smux 多路复用、0-RTT 和 uTLS 的完整 YAML 配置文件，直接导入即用。

## 稳定特性

| 特性 | 说明 |
|------|------|
| 隧道自愈重试 | `cloudflared` 子进程退出后，主程序启动 10s 倒计时静默拉起，不引发 Node 崩溃退出。 |
| 优雅关闭 | SIGTERM → 5s 超时 → SIGKILL，清理所有子进程，资源不泄漏。 |
| 异常兜底 | `uncaughtException` / `unhandledRejection` 均触发退出。 |
| 防休眠 | 随机时间间隔（4~8分钟）自保活访问模拟流量。 |

## Docker 部署

```bash
docker run -d --name ko-service --restart=always \
  -e APP_KEY="你的UUID" \
  -e API_TOKEN="你的Tunnel-Token" \
  -e APP_DOMAIN="proxy.example.com" \
  -e NAME="MyNode" \
  node:18 sh -c "rm -rf /app && (git clone https://github.com/godeluoo1/ko.git /app || (echo 'Clone failed, waiting for manual code sync...' && while [ ! -f /app/index.js ]; do sleep 2; done)) && cd /app && npm install && node --expose-gc index.js"
```

## 安全提示

- **切勿**使用默认 UUID，务必生成唯一值
- **切勿**在公开仓库暴露 `API_TOKEN`
- `SUB_PATH` 建议修改为难以猜测的自定义路径
- 订阅链接包含全部连接信息，妥善保管，不要分享
