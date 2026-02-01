# 发票批量识别（Vite + Fastify）

## 功能概览
- 批量上传 PDF 发票
- 自动识别：项目名称、数量、金额、购买方名称、销售方名称、发票号码、开票日期
- 结果列表展示，支持导出 CSV / XLSX
- 先解析 PDF 文本层，缺失字段时自动切换 OCR

## 本地开发（Windows）

### 1) 前端
```bash
cd web
npm install
npm run dev
```

### 2) 后端
```bash
cd server
copy .env.example .env
npm install
npm run dev
```

在 `server/.env` 中填写百度 OCR 的 Key：
```
BAIDU_API_KEY=你的APIKey
BAIDU_SECRET_KEY=你的SecretKey
```

前端默认请求 `/api`，Vite 已配置开发代理到 `http://localhost:3001`。

## Docker 部署（VPS）

### 1) 准备环境变量
```bash
copy server\.env.example server\.env
```
编辑 `server/.env` 填入百度 OCR Key。

### 2) 启动容器
```bash
docker compose up -d --build
```

默认会在 80 端口对外服务。

## HTTPS（推荐）
建议在 VPS 上使用 Nginx + Certbot 申请证书。可选流程：
1. 域名 A 记录指向 VPS 公网 IP
2. 安装 Certbot（或使用 Nginx 官方镜像 + Certbot 容器）
3. 将证书挂载到 Nginx，并添加 443 监听

如需我提供完整的 HTTPS/Nginx/证书续签配置，告诉我域名即可。

## 目录结构
```
web/        # Vite 前端
server/     # Fastify OCR 代理
nginx/      # Nginx 配置
```
