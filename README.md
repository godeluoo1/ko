# ko

极致精简的云原生边缘 Ingress 流量分流器与静态博客服务 — 原生 Node.js 内存分流，支持双向流式高性能 Web 数据转发与 0-RTT 早期数据响应，内建自适应背压控制，集成 Argo 隧道自愈防崩溃，零磁盘残留。

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
| **极致性能与无痕** | 纯 Node.js 内存拦截解析高性能数据转发，免去任何第三方二进制写盘，零文件特征残留，极度轻量。 |
| **极速鉴权比对** | 采用全局启动时 UUID 二进制缓存与 Trojan 哈希预计算，避开每次连接握手的 CPU 密集型字符串循环与实时哈希运算，握手校验交由底层 C++ 快速 Buffer 比较处理，响应极其灵敏。 |
| **极致稳定 (防重启)** | Argo 隧道进程异常退出退避守护（10秒后台自愈重连），Node 进程常驻运行在外部映射端口（如 3008），彻底切断因隧道网络瞬断而导致的容器无限重启和代码丢失。 |
| **自适应数据分流** | 系统根据传入流量路径，自动将 Web 静态渲染与加密数据中转管道分离，大幅隐蔽 TLS 频繁握手的指纹特征。 |
| **0-RTT 极速启动** | 服务端原生提取并解码 WebSocket 早期数据（Early Data），进行前置拼包合流，让首包时延直接砍半。 |
| **主动探测防御** | 对非法探测流量执行随机 150ms~600ms 的伪装延迟，并回吐高端拟物静态个人博客 HTML，零漏入特征。 |

## 环境变量

### 必填

| 变量 | 说明 |
|------|------|
| `APP_KEY` | 系统运行与安全数据校验密钥 (UUID)（必须手动设置，无默认值） |
| `API_TOKEN` | Cloudflare Tunnel Token 或 JSON 凭证（不支持临时隧道） |
| `APP_DOMAIN` | Tunnel 绑定的服务域名（如 `service.example.com`） |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | Web 服务和伪装主页监听端口 |
| `BACKEND_PORT` | `8001` | 后端数据分流端口 |
| `TUNNEL_PROTO` | `http2` | Tunnel 传输协议（`http2` / `quic`） |
| `CDN_HOST` | `saas.sin.fan` | 优选接入节点 / 域名 |
| `CDN_PORT` | `443` | 优选接入端口 |
| `NAME` | `Vls` | 服务备注名称前缀 |
| `SUB_PATH` | `godeluoo` | 数据查询与健康检查路径（无前导 `/`） |
| `FILE_PATH` | `.tmp` | 运行时临时数据目录 |
| `FP` | `chrome` | 浏览器 TLS 指纹模拟类型 |
| `EDGE_IP_VERSION` | `auto` | Tunnel 边缘 IP 版本 |

## 数据同步与健康检查

```
https://<APP_DOMAIN>/<SUB_PATH>
```

默认路径：`/godeluoo`。服务会根据客户端请求 of User-Agent 智能进行格式适配：
1. **通用文本流**：返回经过 Base64 编码的轻量级连接信息列表。
2. **结构化 YAML 流**：直接生成符合特定分析器规范的完整 YAML 格式系统运维配置文件。

## 稳定特性

| 特性 | 说明 |
|------|------|
| 隧道自愈重试 | `cloudflared` 子进程退出后，主程序启动 10s 倒计时静默拉起，不引发 Node 崩溃退出。 |
| 优雅关闭 | SIGTERM → 5s 超时 → SIGKILL，清理所有子进程，资源不泄漏。 |
| 优雅兜底 | `uncaughtException` / `unhandledRejection` 均触发退出。 |
| 自动保活 | 随机时间间隔（4~8分钟）自保活访问模拟流量。 |

## Docker 部署

```bash
docker run -d --name ko-service --restart=always \
  -e APP_KEY="你的UUID" \
  -e API_TOKEN="你的Tunnel-Token" \
  -e APP_DOMAIN="service.example.com" \
  -e NAME="MyNode" \
  node:18 sh -c "rm -rf /app && (git clone https://github.com/godeluoo1/ko.git /app || (echo 'Clone failed, waiting for manual code sync...' && while [ ! -f /app/index.js ]; do sleep 2; done)) && cd /app && npm install && node --expose-gc index.js"
```

## 安全提示

- **切勿**使用默认 UUID，务必生成唯一值
- **切勿**在公开仓库暴露 `API_TOKEN`
- `SUB_PATH` 建议修改为难以猜测的自定义路径
- 配置文件包含敏感鉴权信息，请妥善保管，不要分享
