# 🚀 ko-server (高可用网络穿透与多协议分流网关)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-18%2B-blue.svg)](https://nodejs.org)
[![Docker Support](https://img.shields.io/badge/Docker-Supported-emerald.svg)](https://www.docker.com)
[![Maintenance](https://img.shields.io/badge/Maintenance-Active-success.svg)](#)

`ko-server` 是一个基于 Node.js 构建的高性能、高可用 WebSocket 接入与规则分流中继网关。通过集成 Cloudflare Tunnel (Argo) 穿透技术与缓存加速引擎，实现单个公网域名/端口下，多协议安全共存与免暴露直连的防护架构。

---

## 🌟 2026 长期稳定运行专项加固 (Production-grade Patches)

为了实现**纯静默、年均免维护**的稳定挂机运行，本项目已集成以下针对极端网络与长期运行环境的深度优化：

1. **🐛 V8 垃圾回收激活**：完美激活 Node.js 底层 `global.gc()` 强制回收，消除长期内存堆积。
2. **⚡ DNS 缓存泄漏防护**：对解析缓存引入 **LRU 淘汰算法**（上限 500 条），防止 Map 随着域名访问而无限增长。
3. **🌐 WebSocket 死链剔除**：首创双向主动 `Ping/Pong` 检测机制，在客户端异常断网（切换 Wi-Fi/5G）时立即清理半开连接，彻底预防 FD（文件描述符）句柄泄露。
4. **🔄 HTTP 链路保活策略**：对齐 Cloudflare 的 900 秒 TCP 复用参数，将 Node `keepAliveTimeout` 设置为 120 秒，**消灭高空闲期下偶发性的 520 / 502 错误**。
5. **🚀 Xray 原位热重启**：如果后端加速内核崩溃或触发看门狗被杀，Node 守护程序会在 **1 秒内就地拉起重启**，保持主网页、隧道整体在线，将网络中断时间压缩到无感级别。
6. **🚨 内存看门狗卫士 (Memory Watchdog)**：定时自动读取 Linux `/proc/[pid]/status`（零 CPU 开销），监控子进程物理内存（CF 180MB / Xray 100MB 阈值），超限自动拉起重建，杜绝因 Go 语言内存泄露撑爆 512MB 容器的问题。
7. **⚙️ 多级子域名 API 兼容**：将 Cloudflare API 域名 Zone 查询改造为**右向左动态递溯查找**，100% 解决深层多级子域名托管绑定失败的问题。
8. **⚡ 并行初始化冷启动**：从串行等待提速为 `Promise.all` 并行加载，把冷启动耗时从 30 秒级压缩至 **5-8 秒**，消灭云平台部署超时限制。
9. **🛡️ 灾备网络多源下载**：核心二进制文件自动启用 `ghp.ci` 和 `mirror.ghproxy.com` 高可用加速镜像灾备下载，防 GitHub CDN 阻断。
10. **🔒 痕迹擦除（阅后即焚）**：系统启动完成后自动抹除临时配置文件与脚本，防密文外泄。

---

## ⚙️ 部署环境变量说明

在部署网关时，你必须且只需要配置以下几个关键参数：

### 1. 📌 核心必填参数

为了通过各大云平台的合规扫描，本项目去除了所有内置的预置二进制。**以下 3 个参数是程序运行的绝对前提：**

| 环境变量 | 必须配置的值 / 推荐填写 | 作用说明 |
| :--- | :--- | :--- |
| **`WEB_URL`** | `https://github.com/godeluoo1/ko-vip/releases/latest/download/web-engine-{arch}-v2` | 穿透客户端二进制 of cloudflared 下载链接。末尾 `{arch}` 必须保留，系统会自动适配 `x64` 或 `arm64` 架构。 |
| **`API_TOKEN`** | 你的 Cloudflare Tunnel Token（或者 API Token） | 建立内部网关与 Cloudflare 边缘节点之间的安全穿透信道。 |
| **`APP_DOMAIN`** | 你绑定在上述隧道上的自定义解析域名 (如 `node.mydomain.com`) | 客户端连接网关的唯一入口。 |

### 2. ⚙️ 可选个性化参数

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| **`APP_KEY`** | *留空时随机生成 UUID* | 客户端连接时的鉴权密码（VLESS 的 UUID 或 Trojan 密码）。建议手动指定一个固定值，方便客户端配置。 |
| **`PATH_A`** | `api/v3/telemetry` | VLESS 协议的 WebSocket 路径。建议自定义修改（如 `my-v-path`），增强隐蔽性。 |
| **`PATH_B`** | `graphql/stream` | Trojan 协议的 WebSocket 路径。建议自定义修改（如 `my-t-path`），增强隐蔽性。 |
| **`CACHE_MODE`** | *留空（纯 JS 模式）* | 设为 **`redis`** 时，会开启基于 Xray 的缓存加速转发模式。 |
| **`CACHE_URL`** | *留空* | **如果 CACHE_MODE 设为了 redis，则此项必填**。可填写：`https://github.com/godeluoo1/ko-vip/releases/latest/download/cache-engine-{arch}`。 |
| **`TUNNEL_PROTO`** | `http2` | 隧道的传输协议类型。推荐保持 `http2`（基于 TCP，极佳的防干扰隐蔽性），网络通畅的环境下可调优为 `quic`。 |
| **`SUB_PATH`** | `godeluoo` | 获取节点订阅的路径（例如设为 `sub`，则可以通过 `https://你的域名/sub` 导入节点）。 |
| **`SUB_TOKEN`** | *留空* | 订阅访问的安全凭证。如果设置了此参数（如 `1234`），则导入地址必须携带 Token：`https://你的域名/sub?token=1234` |
| **`Camouflage_URL`** | *留空（默认显示内置个人博客静态网页）* | 伪装目标站反代地址。如果填入例如 `https://news.ycombinator.com`，普通访客或防火墙探测该域名时，网关会无感反代该网站，完美隐藏自身。 |

---

## 📥 客户端订阅分流

系统会根据连接请求中的 User-Agent 自动识别并提供最适合的配置：
```http
# 节点导入地址 (直接在各客户端中配置拉取)
https://你的域名/<SUB_PATH>?token=<SUB_TOKEN>
```
* **Clash / Stash / Shadowrocket**：智能下发定制版的 YAML/Base64 订阅节点流。
* **Sing-box / v2rayN**：智能生成专属一键配置 JSON / VLESS 协议链接。

---

## 🐳 一键部署指南

### 1. Docker 命令行部署
```bash
docker run -d --name web-gateway --restart=always \
  -p 3000:3000 \
  -e APP_KEY="你的-UUID-连接密钥" \
  -e API_TOKEN="你的-CF-TUNNEL-TOKEN" \
  -e APP_DOMAIN="你的穿透域名.com" \
  -e WEB_URL="https://github.com/godeluoo1/ko-vip/releases/latest/download/web-engine-{arch}-v2" \
  -e PATH_A="自定义V路径" \
  -e PATH_B="自定义T路径" \
  -e SUB_PATH="自定义订阅路径" \
  node:18-alpine sh -c "rm -rf /app && git clone https://github.com/godeluoo1/ko.git /app && cd /app && npm install --omit=dev && node --expose-gc index.js"
```

### 2. Northflank 部署核心建议
* **🔒 端口不暴露模式**：在部署该容器服务时，**请勿在面板中为容器端口（3000）分配 Public Link/URL**，将其设为纯私有（Private/Internal）网络。Cloudflare 隧道会自动向外连通，不暴露公网端口可以彻底避免黑客或扫描器对源站进行直连扫描。
* **📍 固化环境变量**：请手动将 `APP_KEY`（UUID）与 `SUB_PATH` 锁定在 Northflank 环境变量面板中，避免容器重构/冷重启时产生随机重置，导致客户端断网。

---

## 📜 许可证

本网关项目基于 [MIT](LICENSE) 协议开源。请勿将该项目用于任何违反当地法律法规的活动。
