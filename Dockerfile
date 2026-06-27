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

# 创建临时运行目录并设置权限
RUN mkdir -p .tmp && chown -R node:node /app

# 从第一阶段中，只把混淆好的文件复制过来，重命名为 index.js
COPY --from=builder --chown=node:node /app/index.obfuscated.js ./index.js
COPY --chown=node:node blog.html ./blog.html

EXPOSE 3000/tcp

# 切换为安全的非 root 用户运行
USER node

# 保留 --optimize-for-size，为小内存容器做极致的 V8 引擎调优
CMD ["node", "--max-old-space-size=64", "--optimize-for-size", "index.js"]
