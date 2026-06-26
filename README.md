# ko-gateway

一个极简、高性能的云原生微服务网关与分布式数据遥测端点服务。采用原生 Node.js 流式管道技术，集成内存级消息转发、多源缓存引擎（Redis 兼容）以及自动化云端诊断助手连接，专为低配高带宽容器环境深度优化。

> [!NOTE]
> 本项目采用纯 Node.js 主动内存回收机制，无需在默认状态下挂载外部重型内核。通过动态 Ingress 分流技术，保障在低算力沙箱容器中常驻运行的极致轻量与安全。

---

## 架构示意

```
┌────────┐      ┌────────┐      ┌─────────────┐      ┌───────────┐      ┌────────┐
│ Client │─TLS─▶│ CF CDN │─────▶│ Web Helper  │─────▶│ ko-gateway│─────▶│ Target │
│        │      │        │      │ (Connector) │      │ (JS/Redis)│      │ Stream │
└────────┘      └────────┘      └─────────────┘      └───────────┘      └────────┘
                                                       127.0.0.1:8001
```

---

## 核心设计指标

* **主动内存节流**：内建垃圾回收机制，内存开销始终压制在 80MB-100MB 范围，防止容器爆 OOM 被强杀。
* **Ingress 路径流转**：通过 Ingress 实现高防探测分流，默认请求返回精美个人博客，仅特定加密路径可建立数据流连接。
* **应急命令终端**：内建通过一次材质询挑战认证的 WebTerminal，方便在无 Shell 访问权限的 Serverless 空间中远程调试容器。
* **高可用 CNAME 聚合**：订阅配置文件自动支持主 CDN 节点和备用多条 CNAME 解析地址，保障数据传输链路高可用。

---

## 环境变量配置说明

### 1. 核心系统参数 (Required)

| 环境变量 | 默认/示例值 | 业务映射说明 (开发用) |
| :--- | :--- | :--- |
| `APP_KEY` | `5c76da74-0fba-4b2a-8bc5-01e4860b79ef` | **核心代理 ID (UUID)**：用于 Vless/Trojan 的鉴权标识 |
| `API_TOKEN` | `eyJhIjoiM...` | **Cloudflare Tunnel Token**：用于打通穿透隧道的官方凭证 |
| `APP_DOMAIN` | `no.example.com` | **隧道绑定公网域名**：对外访问的主域名 |

### 2. 安全增强与流量路由 (Highly Recommended)

| 环境变量 | 默认值 | 业务映射说明 (开发用) |
| :--- | :--- | :--- |
| `SUB_TOKEN` | 无 | **订阅安全 Key**：配置后，必须在订阅链接后加 `?token=你的值` 才能拉取节点 |
| `Camouflage_URL` | 无 | **防扫伪装反代网址**：如 `https://news.ycombinator.com`，非代理访客将被重定向至此 |
| `VLESS_PATH` | `api/v3/telemetry` | **VLESS 数据遥测路径**：客户端填入的 WebSocket 路径 |
| `TROJAN_PATH` | `graphql/stream` | **Trojan 数据流路径**：客户端填入的 WebSocket 路径 |
| `SUB_PATH` | `godeluoo` | **订阅配置文件主路径**：订阅链接的第一段地址 |

### 3. 高级系统增强与外挂缓存引擎 (Advanced)

| 环境变量 | 默认值 | 业务映射说明 (开发用) |
| :--- | :--- | :--- |
| `SYS_ENHANCE` | `false` | **隧道混淆开关**：设为 `true` 自动拉取 `ko-vip` 中的**哈希去特征混淆版** `web-helper` 运行 |
| `CACHE_MODE` | 无 | **外挂内核开关**：默认留空为纯 JS 转发；**填写 `redis` 时**，自动拉起**混淆去特征版 Xray 内核**接管 8001 端口流量，15秒后自动物理删除二进制，实现最强测速表现 |
| `CDN_HOST` | `saas.sin.fan` | **优选节点主机名**：下发配置文件中默认的接入 IP/地址 |
| `CDN_PORT` | `443` | **优选节点端口**：下发配置文件中默认的端口 |
| `FP` | `chrome` | **TLS 指纹混淆类型**：如 `chrome`, `firefox` 等 |
| `TUNNEL_PROTO` | `http2` | **隧道回源协议**：可选 `http2`, `quic` 等 |

---

## 遥测配置获取 (订阅链接)

对于微服务框架，下发路由参数的拉取地址为：

```bash
# 无鉴权状态下：
https://<APP_DOMAIN>/<SUB_PATH>

# 强鉴权状态下 (推荐，防止扫描器嗅探路由信息)：
https://<APP_DOMAIN>/<SUB_PATH>?token=<SUB_TOKEN>
```
* 服务会根据请求来源的 **User-Agent** 自动适配下发路由文件。
* 普通浏览器访问会自动反代至 `Camouflage_URL` 伪装页；支持的代理客户端请求时，则回吐自适应的 VLESS/Trojan 订阅数据流。

---

## Docker 一键容器化部署

```bash
docker run -d --name ko-gateway --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-KEY" \
  -e API_TOKEN="你的-CLOUDFLARE-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的服务域名.example.com" \
  -e SUB_TOKEN="你的订阅Token" \
  -e Camouflage_URL="https://www.bing.com" \
  -e VLESS_PATH="api/v3/telemetry" \
  -e TROJAN_PATH="graphql/stream" \
  -e SUB_PATH="godeluoo" \
  node:18 sh -c "rm -rf /app && git clone https://github.com/godeluoo1/ko.git /app && cd /app && npm install && node --expose-gc index.js"
```
