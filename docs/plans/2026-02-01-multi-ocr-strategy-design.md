# 多 OCR 方案三层降级识别设计

**日期**: 2026-02-01
**主题**: 集成 PaddleOCR + 云服务 API 的三层降级识别策略
**目标**: 提供免费、高效、准确的发票 OCR 识别方案

---

## 项目概述

在现有百度 + 腾讯 OCR 的基础上，新增 PaddleOCR（本地）和 Google Vision API（高准度备选），实现自动化三层降级策略：
- **第一层（快速）**: PaddleOCR 本地识别，响应 < 500ms
- **第二层（备用）**: 用户优先级配置的云服务（百度/腾讯）
- **第三层（保险）**: Google Vision API，准确率 98%+

---

## 识别策略

### 三层降级流程

```
用户上传 PDF
    ↓
PDF.js 文本层提取（现有逻辑）
    ↓
关键字段不完整？
    ↓ 是
启用 OCR 识别
    ↓
PaddleOCR 本地识别
    ├─ 成功 & 置信度 ≥ 80% → 返回结果 ✅
    ├─ 成功 & 置信度 < 80% → 进入第二层
    └─ 失败或异常 → 进入第二层
    ↓
第二层：调用用户优先级中的首个云服务
    ├─ 百度 OCR
    ├─ 腾讯 OCR
    ├─ Google Vision
    ├─ 成功 & 置信度 ≥ 80% → 返回结果 ✅
    ├─ 成功 & 置信度 < 80% → 尝试下一个
    └─ 失败或异常 → 尝试下一个
    ↓
全部尝试完毕
    ├─ 有可用结果 → 返回最高置信度的结果
    └─ 无可用结果 → 返回错误提示 + 手动编辑选项
```

### 置信度阈值策略

- **默认阈值**: 0.8（80%）
- **用户可配置**: 滑块调节 0.5 - 1.0
- **计算方式**: 6 个目标字段的平均置信度
- **触发降级**: 任何字段缺失或整体置信度 < 设定阈值

---

## 系统架构

### 后端改动

#### 新增依赖
```json
{
  "paddleocr": "^1.3.0",
  "google-cloud-vision": "^3.0.0"
}
```

#### 新增接口: `/api/ocr/paddle`

**请求体:**
```json
{
  "imageBase64": "data:image/jpeg;base64,...",
  "language": "ch"
}
```

**响应体:**
```json
{
  "success": true,
  "data": {
    "invoiceNumber": "123456789",
    "invoiceDate": "2024-01-15",
    "buyerName": "ABC 公司",
    "sellerName": "XYZ 供应商",
    "itemName": "服务费用",
    "totalAmount": "10000.00"
  },
  "meta": {
    "source": "paddle",
    "overallConfidence": 0.92,
    "fieldConfidences": {
      "invoiceNumber": 0.98,
      "invoiceDate": 0.95,
      "buyerName": 0.88,
      "sellerName": 0.92,
      "itemName": 0.85,
      "totalAmount": 0.96
    },
    "executionTime": "320ms",
    "fallbackReason": null
  }
}
```

#### 修改现有接口: `/api/ocr/baidu/vat`

**新增参数:**
- `source`: 指定识别来源（"paddle" | "baidu" | "tencent" | "google"，可选）
- `skipPaddle`: 跳过 PaddleOCR（默认 false）
- `googleApiKey`: Google Vision API 密钥
- `googleProjectId`: Google 项目 ID
- `confidenceThreshold`: 置信度阈值（默认 0.8）

**响应体新增:**
- `source`: 识别来源
- `overallConfidence`: 整体置信度
- `fieldConfidences`: 各字段置信度详情
- `fallbackReason`: 降级原因（如果有的话）

#### 后端实现要点

1. **PaddleOCR 初始化**
   - 在服务启动时初始化一次模型
   - 模型文件缓存，避免重复加载
   - 使用连接池管理实例

2. **置信度计算**
   ```javascript
   const overallConfidence =
     Object.values(fieldConfidences)
       .filter(c => c !== undefined)
       .reduce((a, b) => a + b, 0) /
     Object.values(fieldConfidences)
       .filter(c => c !== undefined).length
   ```

3. **字段有效性检查**
   - 至少识别出 4 个关键字段，否则触发降级
   - 缺失字段的置信度记为 0

4. **环境变量**
   - `CONFIDENCE_THRESHOLD`: 置信度阈值（默认 0.8）
   - `PADDLE_TIMEOUT_MS`: PaddleOCR 超时时间（默认 5000ms）
   - `GOOGLE_CREDENTIALS`: Google 服务账户 JSON 路径

### 前端改动

#### 扩展 OcrConfig 类型

```typescript
type OcrConfig = {
  // 现有配置
  providers: ProviderId[]
  allowFallback: boolean
  baiduApiKey?: string
  baiduSecretKey?: string
  tencentSecretId?: string
  tencentSecretKey?: string
  tencentRegion?: string

  // 新增配置
  googleApiKey?: string
  googleProjectId?: string
  confidenceThreshold?: number  // 默认 0.8
  enablePaddle?: boolean  // 默认 true
  paddleLanguage?: 'ch' | 'en'  // 默认 'ch'
  priorityOrder?: ('paddle' | 'baidu' | 'tencent' | 'google')[]
}
```

#### UI 改进

1. **OCR 配置面板扩展**
   - Google Vision API KEY 输入框（密码字段）
   - Google Project ID 输入框
   - 置信度阈值调节滑块（0.5 - 1.0）
   - OCR 优先级排序（拖拽调整）
   - "验证 API" 按钮（测试各方案连接）

2. **识别结果显示**
   - 显示识别来源（"PaddleOCR 本地识别"、"百度 OCR"等）
   - 显示整体置信度百分比（如"置信度 92%"）
   - 显示各字段置信度（可选，开发者模式）
   - 低置信度字段标记红色（< 70%）

3. **用户交互**
   - 提供"手动修正"按钮修改识别结果
   - 提供"重新识别"按钮重新调用 OCR
   - 配置保存到 localStorage，不上传服务器

---

## 目标字段映射

### 统一字段定义

```typescript
type InvoiceFields = {
  invoiceNumber: string      // 发票号码（必需，≥ 8 位数字）
  invoiceDate: string        // 开票日期（格式: YYYY-MM-DD）
  buyerName: string          // 购买方名称
  sellerName: string         // 销售方名称
  itemName: string           // 项目名称
  totalAmount: string        // 价税合计金额
}
```

### 识别后的映射规则

| 目标字段 | PaddleOCR 关键词 | 百度 API 字段 | 腾讯 API 字段 | Google 处理方式 |
|---------|-----------------|-------------|-------------|----------------|
| `invoiceNumber` | "发票号码" | `invoiceNumber` | `invoiceNumber` | 正则提取 8+ 数字 |
| `invoiceDate` | "开票日期" | `invoiceDate` | `invoiceDate` | 正则提取日期 |
| `buyerName` | "购买方" | `buyerName` | `buyerName` | 关键词后的文本 |
| `sellerName` | "销售方"/"供应商" | `sellerName` | `sellerName` | 关键词后的文本 |
| `itemName` | "货物/服务名称" | 取前三项商品名 | `itemName` 取首项 | 行项目描述 |
| `totalAmount` | "合计" | `totalAmount` | `totalAmount` | 正则提取金额 |

---

## 错误处理与回退

### API 调用失败处理

| 场景 | 处理方案 |
|------|--------|
| PaddleOCR 超时（>5s） | 自动跳过，进入第二层 |
| PaddleOCR 异常崩溃 | 捕获异常，进入第二层 |
| 百度/腾讯认证失败 | 提示用户重新配置 API KEY |
| Google 配额用尽（429） | 自动跳过，尝试其他方案 |
| 网络异常 | 重试 2 次，失败后提示错误 |
| 全部方案失败 | 返回错误提示 + 手动编辑选项 |

### 日志记录

- 后端记录每次 OCR 调用：`logs/ocr-{timestamp}.json`
- 包含：请求来源、使用方案、置信度、耗时、错误信息
- 前端可选地显示调试信息（开发者模式）

---

## 实现阶段规划

### 第一阶段（必需）

1. **后端 PaddleOCR 集成**
   - 安装依赖并初始化模型
   - 实现 `/api/ocr/paddle` 接口
   - 编写置信度计算逻辑
   - 支持中文识别

2. **修改现有 OCR 接口**
   - 修改 `/api/ocr/baidu/vat` 支持新参数
   - 实现三层降级逻辑
   - 返回统一格式（source + confidence）

3. **前端配置面板扩展**
   - 添加 Google Vision API KEY 输入框
   - 添加置信度阈值调节滑块
   - 显示识别来源和置信度

### 第二阶段（可选）

4. Google Vision API 集成（后端）
5. API 验证测试功能
6. 详细日志和调试面板

### 第三阶段（优化）

7. 缓存优化（同一 PDF 避免重复识别）
8. 性能监控和统计
9. 批量识别优化

---

## 技术依赖

### 后端新增

```json
{
  "paddleocr": "^1.3.0",
  "google-cloud-vision": "^3.0.0"
}
```

### 前端无需新增

（已有所有必需库：React、PDF.js、axios 等）

---

## 关键实现要点

### 环境变量配置

```bash
# .env 文件示例
CONFIDENCE_THRESHOLD=0.8
PADDLE_TIMEOUT_MS=5000
PADDLE_LANGUAGE=ch
GOOGLE_CREDENTIALS=/path/to/service-account.json

# 现有配置保持不变
BAIDU_API_KEY=xxx
BAIDU_SECRET_KEY=xxx
```

### Docker 构建优化

- 在 Dockerfile 中预加载 PaddleOCR 模型（避免容器启动延迟）
- 增加 500MB 存储空间预留（PaddleOCR 模型）
- 后端镜像大小预计增加 ~300MB

### 性能指标

| 方案 | 响应时间 | 准确率 | 成本 |
|------|--------|-------|------|
| PaddleOCR（本地） | 300-500ms | 90% | 免费 |
| 百度 OCR | 1-2s | 95% | 已有 |
| 腾讯 OCR | 1-2s | 94% | 已有 |
| Google Vision | 2-3s | 98% | 免费（1000 次/月） |

---

## 用户配置流程

1. 打开 OCR 配置面板
2. 启用/禁用各个 OCR 方案
3. 输入对应的 API KEY（localStorage 存储，不上传）
4. 调整识别优先级（拖拽排序）
5. 设置置信度阈值
6. 点击"验证 API"测试连接
7. 保存配置

---

## 成功标准

- ✅ PaddleOCR 本地识别响应 < 500ms
- ✅ 三层降级逻辑自动执行，用户无感知
- ✅ 置信度计算准确，≥ 80% 时大部分识别正确
- ✅ 支持用户自定义 API KEY 和优先级
- ✅ 识别失败时有清晰的错误提示
- ✅ 日志记录完整，便于调试

---

## 参考资源

- PaddleOCR 文档: https://github.com/PaddlePaddle/PaddleOCR
- Google Cloud Vision: https://cloud.google.com/vision/docs
- 现有项目文档: `CLAUDE.md`
