# ko

极致精简的免费 PaaS 容器代理节点方案 — 仅 VLESS-WS + Early Data，自编译内核，零妥协防风控。

## 架构

```
┌────────┐      ┌────────┐      ┌─────────────┐      ┌──────────┐      ┌────────┐
│ Client │─TLS─▶│ CF CDN │─────▶│ CF Tunnel   │─────▶│   Xray   │─────▶│ Target │
│        │      │        │      │(cloudflared)│      │(VLESS-WS)│      │        │
└────────┘      └────────┘      └─────────────┘      └──────────┘      └────────┘
                                                      127.0.0.1:8001
```

## 核心设计原则

| 原则 | 实现 |
|------|------|
| 极致速度 | Xray 自编译精简版（最小功能集 + strip + UPX）|
| 极致稳定 | 子进程崩溃即退出，依赖平台自动重启；优雅关闭 |
| 极致防风控 | 全链路伪装，二进制阅后即焚，零磁盘残留 |
| 单一协议 | 仅 VLESS-WS + Early Data，攻击面最小 |
| 私有供应链 | 全部二进制来自 [ko-vip](https://github.com/godeluoo1/ko-vip) 自编译 |

## 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `APP_KEY` | VLESS UUID（必须手动设置，无默认值） |
| `API_TOKEN` | Cloudflare Tunnel Token 或 JSON 凭证（不支持临时隧道） |
| `APP_DOMAIN` | Tunnel 绑定的域名（如 `proxy.example.com`） |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | Web 服务监听端口 |
| `BACKEND_PORT` | `8001` | Xray 监听端口 |
| `TUNNEL_PROTO` | `http2` | Tunnel 传输协议（`http2` / `quic`） |
| `CDN_HOST` | `saas.sin.fan` | 优选 IP / 域名 |
| `CDN_PORT` | `443` | 优选端口 |
| `NAME` | `Vls` | 节点备注名 |
| `SUB_PATH` | `godeluoo` | 订阅路径（无前导 `/`） |
| `FILE_PATH` | `.tmp` | 运行时临时目录 |
| `FP` | `chrome` | TLS 指纹 |
| `EDGE_IP_VERSION` | `auto` | Tunnel 边缘 IP 版本 |

## 订阅地址

```
https://<APP_DOMAIN>/<SUB_PATH>
```

默认路径：`/godeluoo`，返回 Base64 编码的 VLESS 分享链接。

## 安全特性（防风控）

| 层级 | 措施 | 说明 |
|------|------|------|
| 进程 | 标题伪装 | `process.title = 'npm start'` |
| 环境变量 | 通用命名 | `APP_KEY` / `API_TOKEN` / `APP_DOMAIN`，无代理关键字 |
| HTTP | Nginx 深度伪装 | 所有路由返回 `nginx/1.27.3` 风格 404 |
| HTTP | 随机延迟 | 响应延迟 1–15ms，模拟真实后端 |
| HTTP | robots.txt | `Disallow: /`，阻止爬虫 |
| 文件系统 | 路径随机化 | 二进制名 / 配置名全随机 |
| 文件系统 | 阅后即焚 | 启动 15s 后删除所有二进制和配置文件 |
| 文件系统 | 启动清理 | 每次启动先清空临时目录 |
| 订阅 | 内存缓存 | 订阅内容仅存内存，不写盘 |
| 保活 | 路径随机化 | 随机访问 `/` `/index.html` `/about` 等，模拟真实站点流量 |
| 保活 | 间隔随机 | 4–8 分钟随机间隔 |

## 稳定特性

| 特性 | 说明 |
|------|------|
| Crash-Exit 策略 | 子进程异常退出 → 主进程退出 → 平台自动重启容器 |
| 优雅关闭 | SIGTERM → 5s 超时 → SIGKILL，资源不泄漏 |
| 下载容错 | 多源重试，支持 fallback |
| 异常兜底 | `uncaughtException` / `unhandledRejection` 均触发退出 |
| 防休眠 | 自保活 HTTP 请求，防止免费平台休眠容器 |

## VLESS 节点参数

手动配置客户端时使用以下参数：

| 参数 | 值 |
|------|-----|
| 协议 | VLESS |
| 地址 | `CDN_HOST`（默认 `saas.sin.fan`） |
| 端口 | `CDN_PORT`（默认 `443`） |
| UUID | `APP_KEY` 的值 |
| 加密 | `none` |
| 传输 | `ws` |
| Host | `APP_DOMAIN` 的值 |
| Path | `/api/v3/telemetry?ed=2560` |
| TLS | 开启 |
| SNI | `APP_DOMAIN` 的值 |
| 指纹 | `FP`（默认 `chrome`） |

## Cloudflare Dashboard 配置

1. **创建 Tunnel**：Cloudflare Zero Trust → Networks → Tunnels → Create
2. **获取 Token**：创建后复制 Token，填入 `API_TOKEN`
3. **添加 Public Hostname**：
   - Subdomain：自定义（如 `proxy`）
   - Domain：你的域名
   - Service：`http://localhost:8001`（即 `BACKEND_PORT`）
4. **DNS**：确保对应子域名已被 Tunnel 自动创建 CNAME 记录

> JSON 凭证模式：将含 `TunnelSecret` 的 JSON 整体填入 `API_TOKEN`，系统自动识别。

## Docker 部署

```bash
docker run -d --restart=always \
  -e APP_KEY="你的UUID" \
  -e API_TOKEN="你的Tunnel-Token" \
  -e APP_DOMAIN="proxy.example.com" \
  -e NAME="MyNode" \
  ghcr.io/godeluoo1/ko:latest
```

## 安全提示

- **切勿**使用默认 UUID，务必生成唯一值
- **切勿**在公开仓库暴露 `API_TOKEN`
- `SUB_PATH` 建议修改为难以猜测的自定义路径
- 订阅链接包含全部连接信息，妥善保管，不要分享
