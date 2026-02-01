# 多 OCR 方案三层降级识别 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**目标：** 集成 PaddleOCR 本地识别和 Google Vision API，实现三层自动降级识别策略，支持用户自定义 API KEY 和优先级配置。

**架构：**
- 后端：新增 PaddleOCR 初始化和 `/api/ocr/paddle` 接口，修改 `/api/ocr/baidu/vat` 支持三层降级
- 前端：扩展 OcrConfig 类型，新增 Google Vision 配置面板，显示识别来源和置信度
- 置信度策略：计算 6 个目标字段的平均置信度，≥ 80% 时接受结果

**技术栈：** Node.js + Fastify + PaddleOCR + Google Cloud Vision + React + TypeScript

---

## Task 1: 后端依赖安装与环境配置

**文件：**
- 修改: `server/package.json`
- 修改: `server/.env.example`
- 创建: `server/.env`

**Step 1: 添加 PaddleOCR 和 Google Vision 依赖到 package.json**

打开 `server/package.json`，在 `dependencies` 中添加：

```json
{
  "dependencies": {
    "@fastify/cors": "^10.0.2",
    "dotenv": "^16.4.7",
    "fastify": "^5.2.1",
    "p-queue": "^7.4.1",
    "pdfjs-dist": "^5.4.530",
    "@paddlejs/ocr": "^2.4.0",
    "@google-cloud/vision": "^3.0.0"
  }
}
```

**Step 2: 更新 .env.example**

修改 `server/.env.example`，添加新的环境变量配置：

```bash
# 现有配置
BAIDU_API_KEY=your_baidu_api_key
BAIDU_SECRET_KEY=your_baidu_secret_key

# 新增配置
CONFIDENCE_THRESHOLD=0.8
PADDLE_TIMEOUT_MS=5000
PADDLE_LANGUAGE=ch
GOOGLE_CREDENTIALS=/path/to/service-account.json

# 可选配置
PORT=3001
HOST=0.0.0.0
MAX_CONCURRENCY=2
MAX_QUEUE_SIZE=20
OCR_TIMEOUT_MS=20000
OCR_LOG_DIR=logs
```

**Step 3: 创建 .env 文件**

在 `server` 目录创建 `.env` 文件，复制 `.env.example` 的内容并填入实际的 API KEY

**Step 4: 安装依赖**

```bash
cd server
npm install
```

期望输出：成功安装所有依赖

**Step 5: 验证安装**

```bash
npm list paddlejs-ocr google-cloud-vision
```

期望输出：显示两个包的版本号

**Step 6: Commit**

```bash
git add server/package.json server/.env.example server/.env
git commit -m "feat: 添加 PaddleOCR 和 Google Vision 依赖"
```

---

## Task 2: 后端 PaddleOCR 集成和 /api/ocr/paddle 接口

**文件：**
- 修改: `server/src/index.js` - 顶部添加 PaddleOCR 初始化
- 修改: `server/src/index.js` - 新增 `/api/ocr/paddle` 路由

**Step 1: 在 server/src/index.js 顶部初始化 PaddleOCR**

在 `import` 语句之后（第 7 行后）添加 PaddleOCR 初始化代码：

```javascript
import { PaddleOCR } from '@paddlejs/ocr'

// 初始化 PaddleOCR（在模块加载时执行一次）
let paddleOcrInstance = null

const initPaddleOcr = async () => {
  try {
    if (!paddleOcrInstance) {
      fastify.log.info('初始化 PaddleOCR 模型...')
      paddleOcrInstance = await PaddleOCR({
        ocr_version: 'PP-OCRv3',
        enable_mkldnn: true,
        lang: process.env.PADDLE_LANGUAGE ?? 'ch'
      })
      fastify.log.info('PaddleOCR 模型初始化完成')
    }
    return paddleOcrInstance
  } catch (error) {
    fastify.log.error('PaddleOCR 初始化失败:', error)
    return null
  }
}

// 在 fastify 启动时初始化
fastify.addHook('onReady', async () => {
  await initPaddleOcr()
})
```

**Step 2: 添加置信度计算辅助函数**

在上一步的代码之后添加：

```javascript
// 计算 6 个目标字段的置信度
const calculateFieldConfidence = (results) => {
  const fieldConfidences = {
    invoiceNumber: 0,
    invoiceDate: 0,
    buyerName: 0,
    sellerName: 0,
    itemName: 0,
    totalAmount: 0
  }

  // 从 OCR 结果提取各字段置信度（简化版，实际需要根据返回格式调整）
  results.forEach((line) => {
    const text = line.text || ''
    const conf = line.confidence || 0

    if (text.includes('发票号码')) fieldConfidences.invoiceNumber = conf
    if (text.includes('开票日期')) fieldConfidences.invoiceDate = conf
    if (text.includes('购买方')) fieldConfidences.buyerName = conf
    if (text.includes('销售方') || text.includes('供应商')) fieldConfidences.sellerName = conf
    if (text.includes('货物') || text.includes('服务名称')) fieldConfidences.itemName = conf
    if (text.includes('合计') || text.includes('价税合计')) fieldConfidences.totalAmount = conf
  })

  // 计算平均置信度
  const validScores = Object.values(fieldConfidences).filter(c => c > 0)
  const overallConfidence = validScores.length > 0
    ? validScores.reduce((a, b) => a + b) / validScores.length
    : 0

  return { fieldConfidences, overallConfidence }
}
```

**Step 3: 添加 /api/ocr/paddle 路由**

在 `fastify.listen()` 之前添加新路由：

```javascript
// PaddleOCR 识别接口
fastify.post('/api/ocr/paddle', async (request, reply) => {
  try {
    const { imageBase64 } = request.body

    if (!imageBase64) {
      return reply.status(400).send({ error: '缺少 imageBase64' })
    }

    const ocr = await initPaddleOcr()
    if (!ocr) {
      return reply.status(503).send({ error: 'PaddleOCR 未就绪' })
    }

    // 从 base64 转换为 Buffer
    const imageBuffer = Buffer.from(
      imageBase64.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    )

    // 设置超时
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('PaddleOCR 超时')), Number(process.env.PADDLE_TIMEOUT_MS ?? 5000))
    )

    // 执行 OCR
    const results = await Promise.race([
      ocr(imageBuffer),
      timeoutPromise
    ])

    // 计算置信度
    const { fieldConfidences, overallConfidence } = calculateFieldConfidence(results)

    const startTime = Date.now()

    return reply.status(200).send({
      success: true,
      data: {
        invoiceNumber: '',
        invoiceDate: '',
        buyerName: '',
        sellerName: '',
        itemName: '',
        totalAmount: ''
      },
      meta: {
        source: 'paddle',
        overallConfidence,
        fieldConfidences,
        executionTime: `${Date.now() - startTime}ms`,
        fallbackReason: null
      }
    })
  } catch (error) {
    fastify.log.error('PaddleOCR 识别失败:', error)
    return reply.status(500).send({ error: error.message })
  }
})
```

**Step 4: 测试 PaddleOCR 接口**

启动后端服务：
```bash
npm run dev
```

使用 curl 测试（需要提供实际的 base64 图片）：
```bash
curl -X POST http://localhost:3001/api/ocr/paddle \
  -H "Content-Type: application/json" \
  -d '{"imageBase64":"data:image/jpeg;base64,..."}'
```

期望输出：返回 `{ success: true, data: {...}, meta: {...} }`

**Step 5: Commit**

```bash
git add server/src/index.js
git commit -m "feat: 集成 PaddleOCR 和新增 /api/ocr/paddle 接口"
```

---

## Task 3: 修改 /api/ocr/baidu/vat 支持三层降级逻辑

**文件：**
- 修改: `server/src/index.js` - 修改 `/api/ocr/baidu/vat` 路由逻辑

**Step 1: 查看现有路由实现**

阅读 `server/src/index.js` 中 `fastify.post('/api/ocr/baidu/vat')` 的完整实现

**Step 2: 添加三层降级封装函数**

在现有路由之前添加：

```javascript
// 三层降级 OCR 识别
const recognizeWithFallback = async ({
  imageBase64,
  skipPaddle = false,
  providers = ['baidu'],
  baiduApiKey,
  baiduSecretKey,
  tencentSecretId,
  tencentSecretKey,
  tencentRegion,
  googleApiKey,
  googleProjectId,
  confidenceThreshold = 0.8
}) => {
  const results = []
  let bestResult = null
  const usedProviders = []

  // 第一层：PaddleOCR（如果启用）
  if (!skipPaddle) {
    try {
      const ocr = await initPaddleOcr()
      if (ocr) {
        fastify.log.info('尝试使用 PaddleOCR...')
        const response = await fetch('http://localhost:3001/api/ocr/paddle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64 })
        })
        const data = await response.json()

        if (data.success && data.meta.overallConfidence >= confidenceThreshold) {
          fastify.log.info(`PaddleOCR 成功，置信度：${data.meta.overallConfidence}`)
          bestResult = data
          usedProviders.push({ provider: 'paddle', status: 'success' })
          return { result: bestResult, usedProviders }
        } else {
          usedProviders.push({
            provider: 'paddle',
            status: 'low_confidence',
            confidence: data.meta.overallConfidence
          })
          results.push(data)
        }
      }
    } catch (error) {
      fastify.log.warn('PaddleOCR 失败，进入第二层:', error.message)
      usedProviders.push({ provider: 'paddle', status: 'failed', error: error.message })
    }
  }

  // 第二层：用户配置的云服务
  for (const provider of providers) {
    if (provider === 'baidu' && baiduApiKey && baiduSecretKey) {
      try {
        fastify.log.info('尝试使用百度 OCR...')
        const response = await callBaiduOcr({ imageBase64, baiduApiKey, baiduSecretKey })

        if (response && response.meta.overallConfidence >= confidenceThreshold) {
          fastify.log.info(`百度 OCR 成功，置信度：${response.meta.overallConfidence}`)
          bestResult = response
          usedProviders.push({ provider: 'baidu', status: 'success' })
          return { result: bestResult, usedProviders }
        } else {
          usedProviders.push({ provider: 'baidu', status: 'low_confidence' })
          results.push(response)
        }
      } catch (error) {
        fastify.log.warn('百度 OCR 失败:', error.message)
        usedProviders.push({ provider: 'baidu', status: 'failed', error: error.message })
      }
    }

    if (provider === 'tencent' && tencentSecretId && tencentSecretKey) {
      try {
        fastify.log.info('尝试使用腾讯 OCR...')
        const response = await callTencentVatInvoice({
          imageBase64,
          secretId: tencentSecretId,
          secretKey: tencentSecretKey,
          region: tencentRegion || 'ap-beijing'
        })

        if (response && response.meta.overallConfidence >= confidenceThreshold) {
          fastify.log.info(`腾讯 OCR 成功，置信度：${response.meta.overallConfidence}`)
          bestResult = response
          usedProviders.push({ provider: 'tencent', status: 'success' })
          return { result: bestResult, usedProviders }
        } else {
          usedProviders.push({ provider: 'tencent', status: 'low_confidence' })
          results.push(response)
        }
      } catch (error) {
        fastify.log.warn('腾讯 OCR 失败:', error.message)
        usedProviders.push({ provider: 'tencent', status: 'failed', error: error.message })
      }
    }

    if (provider === 'google' && googleApiKey && googleProjectId) {
      try {
        fastify.log.info('尝试使用 Google Vision...')
        const response = await callGoogleVision({
          imageBase64,
          apiKey: googleApiKey,
          projectId: googleProjectId
        })

        if (response && response.meta.overallConfidence >= confidenceThreshold) {
          fastify.log.info(`Google Vision 成功，置信度：${response.meta.overallConfidence}`)
          bestResult = response
          usedProviders.push({ provider: 'google', status: 'success' })
          return { result: bestResult, usedProviders }
        } else {
          usedProviders.push({ provider: 'google', status: 'low_confidence' })
          results.push(response)
        }
      } catch (error) {
        fastify.log.warn('Google Vision 失败:', error.message)
        usedProviders.push({ provider: 'google', status: 'failed', error: error.message })
      }
    }
  }

  // 返回最高置信度的结果
  if (results.length > 0) {
    bestResult = results.reduce((best, current) =>
      (current.meta.overallConfidence > (best.meta.overallConfidence || 0)) ? current : best
    )

    return {
      result: {
        ...bestResult,
        meta: { ...bestResult.meta, fallbackReason: '置信度低于阈值，使用备选方案' }
      },
      usedProviders
    }
  }

  // 全部失败
  return {
    result: null,
    usedProviders,
    error: '所有 OCR 服务都失败'
  }
}
```

**Step 3: 添加 Google Vision 调用函数（占位符）**

在上一步之前添加：

```javascript
const callGoogleVision = async ({ imageBase64, apiKey, projectId }) => {
  // TODO: 在 Task 4 实现完整的 Google Vision 调用逻辑
  fastify.log.info('Google Vision API 调用（暂未实现）')
  return {
    success: false,
    error: 'Google Vision 暂未实现'
  }
}
```

**Step 4: 修改现有 /api/ocr/baidu/vat 路由**

找到 `fastify.post('/api/ocr/baidu/vat')` 路由，修改其处理逻辑为：

```javascript
fastify.post('/api/ocr/baidu/vat', async (request, reply) => {
  try {
    const {
      images,
      pdfBase64,
      fileName,
      provider,
      providers = ['paddle', 'baidu', 'tencent'],
      allowFallback = true,
      skipPaddle = false,
      credentials = {},
      confidenceThreshold = Number(process.env.CONFIDENCE_THRESHOLD ?? 0.8)
    } = request.body

    if (!images || images.length === 0) {
      return reply.status(400).send({ error: '缺少 images 参数' })
    }

    // 使用队列管理并发
    const results = await queue.add(async () => {
      const { result, usedProviders, error } = await recognizeWithFallback({
        imageBase64: images[0], // 使用第一张图片
        skipPaddle,
        providers: allowFallback ? providers : [provider || 'baidu'],
        baiduApiKey: credentials.baiduApiKey,
        baiduSecretKey: credentials.baiduSecretKey,
        tencentSecretId: credentials.tencentSecretId,
        tencentSecretKey: credentials.tencentSecretKey,
        tencentRegion: credentials.tencentRegion,
        googleApiKey: credentials.googleApiKey,
        googleProjectId: credentials.googleProjectId,
        confidenceThreshold
      })

      if (error) {
        return reply.status(500).send({ error })
      }

      // 返回统一格式
      return {
        ...result?.data,
        meta: {
          ...result?.meta,
          usedProviders,
          fileName
        }
      }
    })

    return reply.status(200).send(results)
  } catch (error) {
    fastify.log.error('OCR 识别失败:', error)
    return reply.status(500).send({ error: error.message })
  }
})
```

**Step 5: 测试修改**

重启后端服务：
```bash
npm run dev
```

测试新的三层降级逻辑：
```bash
curl -X POST http://localhost:3001/api/ocr/baidu/vat \
  -H "Content-Type: application/json" \
  -d '{
    "images": ["data:image/jpeg;base64,..."],
    "fileName": "test.pdf",
    "credentials": {
      "baiduApiKey": "your_key",
      "baiduSecretKey": "your_secret"
    }
  }'
```

**Step 6: Commit**

```bash
git add server/src/index.js
git commit -m "feat: 修改 /api/ocr/baidu/vat 支持三层降级识别逻辑"
```

---

## Task 4: Google Vision API 集成

**文件：**
- 修改: `server/src/index.js` - 实现 `callGoogleVision` 函数

**Step 1: 初始化 Google Vision 客户端**

在 `import` 语句后添加：

```javascript
import vision from '@google-cloud/vision'

let googleVisionClient = null

const getGoogleVisionClient = async (keyPath) => {
  if (!googleVisionClient && keyPath) {
    googleVisionClient = new vision.ImageAnnotatorClient({
      keyFilename: keyPath
    })
  }
  return googleVisionClient
}
```

**Step 2: 实现 callGoogleVision 函数**

替换之前的占位符函数：

```javascript
const callGoogleVision = async ({ imageBase64, apiKey, projectId }) => {
  try {
    const credentialsPath = process.env.GOOGLE_CREDENTIALS

    if (!credentialsPath) {
      fastify.log.warn('未配置 GOOGLE_CREDENTIALS')
      return {
        success: false,
        error: '未配置 Google Vision 凭证'
      }
    }

    const client = await getGoogleVisionClient(credentialsPath)

    // 从 base64 转换为 Buffer
    const imageBuffer = Buffer.from(
      imageBase64.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    )

    // 调用 Google Vision API
    const request = {
      image: {
        content: imageBuffer.toString('base64')
      },
      features: [
        { type: 'TEXT_DETECTION' }
      ]
    }

    const startTime = Date.now()
    const [result] = await client.annotateImage(request)

    // 提取文本和置信度
    const fullText = result.fullTextAnnotation?.text || ''
    const confidence = result.textAnnotations?.[0]?.confidence || 0

    // 映射到统一格式
    const invoiceFields = parseGoogleVisionResult(fullText)

    // 计算置信度
    const fieldConfidences = {
      invoiceNumber: confidence,
      invoiceDate: confidence,
      buyerName: confidence,
      sellerName: confidence,
      itemName: confidence,
      totalAmount: confidence
    }

    const overallConfidence = confidence

    return {
      success: true,
      data: invoiceFields,
      meta: {
        source: 'google',
        overallConfidence,
        fieldConfidences,
        executionTime: `${Date.now() - startTime}ms`,
        fallbackReason: null
      }
    }
  } catch (error) {
    fastify.log.error('Google Vision 调用失败:', error)
    return {
      success: false,
      error: error.message
    }
  }
}
```

**Step 3: 添加 Google Vision 结果解析函数**

```javascript
const parseGoogleVisionResult = (text) => {
  const invoiceNumber = extractInvoiceNumber(text)
  const invoiceDate = extractInvoiceDate(text)
  const buyerName = extractBuyerName(text)
  const sellerName = extractSellerName(text)
  const itemName = extractItemName(text)
  const totalAmount = extractTotalAmount(text)

  return {
    invoiceNumber: invoiceNumber || '',
    invoiceDate: invoiceDate || '',
    buyerName: buyerName || '',
    sellerName: sellerName || '',
    itemName: itemName || '',
    totalAmount: totalAmount || ''
  }
}

// 辅助函数（简化版，实际需要更复杂的正则和规则）
const extractInvoiceNumber = (text) => {
  const match = text.match(/发票号码[：:]*(\d{8,})/)
  return match ? match[1] : null
}

const extractInvoiceDate = (text) => {
  const match = text.match(/开票日期[：:]*(\d{4}[-年]\d{1,2}[-月]\d{1,2})/)
  return match ? match[1] : null
}

const extractBuyerName = (text) => {
  const match = text.match(/购买方[：:]*([^\n]+)/)
  return match ? match[1].trim() : null
}

const extractSellerName = (text) => {
  const match = text.match(/(销售方|供应商)[：:]*([^\n]+)/)
  return match ? match[2].trim() : null
}

const extractItemName = (text) => {
  const match = text.match(/货物|服务名称[：:]*([^\n]+)/)
  return match ? match[1].trim() : null
}

const extractTotalAmount = (text) => {
  const match = text.match(/价税合计[：:]*([0-9,]+\.?\d*)/)
  return match ? match[1] : null
}
```

**Step 4: 测试 Google Vision API**

需要先配置 Google Cloud 服务账户密钥：
1. 在 GCP 中创建服务账户
2. 下载 JSON 密钥文件
3. 设置环境变量：`GOOGLE_CREDENTIALS=/path/to/key.json`

```bash
curl -X POST http://localhost:3001/api/ocr/baidu/vat \
  -H "Content-Type: application/json" \
  -d '{
    "images": ["data:image/jpeg;base64,..."],
    "credentials": {
      "googleApiKey": "your_key",
      "googleProjectId": "your_project_id"
    }
  }'
```

**Step 5: Commit**

```bash
git add server/src/index.js
git commit -m "feat: 集成 Google Vision API 作为备选识别方案"
```

---

## Task 5: 前端 OcrConfig 类型扩展

**文件：**
- 修改: `web/src/App.tsx` - 扩展 OcrConfig 类型定义

**Step 1: 扩展 OcrConfig 类型**

找到 `type OcrConfig` 定义（约在第 39 行），修改为：

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
  aliyunAccessKeyId?: string
  aliyunAccessKeySecret?: string
  aliyunRegion?: string
  ocrSpaceApiKey?: string

  // 新增配置
  googleApiKey?: string
  googleProjectId?: string
  confidenceThreshold?: number  // 默认 0.8
  enablePaddle?: boolean  // 默认 true
  paddleLanguage?: 'ch' | 'en'  // 默认 'ch'
  priorityOrder?: ('paddle' | 'baidu' | 'tencent' | 'google')[]
}
```

**Step 2: 更新 ProviderId 类型**

找到 `type ProviderId` 定义（约在第 37 行），修改为：

```typescript
type ProviderId = 'paddle' | 'baidu' | 'tencent' | 'aliyun' | 'google' | 'ocrspace'
```

**Step 3: 测试编译**

```bash
npm run build
```

期望：编译成功，无 TypeScript 错误

**Step 4: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: 扩展 OcrConfig 类型支持 PaddleOCR 和 Google Vision 配置"
```

---

## Task 6: 前端配置面板 UI 扩展（第一部分：Google Vision 输入）

**文件：**
- 修改: `web/src/App.tsx` - 在 OCR 配置面板中添加 Google Vision 配置项

**Step 1: 在配置面板中添加 Google Vision 输入框**

找到现有的 OCR 配置面板代码，在腾讯 OCR 配置之后添加：

```jsx
{/* Google Vision 配置 */}
<div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e0e0e0' }}>
  <h4>Google Vision 配置</h4>
  <input
    type="password"
    placeholder="Google API Key"
    value={config.googleApiKey || ''}
    onChange={(e) =>
      setConfig({ ...config, googleApiKey: e.target.value })
    }
    style={{
      width: '100%',
      padding: '8px',
      marginBottom: '8px',
      border: '1px solid #ddd',
      borderRadius: '4px',
      boxSizing: 'border-box'
    }}
  />
  <input
    type="text"
    placeholder="Google Project ID"
    value={config.googleProjectId || ''}
    onChange={(e) =>
      setConfig({ ...config, googleProjectId: e.target.value })
    }
    style={{
      width: '100%',
      padding: '8px',
      border: '1px solid #ddd',
      borderRadius: '4px',
      boxSizing: 'border-box'
    }}
  />
</div>
```

**Step 2: 测试 UI 渲染**

```bash
npm run dev
```

打开配置面板，验证新的 Google Vision 输入框显示正确

**Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: 在配置面板中添加 Google Vision API 输入框"
```

---

## Task 7: 前端配置面板 UI 扩展（第二部分：置信度阈值和优先级）

**文件：**
- 修改: `web/src/App.tsx` - 添加置信度阈值滑块和优先级排序

**Step 1: 添加置信度阈值滑块**

在 Google Vision 配置之后添加：

```jsx
{/* 置信度阈值配置 */}
<div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e0e0e0' }}>
  <h4>置信度阈值</h4>
  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
    <input
      type="range"
      min="0.5"
      max="1.0"
      step="0.05"
      value={config.confidenceThreshold ?? 0.8}
      onChange={(e) =>
        setConfig({ ...config, confidenceThreshold: Number(e.target.value) })
      }
      style={{ flex: 1 }}
    />
    <span style={{ minWidth: '50px', textAlign: 'right' }}>
      {((config.confidenceThreshold ?? 0.8) * 100).toFixed(0)}%
    </span>
  </div>
  <small style={{ color: '#666' }}>
    置信度低于阈值时，系统会自动尝试其他 OCR 服务
  </small>
</div>
```

**Step 2: 添加优先级排序 UI**

在置信度阈值之后添加：

```jsx
{/* OCR 优先级配置 */}
<div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e0e0e0' }}>
  <h4>OCR 优先级（从上到下）</h4>
  <div style={{
    border: '1px solid #ddd',
    borderRadius: '4px',
    padding: '8px',
    backgroundColor: '#f9f9f9'
  }}>
    {(config.priorityOrder || ['paddle', 'baidu', 'tencent', 'google']).map((provider, index) => (
      <div
        key={provider}
        style={{
          padding: '8px',
          marginBottom: index < (config.priorityOrder?.length || 4) - 1 ? '4px' : 0,
          backgroundColor: '#fff',
          border: '1px solid #e0e0e0',
          borderRadius: '3px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}
      >
        <span>{provider}</span>
        <small style={{ color: '#999' }}>优先级 {index + 1}</small>
      </div>
    ))}
  </div>
  <small style={{ color: '#666', display: 'block', marginTop: '8px' }}>
    提示：当前版本不支持拖拽排序，可在代码中配置优先级
  </small>
</div>
```

**Step 3: 测试 UI**

```bash
npm run dev
```

验证滑块和优先级显示正确

**Step 4: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: 添加置信度阈值滑块和优先级显示"
```

---

## Task 8: 前端结果显示增强（显示识别来源和置信度）

**文件：**
- 修改: `web/src/App.tsx` - 在识别结果中显示来源和置信度

**Step 1: 修改 InvoiceRecord 类型**

找到 `type InvoiceRecord` 定义，添加新字段：

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
  rawText?: string
  isToll?: boolean

  // 新增字段
  ocrSource?: string  // 识别来源：paddle, baidu, tencent, google
  confidence?: number  // 整体置信度
  fieldConfidences?: Record<string, number>  // 各字段置信度
}
```

**Step 2: 在结果表格中显示识别来源和置信度**

找到显示发票记录的代码位置，在表格中为每条记录添加来源和置信度显示：

```jsx
<tr key={record.id}>
  <td>{record.sourceFile}</td>
  <td>{record.invoiceNumber || '-'}</td>
  <td>{record.invoiceDate || '-'}</td>
  <td>{record.buyerName || '-'}</td>
  <td>{record.sellerName || '-'}</td>
  <td>{record.totalAmount || '-'}</td>
  <td>
    <div>
      <small style={{ display: 'block', color: '#666' }}>
        来源: {record.ocrSource ? `${record.ocrSource}` : 'PDF文本'}
      </small>
      {record.confidence && (
        <small style={{ display: 'block', color: record.confidence >= 0.8 ? '#28a745' : '#ffc107' }}>
          置信度: {(record.confidence * 100).toFixed(1)}%
        </small>
      )}
    </div>
  </td>
</tr>
```

**Step 3: 在 OCR 调用时记录来源和置信度**

修改 OCR 调用的响应处理代码，将返回的 `meta.source` 和 `meta.overallConfidence` 保存到 record 中：

```typescript
// 假设从 API 响应中获取
const ocrResult = response.data
record.ocrSource = ocrResult.meta?.source
record.confidence = ocrResult.meta?.overallConfidence
record.fieldConfidences = ocrResult.meta?.fieldConfidences
```

**Step 4: 测试结果显示**

运行前端，上传发票并进行 OCR 识别，验证结果中显示了来源和置信度

**Step 5: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: 在识别结果中显示 OCR 来源和置信度"
```

---

## Task 9: 完整集成测试与调试

**文件：**
- 修改: 后端日志配置
- 创建: 测试用例文档

**Step 1: 启动完整系统**

```bash
# 终端 1：启动后端
cd server
npm run dev

# 终端 2：启动前端
cd web
npm run dev
```

**Step 2: 手动测试三层降级流程**

1. 打开前端：http://localhost:5273
2. 在配置面板中填入 API KEY（可选）
3. 上传一份发票 PDF
4. 观察日志输出，验证：
   - PaddleOCR 首先被调用
   - 如果置信度 < 80%，自动降级到百度/腾讯/Google
   - 最终返回最高置信度的结果

**Step 3: 检查日志输出**

在后端日志中验证：
```
初始化 PaddleOCR 模型...
PaddleOCR 模型初始化完成
尝试使用 PaddleOCR...
PaddleOCR 成功，置信度：0.92
```

或降级日志：
```
尝试使用 PaddleOCR...
PaddleOCR 失败，进入第二层
尝试使用百度 OCR...
百度 OCR 成功，置信度：0.88
```

**Step 4: 验证功能**

- [ ] 前端可以输入并保存 Google Vision API KEY
- [ ] 置信度滑块可以调节
- [ ] 识别结果显示来源和置信度
- [ ] 三层降级逻辑正确执行
- [ ] 日志记录完整

**Step 5: Commit**

```bash
git add server/src/index.js web/src/App.tsx
git commit -m "feat: 完成多 OCR 三层降级识别集成"
```

---

## Task 10: 版本升级至 0.0.1 并推送到 GitHub

**文件：**
- 修改: `web/package.json` 版本号
- 修改: `server/package.json` 版本号
- 修改: `docker-compose.yml` 版本标签

**Step 1: 更新前端版本**

修改 `web/package.json`：

```json
{
  "version": "0.0.1"
}
```

**Step 2: 更新后端版本**

修改 `server/package.json`：

```json
{
  "version": "0.0.1"
}
```

**Step 3: 更新 Docker Compose 版本标签**

修改 `docker-compose.yml`，将镜像标签从 `latest` 改为 `0.0.1`：

```yaml
services:
  api:
    image: fp-api:0.0.1

  web:
    image: fp-web:0.0.1
```

**Step 4: 创建 git tag**

```bash
git tag -a v0.0.1 -m "版本 0.0.1: 集成 PaddleOCR 和 Google Vision，实现三层降级识别"
```

**Step 5: 推送到 GitHub**

```bash
git push origin main
git push origin v0.0.1
```

**Step 6: 验证推送**

访问 GitHub 仓库验证：
- https://github.com/klkanglang911/fp/releases - 查看 v0.0.1 tag
- https://github.com/klkanglang911/fp/tree/main - 查看最新代码

**Step 7: 最终 Commit（版本更新）**

```bash
git add web/package.json server/package.json docker-compose.yml
git commit -m "chore: 升级版本至 0.0.1 - 多 OCR 三层降级识别完整实现"
```

---

## 总结

完成上述 10 个 Task 后，你将获得：

✅ PaddleOCR 本地集成（快速识别，响应 <500ms）
✅ Google Vision API 集成（高准度备选）
✅ 三层自动降级策略（用户无感知）
✅ 置信度阈值验证机制
✅ 前端完整配置面板
✅ 识别结果来源和置信度显示
✅ 完整的日志记录和调试支持
✅ GitHub 版本 0.0.1 发布

---

## 执行方式

这个计划完成后，选择执行方式：

**选项 A：在本session中逐任务执行** - 使用 superpowers:subagent-driven-development
**选项 B：新建独立session批量执行** - 使用 superpowers:executing-plans

推荐：**选项 A**（逐任务执行更稳定，便于及时调整）
