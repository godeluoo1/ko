# web-gateway-server (高效网络接入与路由分流网关)

一个基于 Node.js 极速构建的高可用 WebSocket 接入与规则分流中继网关。

---

## 🚀 部署配置说明

网关服务通过以下环境变量进行初始化和路由配置，请在部署时填入对应参数：

### 1. 基础连接参数

| 环境变量 | 默认值 / 示例 | 说明 |
| :--- | :--- | :--- |
| `APP_KEY` | `5c76da74-0fba-4b2a-8bc5-01e4860b79ef` | 系统的核心身份识别凭证 (即连接 UUID 密钥，如果未配置，启动时会自动生成随机 UUID) |
| `API_TOKEN` | `eyJhIjoiM...` | 穿透通道服务的连接凭证/Token (支持直填已创建的 Tunnel Token，或者提供 API Token 自动托管) |
| `APP_DOMAIN` | `no.example.com` | 系统绑定的穿透主域名（如 `node.yourdomain.com`） |

### 2. 网络优化与核心下载 (防平台封禁核心)
为了通过部分托管平台的合规扫描，项目去除了所有默认的二进制文件。**你必须配置以下环境变量来拉取对应的运行引擎**：

| 环境变量 | 填写示例 | 说明 |
| :--- | :--- | :--- |
| `WEB_URL` | `https://github.com/你的用户名/ko-vip/releases/download/<TAG>/web-engine-{arch}-v2` | **[必须配置]** 动态拉取编译好的混淆核心 web-engine 二进制的下载直连链接。*注意：链接中的 `{arch}` 必须保留，系统会自动根据容器架构替换为 `x64` 或 `arm64`。* |
| `CACHE_URL` | `https://github.com/你的用户名/ko-vip/releases/download/<TAG>/cache-engine-{arch}` | **[使用缓存模式时必须配置]** 动态拉取编译好的混淆核心 cache-engine 二进制的下载直连链接 |
| `SYS_ENHANCE` | `false` | 是否启用加强版引擎。设为 `true` 时，会自动请求下载 `-v2` 结尾的二进制包（即带尾部哈希干扰数据的包） |
| `CACHE_MODE` | 无 | 缓存加速模式。留空表示纯 JS 转发；如果填 `redis`，则会自动下载并运行 `CACHE_URL` 的加速核心，实现 C++ 级的高速转发 |
| `CDN_HOST` | `saas.sin.fan` | 优选接入节点 |
| `CDN_PORT` | `443` | 接入端口 |
| `FP` | `chrome` | 安全握手指纹类型 |
| `TUNNEL_PROTO` | `http2` | 隧道传输协议（如果容器网络经常断流，可尝试修改为 `http2` 或 `quic`） |

### 3. 数据流路径自拟 (网页伪装防检测)

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PATH_A` | `api/v3/telemetry` | 转发端点 A 的 WebSocket 路由路径 (客户端连接路径，强烈建议使用自定义随机字符串以增加隐蔽性) |
| `PATH_B` | `graphql/stream` | 转发端点 B 的 WebSocket 路由路径 (客户端连接路径，强烈建议使用自定义随机字符串以增加隐蔽性) |
| `SUB_PATH` | `godeluoo` | 订阅配置文件的获取路径（如果设为 `my-sub`，则可以通过 `https://域名/my-sub` 快速导入节点） |
| `SUB_TOKEN` | 无 | 订阅访问的安全凭证（如设置后，导入链接必须带上 `?token=你的凭证`，否则返回 404 伪装页） |
| `Camouflage_URL` | 无 | 伪装站重定向网址（如果探测流量或普通浏览器直接访问你的域名，会自动反代或跳转到此网页，如 `https://news.ycombinator.com`） |

---

## 📥 客户端配置文件获取方式

系统会根据 HTTP 客户端 Request 中的 User-Agent 类型执行智能分流处理：
```bash
# 配置文件导入地址 (直接在客户端中输入此地址拉取)
https://你的域名/<SUB_PATH>?token=<SUB_TOKEN>
```
* **YAML 格式兼容客户端**：直接拉取标准的 YAML 订阅配置文件。
* **JSON 格式核心分流软件**：自动下发一键配置好的 JSON 文件。
* **标准通用格式拉取终端**：拉取标准的 Base64 节点订阅数据流。

---

## 🐳 Docker 一键部署命令行

```bash
docker run -d --name web-gateway --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-连接密钥" \
  -e API_TOKEN="你的-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的穿透域名.com" \
  -e WEB_URL="https://github.com/你的用户名/ko-vip/releases/download/<TAG>/web-engine-{arch}-v2" \
  -e PATH_A="自定义A路径" \
  -e PATH_B="自定义B路径" \
  -e SUB_PATH="自定义订阅路径" \
  node:18 sh -c "rm -rf /app && git clone https://github.com/你的用户名/ko.git /app && cd /app && npm install && node --expose-gc index.js"
```
