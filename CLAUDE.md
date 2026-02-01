# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个批量发票识别系统，支持上传 PDF 发票，自动识别发票信息（项目名称、数量、金额、购买方/销售方名称、发票号码、开票日期），并导出为 CSV/XLSX 格式。

系统采用前后端分离架构：
- 前端：Vite + React + TypeScript + PDF.js（解析 PDF 文本层）
- 后端：Fastify + Node.js（OCR 代理服务）
- 支持 OCR 服务商：百度 OCR、腾讯云 OCR（阿里云配置已预留）

## 常用命令

### 前端开发
```bash
cd web
npm install          # 安装依赖
npm run dev          # 启动开发服务器（端口 5273）
npm run build        # 构建生产版本
npm run lint         # 代码检查
npm run preview      # 预览构建结果
```

### 后端开发
```bash
cd server
copy .env.example .env    # 创建环境变量文件
npm install          # 安装依赖
npm run dev          # 启动开发服务器（端口 3001，使用 --watch 热重载）
npm start            # 启动生产服务器
```

### Docker 部署
```bash
docker compose up -d --build   # 构建并启动所有服务
docker compose down            # 停止所有服务
```

## 项目架构

### 整体架构

```
fapiao/
├── web/                # 前端应用（React + Vite）
│   ├── src/
│   │   ├── App.tsx     # 主应用组件，处理文件上传、OCR 调用、结果展示
│   │   └── main.tsx
│   ├── vite.config.ts  # Vite 配置（代理设置、PDF.js Worker 配置）
│   ├── eslint.config.js
│   └── package.json
├── server/             # 后端服务（Fastify）
│   ├── src/
│   │   └── index.js    # 主服务器文件，包含所有 OCR 代理逻辑
│   ├── .env.example
│   └── package.json
├── nginx/              # Nginx 配置
├── docker-compose.yml
└── README.md
```

### 数据流

1. **前端处理流程**（`web/src/App.tsx`）：
   - 用户上传 PDF 文件
   - 使用 PDF.js 解析 PDF 文本层（优先）
   - 如果文本层无法提取关键字段，触发 OCR 调用
   - 将 PDF 渲染为图片（Canvas）后调用后端 OCR 接口
   - 合并文本层解析结果和 OCR 结果
   - 显示识别结果，支持导出 CSV/XLSX

2. **后端 OCR 代理**（`server/src/index.js`）：
   - 接收前端发来的图片/PDF Base64 数据
   - 使用 p-queue 进行并发控制（默认 2）
   - 按用户配置的顺序调用 OCR 服务商（百度/腾讯）
   - 支持服务商自动切换兜底
   - 将腾讯云 OCR 结果映射为百度格式
   - 返回统一格式的识别结果

### 关键模块说明

#### 前端数据结构和主要逻辑

**核心类型定义**（`web/src/App.tsx`）：
```typescript
type InvoiceRecord = {
  id: string
  sourceFile: string
  invoiceNumber?: string
  invoiceDate?: string
  buyerName?: string
  sellerName?: string
  totalAmount?: string
  items: LineItem[]
  isToll?: boolean  // 是否为通行费发票
}

type OcrConfig = {
  providers: ProviderId[]
  allowFallback: boolean
  baiduApiKey?: string
  baiduSecretKey?: string
  tencentSecretId?: string
  tencentSecretKey?: string
  tencentRegion?: string
  aliyunAccessKeyId?: string
  aliyunAccessKeySecret?: string
  aliyunRegion?: string
  ocrSpaceApiKey?: string
}
```

**关键函数逻辑**：
- PDF.js Worker 配置（全局）：`GlobalWorkerOptions.workerPort = new worker()`
- 文本规范化：`normalizeValue()`, `currencyClean()` 处理各种格式的数据
- 中文数字转换：`parseChineseAmount()` 处理中文大写金额
- 发票号码验证：`normalizeInvoiceNumber()` 确保最少 8 位数字
- 并发管理：`fileLimit = pLimit(2)` 限制同时处理的文件数

#### 后端关键函数

- `signTencentRequest()`：腾讯云 API 签名（TC3-HMAC-SHA256）
- `callTencentVatInvoice()`：调用腾讯云增值税发票 OCR
- `mapTencentVatToBaidu()`：将腾讯云响应映射为百度格式
- `getAccessToken()`：获取百度 access_token（带缓存）
- `callBaiduOcr()` / `callBaiduGeneralOcr()` / `callBaiduMultipleInvoice()`：百度 OCR 调用
- `writeOcrLog()`：将 OCR 响应写入日志文件用于调试

## 环境变量

### 后端必需变量
- `BAIDU_API_KEY`：百度 OCR API Key
- `BAIDU_SECRET_KEY`：百度 OCR Secret Key

### 后端可选变量
- `PORT`：服务端口（默认 3001）
- `HOST`：监听地址（默认 0.0.0.0）
- `MAX_CONCURRENCY`：最大并发数（默认 2）
- `MAX_QUEUE_SIZE`：最大队列长度（默认 20）
- `OCR_TIMEOUT_MS`：OCR 请求超时（默认 20000ms）
- `OCR_LOG_DIR`：OCR 日志目录（默认 logs）
- `BAIDU_OCR_ACCURACY`：百度 OCR 精度（可选值：high）

### 前端配置（通过 UI 或 localStorage）
- OCR 服务商选择（百度/腾讯/阿里云）
- 百度/腾讯/阿里云 API 密钥
- 失败后是否自动切换服务商

## API 接口

### POST /api/ocr/baidu/vat

批量识别增值税发票。

**请求体：**
```json
{
  "images": ["base64_jpeg..."],
  "pdfBase64": "base64_pdf...",
  "fileName": "invoice.pdf",
  "provider": "baidu",
  "providers": ["baidu", "tencent"],
  "allowFallback": true,
  "credentials": {
    "baiduApiKey": "...",
    "baiduSecretKey": "...",
    "tencentSecretId": "...",
    "tencentSecretKey": "...",
    "tencentRegion": "ap-beijing"
  }
}
```

**响应：**
```json
{
  "words_result": [{...}],
  "multiple_words_result": [...],
  "general_words_result": [...],
  "meta": {
    "usedProviders": [{"provider": "baidu", "status": "used"}]
  }
}
```

### GET /health

健康检查接口，返回 `{ "status": "ok" }`

## 开发注意事项

### 前端特定信息

- **Vite 开发代理**：`vite.config.ts` 配置了 `/api` 到 `http://localhost:3001` 的代理（带 `changeOrigin: true` 和重写规则）
- **PDF.js Worker**：通过 Vite 插件动态导入 (`import worker from 'pdfjs-dist/build/pdf.worker?worker'`)
- **localStorage 密钥**：OCR 配置存储在 `ocr-config` 键，不会发送到服务端
- **并发控制**：使用 `p-limit` 库限制文件处理并发（默认 2）
- **导出功能**：使用 `papaparse` (CSV) 和 `xlsx` 库处理导出
- **ESLint 配置**：使用平面配置格式，启用 React Hooks 和 React Refresh 规则

### 后端特定信息

- **Fastify 框架**：已启用日志（使用 `fastify.log`），CORS 已配置 (`origin: true`)
- **并发队列**：使用 `p-queue` 库实现（默认并发数 2，最大队列 20）
- **百度 access_token 缓存**：在内存中缓存，过期前 60 秒自动刷新
- **OCR 响应日志**：写入 `logs/ocr-{timestamp}-{filename}.json` 用于调试
- **请求超时**：默认 20000ms，超时返回 502 错误
- **腾讯云签名**：使用 TC3-HMAC-SHA256 算法，签名头中包含时间戳和凭证范围

### OCR 服务商切换逻辑

1. 优先使用用户指定的 `provider`
2. 如果 `allowFallback=true` 且结果不完整，尝试其他服务商
3. 百度 OCR 错误码 282103/282102 会尝试切换到 multiple_invoice 或通用 OCR
4. 最终返回所有有效结果，前端选择最佳记录

## 关键技术细节

### PDF 处理

- 优先使用 PDF 文本层提取（通过 `pdfjs-dist` 的 `getDocument()` 和 `getTextContent()` API）
- 如果文本层提取失败或不完整，使用 Canvas 将 PDF 页面渲染为 JPEG 图片
- 多页 PDF 会逐页处理，使用并发控制管理

### 发票字段识别

- **优先级**：文本层解析 < OCR 结果（OCR 结果覆盖）
- **字段清理**：通过正则表达式和多个规范化函数处理各种格式变体
- **数据验证**：发票号需至少 8 位数字，空值或纯标点符号被过滤
- **通行费发票**：通过关键词检测，单独处理（不识别项目明细）

### Docker 构建

- **前端**：Node 20 编译，输出 dist 挂载到 Nginx（多阶段构建优化大小）
- **后端**：Node 20 运行，包含完整依赖，暴露端口 3001
- **docker-compose**：后端 (api) 和前端 (web) 组件，前端依赖后端启动

## 字符编码

- 所有源代码文件使用 UTF-8 编码
- 前后端通信使用 JSON，默认 UTF-8
- 发票字段中包含中文，确保处理时使用正确的编码
