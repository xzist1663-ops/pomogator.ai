import express from 'express'
import { createGunzip, inflateRaw } from 'zlib'
import { Readable } from 'stream'
import cors from 'cors'
import { config, assertOzonKeys, validateEnv } from './config.js'
import { getAllCosts, setCost, getAllAccounts, getActiveAccount, upsertAccount, setActiveAccount, deleteAccount } from './db.js'
import { computeEconomics } from './scoring.js'

// Проверяем обязательные env-переменные при старте
validateEnv()

// ── Безопасная обработка ошибок ───────────────────────────────────────────────
function safeError(e: unknown, context: string): { status: number; message: string } {
  const detail = e instanceof Error ? e.message : String(e)
  console.error('[' + context + ']', detail)
  if (detail.includes('Ozon ') && detail.includes('→')) return { status: 502, message: detail }
  if (detail.includes('Нет привязанного аккаунта')) return { status: 400, message: detail }
  if (detail.includes('Неверные')) return { status: 400, message: detail }
  return { status: 500, message: 'Внутренняя ошибка сервера' }
}

const app = express()

// CORS — разрешаем только запросы из Chrome-расширения и localhost
app.use(cors({
  origin: (origin, callback) => {
    // Chrome extensions имеют origin вида chrome-extension://...
    // localhost для разработки
    if (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('http://localhost')) {
      callback(null, true)
    } else {
      callback(new Error('CORS: запрещённый origin: ' + origin))
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
}))

app.use(express.json({ limit: '1mb' }))

// ── Rate limiter — простой in-memory счётчик ──────────────────────────────────
// Защита от брутфорса токена и злоупотребления API
const _rateCounts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 120       // запросов
const RATE_WINDOW = 60_000   // за 60 секунд

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = _rateCounts.get(ip)
  if (!entry || now > entry.resetAt) {
    _rateCounts.set(ip, { count: 1, resetAt: now + RATE_WINDOW })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT
}

// ══════════════════════════════════════════════════════════════════════════════
// ── МУЛЬТИАККАУНТ ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

interface OzonCreds { clientId: string; apiKey: string; perfApiKey?: string | null }

let _activeCredsCache: OzonCreds | null = null
let _credsCacheTs = 0

async function getActiveCreds(): Promise<OzonCreds> {
  if (_activeCredsCache && Date.now() - _credsCacheTs < 5000) return _activeCredsCache
  const acc = await getActiveAccount()
  if (acc) {
    _activeCredsCache = { clientId: acc.clientId, apiKey: acc.apiKey, perfApiKey: acc.perfApiKey }
    _credsCacheTs = Date.now()
    return _activeCredsCache
  }
  _activeCredsCache = { clientId: config.ozon.clientId, apiKey: config.ozon.apiKey }
  _credsCacheTs = Date.now()
  return _activeCredsCache
}

async function ozonCall<T>(path: string, body: unknown): Promise<T> {
  const creds = await getActiveCreds()
  if (!creds.clientId || !creds.apiKey) throw new Error('Нет привязанного аккаунта Ozon. Привяжите API-ключи в виджете.')
  const res = await fetch(config.ozon.baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Id': creds.clientId, 'Api-Key': creds.apiKey },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Ozon ${path} → ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ── Performance API ───────────────────────────────────────────────────────────

let _perfTokenCache: { token: string; clientId: string; expiresAt: number } | null = null
let _perfTokenInflight: Promise<{ token: string; clientId: string } | null> | null = null

// Глобальная очередь запросов к Performance API — только 1 одновременно
let _perfQueue: Promise<any> = Promise.resolve()
function perfQueued<T>(fn: () => Promise<T>): Promise<T> {
  const next = _perfQueue.then(() => fn()).catch(e => { throw e })
  _perfQueue = next.catch(() => {})  // не обрываем цепочку при ошибке
  return next
}

async function getPerfToken(): Promise<{ token: string; clientId: string } | null> {
  const creds = await getActiveCreds()
  if (!creds.perfApiKey) return null
  const parts = creds.perfApiKey.split('::')
  if (parts.length !== 2) return null
  const [perfClientId, perfClientSecret] = parts

  if (_perfTokenCache && _perfTokenCache.clientId === perfClientId && Date.now() < _perfTokenCache.expiresAt - 60_000) {
    return { token: _perfTokenCache.token, clientId: _perfTokenCache.clientId }
  }
  if (_perfTokenInflight) return _perfTokenInflight

  _perfTokenInflight = (async () => {
    try {
      const params = new URLSearchParams()
      params.append('client_id', perfClientId)
      params.append('client_secret', perfClientSecret)
      params.append('grant_type', 'client_credentials')
      const res = await fetch('https://api-performance.ozon.ru/api/client/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(), redirect: 'follow',
      })
      const data = await res.json()
      if (!res.ok || !data?.access_token) { console.warn('[perf] token error:', JSON.stringify(data)); return null }
      _perfTokenCache = { token: data.access_token, clientId: perfClientId, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 }
      return { token: _perfTokenCache.token, clientId: perfClientId }
    } catch (e) { console.warn('[perf] token exception:', e); return null }
    finally { _perfTokenInflight = null }
  })()
  return _perfTokenInflight
}

async function perfGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const auth = await getPerfToken()
  if (!auth) throw new Error('Нет Performance API ключей или не удалось получить токен')
  const url = 'https://api-performance.ozon.ru' + path + (params ? '?' + new URLSearchParams(params).toString() : '')
  const res = await fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId } })
  if (!res.ok) { const text = await res.text(); throw new Error('Perf GET ' + path + ' → ' + res.status + ': ' + text) }
  return res.json() as Promise<T>
}

async function perfPost<T>(path: string, body: unknown): Promise<T> {
  const auth = await getPerfToken()
  if (!auth) throw new Error('Нет Performance API ключей или не удалось получить токен')
  const res = await fetch('https://api-performance.ozon.ru' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const text = await res.text(); throw new Error('Perf POST ' + path + ' → ' + res.status + ': ' + text) }
  return res.json() as Promise<T>
}

// ══════════════════════════════════════════════════════════════════════════════
// ── КЭШ РЕКЛАМНОЙ СТАТИСТИКИ ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

interface PerfCacheEntry { data: Map<string, number>; updatedAt: number; loading: boolean }
const perfCache = new Map<string, PerfCacheEntry>()
const PERF_CACHE_TTL = 60 * 60 * 1000

async function getPerfSpendByOffer(): Promise<Map<string, number> | null> {
  const creds = await getActiveCreds()
  if (!creds.perfApiKey) return null
  const cacheKey = creds.clientId
  const cached = perfCache.get(cacheKey)
  if (cached && !cached.loading && Date.now() - cached.updatedAt < PERF_CACHE_TTL) return cached.data
  if (cached?.loading) return cached.data ?? null
  const entry: PerfCacheEntry = { data: cached?.data ?? new Map(), updatedAt: cached?.updatedAt ?? 0, loading: true }
  perfCache.set(cacheKey, entry)
  loadPerfStats(cacheKey).catch(e => { console.warn('[perf cache] load failed:', e.message); entry.loading = false })
  return entry.data.size > 0 ? entry.data : null
}

async function loadPerfStats(cacheKey: string): Promise<void> {
  console.log('[perf cache] loading stats for', cacheKey)
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const dateFrom = from.toISOString().slice(0, 10)
  const dateTo   = now.toISOString().slice(0, 10)
  const spendMap = new Map<string, number>()

  // Каждый тип кампаний запрашивается отдельно — смешивать нельзя
  // SKU = трафареты (оплата за клик) — работает через /api/client/statistics
  // SEARCH_PROMO = продвижение в поиске — для него нужен другой endpoint
  // BRAND_SHELF, MEDIA — пропускаем (не дают разбивку по артикулам)
  const campTypes = ['SKU']

  for (const campType of campTypes) {
    try {
      await new Promise(r => setTimeout(r, 1000))
      const campsRes = await perfQueued(() =>
        perfGet<any>('/api/client/campaign', { state: 'CAMPAIGN_STATE_RUNNING', advObjectType: campType })
      )
      const camps: any[] = campsRes?.list ?? []
      if (camps.length === 0) { console.log('[perf cache] type', campType, ': 0'); continue }
      console.log('[perf cache] type', campType, ':', camps.length, 'campaigns')

      const BATCH = 10
      for (let bi = 0; bi < camps.length; bi += BATCH) {
        if (bi > 0) await new Promise(r => setTimeout(r, 10000))  // 10 сек между батчами
        const batch = camps.slice(bi, bi + BATCH).map((c: any) => String(c.id))
        try {
          const statReq = await perfQueued(() => perfPost<any>('/api/client/statistics', {
            campaigns: batch, date_from: dateFrom, date_to: dateTo, groupBy: 'NO_GROUP_BY',
          }))
          const uuid = statReq?.UUID ?? statReq?.uuid
          if (!uuid) { console.warn('[perf cache]', campType, 'no uuid'); continue }
          console.log('[perf cache]', campType, 'uuid:', uuid)

          let downloadLink: string | null = null
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 4000))
            let check: any
            try { check = await perfGet<any>('/api/client/statistics/' + uuid) } catch { continue }
            console.log('[perf cache]', campType, 'poll', i, 'state:', check?.state)
            if ((check?.state === 'READY' || check?.state === 'OK') && check?.link) {
              // Если link относительный — добавляем хост
              const lnk: string = check.link
              downloadLink = lnk.startsWith('http') ? lnk : 'https://api-performance.ozon.ru' + (lnk.startsWith('/') ? '' : '/') + lnk
              break
            }
            if (check?.state === 'ERROR' || check?.state === 'FAILED') break
            // OK без link — используем стандартный URL скачивания
            if (check?.state === 'READY' || check?.state === 'OK') {
              downloadLink = 'https://api-performance.ozon.ru/api/client/statistics/' + uuid + '/report'
              console.log('[perf cache] OK state, trying download:', downloadLink)
              break
            }
          }
          // Если нет link но state=OK — пробуем скачать напрямую
          if (!downloadLink) {
            try {
              const auth2 = await getPerfToken()
              const tryUrls = [
                'https://api-performance.ozon.ru/api/client/statistics/' + uuid + '/report',
              ]
              for (const tryUrl of tryUrls) {
                const r = await fetch(tryUrl, { headers: { 'Authorization': 'Bearer ' + (auth2?.token ?? ''), 'Client-Id': auth2?.clientId ?? '' } })
                console.log('[perf cache]', campType, 'try download', tryUrl, 'status:', r.status)
                if (r.ok) { downloadLink = tryUrl; break }
              }
            } catch (e: any) { console.warn('[perf cache] direct download failed:', e.message) }
            if (!downloadLink) { console.warn('[perf cache]', campType, 'no link'); continue }
          }

          const auth = await getPerfToken()
          const fileRes = await fetch(downloadLink, {
            headers: { 'Authorization': 'Bearer ' + (auth?.token ?? ''), 'Client-Id': auth?.clientId ?? '' }
          })
          console.log('[perf cache]', campType, 'file status:', fileRes.status, 'content-type:', fileRes.headers.get('content-type'), 'encoding:', fileRes.headers.get('content-encoding'))

          // Файл может быть ZIP архивом или gzip
          let csvText: string
          const contentType = fileRes.headers.get('content-type') ?? ''
          const buffer = Buffer.from(await fileRes.arrayBuffer())

          if (contentType.includes('zip') || (buffer[0] === 0x50 && buffer[1] === 0x4B)) {
            // ZIP: ищем EOCD (End of Central Directory) с конца файла
            let csvContent = ''
            let eocdOffset = -1
            for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
              if (buffer[i] === 0x50 && buffer[i+1] === 0x4B && buffer[i+2] === 0x05 && buffer[i+3] === 0x06) {
                eocdOffset = i; break
              }
            }
            if (eocdOffset >= 0) {
              const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
              const cdOffset = buffer.readUInt32LE(eocdOffset + 16)
              let cdPos = cdOffset
              for (let ei = 0; ei < totalEntries && !csvContent; ei++) {
                if (!(buffer[cdPos] === 0x50 && buffer[cdPos+1] === 0x4B && buffer[cdPos+2] === 0x01 && buffer[cdPos+3] === 0x02)) break
                const comp     = buffer.readUInt16LE(cdPos + 10)
                const cSize    = buffer.readUInt32LE(cdPos + 20)
                const lhOffset = buffer.readUInt32LE(cdPos + 42)
                const fnLen    = buffer.readUInt16LE(cdPos + 28)
                const exLen    = buffer.readUInt16LE(cdPos + 30)
                const comLen   = buffer.readUInt16LE(cdPos + 32)
                cdPos += 46 + fnLen + exLen + comLen
                const lFnLen = buffer.readUInt16LE(lhOffset + 26)
                const lExLen = buffer.readUInt16LE(lhOffset + 28)
                const dataStart = lhOffset + 30 + lFnLen + lExLen
                const compData = buffer.slice(dataStart, dataStart + cSize)
                if (comp === 0) {
                  csvContent = compData.toString('utf-8')
                } else if (comp === 8) {
                  csvContent = await new Promise<string>((res, rej) => {
                    inflateRaw(compData, (err, result) => err ? rej(err) : res(result.toString('utf-8')))
                  })
                }
              }
            } else {
              // Fallback: ищем Local File Header напрямую
              const lhIdx = buffer.indexOf(Buffer.from([0x50, 0x4B, 0x03, 0x04]))
              if (lhIdx >= 0) {
                const comp    = buffer.readUInt16LE(lhIdx + 8)
                const cSize   = buffer.readUInt32LE(lhIdx + 18)
                const fnLen   = buffer.readUInt16LE(lhIdx + 26)
                const exLen   = buffer.readUInt16LE(lhIdx + 28)
                const dStart  = lhIdx + 30 + fnLen + exLen
                const compData = buffer.slice(dStart, dStart + cSize)
                if (comp === 0) csvContent = compData.toString('utf-8')
                else if (comp === 8) csvContent = await new Promise<string>((res, rej) => {
                  inflateRaw(compData, (err, result) => err ? rej(err) : res(result.toString('utf-8')))
                })
              }
            }
            csvText = csvContent
          } else if (buffer[0] === 0x1F && buffer[1] === 0x8B) {
            // gzip
            csvText = await new Promise<string>((resolve, reject) => {
              const gunzip = createGunzip()
              const chunks: Buffer[] = []
              Readable.from(buffer).pipe(gunzip)
              gunzip.on('data', (c: Buffer) => chunks.push(c))
              gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
              gunzip.on('error', reject)
            })
          } else {
            csvText = buffer.toString('utf-8')
          }
          console.log('[perf cache]', campType, 'csv sample:', csvText.slice(0, 400))
          const allLines = csvText.split('\n').map((l:string)=>l.trim()).filter((l:string)=>l)
          if (allLines.length < 2) continue
          const sep = allLines.find((l:string)=>l.includes(';')) ? ';' : ','
          // Первая строка — заголовок кампании, вторая — заголовки колонок
          let hIdx = 0
          for (let i = 0; i < Math.min(5, allLines.length); i++) {
            if (/^sku;|;sku;|^артикул/i.test(allLines[i])) { hIdx = i; break }
          }
          const headers = allLines[hIdx].split(sep).map((h:string)=>h.trim().replace(/"/g,'').toLowerCase())
          console.log('[perf cache]', campType, 'headers:', headers.join('|'))
          const skuIdx   = headers.findIndex((h:string) => h === 'sku' || /артикул|offer_id/i.test(h))
          const spentIdx = headers.findIndex((h:string) => /расход|spent/i.test(h))
          console.log('[perf cache]', campType, 'skuIdx:', skuIdx, 'spentIdx:', spentIdx)
          for (let li = hIdx + 1; li < allLines.length; li++) {
            const cols = allLines[li].split(sep).map((c:string)=>c.trim().replace(/"/g,''))
            const oid = skuIdx >= 0 ? cols[skuIdx] : ''
            if (!oid || oid === '\u2014' || oid === '-' || !/^\d+$/.test(oid)) continue
            const spent = spentIdx >= 0 ? Number(cols[spentIdx].replace(',','.').replace(/[^\d.]/g,'')) : 0
            if (spent > 0) { 
              spendMap.set(oid, (spendMap.get(oid)??0) + spent)
              console.log('[perf] sku:', oid, 'spent:', spent)
            }
          }
        } catch (e: any) { console.warn('[perf cache]', campType, 'batch error:', e.message) }
      }
    } catch (e: any) { console.warn('[perf cache] type', campType, 'error:', e.message) }
  }

  console.log('[perf cache] loaded', spendMap.size, 'offer entries')
  const entry = perfCache.get(cacheKey)!
  entry.data = spendMap; entry.updatedAt = Date.now(); entry.loading = false
}

// ══════════════════════════════════════════════════════════════════════════════
// ── КЭШ РЕАЛИЗАЦИИ ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const realizCache = new Map<string, any[]>()
const realizCacheTs = new Map<string, number>()
const CURRENT_MONTH_TTL = 5 * 60 * 1000

async function fetchRealizCached(year: number, month: number): Promise<any[]> {
  const creds = await getActiveCreds()
  const key = `${creds.clientId}:${year}-${String(month).padStart(2, '0')}`
  const now = new Date()
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1
  if (isCurrent && realizCache.has(key) && Date.now() - (realizCacheTs.get(key) ?? 0) > CURRENT_MONTH_TTL) realizCache.delete(key)
  if (realizCache.has(key)) return realizCache.get(key)!

  const out: any[] = []
  let page = 1
  for (let i = 0; i < 100; i++) {
    const data = await ozonCall<any>('/v2/finance/realization', { year, month, page, page_size: 1000 })
    const rows = data?.result?.rows ?? data?.rows ?? []
    out.push(...rows)
    const pageCount = Number(data?.result?.page_count ?? data?.page_count ?? 1)
    if (page >= pageCount || rows.length === 0) break
    page++
  }
  realizCache.set(key, out); realizCacheTs.set(key, Date.now())
  return out
}

async function getMonths(maxClosed = 12): Promise<{ all: { year: number; month: number; isCurrent: boolean }[]; closed: { year: number; month: number }[]; current: { year: number; month: number } | null }> {
  const closed: { year: number; month: number }[] = []
  const now = new Date()
  const curYear = now.getFullYear(), curMonth = now.getMonth() + 1
  let currentMonthData: { year: number; month: number } | null = null
  try { const rows = await fetchRealizCached(curYear, curMonth); if (rows.length > 0) currentMonthData = { year: curYear, month: curMonth } } catch {}
  for (let i = 1; i <= Math.max(maxClosed, 24) && closed.length < maxClosed; i++) {
    const d = new Date(curYear, curMonth - 1 - i, 1)
    try { const rows = await fetchRealizCached(d.getFullYear(), d.getMonth() + 1); if (rows.length > 0) closed.push({ year: d.getFullYear(), month: d.getMonth() + 1 }) }
    catch (e: any) { const msg = String(e?.message ?? ''); if (msg.includes('not found') || msg.includes('404') || msg.includes('Report')) continue; break }
  }
  const all = [...(currentMonthData ? [{ ...currentMonthData, isCurrent: true }] : []), ...closed.map(m => ({ ...m, isCurrent: false }))]
  return { all, closed, current: currentMonthData }
}

function parseRealizRow(row: any): { offerId: string; sku: number | null; deliveryCount: number; deliveryAmount: number; returnCount: number; returnAmount: number } | null {
  const offerId = row.item?.offer_id ?? row.offer_id ?? row.article ?? row.vendor_code ?? null
  if (!offerId) return null
  return {
    offerId, sku: row.item?.sku ? Number(row.item.sku) : null,
    deliveryCount:  Number(row.delivery_count  ?? row.delivered_count ?? row.qty ?? 0),
    deliveryAmount: Number(row.delivery_amount  ?? row.delivered_amount ?? row.payment_amount ?? row.payout_amount ?? 0),
    returnCount:    Number(row.return_count     ?? row.returns_count ?? row.old_qty ?? 0),
    returnAmount:   Number(row.return_amount    ?? row.returns_amount ?? row.return_flow_amount ?? 0),
  }
}

interface OfferStats { offerId: string; sku: number | null; deliveryCount: number; deliveryAmount: number; returnCount: number; returnAmount: number; monthsIncluded: number; includesCurrent: boolean }

async function aggregateRealization(months: { year: number; month: number; isCurrent?: boolean }[]): Promise<Map<string, OfferStats>> {
  const result = new Map<string, OfferStats>()
  for (let i = 0; i < months.length; i++) {
    const { year, month } = months[i]
    const isCurrent = !!(months[i] as any).isCurrent
    try {
      const rows = await fetchRealizCached(year, month)
      for (const row of rows) {
        const parsed = parseRealizRow(row)
        if (!parsed || parsed.deliveryCount === 0) continue
        if (!result.has(parsed.offerId)) result.set(parsed.offerId, { offerId: parsed.offerId, sku: parsed.sku, deliveryCount: 0, deliveryAmount: 0, returnCount: 0, returnAmount: 0, monthsIncluded: 0, includesCurrent: false })
        const acc = result.get(parsed.offerId)!
        acc.deliveryCount  += parsed.deliveryCount
        acc.deliveryAmount += parsed.deliveryAmount
        acc.returnCount    += parsed.returnCount
        acc.returnAmount   += parsed.returnAmount
        if (parsed.sku && !acc.sku) acc.sku = parsed.sku
        acc.monthsIncluded++
        if (isCurrent) acc.includesCurrent = true
      }
    } catch (e: any) { console.warn(`[realiz] ${year}-${month}:`, e.message) }
  }
  return result
}

function monthsInRange(allMonths: { year: number; month: number; isCurrent?: boolean }[], dateFrom: Date, dateTo: Date) {
  return allMonths.filter(({ year, month }) => {
    const mStart = new Date(year, month - 1, 1), mEnd = new Date(year, month, 0)
    return mEnd >= dateFrom && mStart <= dateTo
  })
}

function parseDateRange(query: any): { dateFrom: Date; dateTo: Date } {
  const now = new Date()
  return {
    dateFrom: query.from ? new Date(query.from as string) : new Date(now.getFullYear(), now.getMonth(), 1),
    dateTo:   query.to   ? new Date((query.to as string) + 'T23:59:59') : now,
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── НАЛОГОВЫЙ РАСЧЁТ ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

interface TaxBreakdown { taxSystem: string; nds: number; incomeTax: number; totalTax: number; netAfterTax: number; marginAfterTax: number; ndsDeduction: number }

function calcTax(args: { taxSystem: string; payout: number; cost: number; price: number; commissionRub: number }): TaxBreakdown {
  const { taxSystem, payout, cost, price, commissionRub } = args
  let nds = 0, incomeTax = 0, ndsDeduction = 0
  if (taxSystem === 'usn6') {
    incomeTax = Math.round(price * 0.06)
  } else if (taxSystem === 'usn6_nds5') {
    nds = Math.round(price * 5 / 105)
    incomeTax = Math.round((price - nds) * 0.06)
  } else if (taxSystem === 'usn6_nds7') {
    nds = Math.round(price * 7 / 107)
    incomeTax = Math.round((price - nds) * 0.06)
  } else if (taxSystem === 'osno_nds22') {
    const ndsCharged = Math.round(price * 22 / 122)
    ndsDeduction = Math.round(cost * 22 / 122) + Math.round(commissionRub * 22 / 122)
    nds = Math.max(0, ndsCharged - ndsDeduction)
    incomeTax = Math.max(0, Math.round((price - nds - cost - commissionRub) * 0.20))
  }
  const totalTax = nds + incomeTax
  const netAfterTax = payout - cost - totalTax
  return { taxSystem, nds, incomeTax, totalTax, netAfterTax, ndsDeduction, marginAfterTax: payout > 0 ? parseFloat((netAfterTax / payout * 100).toFixed(1)) : 0 }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── ТРАНЗАКЦИИ: разбивка на помесячные чанки ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Типы транзакций хранения FBO
const STORAGE_SERVICES = new Set([
  'MarketplaceServiceStorage',
  'MarketplaceServiceStorageAdditional',
  'MarketplaceServiceStoragePremium',
])

const LOGISTICS_SERVICES = new Set([
  'MarketplaceServiceItemDirectFlowLogistic',
  'MarketplaceServiceItemDeliveryToHandoverPlaceOzon',
  'MarketplaceServiceItemRedistributionLastMileCourier',
  'MarketplaceServiceItemFulfillment',
  'MarketplaceServiceItemDirectFlowLogisticVDC',
  'MarketplaceServiceItemDirectFlowLogisticDC',
])

async function fetchTxnsOneMonth(from: string, to: string): Promise<any[]> {
  const all: any[] = []
  let page = 1
  for (let i = 0; i < 50; i++) {
    const d = await ozonCall<any>('/v3/finance/transaction/list', { filter: { date: { from, to }, transaction_type: 'all' }, page, page_size: 1000 })
    all.push(...(d?.result?.operations ?? []))
    if (page >= Number(d?.result?.page_count ?? 1)) break
    page++
  }
  return all
}

async function fetchTxnsChunked(from: string, to: string): Promise<any[]> {
  const fromD = new Date(from), toD = new Date(to)
  const chunks: { from: string; to: string }[] = []
  let cur = new Date(fromD.getFullYear(), fromD.getMonth(), 1)
  while (cur <= toD) {
    const chunkEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0, 23, 59, 59)
    chunks.push({ from: (cur < fromD ? fromD : cur).toISOString(), to: (chunkEnd > toD ? toD : chunkEnd).toISOString() })
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
  }
  const all: any[] = []
  for (const chunk of chunks) {
    try { all.push(...await fetchTxnsOneMonth(chunk.from, chunk.to)) }
    catch (e: any) { console.warn('[txns chunk]', chunk.from, e.message) }
  }
  return all
}

// ══════════════════════════════════════════════════════════════════════════════
// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.use(async (req, res, next) => {
  if (req.path === '/health') return next()

  // Rate limiting по IP
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] ?? req.socket.remoteAddress ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' })
  }

  // Авторизация по Origin — Chrome автоматически ставит chrome-extension://EXTENSION_ID
  // Подделать Origin из внешнего источника невозможно (браузер блокирует)
  // localhost разрешён для разработки
  const origin = req.headers['origin'] ?? ''
  const isExtension = origin.startsWith('chrome-extension://')
  const isLocalhost = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')

  // Для запросов без Origin (curl, прямые запросы) — разрешаем только с localhost
  const remoteAddr = req.socket.remoteAddress ?? ''
  const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1'

  if (!isExtension && !isLocalhost && !isLoopback) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  // Автопереключение аккаунта по X-Seller-Id из браузера
  const sellerId = req.header('X-Seller-Id')
  if (sellerId && /^\d{4,10}$/.test(sellerId)) {
    const creds = await getActiveCreds()
    if (creds.clientId !== sellerId) {
      const accs = await getAllAccounts()
      const found = accs.find(a => a.clientId === sellerId)
      if (found) {
        await setActiveAccount(sellerId)
        _activeCredsCache = null
        _perfTokenCache = null
        console.log('[auto-switch] switched to', sellerId)
      }
    }
  }

  next()
})
app.get('/health', (_req, res) => res.json({ ok: true }))

// ══════════════════════════════════════════════════════════════════════════════
// ── АККАУНТЫ ─────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/accounts', async (_req, res) => {
  try {
    const accs = await getAllAccounts()
    res.json({ accounts: accs.map(a => ({ ...a, apiKey: '***', perfApiKey: a.perfApiKey ? '***' : null })) })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

app.post('/api/accounts', async (req, res) => {
  try {
    const { clientId, apiKey, perfApiKey, perfClientId, perfClientSecret, name, taxSystem, annualRevenue, setActive } = req.body ?? {}
    if (typeof clientId !== 'string' || typeof apiKey !== 'string') return res.status(400).json({ error: 'clientId и apiKey обязательны' })

    // Проверяем ключи
    const check = await fetch(config.ozon.baseUrl + '/v5/product/info/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Api-Key': apiKey },
      body: JSON.stringify({ filter: { visibility: 'ALL' }, cursor: '', limit: 1 }),
    })
    if (check.status === 401) return res.status(400).json({ error: 'Неверные Seller API ключи — проверьте Client-Id и Api-Key' })

    const accs = await getAllAccounts()
    const isFirst = accs.length === 0
    const perfKeyStored = perfClientId && perfClientSecret ? (perfClientId + '::' + perfClientSecret) : (perfApiKey ?? null)

    await upsertAccount({
      clientId, apiKey,
      perfApiKey: perfKeyStored,
      name: name || clientId,
      taxSystem: taxSystem ?? 'usn6',
      annualRevenue: annualRevenue ?? 0,
      isActive: setActive === true || isFirst,
    })
    if (setActive === true || isFirst) { await setActiveAccount(clientId); _activeCredsCache = null; _perfTokenCache = null; realizCache.clear() }
    res.json({ ok: true, isActive: setActive === true || isFirst })
  } catch (e: any) {
    const err = safeError(e, 'accounts POST'); res.status(err.status).json({ error: err.message })
  }
})

app.post('/api/accounts/switch', async (req, res) => {
  try {
    const { clientId } = req.body ?? {}
    if (typeof clientId !== 'string') return res.status(400).json({ error: 'clientId обязателен' })
    await setActiveAccount(clientId)
    _activeCredsCache = null; _perfTokenCache = null; realizCache.clear()
    res.json({ ok: true })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

app.delete('/api/accounts/:clientId', async (req, res) => {
  try { await deleteAccount(req.params.clientId); _activeCredsCache = null; res.json({ ok: true }) }
  catch (e: unknown) { const err = safeError(e, 'accounts DELETE'); res.status(err.status).json({ error: err.message }) }
})

app.patch('/api/accounts/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params
    const { taxSystem, annualRevenue, name } = req.body ?? {}
    const accs = await getAllAccounts()
    const acc = accs.find(a => a.clientId === clientId)
    if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' })
    await upsertAccount({ ...acc, name: name ?? acc.name, taxSystem: taxSystem ?? acc.taxSystem, annualRevenue: annualRevenue ?? acc.annualRevenue })
    _activeCredsCache = null
    res.json({ ok: true })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/accounts/active', async (_req, res) => {
  try {
    const acc = await getActiveAccount()
    if (!acc) return res.json({ account: null })
    res.json({ account: { ...acc, apiKey: '***', perfApiKey: acc.perfApiKey ? '***' : null } })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── СЕБЕСТОИМОСТЬ ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/cost', async (req, res) => {
  const { offerId, cost } = req.body ?? {}
  if (typeof offerId !== 'string' || typeof cost !== 'number') return res.status(400).json({ error: 'offerId:string и cost:number обязательны' })
  await setCost(offerId, cost)
  res.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// ── ТОВАРЫ ────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/products', async (_req, res) => {
  try {
    const pricesData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 })
    const priceItems = pricesData?.items ?? pricesData?.result?.items ?? []
    const costsObj = await getAllCosts() as Record<string, number>
    const activeAcc = await getActiveAccount()
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'
    const items = priceItems.map((it: any) => {
      const p = it.price ?? {}, c = it.commissions ?? {}
      const price = Number(p.price) || 0
      const salesPercent = Number(c.sales_percent_fbo ?? c.sales_percent) || 0
      const logistics = (Number(c.fbo_fulfillment_amount)||0) + (Number(c.fbo_deliv_to_customer_amount)||0) + (Number(c.fbo_direct_flow_trans_max_amount)||0) + (Number(c.fbo_return_flow_amount)||0)
      const cost = costsObj[it.offer_id] ?? null
      const economics = computeEconomics({ offerId: it.offer_id, price, commissionPercent: salesPercent, logistics, cost })
      const taxBreakdown = cost != null && economics.net != null
        ? calcTax({ taxSystem, payout: Math.round(price - economics.commissionRub - logistics), cost, price, commissionRub: economics.commissionRub })
        : null
      return { ...economics, taxBreakdown, taxSystem }
    })
    res.json({ items })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── P&L ВИДЖЕТА ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/profit', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query)
    const now = new Date()
    function isoStart(d: Date): string { const c = new Date(d); c.setUTCHours(0,0,0,0); return c.toISOString() }
    const todayStart  = isoStart(now)
    const yesterStart = isoStart(new Date(Date.now() - 86_400_000))
    const weekStart   = isoStart(new Date(Date.now() - 6 * 86_400_000))

    const costsObj  = await getAllCosts() as Record<string, number>
    const hasCosts  = Object.values(costsObj).some(v => v > 0)
    const activeAcc = await getActiveAccount()
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'

    const skuToCost = new Map<number, number>()
    if (hasCosts) {
      try {
        const si = await ozonCall<any>('/v4/product/info/stocks', { filter: { offer_id: Object.keys(costsObj), visibility: 'ALL' }, limit: 100, last_id: '' })
        for (const item of si?.result?.items ?? si?.items ?? []) {
          const sku = item.stocks?.find((s: any) => s.type === 'fbo')?.sku ?? item.stocks?.[0]?.sku
          const cost = costsObj[item.offer_id]
          if (sku && cost != null) skuToCost.set(Number(sku), cost)
        }
      } catch {}
    }

    async function calcFromTxns(from: string, to: string) {
      const ops = await fetchTxnsChunked(from, to)
      let totalNet = 0, totalCost = 0
      const missing = new Set<number>()
      for (const op of ops) {
        totalNet += Number(op.amount) || 0
        if (!hasCosts || op.operation_type !== 'OperationAgentDeliveredToCustomer') continue
        for (const item of op.items ?? []) {
          const sku = Number(item.sku)
          if (skuToCost.has(sku)) totalCost += skuToCost.get(sku)!
          else missing.add(sku)
        }
      }
      return { net: Math.round(totalNet), profit: hasCosts ? Math.round(totalNet - totalCost) : null, missing }
    }

    const [periodData, todayData, yesterData, weekData] = await Promise.all([
      calcFromTxns(dateFrom.toISOString(), dateTo.toISOString()),
      calcFromTxns(todayStart, now.toISOString()),
      calcFromTxns(yesterStart, todayStart),
      calcFromTxns(weekStart, now.toISOString()),
    ])

    const deltaPct = yesterData.net !== 0 ? Math.round((todayData.net - yesterData.net) / Math.abs(yesterData.net) * 100) : null
    const noCostCount = new Set([...periodData.missing, ...todayData.missing]).size

    // Маржа из отчётов реализации (точнее транзакций)
    let avgMarginPct: number | null = null
    if (hasCosts) {
      try {
        const { all } = await getMonths(2)
        const statsMap = await aggregateRealization(all.slice(0, 2))
        const pricesData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 })
        const priceMap = new Map((pricesData?.items ?? []).map((it: any) => [it.offer_id, {
          price: Number(it.price?.price) || 0,
          commissionRub: Math.round(Number(it.price?.price || 0) * Number(it.commissions?.sales_percent_fbo ?? it.commissions?.sales_percent ?? 0) / 100),
        }]))
        let totalPayout = 0, totalCostSum = 0, hasData = false
        for (const [offerId, stats] of statsMap) {
          const cost = costsObj[offerId] ?? 0
          const netQty = Math.max(0, stats.deliveryCount - stats.returnCount)
          if (netQty === 0 || cost === 0) continue
          const netPayout = Math.max(0, stats.deliveryAmount - stats.returnAmount)
          const pm = priceMap.get(offerId)
          const taxB = pm ? calcTax({ taxSystem, payout: netPayout > 0 ? Math.round(netPayout / netQty) : 0, cost, price: pm.price, commissionRub: pm.commissionRub }) : null
          totalPayout  += netPayout
          totalCostSum += netQty * cost + netQty * (taxB?.totalTax ?? 0)
          hasData = true
        }
        if (hasData && totalPayout > 0) avgMarginPct = parseFloat(((totalPayout - totalCostSum) / totalPayout * 100).toFixed(1))
      } catch {}
    }

    res.json({
      net:    { today: todayData.net, yesterday: yesterData.net, week: weekData.net, month: periodData.net },
      profit: hasCosts ? { today: todayData.profit, yesterday: yesterData.profit, week: weekData.profit, month: periodData.profit } : null,
      avgMarginPct, hasCosts, noCostCount, deltaTodayVsYesterdayPct: deltaPct, taxSystem,
    })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── ABC-АНАЛИЗ ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/abc', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query)
    const costsObj  = await getAllCosts() as Record<string, number>
    const activeAcc = await getActiveAccount()
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'

    const pricesData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 })
    const priceItems = pricesData?.items ?? []
    const priceById  = new Map(priceItems.map((it: any) => [it.offer_id, {
      price: Number(it.price?.price) || 0,
      commissionRub: Math.round(Number(it.price?.price || 0) * Number(it.commissions?.sales_percent_fbo ?? it.commissions?.sales_percent ?? 0) / 100),
    }]))

    const { all: allMonths } = await getMonths(14)
    const months = monthsInRange(allMonths, dateFrom, dateTo)
    if (months.length === 0) {
      return res.json({ items: [], totalRevenue: 0, totalProfit: 0, avgMarginPct: 0, ordersTotal: 0, months: 0, warning: 'Нет данных за период. Ozon закрывает отчёт ~5-го числа следующего месяца.' })
    }

    const statsMap = await aggregateRealization(months)

    // Остатки FBO
    const offerIds = Array.from(statsMap.keys())
    const stockMap = new Map<string, { fbo: number; fbs: number }>()
    try {
      const si = await ozonCall<any>('/v4/product/info/stocks', { filter: { offer_id: offerIds, visibility: 'ALL' }, limit: 100, last_id: '' })
      for (const item of si?.result?.items ?? si?.items ?? []) {
        stockMap.set(item.offer_id, {
          fbo: item.stocks?.find((s: any) => s.type === 'fbo')?.present ?? 0,
          fbs: item.stocks?.find((s: any) => s.type === 'fbs')?.present ?? 0,
        })
      }
    } catch {}

    const dayCount = Math.max(1, (dateTo.getTime() - dateFrom.getTime()) / 86_400_000)
    const monthCount = months.length

    const rows = Array.from(statsMap.entries()).map(([offerId, stats]) => {
      const pm = priceById.get(offerId)
      const price = pm?.price ?? 0
      const cost = costsObj[offerId] ?? 0
      const netQty = Math.max(0, stats.deliveryCount - stats.returnCount)
      const netPayout = Math.max(0, stats.deliveryAmount - stats.returnAmount)
      const payoutPerUnit = netQty > 0 ? netPayout / netQty : 0
      const taxB = price > 0 && pm ? calcTax({ taxSystem, payout: payoutPerUnit, cost, price, commissionRub: pm.commissionRub }) : null
      const taxPerUnit = taxB?.totalTax ?? 0
      const profitRub = netPayout - netQty * cost - netQty * taxPerUnit
      const marginPct = netPayout > 0 ? parseFloat(((netPayout - netQty * cost - netQty * taxPerUnit) / netPayout * 100).toFixed(1)) : 0
      const stocks = stockMap.get(offerId) ?? { fbo: 0, fbs: 0 }
      const totalStock = stocks.fbo + stocks.fbs
      const dailySales = netQty / dayCount
      const stockDays = dailySales > 0 ? Math.round(totalStock / dailySales) : (totalStock > 0 ? 999 : 0)
      return { offerId, price, revenue: Math.round(netPayout), ordersCount: netQty, returnCount: stats.returnCount, marginPct, profitRub: Math.round(profitRub), stockDays, fboStock: stocks.fbo, fbsStock: stocks.fbs, hasCost: cost > 0, isCurrent: stats.includesCurrent, taxBreakdown: taxB }
    }).filter(r => r.ordersCount > 0)

    if (!rows.length) return res.json({ items: [], totalRevenue: 0, totalProfit: 0, avgMarginPct: 0, ordersTotal: 0, months: monthCount })

    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
    const sortedBySales = [...rows].sort((a, b) => b.revenue - a.revenue)
    { let cum = 0; for (const r of sortedBySales) { cum += r.revenue; (r as any)._abcS = cum/totalRevenue <= 0.80 ? 'A' : cum/totalRevenue <= 0.95 ? 'B' : 'C' } }
    for (const r of rows) { (r as any)._abcM = r.marginPct >= 20 ? 'A' : r.marginPct >= 10 ? 'B' : 'C' }
    for (const r of rows) { (r as any)._abcK = r.stockDays >= 30 ? 'A' : r.stockDays >= 14 ? 'B' : 'C' }
    const ru: Record<string,string> = { A:'А', B:'Б', C:'В' }
    const items = rows.map(r => ({ ...r, abcSales:(r as any)._abcS, abcMargin:(r as any)._abcM, abcStock:(r as any)._abcK, abcTotal: ru[(r as any)._abcS]+ru[(r as any)._abcM]+ru[(r as any)._abcK] }))
    items.sort((a, b) => {
      const score = (x: typeof a) => (x.abcSales==='A'?4:x.abcSales==='B'?2:0)+(x.abcMargin==='A'?4:x.abcMargin==='B'?2:0)+(x.abcStock==='A'?2:x.abcStock==='B'?1:0)
      return score(b)-score(a) || b.revenue-a.revenue
    })
    const totalProfit = rows.reduce((s,r)=>s+r.profitRub,0)
    const ordersTotal = rows.reduce((s,r)=>s+r.ordersCount,0)
    const avgMarginPct = totalRevenue > 0 ? parseFloat((totalProfit/totalRevenue*100).toFixed(1)) : 0
    res.json({ items, totalRevenue, totalProfit, avgMarginPct, ordersTotal, months: monthCount })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── АНАЛИТИКА ПО АРТИКУЛУ ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

async function getSkuForOffer(offerId: string, months: { year: number; month: number }[]): Promise<number | null> {
  for (const { year, month } of months) {
    const rows = await fetchRealizCached(year, month)
    const match = rows.find((r: any) => (r.item?.offer_id ?? r.offer_id) === offerId)
    if (match?.item?.sku) return Number(match.item.sku)
  }
  return null
}

app.get('/api/analytics/:offerId', async (req, res) => {
  const { offerId } = req.params
  try {
    const { all: allMonths, closed: closedMonths } = await getMonths(12)
    const sku = await getSkuForOffer(offerId, allMonths)
    const activeAcc = await getActiveAccount()
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'

    // Транзакции за последний закрытый месяц
    type OpAccum = { count: number; amount: number; services: Record<string, number> }
    const opsByType: Record<string, OpAccum> = {}
    let cancelCount = 0, cancelAmount = 0, trueReturnCount = 0, trueReturnAmount = 0
    // Хранение — из транзакций (реальное начисление)
    let storageFromTxns = 0

    if (sku && closedMonths.length > 0) {
      for (const { year, month } of closedMonths.slice(0, 2)) {
        // Строго один календарный месяц по UTC
        const from = new Date(Date.UTC(year, month - 1, 1)).toISOString()
        const to   = new Date(Date.UTC(year, month, 1) - 1).toISOString()  // последняя мс месяца
        try {
          const ops = await fetchTxnsOneMonth(from, to)
          const myOps = ops.filter((op: any) => op.items?.some((it: any) => Number(it.sku) === sku))
          for (const op of myOps) {
            const t = op.operation_type
            if (!opsByType[t]) opsByType[t] = { count: 0, amount: 0, services: {} }
            opsByType[t].count++; opsByType[t].amount += Number(op.amount) || 0
            for (const s of op.services ?? [])
              opsByType[t].services[s.name] = (opsByType[t].services[s.name] ?? 0) + Number(s.price)
            if (t === 'OperationItemReturn') {
              const svcs: string[] = (op.services ?? []).map((s: any) => s.name)
              if (svcs.includes('MarketplaceServiceItemReturnAfterDelivToCustomer')) { trueReturnCount++; trueReturnAmount += Math.abs(Number(op.amount)||0) }
              else { cancelCount++; cancelAmount += Math.abs(Number(op.amount)||0) }
            }
          }

          // Хранение — отдельно ищем операции хранения по SKU (MarketplaceServiceStorage)
          const storageOps = ops.filter((op: any) => {
            if (op.operation_type !== 'MarketplaceServiceStorage') return false
            // Хранение может быть без items, проверяем по services
            return op.services?.some((s: any) => STORAGE_SERVICES.has(s.name))
          })
          // Также ищем в services доставленных операций
          for (const op of myOps) {
            for (const s of op.services ?? []) {
              if (STORAGE_SERVICES.has(s.name)) storageFromTxns += Math.abs(Number(s.price) || 0)
            }
          }
        } catch (e: any) { console.warn(`[analytics] ${year}-${month}:`, e.message) }
      }
    }

    // Данные реализации
    const statsMap = await aggregateRealization(allMonths.slice(0, 2))
    const stats = statsMap.get(offerId)
    const realizDeliveries = stats ? Math.max(0, stats.deliveryCount - stats.returnCount) : 0
    const realizNetPayout  = stats ? Math.max(0, stats.deliveryAmount - stats.returnAmount) : 0

    const deliveries    = opsByType['OperationAgentDeliveredToCustomer']
    const acquiring     = opsByType['MarketplaceRedistributionOfAcquiringOperation']
    const clientRet     = opsByType['ClientReturnAgentOperation']
    const deliveryCount = deliveries?.count ?? realizDeliveries
    const base = deliveryCount || 1

    const logTotal = Object.entries(deliveries?.services ?? {}).filter(([n]) => LOGISTICS_SERVICES.has(n)).reduce((s,[,v])=>s+Math.abs(v),0)
    const avgLogistics = deliveryCount > 0 ? Math.round(logTotal/deliveryCount) : null
    const payoutPerUnit = deliveries?.count > 0 ? Math.round(deliveries.amount/deliveries.count) : realizNetPayout > 0 ? Math.round(realizNetPayout/realizDeliveries) : null
    const acquiringPerUnit = Math.round(Math.abs(acquiring?.amount??0)/base*10)/10
    const returnLogPerUnit = Math.round(trueReturnAmount/base*10)/10
    const clientRefundPerUnit = Math.round(Math.abs(clientRet?.amount??0)/base*10)/10
    const cancelLogPerUnit = Math.round(cancelAmount/base*10)/10

    const totalForRate = deliveryCount + trueReturnCount
    const realReturnRate = totalForRate > 0 ? Math.round(trueReturnCount/totalForRate*1000)/10 : null
    const cancelRate = (deliveryCount+cancelCount) > 0 ? Math.round(cancelCount/(deliveryCount+cancelCount)*1000)/10 : null

    let estimatedVolumeLiters: number | null = null
    try {
      const infos = await ozonCall<any>('/v3/product/info/list', { offer_id: [offerId] })
      const info = (infos?.items??[])[0]
      if (info?.volume_weight) estimatedVolumeLiters = Math.round(Number(info.volume_weight)*5*10)/10
    } catch {}

    let fboAvailable = 0, fboTransit = 0, turnoverGrade: string | null = null, adsDaily: number | null = null
    if (sku) {
      try {
        const ad = await ozonCall<any>('/v1/analytics/stocks', { skus: [sku], limit: 100, offset: 0 })
        const items: any[] = ad?.items ?? []
        fboAvailable  = items.reduce((s,w)=>s+(w.available_stock_count??0),0)
        fboTransit    = items.reduce((s,w)=>s+(w.transit_stock_count??0),0)
        turnoverGrade = items[0]?.turnover_grade ?? null
        adsDaily      = items[0]?.ads != null ? Math.round(items[0].ads*10)/10 : null
      } catch {}
    }

    // Хранение: из транзакций если > 0, иначе 0 (не начислялось)
    // storageFromTxns — реальное начисление за период из транзакций
    const monthlySales = realizDeliveries > 0 ? realizDeliveries/2 : deliveryCount/2 || 1
    const storageTotal   = storageFromTxns > 0 ? Math.round(storageFromTxns) : 0
    const storagePerUnit = storageTotal > 0 && monthlySales > 0 ? Math.round(storageTotal/monthlySales*10)/10 : 0

    const netFromOzon = payoutPerUnit != null ? Math.round(payoutPerUnit - acquiringPerUnit - returnLogPerUnit - clientRefundPerUnit - cancelLogPerUnit) : null

    // Налоговый расчёт
    const costsObj = await getAllCosts() as Record<string, number>
    const cost = costsObj[offerId] ?? 0
    const priceData = await ozonCall<any>('/v5/product/info/prices', { filter: { offer_id: [offerId] }, cursor: '', limit: 10 }).catch(() => null)
    const pi = (priceData?.items??[])[0]
    const price = Number(pi?.price?.price) || 0
    const commissionRub = Math.round(price * Number(pi?.commissions?.sales_percent_fbo ?? pi?.commissions?.sales_percent ?? 0) / 100)
    const taxBreakdown = price > 0 && cost > 0 && netFromOzon != null ? calcTax({ taxSystem, payout: netFromOzon, cost, price, commissionRub }) : null

    // Реклама из кэша
    let advPerUnit: number | null = null, advTotal: number | null = null
    try {
      const spendMap = await getPerfSpendByOffer()
      if (spendMap) {
        // Ищем по SKU (число) — именно так Performance API возвращает данные
        const skuStr = sku ? String(sku) : null
        const spent = (skuStr ? spendMap.get(skuStr) : undefined) ?? spendMap.get(offerId)
        if (spent != null && spent > 0) {
          advTotal = spent
          // ДРР на единицу = общий расход / общее число продаж (не только через рекламу)
          const totalSales = Math.max(1, deliveryCount || realizDeliveries)
          advPerUnit = Math.round(advTotal / totalSales * 10) / 10
          console.log('[perf] found for', offerId, 'sku:', skuStr, 'advTotal:', advTotal, 'totalSales:', totalSales)
        }
      }
    } catch {}

    res.json({
      offerId, sku, closedMonthsCount: closedMonths.length,
      deliveryCount, realizDeliveries, realizNetPayout,
      payoutPerUnit, avgLogistics, acquiringPerUnit, returnLogPerUnit,
      clientRefundPerUnit, cancelLogPerUnit, netFromOzon,
      trueReturnCount, cancelCount, realReturnRate, cancelRate,
      estimatedVolumeLiters, fboAvailable, fboTransit, turnoverGrade, adsDaily,
      // Хранение: реальное из транзакций
      storagePerUnit:  storagePerUnit,
      storageTotal:    storageTotal,
      storageSource:   storageFromTxns > 0 ? 'transactions' : 'none',
      taxSystem, taxBreakdown, advPerUnit, advTotal,
      advLoading: advTotal === null && (await getActiveCreds()).perfApiKey != null,
    })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

// ── Дебаг ─────────────────────────────────────────────────────────────────────
app.get('/api/debug/realization/:year/:month', async (req, res) => {
  try {
    const raw = await fetchRealizCached(Number(req.params.year), Number(req.params.month))
    res.json({ rowsCount: raw.length, sample: raw.slice(0,3), parsed: raw.slice(0,3).map(parseRealizRow) })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/months', async (_req, res) => {
  try { const { all, closed, current } = await getMonths(12); res.json({ all, closed, current }) }
  catch (e: unknown) { const err = safeError(e, 'debug months'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/transactions', async (_req, res) => {
  try {
    const to = new Date().toISOString(), from = new Date(Date.now()-7*86400000).toISOString()
    const ops = await fetchTxnsOneMonth(from, to)
    res.json({ total: ops.length, sample: ops.filter((o:any)=>o.services?.length>0).slice(0,3) })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/perf-token', async (_req, res) => {
  try {
    const auth = await getPerfToken()
    if (!auth) return res.json({ ok: false, error: 'Не удалось получить токен' })
    res.json({ ok: true, clientId: auth.clientId.slice(0,30)+'...', tokenLength: auth.token.length })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/perf-campaigns', async (_req, res) => {
  try {
    const running  = await perfGet<any>('/api/client/campaign', { state: 'CAMPAIGN_STATE_RUNNING' })
    const inactive = await perfGet<any>('/api/client/campaign', { state: 'CAMPAIGN_STATE_INACTIVE' })
    res.json({
      running:  (running?.list ?? []).map((c: any) => ({ id: c.id, title: c.title, state: c.state })),
      inactive: (inactive?.list ?? []).slice(0, 5).map((c: any) => ({ id: c.id, title: c.title, state: c.state, updatedAt: c.updatedAt })),
    })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/perf-cache', async (_req, res) => {
  try {
    const creds = await getActiveCreds()
    const cached = perfCache.get(creds.clientId)
    res.json({ cacheKey: creds.clientId, entries: cached?.data?.size ?? 0, updatedAt: cached?.updatedAt ? new Date(cached.updatedAt).toISOString() : null, loading: cached?.loading ?? false })
  } catch (e: unknown) { const err = safeError(e, ctx); res.status(err.status).json({ error: err.message }) }
})

assertOzonKeys()
app.listen(config.port, () => {
  console.log(`Pomogator backend → http://localhost:${config.port}`)
  // Запускаем загрузку рекламного кэша через 3 сек после старта
  setTimeout(async () => {
    try {
      const creds = await getActiveCreds()
      if (creds.perfApiKey) {
        console.log('[perf cache] pre-loading on startup...')
        getPerfSpendByOffer().catch(e => console.warn('[perf cache] startup load failed:', e.message))
      }
    } catch {}
  }, 3000)
})
