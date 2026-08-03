# ko

一个专为极低配环境（如 0.2vCPU / 256MB~512MB RAM）设计的超轻量、高隐蔽性网络中继网关。支持标准 Cloudflare Tunnel (Argo) 部署，并集成多重安全平台规避与防封逻辑。

---

## 🌟 核心特性

- **🚀 双模运行自适应**：
  - **纯 JS 模式 (默认/推荐)**：无任何子进程，零可执行文件落盘，纯 Node.js 内存解析 VLESS/Trojan 协议。内存占用极低（~60MB），完美规避 EDR/HIDS 等主机安全平台的系统调用监控。
  - **xray 转发内核模式**：在需要高性能转发时开启，自动下载混淆内核，并在成功加载进内存 15 秒内执行磁盘“阅后即焚”，清空全部文件特征。
- **🛡️ EDR / HIDS 深度过审规避**：
  - **内存凭证擦除**：启动一瞬间物理擦除 `process.env` 中的 `API_TOKEN` / `APP_KEY` 等敏感环境变量，防范读取 `/proc/<pid>/environ`。
  - **进程名称伪装**：运行时自适应伪装进程标题为 `node /usr/share/nginx/scripts/health-check.js`。
  - **日志仿冒**：stdout/stderr 劫持输出标准的 Nginx 启动与轮询日志，隐藏真实代理特征。
- **🌐 智能网络层优化**：
  - **双源 DoH 竞态解析**：内置 Google/Cloudflare DNS over HTTPS 客户端，解决内网 DNS 劫持与污染。
  - **带宽防风控**：自动识别并丢弃高带宽测速流量，防范服务商出口带宽风控。
  - **优选 CDN 支持**：订阅生成自动将地址指向优选 CNAME，Host 和 SNI 完美留存原域名。

---

## 📋 部署参数 (环境变量)

| 变量名 | 默认值 | 是否必填 | 作用 |
| :--- | :--- | :--- | :--- |
| `API_TOKEN` | (无) | **是** | Cloudflare Tunnel Token 或 API Token (自动配置 DNS A 记录) |
| `APP_DOMAIN` | (无) | **是** | 绑定到隧道的自定义域名 |
| `APP_KEY` | 随机UUID | 否 | VLESS 的 UUID / Trojan 的密码 |
| `CACHE_MODE` | `false` | 否 | 设为 `redis` 启用 xray 转发内核模式，否则默认纯 JS 极速模式 |
| `WEB_URL` | (无) | 否 | 开启 `CACHE_MODE` 时 cloudflared 的分发下载链接 |
| `CACHE_URL` | (无) | 否 | 开启 `CACHE_MODE` 时 xray 代理内核的下载链接 |
| `SUB_PATH` | 随机8位hex | 否 | 订阅入口路径 (如设为 `godeluoo`) |
| `CDN_HOST` | `saas.sin.fan` | 否 | 生成订阅节点时的连接地址 (优选域名) |
| `CDN_PORT` | `443` | 否 | 生成订阅节点时的连接端口 |
| `SERVER_PORT` | `3000` | 否 | 本地 HTTP 监听端口 |

---
### ⚙️ 高级配置参数 (非必填隐藏变量)

以下变量已内置最佳默认值，通常无需手动配置。如果需要微调底层行为，可按需传入：

| 变量名 | 默认值 | 作用 |
| :--- | :--- | :--- |
| `BACKEND_PORT` | `8001` | xray 转发内核的本地监听端口 |
| `TUNNEL_PROTO` | `http2` | cloudflared 隧道协议 (可选 `http2`, `quic`, `tcp`) |
| `NAME` | `Vls` | 生成订阅节点时的前缀标识 |
| `FILE_PATH` | `.tmp` | 缓存与临时文件存放目录 (启动后阅后即焚) |
| `FP` | `chrome` | 节点订阅参数中的 TLS 浏览器指纹伪装类型 |
| `EDGE_IP_VERSION` | `auto` | CF 边缘连接 IP 版本 (可选 `auto`, `4`, `6`) |
| `Camouflage_URL` | (无) | 首页反向代理伪装地址 (可填入你的静态站，让扫描器无法探测) |
| `PATH_A` | `api/v3/telemetry` | VLESS 协议的 WebSocket 连接路径 |
| `PATH_B` | `graphql/stream` | Trojan 协议的 WebSocket 连接路径 |
| `PATH_C` | `api/v4/grpc` | gRPC 节点的连接路径 |
| `PATH_D` | `api/v4/splithttp` | SplitHTTP 节点的连接路径 |
| `HA_CONNS` | `2` | cloudflared 隧道的高可用并发连接数 |

## 🚀 部署指南

### 方式一：纯 JS 极速模式 (零二进制，最安全)
最推荐在 Hugging Face、Render、Railway 等 PaaS 平台或装有严格安全监控的 VPS 上部署。

只需要配置以下最精简参数：
```bash
export API_TOKEN="你的CF隧道Token"
export APP_DOMAIN="你的自定义域名"
export SUB_PATH="godeluoo"   # 订阅路径
export APP_KEY="你的UUID"    # 代理密码

node index.js
```

### 方式二：xray 转发内核模式 (高性能)
需要配合 `ko-vip` 二进制发布平台使用，适用于需要承载高并发流量的 VPS 环境。

```bash
export API_TOKEN="你的CF隧道Token"
export APP_DOMAIN="你的自定义域名"
export SUB_PATH="godeluoo"
export APP_KEY="你的UUID"

# 开启内核代理
export CACHE_MODE="redis"
export WEB_URL="https://github.com/你的用户名/ko-vip/releases/latest/download/web-engine-{arch}-v2"
export CACHE_URL="https://github.com/你的用户名/ko-vip/releases/latest/download/cache-engine-{arch}"

node index.js
```

---

## 🔗 客户端订阅使用

*   **通用订阅获取地址**：`https://你的域名/你的订阅路径`
*   **支持的客户端**：小火箭 (Shadowrocket)、v2rayN、v2rayNG 等主流客户端直接导入链接使用。
*   非代理客户端（如常规浏览器访问订阅路径）将自动返回 Nginx 404 伪装页，阻断平台主动扫描。

---

## ⚖️ 许可与免责声明
- 本项目仅限个人网络技术研究与合法系统状态维护使用。
- 请遵守当地法律法规，严禁滥用或将其用作公共中继节点。
