# ===== 阶段 1: 临时编译容器（专门用来搞混淆） =====
FROM node:alpine AS builder
WORKDIR /app
COPY index.js ./
# 仅在编译阶段临时安装混淆器进行混淆，产出 index.obfuscated.js
RUN npm install -g javascript-obfuscator && \
    javascript-obfuscator index.js --output index.obfuscated.js --string-array true --string-array-encoding 'base64'

# ===== 阶段 2: 极致精简的生产运行容器 =====
FROM node:alpine
WORKDIR /app

COPY package.json ./
# 仅安装生产运行依赖（不包含任何混淆器相关的庞大开发依赖）
RUN npm install --omit=dev && npm cache clean --force

# 创建运行目录并提前下载官方 Linux amd64 版本的 cloudflared 二进制，赋予执行权限
RUN mkdir -p .tmp && \
    wget -qO .tmp/cf-bin https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
    chmod +x .tmp/cf-bin

# 从第一阶段中，只把混淆好的文件复制过来，重命名为 index.js
COPY --from=builder /app/index.obfuscated.js ./index.js

EXPOSE 3000/tcp

# 保留 --optimize-for-size，为小内存容器做极致的 V8 引擎调优
CMD ["node", "--max-old-space-size=64", "--optimize-for-size", "index.js"]
