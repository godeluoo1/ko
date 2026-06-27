# ko-server (网络穿透与多协议分流网关)

一个基于 Node.js 极速搭建的 HTTP / WebSocket 穿透与协议分流服务。

---

## 🚀 部署配置说明 (必看)

项目通过以下环境变量进行运行和对接，请在部署时填入：

### 1. 基础连接参数

| 环境变量 | 默认值 / 示例 | 说明 |
| :--- | :--- | :--- |
| `APP_KEY` | `5c76da74-0fba-4b2a-8bc5-01e4860b79ef` | 你的连接密码（即 UUID，V-VESS / T-Trojan 客户端连接时填入的密码/ID。如果留空，启动时会随机生成） |
| `API_TOKEN` | `eyJhIjoiM...` | 你的 Cloudflare Tunnel (Argo) 隧道 Token（支持直接填写 Token，或者填写 Cloudflare API Token 自动托管） |
| `APP_DOMAIN` | `no.example.com` | 绑定到隧道的自定义域名（如 `node.yourdomain.com`） |

### 2. 网络优化与核心下载 (防平台封禁核心)
为了通过部分托管平台的合规扫描，项目去除了所有默认的二进制文件。**你必须配置以下环境变量来拉取对应的运行引擎**：

| 环境变量 | 填写示例 | 说明 |
| :--- | :--- | :--- |
| `WEB_URL` | `https://github.com/你的用户名/ko-vip/releases/download/<TAG>/web-engine-{arch}-v2` | **[必须配置]** 穿透通道引擎下载直连链接（用于下载混淆版的 CF 客户端）。*注意：链接中的 `{arch}` 必须保留，系统会自动根据容器架构替换为 `x64` 或 `arm64`。* |
| `CACHE_URL` | `https://github.com/你的用户名/ko-vip/releases/download/<TAG>/cache-engine-{arch}` | **[使用缓存模式时必须配置]** 后台加速引擎下载直连链接（当开启缓存加速模式时配置，用于下载混淆版的 X-core 核心） |
| `SYS_ENHANCE` | `false` | 是否启用加强版引擎。设为 `true` 时，会自动请求下载 `-v2` 结尾的二进制包（即带尾部哈希干扰数据的包） |
| `CACHE_MODE` | 无 | 缓存加速模式。留空表示纯 JS 转发；如果填 `redis`，则会自动下载并运行 `CACHE_URL` 的加速核心，实现 C++ 级的高速转发 |
| `CDN_HOST` | `saas.sin.fan` | 优选接入节点 |
| `CDN_PORT` | `443` | 接入端口 |
| `FP` | `chrome` | 安全握手指纹类型 |
| `TUNNEL_PROTO` | `http2` | 隧道传输协议（如果容器网络经常断流，可尝试修改为 `http2` 或 `quic`） |

### 3. 数据流路径自拟 (网页伪装防检测)

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PATH_A` | `api/v3/telemetry` | 通道 A 分流路径 (Websocket 路径，建议修改为自定义路径) |
| `PATH_B` | `graphql/stream` | 通道 B 分流路径 (Websocket 路径，建议修改为自定义路径) |
| `SUB_PATH` | `godeluoo` | 订阅配置文件的获取路径（如果设为 `my-sub`，则可以通过 `https://域名/my-sub` 快速导入节点） |
| `SUB_TOKEN` | 无 | 订阅访问的安全凭证（如设置后，导入链接必须带上 `?token=你的凭证`，否则返回 404 伪装页） |
| `Camouflage_URL` | 无 | 伪装站重定向网址（如果探测流量或普通浏览器直接访问你的域名，会自动反代或跳转到此网页，如 `https://news.ycombinator.com`） |

---

## 📥 客户端节点导入方式

服务会根据访问请求的 **User-Agent**（浏览器还是代理软件）自动做分流拦截。
```bash
# 节点导入地址 (直接在 Clash / Shadowrocket 等软件中输入此地址导入)
https://你的域名/<SUB_PATH>?token=<SUB_TOKEN>
```
* **Clash / Stash**：直接拉取标准的 YAML 订阅配置文件。
* **Sing-box**：自动下发一键配置好的 JSON 文件。
* **其他软件 (Shadowrocket/v2rayN 等)**：拉取标准的 Base64 节点订阅数据。

---

## 🐳 Docker 一键部署命令行

```bash
docker run -d --name web-gateway --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-连接密码" \
  -e API_TOKEN="你的-CLOUDFLARE-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的穿透域名.com" \
  -e WEB_URL="https://github.com/你的用户名/ko-vip/releases/download/<TAG>/web-engine-{arch}-v2" \
  -e PATH_A="自定义A路径" \
  -e PATH_B="自定义B路径" \
  -e SUB_PATH="自定义订阅路径" \
  node:18 sh -c "rm -rf /app && git clone https://github.com/你的用户名/ko.git /app && cd /app && npm install && node --expose-gc index.js"
```
