import Fastify from 'fastify'
import cors from '@fastify/cors'
import PQueue from 'p-queue'
import dotenv from 'dotenv'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import Tesseract from 'tesseract.js'

dotenv.config()

// 初始化 Tesseract.js（全局单例）
let tesseractWorker = null

const initTesseract = async (fastifyInstance) => {
  try {
    if (!tesseractWorker) {
      fastifyInstance.log.info('初始化 Tesseract.js 本地 OCR...')
      tesseractWorker = await Tesseract.createWorker()
      await tesseractWorker.loadLanguage('chi_sim')
      await tesseractWorker.initialize('chi_sim')
      fastifyInstance.log.info('Tesseract.js 初始化完成')
    }
    return tesseractWorker
  } catch (error) {
    fastifyInstance.log.error('Tesseract.js 初始化失败:', error)
    return null
  }
}

const fastify = Fastify({ logger: true })

await fastify.register(cors, {
  origin: true,
})

// 在 fastify 启动时初始化 Tesseract
fastify.addHook('onReady', async () => {
  await initTesseract(fastify)
})

// 计算 6 个目标字段的置信度
const calculateFieldConfidence = (text) => {
  // 简化版置信度计算：如果字段被识别则认为有 0.85 的置信度，否则为 0
  const fieldConfidences = {
    invoiceNumber: text.match(/发票号码|invoice\s*number/i) ? 0.85 : 0,
    invoiceDate: text.match(/开票日期|invoice\s*date/i) ? 0.85 : 0,
    buyerName: text.match(/购买方|buyer|purchaser/i) ? 0.85 : 0,
    sellerName: text.match(/销售方|supplier|seller/i) ? 0.85 : 0,
    itemName: text.match(/货物|服务|item|product/i) ? 0.85 : 0,
    totalAmount: text.match(/合计|总计|金额|total|amount/i) ? 0.85 : 0
  }

  // 计算平均置信度
  const validScores = Object.values(fieldConfidences).filter(c => c > 0)
  const overallConfidence = validScores.length > 0
    ? validScores.reduce((a, b) => a + b) / 6  // 除以 6（总字段数）而不是有效数量
    : 0

  return { fieldConfidences, overallConfidence }
}

const requiredEnv = ['BAIDU_API_KEY', 'BAIDU_SECRET_KEY']
const missingEnv = requiredEnv.filter((key) => !process.env[key])
if (missingEnv.length > 0) {
  fastify.log.warn(`缺少环境变量: ${missingEnv.join(', ')}`)
}

const queue = new PQueue({
  concurrency: Number(process.env.MAX_CONCURRENCY ?? 2),
})

const maxQueueSize = Number(process.env.MAX_QUEUE_SIZE ?? 20)
const requestTimeout = Number(process.env.OCR_TIMEOUT_MS ?? 20000)
const logDir = process.env.OCR_LOG_DIR ?? 'logs'

let tokenCache = {
  token: '',
  expiresAt: 0,
}

const writeOcrLog = async (fileName, payload) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = (fileName || 'unknown').replace(/[^\w\u4e00-\u9fa5.-]/g, '_')
    const filePath = path.join(logDir, `ocr-${timestamp}-${safeName}.json`)
    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    fastify.log.warn('写入OCR日志失败')
  }
}

const signTencentRequest = ({ secretId, secretKey, payload, service, region, action, version }) => {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)

  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex')
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:application/json; charset=utf-8\nhost:${service}.tencentcloudapi.com\n`,
    'content-type;host',
    hashedPayload,
  ].join('\n')

  const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, hashedCanonicalRequest].join('\n')

  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest()
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex')

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`

  return {
    authorization,
    timestamp,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: `${service}.tencentcloudapi.com`,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
    },
  }
}

const callTencentVatInvoice = async ({ imageBase64, secretId, secretKey, region }) => {
  const service = 'ocr'
  const action = 'VatInvoiceOCR'
  const version = '2018-11-19'
  const payload = JSON.stringify({ ImageBase64: imageBase64 })

  const { headers } = signTencentRequest({
    secretId,
    secretKey,
    payload,
    service,
    region,
    action,
    version,
  })

  const response = await fetch(`https://${service}.tencentcloudapi.com`, {
    method: 'POST',
    headers,
    body: payload,
  })
  const data = await response.json()
  if (data?.Response?.Error) {
    const error = new Error(data.Response.Error.Message || '腾讯云OCR失败')
    error.code = data.Response.Error.Code
    throw error
  }

  return data.Response
}

const mapTencentVatToBaidu = (response) => {
  const infoSource = response?.VatInvoiceInfos ?? response?.VatInvoiceInfo ?? []
  const infoList = Array.isArray(infoSource) ? infoSource : []
  const infoMap = {}
  infoList.forEach((item) => {
    if (item?.Name) {
      infoMap[item.Name] = item.Value ?? ''
    }
  })
  const itemSource = response?.VatInvoiceItemInfos ?? []
  const items = Array.isArray(itemSource) ? itemSource : []

  const toRowItems = (list, key) =>
    list.map((item, index) => ({
      row: index + 1,
      word: item?.[key] ?? '',
    }))

  return {
    words_result: {
      InvoiceNum: infoMap['发票号码'] ?? '',
      InvoiceCode: infoMap['发票代码'] ?? '',
      InvoiceDate: infoMap['开票日期'] ?? '',
      PurchaserName: infoMap['购买方名称'] ?? '',
      PurchaserRegisterNum: infoMap['购买方统一社会信用代码/纳税人识别号'] ?? '',
      SellerName: infoMap['销售方名称'] ?? '',
      SellerRegisterNum: infoMap['销售方统一社会信用代码/纳税人识别号'] ?? '',
      TotalAmount: infoMap['合计金额'] ?? '',
      AmountInFiguers: infoMap['价税合计(小写)'] ?? '',
      AmountInWords: infoMap['价税合计(大写)'] ?? '',
      CommodityName: toRowItems(items, 'Name'),
      CommodityNum: toRowItems(items, 'Quantity'),
      CommodityAmount: toRowItems(items, 'Amount'),
    },
  }
}

const getBaiduField = (words, key) => {
  const value = words?.[key]
  if (!value) return ''
  if (Array.isArray(value)) {
    const first = value[0]
    return first?.word ?? first ?? ''
  }
  if (typeof value === 'string') return value
  if (value.word) return value.word
  return ''
}

const isBaiduResultIncomplete = (words) => {
  const invoiceNum = getBaiduField(words, 'InvoiceNum') || getBaiduField(words, 'InvoiceNumDigit')
  const invoiceDate = getBaiduField(words, 'InvoiceDate')
  const buyer = getBaiduField(words, 'PurchaserName') || getBaiduField(words, 'PurchaserRegisterNum')
  const seller = getBaiduField(words, 'SellerName') || getBaiduField(words, 'SellerRegisterNum')
  const amount = getBaiduField(words, 'AmountInFiguers') || getBaiduField(words, 'TotalAmount')
  if (!invoiceNum || !invoiceDate || !amount) return true
  if (!buyer && !seller) return true
  return false
}

const getAccessToken = async ({ apiKey, secretKey }) => {
  const now = Date.now()
  if (tokenCache.token && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.token
  }

  const resolvedApiKey = apiKey || process.env.BAIDU_API_KEY
  const resolvedSecretKey = secretKey || process.env.BAIDU_SECRET_KEY

  const response = await fetch(
    `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${resolvedApiKey}&client_secret=${resolvedSecretKey}`,
  )
  const data = await response.json()
  if (!data.access_token) {
    throw new Error(data.error_description || '无法获取百度 access_token')
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  }

  return tokenCache.token
}

const callBaiduOcr = async (base64Image, accuracy) => {
  const token = await getAccessToken({})
  const params = new URLSearchParams()
  params.set('image', base64Image)
  if (accuracy) {
    params.set('accuracy', accuracy)
  }

  const response = await fetch(
    `https://aip.baidubce.com/rest/2.0/ocr/v1/vat_invoice?access_token=${token}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    },
  )

  const data = await response.json()
  if (data.error_code) {
    const error = new Error(data.error_msg || 'OCR 失败')
    error.code = data.error_code
    throw error
  }

  return data
}

const callBaiduGeneralOcr = async (base64Image) => {
  const token = await getAccessToken({})
  const params = new URLSearchParams()
  params.set('image', base64Image)

  const response = await fetch(
    `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${token}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    },
  )

  const data = await response.json()
  if (data.error_code) {
    const error = new Error(data.error_msg || '通用OCR失败')
    error.code = data.error_code
    throw error
  }

  return data
}

const callBaiduMultipleInvoice = async ({ imageBase64, pdfBase64 }) => {
  const token = await getAccessToken({})
  const params = new URLSearchParams()
  if (pdfBase64) {
    params.set('pdf_file', pdfBase64)
    params.set('pdf_file_num', '1')
  } else if (imageBase64) {
    params.set('image', imageBase64)
  }

  const response = await fetch(
    `https://aip.baidubce.com/rest/2.0/ocr/v1/multiple_invoice?access_token=${token}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    },
  )

  const data = await response.json()
  if (data.error_code) {
    const error = new Error(data.error_msg || '智能财务票据识别失败')
    error.code = data.error_code
    throw error
  }

  return data
}

// 计算字段置信度的辅助函数
const calculateFieldConfidenceForFallback = (extractedFields) => {
  const fieldConfidences = {
    invoiceNumber: extractedFields.invoiceNumber ? 0.85 : 0,
    invoiceDate: extractedFields.invoiceDate ? 0.85 : 0,
    buyerName: extractedFields.buyerName ? 0.85 : 0,
    sellerName: extractedFields.sellerName ? 0.85 : 0,
    itemName: extractedFields.itemName ? 0.85 : 0,
    totalAmount: extractedFields.totalAmount ? 0.85 : 0
  }

  const validScores = Object.values(fieldConfidences).filter(c => c > 0)
  const overallConfidence = validScores.length > 0
    ? validScores.reduce((a, b) => a + b) / 6  // 除以 6（总字段数）而不是有效数量
    : 0

  return { fieldConfidences, overallConfidence }
}

// 三层降级 OCR 识别函数
const recognizeWithFallback = async ({
  imageBase64,
  skipLocal = false,
  providers = ['baidu'],
  baiduApiKey,
  baiduSecretKey,
  tencentSecretId,
  tencentSecretKey,
  tencentRegion,
  googleApiKey,
  googleProjectId,
  pdfBase64,
  fileName,
  confidenceThreshold = 0.8
}) => {
  const results = []
  let bestResult = null
  const usedProviders = []

  // 第一层：本地 Tesseract.js OCR（如果启用）
  if (!skipLocal) {
    try {
      fastify.log.info('尝试使用本地 Tesseract.js...')

      const worker = await initTesseract(fastify)
      if (worker) {
        // 从 base64 转换为 Buffer
        const imageBuffer = Buffer.from(
          imageBase64.replace(/^data:image\/\w+;base64,/, ''),
          'base64'
        )

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('超时')), Number(process.env.TESSERACT_TIMEOUT_MS ?? 10000))
        )

        const result = await Promise.race([
          worker.recognize(imageBuffer),
          timeoutPromise
        ])

        const fullText = result.data.text || ''
        const { fieldConfidences, overallConfidence } = calculateFieldConfidence(fullText)

        // 提取字段值
        const invoiceNumber = (fullText.match(/发票号码[：:]*(\d{8,})/i) || [])[1] || ''
        const invoiceDate = (fullText.match(/开票日期[：:]*(\d{4}[-年]\d{1,2}[-月]\d{1,2})/i) || [])[1] || ''
        const buyerName = (fullText.match(/购买方[：:]*([^\n]+)/i) || [])[1]?.trim() || ''
        const sellerName = (fullText.match(/销售方[：:]*([^\n]+)/i) || [])[1]?.trim() || ''
        const itemName = (fullText.match(/货物[、，]?服务[、，]?名称[：:]*([^\n]+)/i) || [])[1]?.trim() || ''
        const totalAmount = (fullText.match(/价税合计[：:]*([0-9,]+\.?\d*)/i) || [])[1] || ''

        const localResult = {
          success: true,
          data: {
            invoiceNumber,
            invoiceDate,
            buyerName,
            sellerName,
            itemName,
            totalAmount
          },
          meta: {
            source: 'local',
            overallConfidence,
            fieldConfidences,
            fallbackReason: null
          }
        }

        if (overallConfidence >= confidenceThreshold) {
          fastify.log.info(`本地 Tesseract.js 成功，置信度：${overallConfidence}`)
          usedProviders.push({ provider: 'local', status: 'success', confidence: overallConfidence })
          return { result: localResult, usedProviders }
        } else {
          usedProviders.push({ provider: 'local', status: 'low_confidence', confidence: overallConfidence })
          results.push(localResult)
        }
      }
    } catch (error) {
      fastify.log.warn('本地 Tesseract.js 失败，进入第二层:', error.message)
      usedProviders.push({ provider: 'local', status: 'failed', error: error.message })
    }
  }

  // 第二层：用户选择的云服务（百度/腾讯）
  for (const provider of providers) {
    if (provider === 'baidu' && baiduApiKey && baiduSecretKey) {
      try {
        fastify.log.info('尝试使用百度 OCR...')
        const baiduResult = await runBaiduOcrLogic({
          imageBase64,
          pdfBase64,
          apiKey: baiduApiKey,
          secretKey: baiduSecretKey,
          fastifyInstance: fastify
        })

        if (baiduResult) {
          const { fieldConfidences, overallConfidence } = calculateFieldConfidenceForFallback({
            invoiceNumber: getBaiduField(baiduResult.words_result, 'InvoiceNum'),
            invoiceDate: getBaiduField(baiduResult.words_result, 'InvoiceDate'),
            buyerName: getBaiduField(baiduResult.words_result, 'PurchaserName'),
            sellerName: getBaiduField(baiduResult.words_result, 'SellerName'),
            itemName: Array.isArray(getBaiduField(baiduResult.words_result, 'CommodityName'))
              ? getBaiduField(baiduResult.words_result, 'CommodityName')[0]?.word
              : '',
            totalAmount: getBaiduField(baiduResult.words_result, 'AmountInFiguers')
          })

          const baiduFallbackResult = {
            success: true,
            data: {
              invoiceNumber: getBaiduField(baiduResult.words_result, 'InvoiceNum'),
              invoiceDate: getBaiduField(baiduResult.words_result, 'InvoiceDate'),
              buyerName: getBaiduField(baiduResult.words_result, 'PurchaserName'),
              sellerName: getBaiduField(baiduResult.words_result, 'SellerName'),
              totalAmount: getBaiduField(baiduResult.words_result, 'AmountInFiguers')
            },
            meta: {
              source: 'baidu',
              overallConfidence,
              fieldConfidences,
              fallbackReason: null
            }
          }

          if (overallConfidence >= confidenceThreshold) {
            fastify.log.info(`百度 OCR 成功，置信度：${overallConfidence}`)
            usedProviders.push({ provider: 'baidu', status: 'success', confidence: overallConfidence })
            return { result: baiduFallbackResult, usedProviders }
          } else {
            usedProviders.push({ provider: 'baidu', status: 'low_confidence', confidence: overallConfidence })
            results.push(baiduFallbackResult)
          }
        }
      } catch (error) {
        fastify.log.warn('百度 OCR 失败:', error.message)
        usedProviders.push({ provider: 'baidu', status: 'failed', error: error.message })
      }
    }

    if (provider === 'tencent' && tencentSecretId && tencentSecretKey) {
      try {
        fastify.log.info('尝试使用腾讯 OCR...')
        const tencentResult = await callTencentVatInvoice({
          imageBase64,
          secretId: tencentSecretId,
          secretKey: tencentSecretKey,
          region: tencentRegion
        })

        const mappedResult = mapTencentVatToBaidu(tencentResult)
        if (mappedResult) {
          const { fieldConfidences, overallConfidence } = calculateFieldConfidenceForFallback({
            invoiceNumber: getBaiduField(mappedResult.words_result, 'InvoiceNum'),
            invoiceDate: getBaiduField(mappedResult.words_result, 'InvoiceDate'),
            buyerName: getBaiduField(mappedResult.words_result, 'PurchaserName'),
            sellerName: getBaiduField(mappedResult.words_result, 'SellerName'),
            itemName: Array.isArray(getBaiduField(mappedResult.words_result, 'CommodityName'))
              ? getBaiduField(mappedResult.words_result, 'CommodityName')[0]?.word
              : '',
            totalAmount: getBaiduField(mappedResult.words_result, 'AmountInFiguers')
          })

          const tencentFallbackResult = {
            success: true,
            data: {
              invoiceNumber: getBaiduField(mappedResult.words_result, 'InvoiceNum'),
              invoiceDate: getBaiduField(mappedResult.words_result, 'InvoiceDate'),
              buyerName: getBaiduField(mappedResult.words_result, 'PurchaserName'),
              sellerName: getBaiduField(mappedResult.words_result, 'SellerName'),
              totalAmount: getBaiduField(mappedResult.words_result, 'AmountInFiguers')
            },
            meta: {
              source: 'tencent',
              overallConfidence,
              fieldConfidences,
              fallbackReason: null
            }
          }

          if (overallConfidence >= confidenceThreshold) {
            fastify.log.info(`腾讯 OCR 成功，置信度：${overallConfidence}`)
            usedProviders.push({ provider: 'tencent', status: 'success', confidence: overallConfidence })
            return { result: tencentFallbackResult, usedProviders }
          } else {
            usedProviders.push({ provider: 'tencent', status: 'low_confidence', confidence: overallConfidence })
            results.push(tencentFallbackResult)
          }
        }
      } catch (error) {
        fastify.log.warn('腾讯 OCR 失败:', error.message)
        usedProviders.push({ provider: 'tencent', status: 'failed', error: error.message })
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

// 百度 OCR 逻辑提取为独立函数（供三层降级使用）
const runBaiduOcrLogic = async ({ imageBase64, pdfBase64, apiKey, secretKey, fastifyInstance }) => {
  const token = await getAccessToken({ apiKey, secretKey })

  // 尝试 VAT 发票识别
  const params = new URLSearchParams()
  params.set('image', imageBase64)

  const response = await fetch(
    `https://aip.baidubce.com/rest/2.0/ocr/v1/vat_invoice?access_token=${token}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    },
  )

  const data = await response.json()
  if (data.error_code) {
    const error = new Error(data.error_msg || 'OCR 失败')
    error.code = data.error_code
    throw error
  }

  return data
}

// 本地 OCR 识别接口（Tesseract.js）
fastify.post('/api/ocr/local', async (request, reply) => {
  try {
    const { imageBase64 } = request.body

    if (!imageBase64) {
      return reply.status(400).send({ error: '缺少 imageBase64' })
    }

    const worker = await initTesseract(fastify)
    if (!worker) {
      return reply.status(503).send({ error: 'Tesseract.js 未就绪' })
    }

    // 从 base64 转换为 Buffer
    const imageBuffer = Buffer.from(
      imageBase64.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    )

    const startTime = Date.now()

    // 设置超时
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Tesseract.js 超时')), Number(process.env.TESSERACT_TIMEOUT_MS ?? 10000))
    )

    // 执行 OCR
    const result = await Promise.race([
      worker.recognize(imageBuffer),
      timeoutPromise
    ])

    // 提取文本
    const fullText = result.data.text || ''

    // 计算置信度
    const { fieldConfidences, overallConfidence } = calculateFieldConfidence(fullText)

    // 映射到统一格式（提取字段值）
    const invoiceNumber = (fullText.match(/发票号码[：:]*(\d{8,})/i) || [])[1] || ''
    const invoiceDate = (fullText.match(/开票日期[：:]*(\d{4}[-年]\d{1,2}[-月]\d{1,2})/i) || [])[1] || ''
    const buyerName = (fullText.match(/购买方[：:]*([^\n]+)/i) || [])[1]?.trim() || ''
    const sellerName = (fullText.match(/销售方[：:]*([^\n]+)/i) || [])[1]?.trim() || ''
    const itemName = (fullText.match(/货物[、，]?服务[、，]?名称[：:]*([^\n]+)/i) || [])[1]?.trim() || ''
    const totalAmount = (fullText.match(/价税合计[：:]*([0-9,]+\.?\d*)/i) || [])[1] || ''

    return reply.status(200).send({
      success: true,
      data: {
        invoiceNumber,
        invoiceDate,
        buyerName,
        sellerName,
        itemName,
        totalAmount
      },
      meta: {
        source: 'local',
        overallConfidence,
        fieldConfidences,
        executionTime: `${Date.now() - startTime}ms`,
        fallbackReason: null
      }
    })
  } catch (error) {
    fastify.log.error('Tesseract.js 识别失败:', error)
    return reply.status(500).send({ error: error.message })
  }
})

fastify.get('/health', async () => ({ status: 'ok' }))

fastify.post('/ocr/baidu/vat', async (request, reply) => {
  if (queue.size >= maxQueueSize) {
    return reply.code(429).send({ message: '当前排队任务过多，请稍后重试' })
  }

  const body = request.body
  const images = body?.images
  const pdfBase64 = body?.pdfBase64
  const provider = body?.provider ?? 'baidu'
  const providers = Array.isArray(body?.providers) ? body.providers : [provider]
  const allowFallback = Boolean(body?.allowFallback)
  const credentials = body?.credentials ?? {}
  const fileName = body?.fileName

  if (!Array.isArray(images) || images.length === 0) {
    return reply.code(400).send({ message: '缺少图片数据' })
  }
  // OCR.Space API 调用函数（完全免费，每月 25,000 次额度）
  const callOcrSpace = async (imageBase64, apiKey) => {
    // 优先使用用户配置的 Key，否则使用默认 Key
    const API_KEY = apiKey || 'helloworld'
    const params = new URLSearchParams()
    params.set('base64Image', imageBase64)
    params.set('language', 'chs')  // 中文识别
    params.set('isTable', 'true')  // 表格优化，适合发票
    params.set('isOverlayRequired', 'false')  // 不需要坐标，减小响应体积

    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: {
        apikey: API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    })

    const data = await response.json()

    if (data?.IsErroredOnProcessing) {
      throw new Error('OCR.Space 处理失败')
    }

    // 将 OCR.Space 的通用文本结果映射为发票格式
    const parsedResults = data?.ParsedResults || []
    if (!parsedResults || parsedResults.length === 0) {
      throw new Error('OCR.Space 未返回有效结果')
    }

    const firstResult = parsedResults[0]
    const parsedText = firstResult?.ParsedText || ''
    const errorMessage = firstResult?.ErrorMessage

    if (errorMessage || !parsedText) {
      throw new Error(errorMessage || 'OCR.Space 解析失败')
    }

    // 使用正则表达式从文本中提取发票字段
    const lines = parsedText.split('\n').map((line) => line.trim()).filter(Boolean)

    const findByLabels = (labels) => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const label of labels) {
          if (!line.includes(label)) continue
          const match = line.match(new RegExp(`${label}[:：]?\\s*([\\S\\s]+.*)$`))
          if (match?.[1]) return match[1].trim()
          const next = lines[i + 1]
          if (next && !labels.some((l) => next.includes(l))) return next.trim()
        }
      }
      return undefined
    }

    const invoiceNumberMatch = parsedText.match(/发票号码[：:]\s*(\d{8,})/)
    const invoiceNumber = invoiceNumberMatch?.[1] || findByLabels(['发票号码', '发票号'])
    const dateMatch = parsedText.match(/(\d{4}[年\-/.]?\d{1,2}[月\-/.]?\d{1,2}日?)/)
    const invoiceDate = dateMatch?.[0] || findByLabels(['开票日期', '日期'])

    const buyerRaw = findByLabels(['购买方名称', '购方名称', '购买方', '购方'])
    const buyerName = buyerRaw?.replace(/(纳税人识别号|税号).*/g, '').trim()

    const sellerRaw = findByLabels(['销售方名称', '销方名称', '销售方', '销方'])
    const sellerName = sellerRaw?.replace(/(纳税人识别号|税号).*/g, '').trim()

    const totalMatch = parsedText.match(/价税合计[（(小写）)]?[:：]?\s*([￥¥]?[\d.,]+)/)
    const totalAmount = totalMatch?.[1]?.replace(/[￥¥,\s]/g, '')

    const toRowItems = (list, key) =>
      list.map((item, index) => ({
        row: index + 1,
        word: item?.[key] ?? '',
      }))

    // 尝试提取项目信息
    const itemLines = lines
      .filter((line) => line.includes('*') || /货物|劳务|服务|项目/.test(line))
      .filter((line) => !/合计|价税|小写|大写/.test(line))

    const items = itemLines.map((line, index) => ({
      row: index + 1,
      word: line.replace(/[*]/g, '').trim(),
    }))

    return {
      words_result: {
        InvoiceNum: invoiceNumber || '',
        InvoiceCode: '',
        InvoiceDate: invoiceDate || '',
        PurchaserName: buyerName || '',
        SellerName: sellerName || '',
        TotalAmount: totalAmount || '',
        AmountInFiguers: totalAmount || '',
        AmountInWords: '',
        CommodityName: items.length > 0 ? toRowItems(items, 'word') : [],
        CommodityNum: [],
        CommodityAmount: items.length > 0 ? toRowItems(items, 'word') : [],
      },
    }
  }

  const validateProvider = (name) => {
    if (name === 'baidu') {
      return Boolean(credentials.baiduApiKey && credentials.baiduSecretKey)
    }
    if (name === 'tencent') {
      return Boolean(credentials.tencentSecretId && credentials.tencentSecretKey && credentials.tencentRegion)
    }
    if (name === 'ocrspace') {
      // OCR.Space 默认使用 helloworld API Key（无需用户配置）
      return true
    }
    return false
  }

  if (!providers.some((name) => validateProvider(name))) {
    return reply.code(400).send({ message: 'OCR密钥缺失或服务商不可用' })
  }

  const task = async () => {
    const results = []
    const generalResults = []
    const multipleResults = []
    const debugPayload = { tencentRaw: [] }
    const usedProviders = []
    const runTencent = async (image) => {
      const tencent = await callTencentVatInvoice({
        imageBase64: image,
        secretId: credentials.tencentSecretId,
        secretKey: credentials.tencentSecretKey,
        region: credentials.tencentRegion,
      })
      debugPayload.tencentRaw.push(tencent)
      return mapTencentVatToBaidu(tencent)
    }

    const runBaidu = async (image) => {
      try {
        tokenCache = { token: '', expiresAt: 0 }
        const token = await getAccessToken({
          apiKey: credentials.baiduApiKey,
          secretKey: credentials.baiduSecretKey,
        })
        const runBaidu = async (fn) => fn(token)

        const callVat = async (accessToken, accuracy) => {
          const params = new URLSearchParams()
          params.set('image', image)
          if (accuracy) {
            params.set('accuracy', accuracy)
          }
          const response = await fetch(
            `https://aip.baidubce.com/rest/2.0/ocr/v1/vat_invoice?access_token=${accessToken}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: params,
            },
          )
          const data = await response.json()
          if (data.error_code) {
            const error = new Error(data.error_msg || 'OCR 失败')
            error.code = data.error_code
            throw error
          }
          return data
        }

        const callGeneral = async (accessToken) => {
          const params = new URLSearchParams()
          params.set('image', image)
          const response = await fetch(
            `https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=${accessToken}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: params,
            },
          )
          const data = await response.json()
          if (data.error_code) {
            const error = new Error(data.error_msg || '通用OCR失败')
            error.code = data.error_code
            throw error
          }
          return data
        }

        const callMultiple = async (accessToken) => {
          const params = new URLSearchParams()
          if (pdfBase64) {
            params.set('pdf_file', pdfBase64)
            params.set('pdf_file_num', '1')
          } else {
            params.set('image', image)
          }
          const response = await fetch(
            `https://aip.baidubce.com/rest/2.0/ocr/v1/multiple_invoice?access_token=${accessToken}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: params,
            },
          )
          const data = await response.json()
          if (data.error_code) {
            const error = new Error(data.error_msg || '智能财务票据识别失败')
            error.code = data.error_code
            throw error
          }
          return data
        }

        const vatResult = await runBaidu((accessToken) => callVat(accessToken, process.env.BAIDU_OCR_ACCURACY))

        // NOTE: 当VAT识别结果不完整时（如通行费发票），尝试使用 multiple_invoice 接口补充
        const vatWords = vatResult?.words_result
        if (vatWords && isBaiduResultIncomplete(vatWords)) {
          try {
            fastify.log.info('VAT识别结果不完整，尝试使用 multiple_invoice 接口补充')
            const multipleData = await runBaidu(callMultiple)
            const multipleResult = multipleData?.words_result || []
            const hasMultipleResult = Array.isArray(multipleResult)
              ? multipleResult.length > 0
              : Object.keys(multipleResult).length > 0
            if (hasMultipleResult) {
              return { vatResult, generalResults: [], multipleResults: [multipleResult] }
            }
          } catch (multipleError) {
            fastify.log.warn('multiple_invoice 调用失败，使用原VAT结果')
          }
        }

        return { vatResult, generalResults: [], multipleResults: [] }
      } catch (error) {
        if (error?.code === 282103 || error?.code === 282102) {
          try {
            const token = await getAccessToken({
              apiKey: credentials.baiduApiKey,
              secretKey: credentials.baiduSecretKey,
            })
            const params = new URLSearchParams()
            params.set('image', image)
            params.set('accuracy', 'high')
            const response = await fetch(
              `https://aip.baidubce.com/rest/2.0/ocr/v1/vat_invoice?access_token=${token}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: params,
              },
            )
            const data = await response.json()
            if (data.error_code) {
              const retryError = new Error(data.error_msg || 'OCR 失败')
              retryError.code = data.error_code
              throw retryError
            }
            return { vatResult: data, generalResults: [], multipleResults: [] }
          } catch (retryError) {
            if (retryError?.code === 282103 || retryError?.code === 282102) {
              try {
                const token = await getAccessToken({
                  apiKey: credentials.baiduApiKey,
                  secretKey: credentials.baiduSecretKey,
                })
                const callMultiple = async (accessToken) => {
                  const params = new URLSearchParams()
                  if (pdfBase64) {
                    params.set('pdf_file', pdfBase64)
                    params.set('pdf_file_num', '1')
                  } else {
                    params.set('image', image)
                  }
                  const response = await fetch(
                    `https://aip.baidubce.com/rest/2.0/ocr/v1/multiple_invoice?access_token=${accessToken}`,
                    {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                      },
                      body: params,
                    },
                  )
                  const data = await response.json()
                  if (data.error_code) {
                    const error = new Error(data.error_msg || '智能财务票据识别失败')
                    error.code = data.error_code
                    throw error
                  }
                  return data
                }
                const multiple = await callMultiple(token)
                const multipleResult = multiple.words_result || []
                const hasResult = Array.isArray(multipleResult)
                  ? multipleResult.length > 0
                  : Object.keys(multipleResult).length > 0
                if (hasResult) {
                  return { vatResult: null, generalResults: [], multipleResults: [multipleResult] }
                } else {
                  const general = await callGeneral(token)
                  return { vatResult: null, generalResults: [general.words_result || []], multipleResults: [] }
                }
              } catch (multipleError) {
                const token = await getAccessToken({
                  apiKey: credentials.baiduApiKey,
                  secretKey: credentials.baiduSecretKey,
                })
                const general = await callGeneral(token)
                return { vatResult: null, generalResults: [general.words_result || []], multipleResults: [] }
              }
            } else {
              throw retryError
            }
          }
        } else {
          throw error
        }
      }

      return { vatResult: null, generalResults: [], multipleResults: [] }
    }

    for (const image of images) {
      let handled = false
      let lastError

      for (const currentProvider of providers) {
        if (!validateProvider(currentProvider)) continue
        try {
          if (currentProvider === 'tencent') {
            const vatResult = await runTencent(image)
            results.push(vatResult)
            usedProviders.push({ provider: 'tencent', status: 'used' })
            handled = true
            break
          }

          if (currentProvider === 'ocrspace') {
            const vatResult = await callOcrSpace(image, credentials.ocrSpaceApiKey)
            results.push(vatResult)
            usedProviders.push({ provider: 'ocrspace', status: 'used' })
            handled = true
            break
          }

          if (currentProvider === 'baidu') {
            const baiduResult = await runBaidu(image)
            let finalVatResult = baiduResult.vatResult
            const canFallback = allowFallback && validateProvider('tencent')
            if (canFallback && finalVatResult?.words_result) {
              if (isBaiduResultIncomplete(finalVatResult.words_result)) {
                try {
                  const tencentResult = await runTencent(image)
                  if (!isBaiduResultIncomplete(tencentResult.words_result)) {
                    finalVatResult = tencentResult
                    usedProviders.push({ provider: 'tencent', status: 'used', from: 'baidu' })
                  } else {
                    usedProviders.push({ provider: 'tencent', status: 'attempted', from: 'baidu', reason: '字段不完整' })
                  }
                } catch (fallbackError) {
                  lastError = fallbackError
                  usedProviders.push({ provider: 'tencent', status: 'attempted', from: 'baidu', reason: '调用失败' })
                }
              }
            }
            if (finalVatResult) {
              results.push(finalVatResult)
              if (!usedProviders.some((entry) => entry.provider === 'tencent' && entry.status === 'used')) {
                usedProviders.push({ provider: 'baidu', status: 'used' })
              }
            }
            if (baiduResult.multipleResults?.length) {
              multipleResults.push(...baiduResult.multipleResults)
            }
            if (baiduResult.generalResults?.length) {
              generalResults.push(...baiduResult.generalResults)
            }
            handled = true
            break
          }
        } catch (error) {
          lastError = error
          if (!allowFallback) break
        }
      }

      if (!handled && lastError) {
        throw lastError
      }
    }
    const responsePayload = {
      words_result: results.map((item) => item.words_result),
      multiple_words_result: multipleResults,
      general_words_result: generalResults,
      meta: {
        usedProviders,
      },
    }
    await writeOcrLog(fileName, { ...responsePayload, debug: debugPayload })
    return responsePayload
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('OCR 请求超时')), requestTimeout)
  })

  try {
    const result = await queue.add(() => Promise.race([task(), timeoutPromise]))
    return reply.send(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OCR 处理失败'
    const code = error?.code
    return reply.code(502).send({ message, code })
  }
})

// 新的 /api/ocr/baidu/vat 路由（支持三层降级）
fastify.post('/api/ocr/baidu/vat', async (request, reply) => {
  try {
    const {
      images,
      pdfBase64,
      fileName,
      provider,
      providers = ['local', 'baidu', 'tencent'],
      allowFallback = true,
      skipLocal = false,
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
        skipLocal,
        providers: allowFallback ? providers : [provider || 'local'],
        baiduApiKey: credentials.baiduApiKey,
        baiduSecretKey: credentials.baiduSecretKey,
        tencentSecretId: credentials.tencentSecretId,
        tencentSecretKey: credentials.tencentSecretKey,
        tencentRegion: credentials.tencentRegion,
        googleApiKey: credentials.googleApiKey,
        googleProjectId: credentials.googleProjectId,
        pdfBase64,
        fileName,
        confidenceThreshold
      })

      if (error) {
        throw new Error(error)
      }

      // 返回统一格式
      const response = {
        success: result ? true : false
      }

      if (result?.data) {
        Object.assign(response, result.data)
      }

      response.meta = {
        ...(result?.meta || {}),
        usedProviders,
        fileName
      }

      await writeOcrLog(fileName, response)
      return response
    })

    return reply.status(200).send(results)
  } catch (error) {
    fastify.log.error('三层降级 OCR 识别失败:', error)
    return reply.status(500).send({ error: error.message })
  }
})

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

fastify.listen({ port, host })
