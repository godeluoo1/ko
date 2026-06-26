# ko-server

一个基于 Node.js 的高可用数据通道与分流网关服务。

---

## 环境变量配置

### 1. 核心运行参数

| 环境变量 | 默认值 / 示例 | 说明 |
| :--- | :--- | :--- |
| `APP_KEY` | `5c76da74-0fba-4b2a-8bc5-01e4860b79ef` | 核心连接 ID (v / t 通用) |
| `API_TOKEN` | `eyJhIjoiM...` | c 平台连接凭证 |
| `APP_DOMAIN` | `no.example.com` | c 域名 |

### 2. 安全与路由微调

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SUB_TOKEN` | 无 | 配置文件获取的安全 Key (需在链接后加 `?token=值`) |
| `Camouflage_URL` | 无 | 防扫重定向网址 (如 `https://news.ycombinator.com`) |
| `VLESS_PATH` | `api/v3/telemetry` | v 路径 (客户端填入的 Websocket 路径) |
| `TROJAN_PATH` | `graphql/stream` | t 路径 (客户端填入的 Websocket 路径) |
| `SUB_PATH` | `godeluoo` | 配置文件分发主路径 |

### 3. 高级引擎与 c 优化

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SYS_ENHANCE` | `false` | 设为 `true` 时，自动运行 c 混淆加强版 (v2) |
| `CACHE_MODE` | 无 | 填 `redis` 时，自动拉起 x 混淆版引擎做后台转发，并在 15 秒后执行自毁 |
| `CDN_HOST` | `saas.sin.fan` | 优选接入节点 (c-ip 或域名) |
| `CDN_PORT` | `443` | 接入端口 |
| `FP` | `chrome` | t-指纹类型 |
| `TUNNEL_PROTO` | `http2` | c 隧道协议 |

---

## 配置文件获取

```bash
# 默认路径：
https://<APP_DOMAIN>/<SUB_PATH>

# 启用 SUB_TOKEN 时：
https://<APP_DOMAIN>/<SUB_PATH>?token=<SUB_TOKEN>
```
* 服务会根据请求来源的 **User-Agent** 自动适配下发路由配置。
* 浏览器访问会自动重定向至 `Camouflage_URL`；支持的客户端请求时，则回吐 v/t 配置文件数据流。

---

## Docker 部署

```bash
docker run -d --name ko-server --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-KEY" \
  -e API_TOKEN="你的-C-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的域名.example.com" \
  -e SUB_TOKEN="你的安全Key" \
  -e Camouflage_URL="https://www.bing.com" \
  -e VLESS_PATH="api/v3/telemetry" \
  -e TROJAN_PATH="graphql/stream" \
  -e SUB_PATH="godeluoo" \
  node:18 sh -c "rm -rf /app && git clone https://github.com/godeluoo1/ko.git /app && cd /app && npm install && node --expose-gc index.js"
```
