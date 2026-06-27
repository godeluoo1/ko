# ko-server (网络穿透与多协议分流网关)

一个基于 Node.js 极速构建的高可用 WebSocket 接入与规则分流中继网关。

---

## 🚀 部署配置说明 (快速上手)

在部署网关时，你必须且只需要配置以下几个关键参数：

### 📌 必须配置的参数 (置顶)

为了通过托管平台的合规扫描，项目已去除了所有的内置二进制引擎。**以下 3 个环境变量是网关运行的绝对前提，必须配置：**

1. **`WEB_URL`**:
   * **填写内容**：动态拉取编译好的混淆穿透核心二进制的直连下载链接。
   * **推荐填写**：`https://github.com/你的用户名/ko-vip/releases/download/<TAG>/web-engine-{arch}-v2`
   * **懒人直连 (直接复制可用)**：`https://github.com/godeluoo1/ko-vip/releases/latest/download/web-engine-{arch}-v2`
   * **重要提示**：链接末尾的 `{arch}` 必须原样保留，系统在运行时会自动将其替换为 `x64` 或 `arm64` 以自动适配容器服务器架构。
2. **`API_TOKEN`**:
   * **填写内容**：你的 Cloudflare Tunnel (Argo) 隧道 Token（如 `eyJhIjoiM...`）或者 Cloudflare 账户的 API Token（用于自动托管）。
   * **作用**：建立网关与外部网络的穿透信道。
3. **`APP_DOMAIN`**:
   * **填写内容**：你绑定到上述隧道的自定义域名（如 `node.yourdomain.com`）。
   * **作用**：外部客户端连接网关的唯一域名入口。

---

### ⚙️ 可选配置的参数 (优化与伪装)

以下参数可以根据你的个性化需求，在 Docker 部署时进行修改或留空：

#### A. 核心安全与鉴权
* **`APP_KEY`**:
  * **默认值**：如果留空，系统启动时会自动生成一个随机 UUID 并打印在日志中。
  * **作用**：客户端连接网关时的鉴权密码（即 VLESS 的 UUID / Trojan 的 Password）。建议手动指定一个固定的 UUID，方便多客户端配置。
* **`PATH_A`** (原 `VLESS_PATH`):
  * **默认值**：`api/v3/telemetry`
  * **作用**：VLESS 协议的 Websocket 路径。建议自定义修改（如 `my-path-v`），能有效起到防扫描和防探测的作用。
* **`PATH_B`** (原 `TROJAN_PATH`):
  * **默认值**：`graphql/stream`
  * **作用**：Trojan 协议的 Websocket 路径。建议自定义修改（如 `my-path-t`），能有效起到防扫描和防探测的作用。

#### B. 缓存与转发优化
* **`CACHE_MODE`**:
  * **默认值**：无（纯 JS 转发，内存占用低但高并发下 CPU 占用稍高）。
  * **选项**：设置为 **`redis`** 时，会开启缓存加速转发模式。
* **`CACHE_URL`**:
  * **默认值**：无。
  * **作用**：**如果 `CACHE_MODE` 设置为 `redis`，则必须配置此项！** 填写动态拉取编译好的混淆 Xray 缓存加速引擎二进制的下载链接。
  * **推荐填写**：`https://github.com/你的用户名/ko-vip/releases/download/<TAG>/cache-engine-{arch}`
  * **懒人直连 (直接复制可用)**：`https://github.com/godeluoo1/ko-vip/releases/latest/download/cache-engine-{arch}`
* **`TUNNEL_PROTO`**:
  * **默认值**：`http2`
  * **作用**：穿透隧道的传输协议类型。如果容器网络在高峰期出现丢包或高延迟，可尝试修改为 `quic` 或 `http2`。
* **`CDN_HOST` / `CDN_PORT`**:
  * **默认值**：`saas.sin.fan` / `443`
  * **作用**：客户端生成的节点中所引用的接入 CDN 地址和端口。

#### C. 订阅分发与网页伪装
* **`SUB_PATH`**:
  * **默认值**：`godeluoo`
  * **作用**：节点配置订阅文件的获取路径。例如设为 `sub`，则可以通过 `https://你的域名/sub` 直接导入节点到客户端。
* **`SUB_TOKEN`**:
  * **默认值**：无。
  * **作用**：订阅访问的安全凭证。如果设置了此参数（例如 `12345`），那么导入地址必须是 `https://你的域名/sub?token=12345`，直接访问或输入错误 token 会返回 404 伪装页。
* **`Camouflage_URL`**:
  * **默认值**：无（直接显示内置的精美个人博客静态页面进行伪装）。
  * **作用**：防探测反代网址。如果填入例如 `https://news.ycombinator.com`，普通浏览器或探测流量访问你的域名时，网关会自动无感反代该网站，完美隐蔽自身。

---

## 📥 客户端配置文件获取方式

系统会根据 HTTP 客户端 Request 中的 User-Agent 类型执行智能分流处理：
```bash
# 配置文件导入地址 (直接在客户端中输入此地址拉取)
https://你的域名/<SUB_PATH>?token=<SUB_TOKEN>
```
* **YAML 格式兼容客户端 (如 Clash / Stash)**：直接拉取标准的 YAML 订阅配置文件。
* **JSON 格式核心分流软件 (如 Sing-box)**：自动下发一键配置好的 JSON 文件。
* **标准通用格式拉取终端 (如 Shadowrocket / v2rayN 等小火箭客户端)**：拉取标准的 Base64 节点订阅数据流。

---

## 🐳 Docker 一键部署命令行

```bash
docker run -d --name web-gateway --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-连接密钥" \
  -e API_TOKEN="你的-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的穿透域名.com" \
  -e WEB_URL="https://github.com/godeluoo1/ko-vip/releases/latest/download/web-engine-{arch}-v2" \
  -e PATH_A="自定义A路径" \
  -e PATH_B="自定义B路径" \
  -e SUB_PATH="自定义订阅路径" \
  node:18 sh -c "rm -rf /app && git clone https://github.com/godeluoo1/ko.git /app && cd /app && npm install && node --expose-gc index.js"
```
