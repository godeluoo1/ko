# web-gateway-server

一个基于 Node.js 的高可用数据通道与分流网关服务。

---

## 环境变量配置

### 1. 核心运行参数

| 环境变量 | 默认值 / 示例 | 说明 |
| :--- | :--- | :--- |
| `APP_KEY` | `5c76da74-0fba-4b2a-8bc5-01e4860b79ef` | 核心连接 ID (通道通用) |
| `API_TOKEN` | `eyJhIjoiM...` | 平台连接凭证 |
| `APP_DOMAIN` | `no.example.com` | 系统绑定域名 |

### 2. 安全与路由微调

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SUB_TOKEN` | 无 | 配置文件获取的安全 Key (需在链接后加 `?token=值`) |
| `Camouflage_URL` | 无 | 防扫重定向网址 (如 `https://news.ycombinator.com`) |
| `VLESS_PATH` | `api/v3/telemetry` | 通道 A 分流路径 (Websocket 路径) |
| `TROJAN_PATH` | `graphql/stream` | 通道 B 分流路径 (Websocket 路径) |
| `SUB_PATH` | `godeluoo` | 配置文件分发主路径 |

### 3. 高级引擎与网络优化

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `WEB_URL` | 无 | **[必须配置]** 动态拉取编译好的混淆核心 web-engine 二进制的下载直连链接 |
| `CACHE_URL` | 无 | **[使用缓存模式时必须配置]** 动态拉取编译好的混淆核心 cache-engine 二进制的下载直连链接 |
| `SYS_ENHANCE` | `false` | 设为 `true` 时，自动运行混淆加强版 (v2) 引擎 |
| `CACHE_MODE` | 无 | 填 `redis` 时，自动拉起混淆版 cache 引擎做后台转发，并在 15 秒后执行自毁 |
| `CDN_HOST` | `saas.sin.fan` | 优选接入节点 |
| `CDN_PORT` | `443` | 接入端口 |
| `FP` | `chrome` | 安全握手指纹类型 |
| `TUNNEL_PROTO` | `http2` | 隧道传输协议 |

---

## 配置文件获取

```bash
# 默认路径：
https://<APP_DOMAIN>/<SUB_PATH>

# 启用 SUB_TOKEN 时：
https://<APP_DOMAIN>/<SUB_PATH>?token=<SUB_TOKEN>
```
* 服务会根据请求来源的 **User-Agent** 自动适配下发路由配置。
* 浏览器访问会自动重定向至 `Camouflage_URL`；支持的客户端请求时，则回吐数据流。

---

## Docker 部署

```bash
docker run -d --name web-gateway --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-KEY" \
  -e API_TOKEN="你的-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的域名.example.com" \
  -e SUB_TOKEN="你的安全Key" \
  -e Camouflage_URL="https://www.bing.com" \
  -e VLESS_PATH="api/v3/telemetry" \
  -e TROJAN_PATH="graphql/stream" \
  -e SUB_PATH="godeluoo" \
  -e WEB_URL="https://github.com/你的用户名/ko-vip/releases/download/<TAG>/web-engine-{arch}-v2" \
  node:18 sh -c "rm -rf /app && git clone https://github.com/godeluoo1/ko.git /app && cd /app && npm install && node --expose-gc index.js"
```
