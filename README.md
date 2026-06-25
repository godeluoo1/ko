# ko

极致精简与极致隐蔽的云原生边缘 Ingress 流量分流器与伪装反代服务 — 原生 Node.js 内存分流，支持双向流式高性能 Web 数据转发与 0-RTT 早期数据响应，内建自适应背压控制，集成 Argo 隧道自愈防崩溃，零磁盘残留。

> [!NOTE]
> **“无内核万金油”终极架构**：本项目在保留原生 Node.js 高隐蔽性的前提下，彻底吸收了 eooce 30 个 PaaS 穿透项目在风控、速度与稳定维度的核心优势，无需运行任何 Xray 或 Sing-box 内核，将内存开销和文件特征降到最低。

## 架构

```
┌────────┐      ┌────────┐      ┌─────────────┐      ┌───────────┐      ┌────────┐
│ Client │─TLS─▶│ CF CDN │─────▶│ CF Tunnel   │─────▶│  Node.js  │─────▶│ Target │
│        │      │        │      │(cloudflared)│      │(内存分流) │      │        │
└────────┘      └────────┘      └─────────────┘      └───────────┘      └────────┘
                                                       127.0.0.1:8001
```

## 核心设计与防风控优势

| 维度 | 特性与实现 | 说明 |
| :--- | :--- | :--- |
| **风控伪装** | **随机二进制混淆** | 隧道二进制不再使用 `cloudflared`，启动时自动重命名为随机名称（如 `web-a3d2`），规避主机进程特征审查。 |
| | **站点级反代伪装 (`Camouflage_URL`)** | 收到探测或非代理流量时，直接透明反代到配置的合法大厂网站（非简单静态页），支持资源重定向与跨域自适应，完美伪装。 |
| | **自定义混淆路径** | 支持分别自定义 VLESS / Trojan 协议的 Websocket 握手 Path，完全避开公开默认指纹。 |
| | **订阅鉴权保护 (`SUB_TOKEN`)** | 支持对订阅路径加盐，必须携带特定的 `?token=xxx` 参数，否则回吐伪装网页，彻底屏蔽主动扫描。 |
| **速度与连接** | **0-RTT 早期数据** | 自动提取和拼包处理 WebSocket 早期数据（Early Data），握手首包延时缩短 50%。 |
| | **WS Ping 心跳保活** | 每隔 55 秒自动向客户端发送 WS Ping 心跳，防止反代 CDN 或 PaaS 平台由于无流量自动切断长连接。 |
| | **客户端订阅增强** | 订阅响应附带 `profile-update-interval` 与 `subscription-userinfo` 响应头，自动在客户端显示订阅流量和刷新周期。 |
| **稳定性优化** | **Argo 隧道自愈** | 隧道异常退出后，主程序启动 10s 退避倒计时拉起，不影响 Node 服务与已有连接。 |
| | **Socket 超时释放** | 限制 Socket 最大空闲时间（300秒），防止死连接长期占用系统描述符和内存。 |
| | **并发自适应流控** | 动态监控 `activeConns` 计数器，遇到资源瓶颈自动收紧机制，确保单核 VPS 稳定运行。 |
| | **内存敏感型主动 GC** | Node 启动强制开启 GC 参数（`--expose-gc`），结合堆内存使用率算法主动执行垃圾回收，极低开销。 |
| | **高容错兜底** | 全局捕获 `uncaughtException` 并执行限制重试，静默丢弃非致死 `unhandledRejection`，防止偶发异常导致停机。 |
| | **安全文件权限** | 生成的临时凭证与配置文件强制设为 `0o600`，彻底斩断越权读取风险。 |

## 环境变量配置

### 1. 必填参数

| 变量 | 示例/默认值 | 说明 |
| :--- | :--- | :--- |
| `APP_KEY` | `5c76da74-0fba-4b2a-8bc5-01e4860b79ef` | 系统的核心鉴权 UUID（必须手动设置，支持 VLESS 与 Trojan） |
| `API_TOKEN` | `eyJhIjoiM...` | Cloudflare Tunnel Token 或 JSON 凭证（不支持临时隧道） |
| `APP_DOMAIN` | `service.example.com` | Tunnel 绑定的服务域名（由 CF 控制台解析） |

### 2. 混淆与安全（推荐配置）

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SUB_TOKEN` | 无 | 订阅鉴权 Token。**强烈建议配置**，配置后必须使用 `https://域名/SUB_PATH?token=SUB_TOKEN` 获取订阅。 |
| `Camouflage_URL` | 无（默认回吐拟物博客）| 伪装目标网址（如 `https://news.ycombinator.com`）。输入非代理流量时，透明反代此站点。 |
| `VLESS_PATH` | `api/v3/telemetry` | 自定义 VLESS Websocket 监听路径（内部自动补齐前导 `/`） |
| `TROJAN_PATH` | `graphql/stream` | 自定义 Trojan Websocket 监听路径（内部自动补齐前导 `/`） |
| `SUB_PATH` | `godeluoo` | 订阅拉取与监控主路径 |

### 3. 高级网络与系统微调

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | 主 Web 服务和伪装主页监听端口 |
| `BACKEND_PORT` | `8001` | 后端分流中转端口 |
| `TUNNEL_PROTO` | `http2` | Tunnel 边缘传输协议（可选 `http2`, `quic` 等） |
| `CDN_HOST` | `saas.sin.fan` | 订阅节点中预设的优选接入 CDN 地址 |
| `CDN_PORT` | `443` | 订阅节点中预设的优选接入 CDN 端口 |
| `NAME` | `Vls` | 生成订阅节点名称前缀 |
| `FILE_PATH` | `.tmp` | 存放隧道临时配置文件的目录 |
| `FP` | `chrome` | 浏览器 TLS 指纹模拟类型 |
| `EDGE_IP_VERSION` | `auto` | Tunnel 边缘 IP 版本 |

## 订阅与检测

### 订阅路径说明
```bash
# 未配置 SUB_TOKEN 时
https://<APP_DOMAIN>/<SUB_PATH>

# 已配置 SUB_TOKEN 时 (推荐，防止防扫探针爬取节点)
https://<APP_DOMAIN>/<SUB_PATH>?token=<SUB_TOKEN>
```
根据发起请求的客户端 **User-Agent** 自动适配返回格式：
1. **普通浏览器 / Curl**：适配显示反代伪装站点（由 `Camouflage_URL` 指定，若无则回吐高端静态页）或提示。
2. **Clash/v2rayN/Sing-box** 等代理客户端：直接回吐已完成 Base64 编码的 VLESS / Trojan 代理订阅配置流。
3. **Clash Meta / Mihomo**：不仅返回配置，还附加流量状态与自动更新响应头（如 `profile-update-interval` 订阅自动刷新等），在客户端 UI 中直接可见刷新周期。

---

## 极速 Docker 部署

本项目的 `Dockerfile` 已完美升级为**多架构自适应构建**。在拉取 `cloudflared` 二进制时，会自动根据当前主机的芯片架构（amd64 / arm64）下载最匹配的组件，完美适配包括 树莓派、M1/M2/M3 Mac 以及甲骨文 ARM / AMD 机器等所有云平台。

### 部署命令示例

```bash
docker run -d --name ko-service --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-KEY" \
  -e API_TOKEN="你的-CLOUDFLARE-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的服务域名.example.com" \
  -e SUB_TOKEN="你的订阅私钥Token" \
  -e Camouflage_URL="https://www.bing.com" \
  -e VLESS_PATH="myvless" \
  -e TROJAN_PATH="mytrojan" \
  -e SUB_PATH="getsub" \
  node:18 sh -c "rm -rf /app && (git clone https://github.com/godeluoo1/ko.git /app || (echo 'Clone failed, waiting...' && while [ ! -f /app/index.js ]; do sleep 2; done)) && cd /app && npm install && node --expose-gc index.js"
```

## 安全建议

1. **绝对避免**公开明文 UUID 和 Tunnel Token。
2. 配置 `SUB_TOKEN` 可以杜绝 99% 的扫描探针提取你的节点。
3. 把 `Camouflage_URL` 设为你喜欢的英文资讯站、技术博客或大厂主页，让探针行为无功而返。
4. 本地生成的临时凭证和配置文件被自动指定为 `0o600` 权限，以阻断本地其他恶意程序的越权读取行为。

