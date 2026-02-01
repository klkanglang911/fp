import { useEffect, useMemo, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import worker from 'pdfjs-dist/build/pdf.worker?worker'
import pLimit from 'p-limit'
import * as XLSX from 'xlsx'
import Papa from 'papaparse'

GlobalWorkerOptions.workerPort = new worker()

type LineItem = {
  name: string
  quantity?: string
  amount?: string
}

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
}

type FileTask = {
  id: string
  file: File
  status: 'pending' | 'processing' | 'done' | 'error'
  progress: number
  message?: string
}

type ProviderId = 'baidu' | 'tencent' | 'aliyun' | 'ocrspace'

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

const apiBase = import.meta.env.VITE_API_BASE ?? '/api'
const fileLimit = pLimit(2)
const storageKey = 'ocr-config'

const currencyClean = (value?: string) => {
  if (!value) return undefined
  return value.replace(/[\s￥,]/g, '')
}

const normalizeValue = (value?: string) => {
  if (!value) return undefined
  const cleaned = value.replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  if (/^[：:，,.-]+$/.test(cleaned)) return undefined
  return cleaned
}

const normalizeInvoiceNumber = (value?: string) => {
  const cleaned = normalizeValue(value)
  if (!cleaned) return undefined
  const digits = cleaned.replace(/\D/g, '')
  if (digits.length < 8) return undefined
  return digits
}

const hasMeaningfulData = (record?: InvoiceRecord) => {
  if (!record) return false
  return Boolean(
    record.invoiceNumber ||
    record.invoiceDate ||
    record.buyerName ||
    record.sellerName ||
    record.totalAmount ||
    record.items.length > 0,
  )
}

const parseChineseAmount = (value?: string) => {
  if (!value) return undefined
  const normalized = value
    .replace(/人民币|整/g, '')
    .replace(/圆/g, '元')
    .replace(/元整/g, '元')

  const hasYuan = normalized.includes('元')

  const digitMap: Record<string, number> = {
    零: 0,
    壹: 1,
    贰: 2,
    叁: 3,
    肆: 4,
    伍: 5,
    陆: 6,
    柒: 7,
    捌: 8,
    玖: 9,
  }
  const unitMap: Record<string, number> = {
    拾: 10,
    佰: 100,
    仟: 1000,
    万: 10000,
    亿: 100000000,
  }

  let integerPart = 0
  let section = 0
  let number = 0

  const [integerTextRaw, decimalTextRaw] = normalized.split('元')
  const integerText = hasYuan ? integerTextRaw : ''
  const decimalText = hasYuan ? decimalTextRaw : normalized

  for (const char of integerText) {
    if (digitMap[char] !== undefined) {
      number = digitMap[char]
    } else if (unitMap[char]) {
      if (char === '万' || char === '亿') {
        section = (section + number) * unitMap[char]
        integerPart += section
        section = 0
      } else {
        section += (number || 1) * unitMap[char]
      }
      number = 0
    }
  }
  integerPart += section + number

  let decimalPart = 0
  if (decimalText) {
    const jiaoIndex = decimalText.indexOf('角')
    const fenIndex = decimalText.indexOf('分')
    if (jiaoIndex > -1) {
      const jiaoChar = decimalText[jiaoIndex - 1]
      decimalPart += (digitMap[jiaoChar] ?? 0) * 0.1
    }
    if (fenIndex > -1) {
      const fenChar = decimalText[fenIndex - 1]
      decimalPart += (digitMap[fenChar] ?? 0) * 0.01
    }
  }

  const result = integerPart + decimalPart
  if (Number.isNaN(result)) return undefined
  return result.toFixed(2)
}

const pickFirst = (value?: string | string[]) => {
  if (!value) return undefined
  if (Array.isArray(value)) return value[0]
  return value
}

const parseTextInvoice = (text: string): InvoiceRecord => {
  const normalized = text.replace(/：/g, ':')
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  // NOTE: 只有明确包含"通行费"关键词才判定为通行费发票
  const isTollInvoice = /通行费/.test(text)

  // NOTE: 增强的标签匹配函数，支持标签中带空格的情况（如 "名 称:"）
  const findByLabels = (labels: string[]) => {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const label of labels) {
        // 构建支持空格的正则：将标签字符间插入可选空格
        const flexLabel = label.split('').join('\\s*')
        const regex = new RegExp(`${flexLabel}[:：]?\\s*([^\\s]+.*)$`)
        const match = line.match(regex)
        if (match?.[1]) return match[1].trim()
        // 如果标签在行末，尝试取下一行
        if (new RegExp(`${flexLabel}\\s*$`).test(line)) {
          const next = lines[i + 1]
          if (next && !labels.some((l) => next.includes(l))) return next.trim()
        }
      }
    }
    return undefined
  }

  // NOTE: 在指定区域范围内查找标签（用于通行费发票的区域定位）
  const findByLabelsInRange = (labels: string[], startIdx: number, endIdx: number) => {
    for (let i = startIdx; i < Math.min(endIdx, lines.length); i += 1) {
      const line = lines[i]
      for (const label of labels) {
        const flexLabel = label.split('').join('\\s*')
        const regex = new RegExp(`${flexLabel}[:：]?\\s*(.+)$`)
        const match = line.match(regex)
        if (match?.[1]) return match[1].trim()
      }
    }
    return undefined
  }

  // NOTE: 发票号码匹配策略
  // 1. 优先匹配有"发票号码"标签的
  const invoiceNumberMatch = normalized.match(/发票号码\s*[:：]?\s*([0-9]{8,20})/)
  // 2. 兜底：匹配独立的20位数字行（全电发票格式，通常在末尾）
  const standalone20DigitLine = lines.find((line) => /^\d{20}$/.test(line.trim()))
  // 3. 兜底：匹配文本中任意位置的20位数字
  const standalone20DigitMatch = normalized.match(/(?:^|[^\d])(\d{20})(?:$|[^\d])/)

  // NOTE: 每个候选值都需要单独进行归一化检查，因为 findByLabels 可能返回 ":" 等无效字符
  // 如果直接串联 raw value，无效字符会阻断后续的兜底值
  const invoiceNumber =
    normalizeInvoiceNumber(invoiceNumberMatch?.[1]) ??
    normalizeInvoiceNumber(findByLabels(['发票号码', '发票号'])) ??
    normalizeInvoiceNumber(standalone20DigitLine) ??
    normalizeInvoiceNumber(standalone20DigitMatch?.[1])

  const dateMatch = normalized.match(/(\d{4}[年\-/\.][0-9]{1,2}[月\-/\.][0-9]{1,2}日?)/)
  const invoiceDate = normalizeValue(dateMatch?.[1] ?? findByLabels(['开票日期', '日期']))

  let buyerName: string | undefined
  let sellerName: string | undefined

  if (isTollInvoice) {
    // NOTE: 通行费发票使用区域定位方式提取购买方和销售方
    const buyerInfoIdx = lines.findIndex((line) => /购买方信息|购\s*买\s*方/.test(line))
    const sellerInfoIdx = lines.findIndex((line) => /销售方信息|销\s*售\s*方/.test(line))

    if (buyerInfoIdx >= 0) {
      const buyerEndIdx = sellerInfoIdx > buyerInfoIdx ? sellerInfoIdx : buyerInfoIdx + 10
      buyerName = normalizeValue(findByLabelsInRange(['名称'], buyerInfoIdx, buyerEndIdx))
    }

    if (sellerInfoIdx >= 0) {
      sellerName = normalizeValue(findByLabelsInRange(['名称'], sellerInfoIdx, sellerInfoIdx + 10))
    }

    // 兜底：按顺序提取所有"名称:"字段
    if (!buyerName || !sellerName) {
      const nameMatches: string[] = []
      lines.forEach((line) => {
        const match = line.match(/名\s*称[:：]\s*(.+)/)
        if (match?.[1]) nameMatches.push(match[1].trim())
      })
      if (nameMatches.length >= 2) {
        buyerName = buyerName || normalizeValue(nameMatches[0])
        sellerName = sellerName || normalizeValue(nameMatches[1])
      } else if (nameMatches.length === 1 && !buyerName) {
        buyerName = normalizeValue(nameMatches[0])
      }
    }
  } else {
    // 普通增值税发票的标准解析
    const buyerRaw = findByLabels(['购买方名称', '购方名称', '购买方', '购方'])
    const sellerRaw = findByLabels(['销售方名称', '销方名称', '销售方', '销方'])
    buyerName = normalizeValue(buyerRaw?.replace(/(纳税人识别号|税号).*/g, ''))
    sellerName = normalizeValue(sellerRaw?.replace(/(纳税人识别号|税号).*/g, ''))

    // NOTE: 全电发票特殊格式处理
    // 格式特点：公司名称在"统一社会信用代码/纳税人识别号:"标签的下一行
    // 注意：PDF 中可能有多个税号标签，需要找到下一行是公司名称的那个
    if (!sellerName) {
      for (let idx = 0; idx < lines.length - 1; idx++) {
        const line = lines[idx]
        if (/统一社会信用代码|纳税人识别号/.test(line) && line.includes(':')) {
          const nextLine = lines[idx + 1]
          if (nextLine && /公司|有限|集团|企业|商店|个人$/.test(nextLine)) {
            sellerName = normalizeValue(nextLine)
            break
          }
        }
      }
    }

    // 如果还是没找到，尝试匹配"名 称:"格式（可能后面跟着无效内容）
    if (!buyerName || !sellerName) {
      const nameMatches: string[] = []
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        const match = line.match(/名\s*称[:：]\s*(.*)/)
        if (match) {
          const content = match[1].trim()
          // 如果"名 称:"后面的内容无效（如"大写) (小写)"），检查周围行
          if (!content || /大写|小写|^\(|^（|^-|^:/.test(content)) {
            // 遍历所有"统一社会信用代码"标签，找下一行是公司名的
            for (let j = 0; j < lines.length - 1; j++) {
              if (/统一社会信用代码|纳税人识别号/.test(lines[j])) {
                const candidate = lines[j + 1]
                if (candidate && /公司|有限|集团|企业|商店|个人$/.test(candidate)) {
                  if (!nameMatches.includes(candidate)) nameMatches.push(candidate.trim())
                  break
                }
              }
            }
          } else if (/公司|有限|集团|企业|商店|个人/.test(content)) {
            nameMatches.push(content)
          }
        }
      }

      if (nameMatches.length >= 2) {
        buyerName = buyerName || normalizeValue(nameMatches[0])
        sellerName = sellerName || normalizeValue(nameMatches[1])
      } else if (nameMatches.length === 1) {
        sellerName = sellerName || normalizeValue(nameMatches[0])
      }
    }
  }

  // NOTE: 支持两种价税合计格式：(大写) 和 (小写)
  const totalMatch = normalized.match(/价税合计(?:\([大小]写\))?[:：\s]*([￥¥]?[0-9.,]+)/)
  // 兜底：匹配最后一个 ¥ 金额（全电发票格式）
  const currencyMatches = normalized.match(/[￥¥]\s*([0-9]+\.[0-9]{2})/g)
  const lastCurrency = currencyMatches ? currencyMatches[currencyMatches.length - 1] : undefined
  const totalAmount = currencyClean(totalMatch?.[1]) || currencyClean(lastCurrency)

  const starMatches = normalized.match(/\*[^\*]+\*/g) ?? []
  const itemLines = lines
    .filter((line) => line.includes('*') && line.length > 2)
    .filter((line) => !/合计|价税合计|大写|小写/.test(line))

  const headerIndex = lines.findIndex((line) => /货物|劳务|服务名称|项目名称/.test(line))
  const tableLines: string[] = []
  if (headerIndex >= 0) {
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      const line = lines[i]
      // NOTE: 添加更多终止条件，避免提取到页脚内容
      if (/合计|价税合计|小写|大写|开票人|发票号码|订单号|\d{20}/.test(line)) break
      if (line.length > 1) tableLines.push(line)
    }
  }

  const names = [...new Set([...starMatches, ...itemLines, ...tableLines])]
  let items = names.map((line) => ({ name: line }))

  // NOTE: 通行费发票如果没有提取到项目，默认添加"通行费"
  if (isTollInvoice && items.length === 0) {
    items = [{ name: '通行费' }]
  }

  const cleanName = (name?: string) => {
    if (!name) return undefined
    let cleaned = name
    // 去除末尾的"个人"（如果不应该是个人名字，而是公司名后面带的类型标识）
    if (cleaned.length > 4 && cleaned.endsWith('个人') && /公司|有限|集团|企业|商店/.test(cleaned)) {
      cleaned = cleaned.slice(0, -2)
    }
    return cleaned
  }

  return {
    id: crypto.randomUUID(),
    sourceFile: '本地解析',
    invoiceNumber: pickFirst(invoiceNumber),
    invoiceDate: pickFirst(invoiceDate),
    buyerName: pickFirst(cleanName(buyerName)),
    sellerName: pickFirst(cleanName(sellerName)),
    totalAmount,
    items,
    rawText: text,
    isToll: isTollInvoice,
  }
}

const mergeInvoices = (textRecord: InvoiceRecord, ocrRecord?: InvoiceRecord): InvoiceRecord => {
  if (!ocrRecord) return textRecord

  const mergedItems: LineItem[] = []
  const textItems = textRecord.items
  const ocrItems = ocrRecord.items

  if (textItems.length === 0 && ocrItems.length > 0) {
    mergedItems.push(...ocrItems)
  } else if (textItems.length > 0) {
    textItems.forEach((item, index) => {
      const candidate = ocrItems[index]
      mergedItems.push({
        name: item.name || candidate?.name || '',
        quantity: item.quantity || candidate?.quantity,
        amount: item.amount || candidate?.amount,
      })
    })
  }

  const textAmount = Number(textRecord.totalAmount)
  const ocrAmount = Number(ocrRecord.totalAmount)
  const amountShouldOverride =
    !textRecord.totalAmount ||
    (ocrRecord.isToll && Boolean(ocrRecord.totalAmount)) ||
    (!Number.isNaN(ocrAmount) && Math.abs(textAmount - ocrAmount) > 0.01)

  return {
    ...textRecord,
    invoiceNumber: textRecord.invoiceNumber || ocrRecord.invoiceNumber,
    invoiceDate: textRecord.invoiceDate || ocrRecord.invoiceDate,
    buyerName: textRecord.buyerName || ocrRecord.buyerName,
    sellerName: textRecord.sellerName || ocrRecord.sellerName,
    totalAmount: amountShouldOverride ? ocrRecord.totalAmount : textRecord.totalAmount,
    items: mergedItems,
    isToll: textRecord.isToll || ocrRecord.isToll,
  }
}

const extractTextFromPdf = async (file: File) => {
  const buffer = await file.arrayBuffer()
  const loadingTask = getDocument({ data: buffer })
  const pdf = await loadingTask.promise
  let fullText = ''

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    let lastY: number | undefined
    let pageText = ''

    content.items.forEach((item) => {
      if (!('str' in item)) return
      const textItem = item
      const y = (textItem.transform as number[])[5]
      if (lastY !== undefined && Math.abs(lastY - y) > 2) {
        pageText += '\n'
      }
      pageText += textItem.str
      lastY = y
    })

    fullText += `\n${pageText}`
  }

  return fullText.trim()
}

const renderPdfToImages = async (file: File) => {
  const buffer = await file.arrayBuffer()
  const loadingTask = getDocument({ data: buffer })
  const pdf = await loadingTask.promise
  const images: string[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('无法创建画布上下文')
    }
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvasContext: context, viewport }).promise
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88)
    images.push(dataUrl.replace(/^data:image\/jpeg;base64,/, ''))
  }

  return images
}

const readPdfBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('无法读取PDF内容'))
        return
      }
      resolve(result.replace(/^data:application\/pdf;base64,/, ''))
    }
    reader.onerror = () => reject(new Error('读取PDF失败'))
    reader.readAsDataURL(file)
  })

const getValue = (value: any) => {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value.word) return value.word
  if (value.words) return value.words
  return undefined
}

const getArrayValue = (value: any) => {
  if (Array.isArray(value)) {
    return getValue(value[0])
  }
  return getValue(value)
}

const mapBaiduResult = (payload: any, fileName: string): InvoiceRecord[] => {
  const words = payload?.words_result ?? {}
  const list = Array.isArray(words) ? words : [words]

  return list.map((item: any) => {
    const itemsByRow = new Map<number, LineItem>()
    const ensureItem = (row: number) => {
      if (!itemsByRow.has(row)) {
        itemsByRow.set(row, { name: '' })
      }
      return itemsByRow.get(row) as LineItem
    }

    const applyRowData = (entries: any[], setter: (line: LineItem, value: string) => void) => {
      entries.forEach((entry, index) => {
        const rowRaw = entry?.row ?? index + 1
        const row = Number(rowRaw)
        const value = getValue(entry)
        if (!value) return
        const line = ensureItem(Number.isNaN(row) ? index + 1 : row)
        setter(line, value)
      })
    }

    applyRowData(item?.CommodityName ?? [], (line, value) => {
      line.name = value
    })
    applyRowData(item?.CommodityNum ?? [], (line, value) => {
      line.quantity = value
    })
    applyRowData(item?.CommodityAmount ?? [], (line, value) => {
      line.amount = currencyClean(value)
    })

    let items = Array.from(itemsByRow.values())
    const invoiceTag = getArrayValue(item?.InvoiceTag)
    const serviceType = getArrayValue(item?.ServiceType)
    const isTollInvoice = invoiceTag?.includes('通行费') || serviceType?.includes('交通')
    if (items.length === 0 && isTollInvoice) {
      items = [{ name: '通行费' }]
    }

    const amountFromWords = parseChineseAmount(getArrayValue(item?.AmountInWords))
    const totalAmount = currencyClean(getArrayValue(item?.TotalAmount) ?? getArrayValue(item?.AmountInFiguers))
    const finalAmount = amountFromWords ?? totalAmount

    return {
      id: crypto.randomUUID(),
      sourceFile: fileName,
      invoiceNumber: normalizeInvoiceNumber(
        getArrayValue(item?.InvoiceNum) ??
        getArrayValue(item?.InvoiceNumDigit) ??
        getArrayValue(item?.InvoiceCode),
      ),
      invoiceDate: normalizeValue(getArrayValue(item?.InvoiceDate)),
      buyerName: normalizeValue(getArrayValue(item?.PurchaserName)),
      sellerName: normalizeValue(getArrayValue(item?.SellerName)) ?? (isTollInvoice ? undefined : normalizeValue(getArrayValue(item?.SellerRegisterNum))),
      totalAmount: finalAmount,
      items,
      isToll: isTollInvoice,
    }
  })
}

const mapMultipleInvoice = (payload: any, fileName: string): InvoiceRecord[] => {
  const raw = payload?.multiple_words_result ?? []
  // NOTE: multiple_words_result 可能是嵌套数组 [[{...}]] 或单层数组 [{...}]
  // 需要展平处理
  const flattenArray = (arr: any[]): any[] => {
    const result: any[] = []
    arr.forEach((item) => {
      if (Array.isArray(item)) {
        result.push(...flattenArray(item))
      } else {
        result.push(item)
      }
    })
    return result
  }

  const list = Array.isArray(raw) ? flattenArray(raw) : raw?.words_result ?? raw?.result ?? [raw]
  const entries = Array.isArray(list) ? list : [list]

  // NOTE: 过滤有效的发票识别结果
  const targetEntries = entries.filter((entry: any) => entry?.type || entry?.result)

  return targetEntries
    .filter(Boolean)
    .map((entry: any) => {
      const invoiceType = entry?.type ?? ''
      const result = entry?.result ?? entry?.words_result ?? entry

      // NOTE: 处理通行费发票（toll_invoice）和普通增值税发票（vat_invoice）
      if (invoiceType === 'toll_invoice' || invoiceType === 'vat_invoice') {
        const amountFromWords = parseChineseAmount(getArrayValue(result?.AmountInWords))
        const totalAmount = currencyClean(
          getArrayValue(result?.TotalAmount) ??
          getArrayValue(result?.AmountInFiguers) ??
          getArrayValue(result?.AmountInFigures),
        )
        const finalAmount = amountFromWords ?? totalAmount

        // 提取商品项目
        const itemsByRow = new Map<number, LineItem>()
        const ensureItem = (row: number) => {
          if (!itemsByRow.has(row)) {
            itemsByRow.set(row, { name: '' })
          }
          return itemsByRow.get(row) as LineItem
        }

        const applyRowData = (data: any[], setter: (line: LineItem, value: string) => void) => {
          if (!Array.isArray(data)) return
          data.forEach((item, index) => {
            const rowRaw = item?.row ?? index + 1
            const row = Number(rowRaw)
            const value = getValue(item)
            if (!value) return
            const line = ensureItem(Number.isNaN(row) ? index + 1 : row)
            setter(line, value)
          })
        }

        applyRowData(result?.CommodityName ?? [], (line, value) => {
          line.name = value
        })
        applyRowData(result?.CommodityNum ?? [], (line, value) => {
          line.quantity = value
        })
        applyRowData(result?.CommodityAmount ?? [], (line, value) => {
          line.amount = currencyClean(value)
        })

        let items = Array.from(itemsByRow.values())
        const invoiceTag = getArrayValue(result?.InvoiceTag)
        const isToll = invoiceTag?.includes('通行费') || invoiceType === 'toll_invoice'
        if (items.length === 0 && isToll) {
          items = [{ name: '通行费' }]
        }

        return {
          id: crypto.randomUUID(),
          sourceFile: fileName,
          invoiceNumber: normalizeInvoiceNumber(
            getArrayValue(result?.InvoiceNum) ??
            getArrayValue(result?.InvoiceNumConfirm) ??
            getArrayValue(result?.InvoiceCode),
          ),
          invoiceDate: normalizeValue(
            getArrayValue(result?.InvoiceDate) ?? getArrayValue(result?.Date),
          ),
          buyerName: normalizeValue(getArrayValue(result?.PurchaserName)),
          sellerName: normalizeValue(getArrayValue(result?.SellerName)),
          totalAmount: finalAmount,
          items,
          isToll,
        }
      }

      // 回退：使用通用解析
      return mapBaiduResult({ words_result: result }, fileName)[0]
    })
    .filter(Boolean)
}

const pickBestRecord = (records: Array<InvoiceRecord | undefined>) => {
  for (const record of records) {
    if (hasMeaningfulData(record)) return record
  }
  return undefined
}

const parseGeneralOcr = (payload: any, fileName: string) => {
  const general = payload?.general_words_result ?? []
  if (!Array.isArray(general) || general.length === 0) return undefined
  const text = general
    .flat()
    .map((entry: any) => entry?.words)
    .filter(Boolean)
    .join('\n')
  if (!text) return undefined
  return { ...parseTextInvoice(text), sourceFile: fileName }
}

const toSummaryRows = (records: InvoiceRecord[]) => {
  const rows: Record<string, string>[] = []
  const seen = new Set<string>()

  records.forEach((record) => {
    const key = [
      record.invoiceNumber ?? '',
      record.invoiceDate ?? '',
      record.buyerName ?? '',
      record.sellerName ?? '',
      record.sourceFile ?? '',
    ].join('|')
    if (seen.has(key)) return
    seen.add(key)
    const itemNames = record.isToll
      ? '通行费'
      : Array.from(
        new Set(record.items.map((item) => item.name).filter(Boolean)),
      ).join(' / ')

    rows.push({
      文件名: normalizeValue(record.sourceFile) ?? '-',
      发票号码: normalizeInvoiceNumber(record.invoiceNumber) ?? '-',
      开票日期: normalizeValue(record.invoiceDate) ?? '-',
      购买方名称: normalizeValue(record.buyerName) ?? '-',
      销售方名称: normalizeValue(record.sellerName) ?? '-',
      项目名称: normalizeValue(itemNames) ?? '-',
      价税合计: normalizeValue(record.totalAmount) ?? '-',
    })
  })

  return rows
}

const toDetailRows = (records: InvoiceRecord[]) => {
  const rows: Record<string, string>[] = []
  const seen = new Set<string>()

  records.forEach((record) => {
    const items = record.items.length > 0 ? record.items : [{ name: '', quantity: '', amount: record.totalAmount ?? '' }]
    items.forEach((item) => {
      const row = {
        文件名: record.sourceFile,
        发票号码: record.invoiceNumber ?? '',
        开票日期: record.invoiceDate ?? '',
        购买方名称: record.buyerName ?? '',
        销售方名称: record.sellerName ?? '',
        项目名称: item.name ?? '',
        数量: item.quantity ?? '',
        金额: item.amount ?? record.totalAmount ?? '',
      }
      const key = Object.values(row).join('|')
      if (seen.has(key)) return
      seen.add(key)
      rows.push(row)
    })
  })

  return rows
}

function App() {
  const [tasks, setTasks] = useState<FileTask[]>([])
  const [records, setRecords] = useState<InvoiceRecord[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [copiedText, setCopiedText] = useState('')
  const [isConfigOpen, setIsConfigOpen] = useState(false)
  const [ocrConfig, setOcrConfig] = useState<OcrConfig>(() => {
    const cached = localStorage.getItem(storageKey)
    if (!cached) {
      return {
        providers: ['baidu'],
        allowFallback: true,
        tencentRegion: 'ap-beijing',
      }
    }
    try {
      return JSON.parse(cached) as OcrConfig
    } catch {
      return {
        providers: ['baidu'],
        allowFallback: true,
        tencentRegion: 'ap-beijing',
      }
    }
  })
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (ocrConfig.providers.includes('tencent') && !ocrConfig.tencentRegion) {
      updateConfig({ tencentRegion: 'ap-beijing' })
    }
  }, [ocrConfig.providers, ocrConfig.tencentRegion])

  const totalDone = useMemo(() => tasks.filter((task) => task.status === 'done').length, [tasks])
  const totalErrors = useMemo(() => tasks.filter((task) => task.status === 'error').length, [tasks])

  const appendLog = (message: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${message}`, ...prev].slice(0, 8))
  }

  const updateConfig = (next: Partial<OcrConfig>) => {
    const updated = { ...ocrConfig, ...next }
    setOcrConfig(updated)
    localStorage.setItem(storageKey, JSON.stringify(updated))
  }

  const toggleProvider = (provider: ProviderId) => {
    const providers = ocrConfig.providers.includes(provider)
      ? ocrConfig.providers.filter((item) => item !== provider)
      : [...ocrConfig.providers, provider]
    if (provider === 'tencent' && !ocrConfig.providers.includes('tencent')) {
      updateConfig({ providers, tencentRegion: ocrConfig.tencentRegion ?? 'ap-beijing' })
      return
    }
    updateConfig({ providers })
  }

  const validateConfig = () => {
    // NOTE: 如果没有选择服务商，静默返回 false，让调用方决定是否使用文本层回退
    if (ocrConfig.providers.length === 0) {
      return false
    }
    if (ocrConfig.providers.includes('baidu')) {
      if (!ocrConfig.baiduApiKey || !ocrConfig.baiduSecretKey) {
        appendLog('请填写百度OCR密钥')
        return false
      }
    }
    if (ocrConfig.providers.includes('tencent')) {
      if (!ocrConfig.tencentSecretId || !ocrConfig.tencentSecretKey) {
        appendLog('请填写腾讯云OCR密钥与地域')
        return false
      }
      if (!ocrConfig.tencentRegion) {
        updateConfig({ tencentRegion: 'ap-beijing' })
      }
    }
    if (ocrConfig.providers.includes('aliyun')) {
      if (!ocrConfig.aliyunAccessKeyId || !ocrConfig.aliyunAccessKeySecret || !ocrConfig.aliyunRegion) {
        appendLog('请填写阿里云OCR密钥与地域')
        return false
      }
    }
    return true
  }

  const updateTask = (id: string, updater: (task: FileTask) => FileTask) => {
    setTasks((prev) => prev.map((task) => (task.id === id ? updater(task) : task)))
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const selected = Array.from(files).filter((file) => file.type === 'application/pdf')
    if (selected.length === 0) {
      appendLog('未检测到 PDF 文件')
      return
    }

    const nextTasks = selected.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: 'pending' as const,
      progress: 0,
    }))

    setTasks((prev) => [...nextTasks, ...prev])
    setIsProcessing(true)

    await Promise.all(
      nextTasks.map((task) =>
        fileLimit(() => processFile(task)),
      ),
    )

    setIsProcessing(false)
  }

  const processFile = async (task: FileTask) => {
    updateTask(task.id, (item) => ({ ...item, status: 'processing', progress: 10 }))
    appendLog(`开始处理 ${task.file.name}`)

    try {
      const text = await extractTextFromPdf(task.file)
      updateTask(task.id, (item) => ({ ...item, progress: 35 }))

      const parsed = parseTextInvoice(text)
      const missingKeyFields = !parsed.invoiceNumber || !parsed.invoiceDate || !parsed.buyerName || !parsed.sellerName
      const missingDetail = parsed.items.length === 0
      const missingAmount = !parsed.totalAmount
      const needsOcr = missingKeyFields || missingDetail || missingAmount

      if (!needsOcr) {
        setRecords((prev) => [{ ...parsed, sourceFile: task.file.name }, ...prev])
        updateTask(task.id, (item) => ({ ...item, status: 'done', progress: 100 }))
        appendLog(`文本层解析完成 ${task.file.name}`)
        return
      }

      updateTask(task.id, (item) => ({ ...item, progress: 55 }))

      // NOTE: 如果 OCR 配置不完整，回退使用文本层结果
      if (!validateConfig()) {
        appendLog(`OCR 配置不完整，使用文本层结果 ${task.file.name}`)
        if (hasMeaningfulData(parsed)) {
          setRecords((prev) => [{ ...parsed, sourceFile: task.file.name }, ...prev])
          updateTask(task.id, (item) => ({ ...item, status: 'done', progress: 100 }))
          appendLog(`文本层解析完成（部分字段可能缺失）${task.file.name}`)
        } else {
          updateTask(task.id, (item) => ({ ...item, status: 'error', progress: 100, message: 'OCR配置不完整且文本层无有效数据' }))
        }
        return
      }

      appendLog(`改用 OCR 校对 ${task.file.name}`)

      const images = await renderPdfToImages(task.file)
      const pdfBase64 = await readPdfBase64(task.file)
      const primaryProvider = ocrConfig.providers[0] ?? 'baidu'
      updateTask(task.id, (item) => ({ ...item, progress: 70 }))

      try {
        const response = await fetch(`${apiBase}/ocr/baidu/vat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images,
            fileName: task.file.name,
            pdfBase64,
            provider: primaryProvider,
            providers: ocrConfig.providers,
            allowFallback: ocrConfig.allowFallback,
            credentials: {
              baiduApiKey: ocrConfig.baiduApiKey,
              baiduSecretKey: ocrConfig.baiduSecretKey,
              tencentSecretId: ocrConfig.tencentSecretId,
              tencentSecretKey: ocrConfig.tencentSecretKey,
              tencentRegion: ocrConfig.tencentRegion,
              aliyunAccessKeyId: ocrConfig.aliyunAccessKeyId,
              aliyunAccessKeySecret: ocrConfig.aliyunAccessKeySecret,
              aliyunRegion: ocrConfig.aliyunRegion,
              ocrSpaceApiKey: ocrConfig.ocrSpaceApiKey,
            },
          }),
        })

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null)
          const message = errorBody?.message || 'OCR 请求失败'
          const code = errorBody?.code
          throw new Error(code ? `${message} (${code})` : message)
        }

        const data = await response.json()
        if (data.meta?.usedProviders?.length) {
          const providerLabels = data.meta.usedProviders
            .map((entry: { provider: string; status: string; from?: string; reason?: string }) => {
              if (entry.status === 'used') return entry.provider
              if (entry.status === 'attempted') {
                const reason = entry.reason ? `(${entry.reason})` : ''
                const from = entry.from ? `,兜底自${entry.from}` : ''
                return `${entry.provider}${from}${reason}`
              }
              return entry.provider
            })
            .join(' / ')
          appendLog(`本次OCR服务商记录: ${providerLabels}`)
        }
        const mapped = mapBaiduResult(data, task.file.name)
        const multipleMapped = mapMultipleInvoice(data, task.file.name)
        const generalRecord = parseGeneralOcr(data, task.file.name)
        const candidates = [mapped[0], multipleMapped[0], generalRecord]

        let merged = { ...parsed, sourceFile: task.file.name }
        candidates.forEach((candidate) => {
          if (hasMeaningfulData(candidate)) {
            merged = mergeInvoices(merged, candidate)
          }
        })

        if (!hasMeaningfulData(merged)) {
          updateTask(task.id, (item) => ({
            ...item,
            status: 'error',
            progress: 100,
            message: '未识别到增值税发票字段',
          }))
          appendLog(`未识别到增值税发票字段 ${task.file.name}`)
          return
        }

        setRecords((prev) => [merged, ...prev])
        updateTask(task.id, (item) => ({ ...item, status: 'done', progress: 100 }))
        const incomplete = !merged.invoiceNumber || !merged.invoiceDate || !merged.buyerName || !merged.sellerName
        appendLog(`${incomplete ? 'OCR 校对完成但字段不完整' : 'OCR 校对完成'} ${task.file.name}`)
      } catch (ocrError) {
        const hasAnyText = text.length > 0
        if (hasAnyText) {
          setRecords((prev) => [{ ...parsed, sourceFile: task.file.name }, ...prev])
          updateTask(task.id, (item) => ({ ...item, status: 'done', progress: 100 }))
          const message = ocrError instanceof Error ? ocrError.message : 'OCR 失败'
          appendLog(`OCR 失败，已使用文本层结果 ${task.file.name} (${message})`)
        } else {
          throw ocrError
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      updateTask(task.id, (item) => ({ ...item, status: 'error', progress: 100, message }))
      appendLog(`处理失败 ${task.file.name}`)
    }
  }

  const exportCsv = () => {
    const rows = toDetailRows(records)
    if (rows.length === 0) return
    const csv = Papa.unparse(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `发票识别_${Date.now()}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportXlsx = () => {
    const summary = toSummaryRows(records)
    const detail = toDetailRows(records)
    if (summary.length === 0 && detail.length === 0) return
    const book = XLSX.utils.book_new()
    if (summary.length > 0) {
      const sheet = XLSX.utils.json_to_sheet(summary)
      XLSX.utils.book_append_sheet(book, sheet, '汇总')
    }
    if (detail.length > 0) {
      const sheet = XLSX.utils.json_to_sheet(detail)
      XLSX.utils.book_append_sheet(book, sheet, '明细')
    }
    XLSX.writeFile(book, `发票识别_${Date.now()}.xlsx`)
  }

  const exportSummaryCsv = () => {
    const rows = toSummaryRows(records)
    if (rows.length === 0) return
    const csv = Papa.unparse(rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `发票识别_汇总_${Date.now()}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleCopy = async (value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      appendLog(`已复制: ${value}`)
      setCopiedText(value)
      setTimeout(() => setCopiedText(''), 1200)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = value
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      appendLog(`已复制: ${value}`)
      setCopiedText(value)
      setTimeout(() => setCopiedText(''), 1200)
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div className="hero__content">
          <p className="eyebrow">批量发票识别工作台</p>
          <h1>把发票录入变成几分钟的事</h1>
          <p className="hero__subtitle">
            支持批量 PDF 上传，自动识别项目名称、数量、金额、购买方名称、销售方名称、发票号码、开票日期，并导出 CSV/XLSX。
          </p>
          <div className="hero__actions">
            <button className="primary" onClick={() => inputRef.current?.click()} disabled={isProcessing}>
              上传 PDF 发票
            </button>
            <button className="ghost" onClick={() => setIsConfigOpen(true)}>
              OCR 配置
            </button>
            <button className="ghost" onClick={exportXlsx} disabled={records.length === 0}>
              导出 XLSX(汇总+明细)
            </button>
            <button className="ghost" onClick={exportCsv} disabled={records.length === 0}>
              导出 CSV(明细)
            </button>
            <button className="ghost" onClick={exportSummaryCsv} disabled={records.length === 0}>
              导出 CSV(汇总)
            </button>
          </div>
          <div className="hero__stats">
            <div>
              <span className="label">已处理</span>
              <strong>{totalDone}</strong>
            </div>
            <div>
              <span className="label">失败</span>
              <strong>{totalErrors}</strong>
            </div>
            <div>
              <span className="label">记录数</span>
              <strong>{records.length}</strong>
            </div>
          </div>
        </div>
        <div className="hero__panel">
          <div className="panel__title">处理日志</div>
          <div className="panel__log">
            {log.length === 0 ? <span>等待上传 PDF 发票…</span> : log.map((entry) => <div key={entry}>{entry}</div>)}
          </div>
          <div className="panel__note">
            系统会优先解析电子发票文本层，无法提取时自动切换 OCR。
          </div>
        </div>
      </header>

      <section className="workspace">
        <div className="workspace__header">
          <h2>任务队列</h2>
          <p>支持多文件并行处理，队列自动限流。</p>
        </div>
        <div className="queue">
          {tasks.length === 0 ? (
            <div className="queue__empty">
              <span>还没有任务，拖拽或点击上传 PDF。</span>
            </div>
          ) : (
            tasks.map((task) => (
              <div key={task.id} className={`queue__item queue__item--${task.status}`}>
                <div>
                  <div className="queue__name">{task.file.name}</div>
                  <div className="queue__meta">
                    {task.file.size ? `${Math.round(task.file.size / 1024)} KB` : ''}
                    <span>{task.status === 'processing' ? '处理中' : task.status === 'done' ? '完成' : task.status === 'error' ? '失败' : '待处理'}</span>
                  </div>
                  {task.message ? <div className="queue__error">{task.message}</div> : null}
                </div>
                <div className="queue__progress">
                  <div style={{ width: `${task.progress}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="results">
        <div className="workspace__header">
          <h2>识别结果</h2>
          <p>结果按发票汇总展示，明细请使用导出。</p>
        </div>
        <div className="table">
          <div className="table__head">
            <span>文件名</span>
            <span>发票号码</span>
            <span>开票日期</span>
            <span>购买方</span>
            <span>销售方</span>
            <span>项目名称</span>
            <span>价税合计</span>
          </div>
          <div className="table__body">
            {toSummaryRows(records).length === 0 ? (
              <div className="table__empty">暂无识别结果</div>
            ) : (
              toSummaryRows(records).map((row, index) => (
                <div className="table__row" key={`${row.发票号码}-${index}`}>
                  <span
                    title={row.文件名}
                    onClick={() => handleCopy(row.文件名)}
                  >
                    {row.文件名}
                  </span>
                  <span
                    title={row.发票号码}
                    onClick={() => handleCopy(row.发票号码)}
                  >
                    {row.发票号码}
                  </span>
                  <span
                    title={row.开票日期}
                    onClick={() => handleCopy(row.开票日期)}
                  >
                    {row.开票日期}
                  </span>
                  <span
                    title={row.购买方名称}
                    onClick={() => handleCopy(row.购买方名称)}
                  >
                    {row.购买方名称}
                  </span>
                  <span
                    title={row.销售方名称}
                    onClick={() => handleCopy(row.销售方名称)}
                  >
                    {row.销售方名称}
                  </span>
                  <span
                    title={row.项目名称}
                    onClick={() => handleCopy(row.项目名称)}
                  >
                    {row.项目名称}
                  </span>
                  <span
                    title={row.价税合计}
                    onClick={() => handleCopy(row.价税合计)}
                  >
                    {row.价税合计}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        {copiedText ? (
          <div className="copy-toast">已复制到剪切板</div>
        ) : null}
      </section>

      {isConfigOpen ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__panel">
            <div className="modal__header">
              <h3>OCR 服务配置</h3>
              <button className="ghost" onClick={() => setIsConfigOpen(false)}>
                关闭
              </button>
            </div>
            <p className="modal__note">
              你的密钥只保存在本地浏览器中，调用OCR时通过后端转发，服务端不会落盘保存。
            </p>

            <div className="modal__section">
              <h4>选择服务商（可多选）</h4>
              <div className="provider-list">
                <label>
                  <input
                    type="checkbox"
                    checked={ocrConfig.providers.includes('baidu')}
                    onChange={() => toggleProvider('baidu')}
                  />
                  百度OCR
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={ocrConfig.providers.includes('tencent')}
                    onChange={() => toggleProvider('tencent')}
                  />
                  腾讯云OCR
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={ocrConfig.providers.includes('ocrspace')}
                    onChange={() => toggleProvider('ocrspace')}
                  />
                  OCR.Space（免费，每月25,000次）
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={ocrConfig.providers.includes('aliyun')}
                    onChange={() => toggleProvider('aliyun')}
                  />
                  阿里云OCR
                </label>
              </div>
              <div className="modal__hint">
                当前已支持百度/腾讯/OCR.Space；阿里云配置会先保存，后续接入即可启用。
              </div>
            </div>

            {ocrConfig.providers.includes('baidu') ? (
              <div className="modal__section">
                <h4>百度OCR</h4>
                <div className="field-grid">
                  <label>
                    API Key
                    <input
                      type="text"
                      value={ocrConfig.baiduApiKey ?? ''}
                      onChange={(event) => updateConfig({ baiduApiKey: event.target.value })}
                    />
                  </label>
                  <label>
                    Secret Key
                    <input
                      type="password"
                      value={ocrConfig.baiduSecretKey ?? ''}
                      onChange={(event) => updateConfig({ baiduSecretKey: event.target.value })}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {ocrConfig.providers.includes('tencent') ? (
              <div className="modal__section">
                <h4>腾讯云OCR</h4>
                <div className="field-grid">
                  <label>
                    SecretId
                    <input
                      type="text"
                      value={ocrConfig.tencentSecretId ?? ''}
                      onChange={(event) => updateConfig({ tencentSecretId: event.target.value })}
                    />
                  </label>
                  <label>
                    SecretKey
                    <input
                      type="password"
                      value={ocrConfig.tencentSecretKey ?? ''}
                      onChange={(event) => updateConfig({ tencentSecretKey: event.target.value })}
                    />
                  </label>
                </div>
                <div className="region-group">
                  <span>地域</span>
                  <label>
                    <input
                      type="radio"
                      name="tencentRegion"
                      checked={(ocrConfig.tencentRegion ?? 'ap-beijing') === 'ap-beijing'}
                      onChange={() => updateConfig({ tencentRegion: 'ap-beijing' })}
                    />
                    ap-beijing
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="tencentRegion"
                      checked={ocrConfig.tencentRegion === 'ap-shanghai'}
                      onChange={() => updateConfig({ tencentRegion: 'ap-shanghai' })}
                    />
                    ap-shanghai
                  </label>
                </div>
              </div>
            ) : null}

            {ocrConfig.providers.includes('aliyun') ? (
              <div className="modal__section">
                <h4>阿里云OCR</h4>
                <div className="field-grid">
                  <label>
                    AccessKeyId
                    <input
                      type="text"
                      value={ocrConfig.aliyunAccessKeyId ?? ''}
                      onChange={(event) => updateConfig({ aliyunAccessKeyId: event.target.value })}
                    />
                  </label>
                  <label>
                    AccessKeySecret
                    <input
                      type="password"
                      value={ocrConfig.aliyunAccessKeySecret ?? ''}
                      onChange={(event) => updateConfig({ aliyunAccessKeySecret: event.target.value })}
                    />
                  </label>
                  <label>
                    地域
                    <input
                      type="text"
                      placeholder="cn-shanghai"
                      value={ocrConfig.aliyunRegion ?? ''}
                      onChange={(event) => updateConfig({ aliyunRegion: event.target.value })}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {ocrConfig.providers.includes('ocrspace') ? (
              <div className="modal__section">
                <h4>OCR.Space</h4>
                <div className="field-grid">
                  <label>
                    API Key
                    <input
                      type="text"
                      placeholder="留空则使用默认免费Key"
                      value={ocrConfig.ocrSpaceApiKey ?? ''}
                      onChange={(event) => updateConfig({ ocrSpaceApiKey: event.target.value })}
                    />
                  </label>
                </div>
                <div className="modal__hint">
                  提示：OCR.Space 提供免费 API Key（每月25,000次），也可申请 PRO Key 以获得更高额度与速度。
                </div>
              </div>
            ) : null}

            <div className="modal__section">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={ocrConfig.allowFallback}
                  onChange={(event) => updateConfig({ allowFallback: event.target.checked })}
                />
                失败后允许自动切换到其他已配置服务商
              </label>
            </div>
            <div className="modal__footer">
              <button className="primary" onClick={() => setIsConfigOpen(false)}>
                保存配置
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple
        hidden
        onChange={(event) => handleFiles(event.target.files)}
      />
    </div>
  )
}

export default App
