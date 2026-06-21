import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { config, validateEnv } from './config.js'
import { getAllCosts, getAllTargetMargins, setCost, getAllAccounts, getActiveAccount, getAccountByClientId, upsertAccount, setActiveAccount, deleteAccount, getCurrentVolumes, getAllVolumeHistory, syncVolume, getAllPriceSnapshots, upsertPriceSnapshot } from './db.js'
import { computeEconomics } from './scoring.js'
import {
  resolveCreds, ozonCall,
  getPerfToken, perfGet, perfPost, perfPoll, perfDownload, invalidatePerfToken,
  fetchTxnsOneMonth, fetchTxnsChunked,
} from './ozon.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Проверяем обязательные env-переменные при старте
validateEnv()

// ── Безопасная обработка ошибок ───────────────────────────────────────────────
function safeError(e: unknown, context: string): { status: number; message: string } {
  const detail = e instanceof Error ? e.message : String(e)
  console.error('[' + context + ']', detail)
  if (detail.includes('Ozon ') && detail.includes('→')) return { status: 502, message: detail }
  if (detail.includes('Нет привязанного аккаунта')) return { status: 400, message: detail }
  if (detail.includes('не найден. Привяжите API-ключи')) return { status: 400, message: detail }
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

// Трекинг активности — обновляем при каждом запросе к /api/*
app.use((req, _res, next) => { if (req.path.startsWith('/api/')) touchActivity(); next() })

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

// Очищаем истёкшие записи rate limiter раз в 5 минут
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of _rateCounts) {
    if (now > entry.resetAt) _rateCounts.delete(ip)
  }
}, 5 * 60_000)

// ══════════════════════════════════════════════════════════════════════════════
// ── МУЛЬТИАККАУНТ И PERFORMANCE API ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// resolveCreds, ozonCall, getPerfToken, perfGet, perfPost, perfPoll, perfDownload —
// импортированы из ./ozon.js (единый клиент с rate limiting: sellerLimiter 5/200ms,
// perfLimiter строго 1 одновременный запрос). Локальные дубли этих функций убраны —
// они не имели рейт-лимита вообще (ozonCall) или имели мёртвый код очереди
// (_perfQueue/perfQueued объявлялись, но нигде не вызывались).

// ══════════════════════════════════════════════════════════════════════════════
// ── КЭШ РЕКЛАМНОЙ СТАТИСТИКИ ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

interface PerfCacheEntry { data: Map<string, number>; updatedAt: number; loading: boolean }
const perfCache = new Map<string, PerfCacheEntry>()
const PERF_CACHE_TTL     = 15 * 60 * 1000   // 15 минут — перегружаем если старше
const PERF_CACHE_MAX_AGE = 24 * 60 * 60 * 1000  // 24 часа — не используем совсем старые данные
const PERF_REFRESH_INTERVAL = 15 * 60 * 1000    // фоновое обновление каждые 15 минут
const ACTIVITY_TIMEOUT = 20 * 60 * 1000          // 20 минут — без активности не обновляем кэш

// Трекинг последней активности пользователя.
// Обновляется при каждом запросе к API — если пользователь не заходил 20 минут,
// фоновые обновления Performance API пропускаются чтобы не тратить лимиты.
let lastActivityAt = Date.now()
function touchActivity() { lastActivityAt = Date.now() }
function isUserActive() { return Date.now() - lastActivityAt < ACTIVITY_TIMEOUT }

// ── Персистентный кэш на диске ────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { encrypt, decrypt } from './crypto.js'

const CACHE_DIR  = join(process.cwd(), 'data')
const CACHE_FILE = join(CACHE_DIR, 'perf-cache.json')

interface DiskCacheEntry { clientId: string; data: Record<string, number>; updatedAt: number }

function savePerfCacheToDisk(): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
    const entries: DiskCacheEntry[] = []
    for (const [clientId, entry] of perfCache) {
      if (entry.data.size === 0) continue
      entries.push({
        clientId,
        data: Object.fromEntries(entry.data),
        updatedAt: entry.updatedAt,
      })
    }
    // Шифруем данные тем же ключом что и API-ключи в БД
    const json = JSON.stringify(entries)
    const encrypted = encrypt(json)
    writeFileSync(CACHE_FILE, encrypted, 'utf8')
    console.log('[perf cache] saved to disk:', entries.length, 'accounts')
  } catch (e: any) {
    console.warn('[perf cache] disk save failed:', e.message)
  }
}

function loadPerfCacheFromDisk(): void {
  try {
    if (!existsSync(CACHE_FILE)) return
    const encrypted = readFileSync(CACHE_FILE, 'utf8').trim()
    if (!encrypted) return
    const json = decrypt(encrypted)
    const entries: DiskCacheEntry[] = JSON.parse(json)
    const now = Date.now()
    let loaded = 0
    for (const entry of entries) {
      // Не загружаем данные старше 24 часов
      if (now - entry.updatedAt > PERF_CACHE_MAX_AGE) {
        console.log('[perf cache] disk entry too old, skipping:', entry.clientId)
        continue
      }
      perfCache.set(entry.clientId, {
        data: new Map(Object.entries(entry.data).map(([k, v]) => [k, Number(v)])),
        updatedAt: entry.updatedAt,
        loading: false,
      })
      loaded++
    }
    if (loaded > 0) console.log('[perf cache] loaded from disk:', loaded, 'accounts, ages:',
      entries.filter(e => now - e.updatedAt <= PERF_CACHE_MAX_AGE)
        .map(e => Math.round((now - e.updatedAt) / 60_000) + 'min').join(', '))
  } catch (e: any) {
    console.warn('[perf cache] disk load failed (will reload from API):', e.message)
  }
}

async function getPerfSpendByOffer(clientId?: string): Promise<Map<string, number> | null> {
  const creds = await resolveCreds(clientId)
  if (!creds.perfApiKey) return null
  const cacheKey = creds.clientId
  const cached = perfCache.get(cacheKey)
  // Есть свежие данные — возвращаем сразу
  if (cached && !cached.loading && Date.now() - cached.updatedAt < PERF_CACHE_TTL) return cached.data
  // Данные устарели, но есть — возвращаем старые и запускаем обновление фоном
  if (cached && !cached.loading && cached.data.size > 0) {
    console.log('[perf cache] stale, refreshing in background...')
    const entry = { ...cached, loading: true }
    perfCache.set(cacheKey, entry)
    loadPerfStats(cacheKey).catch(e => { console.warn('[perf cache] bg refresh failed:', e.message); entry.loading = false })
    return cached.data  // возвращаем старые данные пока грузятся новые
  }
  // Нет данных — грузим впервые
  if (cached?.loading) return cached.data.size > 0 ? cached.data : null
  const entry: PerfCacheEntry = { data: new Map(), updatedAt: 0, loading: true }
  perfCache.set(cacheKey, entry)
  loadPerfStats(cacheKey).catch(e => { console.warn('[perf cache] load failed:', e.message); entry.loading = false })
  return null
}

async function loadPerfStats(cacheKey: string): Promise<void> {
  // cacheKey здесь — это clientId аккаунта (Seller API), который и резолвит
  // правильные Performance API ключи через resolveCreds внутри perfGet/perfPost.
  const clientId = cacheKey
  // ВАЖНО: раньше cacheEntry бралась как perfCache.get(cacheKey) и если записи
  // ещё не было (например, вызов пришёл из фонового прогрева при старте, а не
  // через getPerfSpendByOffer, которая создаёт запись сама перед вызовом) —
  // cacheEntry оказывалась undefined, и все "if (cacheEntry) {...}" дальше по
  // функции молча НИЧЕГО не делали. Данные реально считались (видно в логах
  // "mapped N offers"), но нигде не сохранялись — функция работала "в пустоту".
  // Теперь гарантируем, что запись существует, до начала любой работы.
  let cacheEntry = perfCache.get(cacheKey)
  if (!cacheEntry) {
    cacheEntry = { data: new Map(), updatedAt: 0, loading: true }
    perfCache.set(cacheKey, cacheEntry)
  } else if (cacheEntry.loading) {
    // Уже идёт загрузка для этого clientId из другого места (стартовый прогрев,
    // почасовое обновление, getPerfSpendByOffer) — не запускаем второй параллельный
    // запрос к Performance API на те же данные. Именно отсутствие этой проверки
    // давало в логах два полных дублирующих цикла "loading stats for ..." подряд.
    console.log('[perf cache]', cacheKey, 'already loading, skip duplicate call')
    return
  } else {
    cacheEntry.loading = true
  }
  try {
    console.log('[perf cache] loading stats for', cacheKey)
    const now = new Date()
    const dateTo   = now.toISOString().slice(0, 10)
    // Максимум 62 дня по ограничению Ozon Performance API
    const dateFrom = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
    console.log('[perf cache] period:', dateFrom, '→', dateTo)
    const spendMap = new Map<string, number>()

    // Запрашиваем SKU-кампании и Трафареты (SEARCH_PROMO) отдельно — разные advObjectType
    const [campsSkuRes, campsPromoRes] = await Promise.all([
      perfGet<any>('/api/client/campaign', { state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' }, clientId).catch(() => null),
      perfGet<any>('/api/client/campaign', { state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SEARCH_PROMO' }, clientId).catch(() => null),
    ])
    const camps: any[] = [...(campsSkuRes?.list ?? []), ...(campsPromoRes?.list ?? [])]
    console.log('[perf cache] SKU campaigns:', (campsSkuRes?.list ?? []).length, '+ SEARCH_PROMO:', (campsPromoRes?.list ?? []).length)
    if (camps.length === 0) {
      cacheEntry.data = spendMap; cacheEntry.updatedAt = Date.now()
      return
    }

    // Запрашиваем каждую кампанию индивидуально чтобы использовать её собственную дату начала.
    // При батчинге нескольких кампаний с разными датами старта Performance API может вернуть
    // 0 расхода для кампаний у которых период не совпадает с запрошенным dateFrom.
    for (let ci = 0; ci < camps.length; ci++) {
      const camp = camps[ci]
      if (ci > 0) await new Promise(r => setTimeout(r, 3000))
      const campFrom = camp.fromDate && camp.fromDate > dateFrom ? camp.fromDate : dateFrom
      console.log(`[perf cache] ${clientId} camp ${camp.id} "${camp.title}" from=${campFrom}`)
      try {
        let statReq: any = null
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt > 0) {
            console.log('[perf cache] 429 retry', attempt, '— waiting 60s...')
            await new Promise(r => setTimeout(r, 60_000))
          }
          try {
            statReq = await perfPost<any>('/api/client/statistics', {
              campaigns: [String(camp.id)], date_from: campFrom, date_to: dateTo, groupBy: 'NO_GROUP_BY',
            }, clientId)
            break
          } catch (e: any) {
            if (e.message?.includes('429') && attempt < 4) continue
            throw e
          }
        }
        const uuid = statReq?.UUID ?? statReq?.uuid
        if (!uuid) { console.warn('[perf cache] no uuid'); continue }
        console.log('[perf cache] uuid:', uuid)

        // Polling: NOT_STARTED может держаться несколько минут
        // Ждём до 10 минут (75 попыток × 8 сек)
        // ВАЖНО: используем perfPoll (без rate limiter), а не perfGet — иначе
        // 10-минутный polling занял бы единственный слот perfLimiter(1) и заблокировал
        // бы все остальные запросы к Performance API на это время.
        let csvText: string | null = null
        for (let i = 0; i < 75 && csvText === null; i++) {
          await new Promise(r => setTimeout(r, i === 0 ? 10_000 : 8_000))
          let check: any
          try { check = await perfPoll<any>('/api/client/statistics/' + uuid, clientId) } catch { continue }
          const state: string = check?.state ?? ''
          if (i % 5 === 0) console.log('[perf cache] poll', i, 'state:', state)
          if (state === 'NOT_STARTED' || state === 'IN_PROGRESS') continue
          if (state === 'ERROR' || state === 'FAILED') { console.warn('[perf cache] report failed'); break }
          if (state === 'READY' || state === 'OK') {
            // Скачиваем файл. Построение URL с fallback на uuid — специфично для
            // этого отчёта, оставляем здесь; саму скачку делегируем perfDownload()
            // из ozon.ts, чтобы не дублировать работу с токеном и заголовками.
            const lnk: string = check.link ?? ''
            const downloadUrl = lnk.startsWith('http') ? lnk
              : lnk ? 'https://api-performance.ozon.ru' + (lnk.startsWith('/') ? '' : '/') + lnk
              : `https://api-performance.ozon.ru/api/client/statistics/${uuid}/report`
            let buffer: Buffer
            try {
              buffer = await perfDownload(downloadUrl, clientId)
            } catch (e: any) {
              console.warn('[perf cache] file download failed:', e.message)
              break
            }
            console.log('[perf cache] file', buffer.length, 'bytes')
            if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
              // ZIP — извлекаем первый файл
              csvText = await extractFirstFileFromZip(buffer)
            } else if (buffer[0] === 0x1F && buffer[1] === 0x8B) {
              // gzip
              const { createGunzip } = await import('zlib')
              const { Readable } = await import('stream')
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
          }
        }

        if (!csvText) { console.warn('[perf cache] no csv data'); continue }
        console.log('[perf cache] csv sample:', csvText.slice(0, 400))

        // Парсим CSV
        const allLines = csvText.split('\n').map(l => l.trim()).filter(Boolean)
        if (allLines.length < 2) continue
        const sep = allLines.some(l => l.includes(';')) ? ';' : ','
        let hIdx = 0
        for (let i = 0; i < Math.min(5, allLines.length); i++) {
          if (/^sku[;,]|[;,]sku[;,]|^артикул/i.test(allLines[i])) { hIdx = i; break }
        }
        const headers = allLines[hIdx].split(sep).map(h => h.trim().replace(/"/g, '').toLowerCase())
        const skuIdx   = headers.findIndex(h => h === 'sku' || /артикул|offer_id/i.test(h))
        const spentIdx = headers.findIndex(h => /расход|spent/i.test(h))
        console.log('[perf cache] headers skuIdx:', skuIdx, 'spentIdx:', spentIdx, 'cols:', headers.join('|'))
        console.log('[perf cache] total data rows:', allLines.length - hIdx - 1)
        for (let li = hIdx + 1; li < allLines.length; li++) {
          const cols = allLines[li].split(sep).map(c => c.trim().replace(/"/g, ''))
          const sku = skuIdx >= 0 ? cols[skuIdx].replace(/\s/g, '') : ''
          if (!sku || !/^\d+$/.test(sku)) continue
          const spent = spentIdx >= 0 ? Number(cols[spentIdx].replace(',', '.').replace(/[^\d.]/g, '')) : 0
          console.log('[perf csv row] sku:', sku, 'spent:', spent)
          if (spent > 0) {
            spendMap.set(sku, (spendMap.get(sku) ?? 0) + spent)
          }
        }
      } catch (e: any) { console.warn(`[perf cache] camp ${camp.id} error:`, e.message) }
    }

    console.log('[perf cache] loaded', spendMap.size, 'entries by perf-SKU')

    // Конвертируем ключи: perf-SKU → offerId
    // Performance API использует SKU из каталога Ozon (item.sku из /v3/product/info/list)
    const offerSpendMap = new Map<string, number>()
    if (spendMap.size > 0) {
      try {
        // Берём offer_id всех товаров из /v3/product/list
        const productList = await ozonCall<any>('/v3/product/list', {
          filter: { visibility: 'ALL' }, last_id: '', limit: 1000,
        }, clientId)
        const offerIds: string[] = (productList?.result?.items ?? []).map((it: any) => it.offer_id).filter(Boolean)

        // Получаем детали включая все варианты SKU
        const skuToOffer = new Map<string, string>()
        for (let i = 0; i < offerIds.length; i += 100) {
          const batch = offerIds.slice(i, i + 100)
          const info = await ozonCall<any>('/v3/product/info/list', { offer_id: batch }, clientId)
          for (const item of info?.items ?? []) {
            // Регистрируем все доступные варианты SKU
            const skuVariants = [item.sku, item.fbo_sku, item.fbs_sku].filter(Boolean)
            for (const s of skuVariants) skuToOffer.set(String(s), item.offer_id)
          }
        }
        console.log('[perf cache] skuToOffer map size:', skuToOffer.size)

        // Первый проход: маппим через skuToOffer
        const unmappedSkus: string[] = []
        for (const [perfSku, spent] of spendMap) {
          const offerId = skuToOffer.get(perfSku)
          if (offerId) {
            offerSpendMap.set(offerId, (offerSpendMap.get(offerId) ?? 0) + spent)
            console.log('[perf] mapped', perfSku, '→', offerId, 'spent:', spent)
          } else {
            unmappedSkus.push(perfSku)
            console.log('[perf] no mapping for', perfSku, '— will try reverse SKU lookup')
          }
        }

        // Второй проход: для незамапленных SKU делаем прямой запрос по SKU
        // Performance API может использовать SKU который не совпадает с item.sku
        // из /v3/product/info/list — в этом случае делаем обратный поиск
        if (unmappedSkus.length > 0) {
          for (let i = 0; i < unmappedSkus.length; i += 100) {
            const batch = unmappedSkus.slice(i, i + 100).map(Number).filter(Boolean)
            try {
              const info = await ozonCall<any>('/v3/product/info/list', { sku: batch }, clientId)
              for (const item of info?.items ?? []) {
                if (!item.offer_id) continue
                const skuVariants = [item.sku, item.fbo_sku, item.fbs_sku].filter(Boolean).map(String)
                for (const s of skuVariants) skuToOffer.set(s, item.offer_id)
                // Находим совпадение
                for (const perfSku of unmappedSkus) {
                  if (skuVariants.includes(perfSku)) {
                    const spent = spendMap.get(perfSku) ?? 0
                    offerSpendMap.set(item.offer_id, (offerSpendMap.get(item.offer_id) ?? 0) + spent)
                    console.log('[perf] reverse-mapped', perfSku, '→', item.offer_id, 'spent:', spent)
                  }
                }
              }
            } catch (e: any) {
              console.warn('[perf] reverse SKU lookup failed:', e.message)
              // Fallback: сохраняем как есть по числовому SKU
              for (const perfSku of unmappedSkus) {
                const spent = spendMap.get(perfSku) ?? 0
                offerSpendMap.set(perfSku, (offerSpendMap.get(perfSku) ?? 0) + spent)
              }
            }
          }
        }

        console.log('[perf cache] mapped', offerSpendMap.size, 'offers')
      } catch (e: any) {
        console.warn('[perf cache] mapping failed:', e.message)
        for (const [k, v] of spendMap) offerSpendMap.set(k, v)
      }
    }

    cacheEntry.data = offerSpendMap; cacheEntry.updatedAt = Date.now()
    // Сбрасываем advPerUnit кэш чтобы он пересчитался с новыми данными perf
    _advPerUnitCache.delete(clientId)
    savePerfCacheToDisk()
    // Пересчитываем advPerUnit фоном — не ждём, пользователь увидит результат
    // при следующем открытии вкладки Заказы (или через 30 сек если уже открыта)
    getAdvPerUnitMap(clientId).catch(e => console.warn('[advPerUnit] bg recalc failed:', e.message))
  } catch (e: any) {
    console.warn('[perf cache] fatal:', e.message)
  } finally {
    cacheEntry.loading = false
  }
}

// Извлекает первый файл из ZIP буфера
async function extractFirstFileFromZip(buffer: Buffer): Promise<string> {
  const { inflateRaw } = await import('zlib')
  // Ищем EOCD
  let eocdOffset = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
    if (buffer[i] === 0x50 && buffer[i+1] === 0x4B && buffer[i+2] === 0x05 && buffer[i+3] === 0x06) {
      eocdOffset = i; break
    }
  }
  if (eocdOffset >= 0) {
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16)
    let cdPos = cdOffset
    if (buffer[cdPos] === 0x50 && buffer[cdPos+1] === 0x4B && buffer[cdPos+2] === 0x01 && buffer[cdPos+3] === 0x02) {
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
      if (comp === 0) return compData.toString('utf-8')
      if (comp === 8) return new Promise<string>((res, rej) => {
        inflateRaw(compData, (err, result) => err ? rej(err) : res(result.toString('utf-8')))
      })
    }
  }
  // Fallback: Local File Header
  const lhIdx = buffer.indexOf(Buffer.from([0x50, 0x4B, 0x03, 0x04]))
  if (lhIdx >= 0) {
    const comp  = buffer.readUInt16LE(lhIdx + 8)
    const cSize = buffer.readUInt32LE(lhIdx + 18)
    const fnLen = buffer.readUInt16LE(lhIdx + 26)
    const exLen = buffer.readUInt16LE(lhIdx + 28)
    const data  = buffer.slice(lhIdx + 30 + fnLen + exLen, lhIdx + 30 + fnLen + exLen + cSize)
    if (comp === 0) return data.toString('utf-8')
    if (comp === 8) return new Promise<string>((res, rej) => {
      inflateRaw(data, (err, result) => err ? rej(err) : res(result.toString('utf-8')))
    })
  }
  return buffer.toString('utf-8')
}

// ══════════════════════════════════════════════════════════════════════════════
// ── КЭШ РЕАЛИЗАЦИИ ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const realizCache = new Map<string, any[]>()
const realizCacheTs = new Map<string, number>()
const CURRENT_MONTH_TTL = 5 * 60 * 1000

async function fetchRealizCached(year: number, month: number, clientId?: string): Promise<any[]> {
  const creds = await resolveCreds(clientId)
  const key = `${creds.clientId}:${year}-${String(month).padStart(2, '0')}`
  const now = new Date()
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1
  if (isCurrent && realizCache.has(key) && Date.now() - (realizCacheTs.get(key) ?? 0) > CURRENT_MONTH_TTL) realizCache.delete(key)
  if (realizCache.has(key)) return realizCache.get(key)!

  const out: any[] = []
  let page = 1
  for (let i = 0; i < 100; i++) {
    const data = await ozonCall<any>('/v2/finance/realization', { year, month, page, page_size: 1000 }, creds.clientId)
    const rows = data?.result?.rows ?? data?.rows ?? []
    out.push(...rows)
    const pageCount = Number(data?.result?.page_count ?? data?.page_count ?? 1)
    if (page >= pageCount || rows.length === 0) break
    page++
  }
  realizCache.set(key, out); realizCacheTs.set(key, Date.now())
  return out
}

async function getMonths(maxClosed = 12, clientId?: string): Promise<{ all: { year: number; month: number; isCurrent: boolean }[]; closed: { year: number; month: number }[]; current: { year: number; month: number } | null }> {
  const closed: { year: number; month: number }[] = []
  const now = new Date()
  const curYear = now.getFullYear(), curMonth = now.getMonth() + 1
  let currentMonthData: { year: number; month: number } | null = null
  try { const rows = await fetchRealizCached(curYear, curMonth, clientId); if (rows.length > 0) currentMonthData = { year: curYear, month: curMonth } } catch {}
  for (let i = 1; i <= Math.max(maxClosed, 24) && closed.length < maxClosed; i++) {
    const d = new Date(curYear, curMonth - 1 - i, 1)
    try { const rows = await fetchRealizCached(d.getFullYear(), d.getMonth() + 1, clientId); if (rows.length > 0) closed.push({ year: d.getFullYear(), month: d.getMonth() + 1 }) }
    catch (e: any) { const msg = String(e?.message ?? ''); if (msg.includes('not found') || msg.includes('404') || msg.includes('Report')) continue; break }
  }
  const all = [...(currentMonthData ? [{ ...currentMonthData, isCurrent: true }] : []), ...closed.map(m => ({ ...m, isCurrent: false }))]
  return { all, closed, current: currentMonthData }
}

function parseRealizRow(row: any): { offerId: string; sku: number | null; deliveryCount: number; deliveryAmount: number; returnCount: number; returnAmount: number; buyerPrice: number; commissionRub: number } | null {
  const offerId = row.item?.offer_id ?? row.offer_id ?? row.article ?? row.vendor_code ?? null
  if (!offerId) return null

  const dc = row.delivery_commission
  const rc = row.return_commission
  const isReturn = rc != null && dc == null

  const buyerPrice = Number(row.seller_price_per_instance ?? 0)
  const deliveryAmount = dc ? Number(dc.price_per_instance ?? dc.amount ?? 0) : 0
  const returnAmount   = rc ? Math.abs(Number(rc.price_per_instance ?? rc.amount ?? 0)) : 0

  // Реальная комиссия Ozon из отчёта реализации.
  // standard_fee — это фиксированная комиссия за продажу (например 20% от цены).
  // Делим на quantity потому что один row может покрывать несколько единиц.
  // commission_ratio тоже есть (0.2 = 20%) но нам нужна сумма в рублях.
  const qty = dc ? Math.max(1, Number(dc.quantity) || 1) : 1
  const commissionRub = isReturn ? 0 : (
    dc ? Math.round(Number(dc.standard_fee ?? 0) / qty * 100) / 100 : 0
  )

  return {
    offerId,
    sku: row.item?.sku ? Number(row.item.sku) : null,
    deliveryCount:  isReturn ? 0 : 1,
    deliveryAmount: isReturn ? 0 : deliveryAmount,
    returnCount:    isReturn ? 1 : 0,
    returnAmount:   isReturn ? returnAmount : 0,
    buyerPrice:     isReturn ? 0 : buyerPrice,
    commissionRub,
  }
}

interface OfferStats { offerId: string; sku: number | null; deliveryCount: number; deliveryAmount: number; returnCount: number; returnAmount: number; monthsIncluded: number; includesCurrent: boolean; buyerPriceTotal: number; commissionTotal: number }

async function aggregateRealization(months: { year: number; month: number; isCurrent?: boolean }[], clientId?: string): Promise<Map<string, OfferStats>> {
  const result = new Map<string, OfferStats>()
  for (let i = 0; i < months.length; i++) {
    const { year, month } = months[i]
    const isCurrent = !!(months[i] as any).isCurrent
    try {
      const rows = await fetchRealizCached(year, month, clientId)
      for (const row of rows) {
        const parsed = parseRealizRow(row)
        if (!parsed || parsed.deliveryCount === 0) continue
        if (!result.has(parsed.offerId)) result.set(parsed.offerId, { offerId: parsed.offerId, sku: parsed.sku, deliveryCount: 0, deliveryAmount: 0, returnCount: 0, returnAmount: 0, monthsIncluded: 0, includesCurrent: false, buyerPriceTotal: 0, commissionTotal: 0 })
        const acc = result.get(parsed.offerId)!
        acc.deliveryCount    += parsed.deliveryCount
        acc.deliveryAmount   += parsed.deliveryAmount
        acc.returnCount      += parsed.returnCount
        acc.returnAmount     += parsed.returnAmount
        acc.buyerPriceTotal  += parsed.buyerPrice
        acc.commissionTotal  += parsed.commissionRub
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
  const maxRange = 366 * 86_400_000  // макс 1 год
  let dateFrom = query.from ? new Date(query.from as string) : new Date(now.getFullYear(), now.getMonth(), 1)
  let dateTo   = query.to   ? new Date((query.to as string) + 'T23:59:59') : now
  // Защита от Invalid Date и слишком широких диапазонов
  if (isNaN(dateFrom.getTime())) dateFrom = new Date(now.getFullYear(), now.getMonth(), 1)
  if (isNaN(dateTo.getTime()))   dateTo = now
  if (dateTo > now) dateTo = now  // нельзя запрашивать будущее
  if (dateTo.getTime() - dateFrom.getTime() > maxRange) dateFrom = new Date(dateTo.getTime() - maxRange)
  if (dateFrom > dateTo) dateFrom = new Date(now.getFullYear(), now.getMonth(), 1)
  return { dateFrom, dateTo }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── НАЛОГОВЫЙ РАСЧЁТ ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// Хелпер для получения правильной комиссии в зависимости от схемы работы.
// У одного товара FBO и FBS комиссии могут отличаться (иногда существенно).
// Если схема неизвестна (например, в ABC-анализе агрегируем все продажи) —
// используем FBO как дефолт, т.к. это основная схема у большинства продавцов,
// но явно возвращаем оба значения для UI чтобы можно было показать разницу.
function getCommissionPct(commissions: any, scheme?: 'fbo' | 'fbs'): number {
  if (!commissions) return 0
  // Поддерживаем два формата:
  // 1. Сырой объект из Ozon API: { sales_percent_fbo, sales_percent_fbs, sales_percent }
  // 2. Pre-extracted объект из getCommissionBoth: { fbo, fbs }
  const fbo = Number(commissions.sales_percent_fbo ?? commissions.fbo ?? 0)
  const fbs = Number(commissions.sales_percent_fbs ?? commissions.fbs ?? 0)
  const fallback = Number(commissions.sales_percent ?? 0)
  if (scheme === 'fbs') return fbs || fallback || fbo
  if (scheme === 'fbo') return fbo || fallback
  return fbo || fbs || fallback
}

// Оба значения для UI (показ в карточке товара — разные строки для FBO/FBS)
function getCommissionBoth(commissions: any): { fbo: number; fbs: number } {
  return {
    fbo: Number(commissions?.sales_percent_fbo ?? commissions?.sales_percent ?? 0),
    fbs: Number(commissions?.sales_percent_fbs ?? commissions?.sales_percent ?? 0),
  }
}

interface TaxBreakdown { taxSystem: string; nds: number; incomeTax: number; totalTax: number; netAfterTax: number; marginAfterTax: number; ndsDeduction: number }

// Расчёт налоговой нагрузки по системе налогообложения.
// buyerPrice — цена, которую реально заплатил покупатель (не цена в ЛК).
// Для ОСНО это критично: НДС начисляется с реальной цены продажи.
// logisticsRub — расходы на логистику (идут в вычет НДС при ОСНО).
function calcTax(args: { taxSystem: string; payout: number; cost: number; price: number; commissionRub: number; logisticsRub?: number; buyerPrice?: number }): TaxBreakdown {
  const { taxSystem, payout, cost, commissionRub } = args
  const price = args.buyerPrice ?? args.price  // предпочитаем цену покупателя
  const logisticsRub = args.logisticsRub ?? 0
  let nds = 0, incomeTax = 0, ndsDeduction = 0

  if (taxSystem === 'usn6') {
    // УСН 6%: налог с дохода (с цены покупателя), расходы не учитываются
    incomeTax = Math.round(price * 0.06)
  } else if (taxSystem === 'usn6_nds5') {
    // УСН 6% + НДС 5% (без права на вычет входного НДС)
    nds = Math.round(price * 5 / 105)
    incomeTax = Math.round((price - nds) * 0.06)
  } else if (taxSystem === 'usn6_nds7') {
    // УСН 6% + НДС 7% (без права на вычет входного НДС)
    nds = Math.round(price * 7 / 107)
    incomeTax = Math.round((price - nds) * 0.06)
  } else if (taxSystem === 'osno_nds22') {
    // ОСНО: НДС 22% с 1 января 2026 года + налог на прибыль 25% (с 2025 года)
    //
    // НДС начисленный: с реальной цены покупателя (не из ЛК)
    const ndsCharged = Math.round(price * 22 / 122)
    // Входной НДС к вычету: со всех расходов с НДС (закупка, комиссия Ozon, логистика)
    // Комиссия Ozon облагается НДС → можно взять к вычету
    // Логистика Ozon — тоже с НДС
    ndsDeduction = Math.round((cost + commissionRub + logisticsRub) * 22 / 122)
    nds = Math.max(0, ndsCharged - ndsDeduction)
    //
    // Налог на прибыль 25%:
    // База = выручка без НДС − расходы без НДС
    // Выручка без НДС = price - ndsCharged
    // Расходы без НДС = cost + commissionRub + logisticsRub (уже без НДС, т.к. НДС вычли)
    const revenueExNds  = price - ndsCharged
    const expensesExNds = cost + commissionRub + logisticsRub
    const profitBase = Math.max(0, revenueExNds - expensesExNds)
    incomeTax = Math.round(profitBase * 0.25)
  }

  const totalTax = nds + incomeTax
  const netAfterTax = payout - cost - totalTax
  return {
    taxSystem, nds, incomeTax, totalTax, netAfterTax, ndsDeduction,
    marginAfterTax: price > 0 ? parseFloat((netAfterTax / price * 100).toFixed(1)) : 0,
  }
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

// ══════════════════════════════════════════════════════════════════════════════
// ── ТАРИФНАЯ СЕТКА OZON «ПО УМОЛЧАНИЮ» (логистика последней мили по литражу) ──
// ══════════════════════════════════════════════════════════════════════════════
// Источник: официальный файл тарифов Ozon, лист «Тарифы по умолчанию»
// (logistikafbofbs01052026). Это базовая норма без привязки к конкретной паре
// кластеров отправления/доставки — используется как объективный ориентир
// "сколько ДОЛЖНА стоить логистика товара такого-то объёма и ценового сегмента",
// чтобы отличить реальную переплату от обычного разброса по регионам.
interface TariffRow { minL: number; maxL: number | null; cheap: number; exp: number }
const LOGISTICS_TARIFF_DEFAULT: TariffRow[] = [
  { minL: 0.0, maxL: 0.2, cheap: 17.28, exp: 56 },
  { minL: 0.201, maxL: 0.4, cheap: 19.32, exp: 63 },
  { minL: 0.401, maxL: 0.6, cheap: 21.35, exp: 67 },
  { minL: 0.601, maxL: 0.8, cheap: 22.37, exp: 67 },
  { minL: 0.801, maxL: 1.0, cheap: 23.38, exp: 67 },
  { minL: 1.001, maxL: 1.25, cheap: 25.42, exp: 71 },
  { minL: 1.251, maxL: 1.5, cheap: 26.43, exp: 74 },
  { minL: 1.501, maxL: 1.75, cheap: 27.45, exp: 74 },
  { minL: 1.751, maxL: 2.0, cheap: 29.48, exp: 74 },
  { minL: 2.001, maxL: 3.0, cheap: 31.52, exp: 74 },
  { minL: 3.001, maxL: 4.0, cheap: 35.58, exp: 78 },
  { minL: 4.001, maxL: 5.0, cheap: 38.63, exp: 89 },
  { minL: 5.001, maxL: 6.0, cheap: 42.7, exp: 89 },
  { minL: 6.001, maxL: 7.0, cheap: 57.95, exp: 99 },
  { minL: 7.001, maxL: 8.0, cheap: 62.02, exp: 99 },
  { minL: 8.001, maxL: 9.0, cheap: 65.07, exp: 100 },
  { minL: 9.001, maxL: 10.0, cheap: 69.13, exp: 100 },
  { minL: 10.001, maxL: 11.0, cheap: 79.3, exp: 102 },
  { minL: 11.001, maxL: 12.0, cheap: 83.37, exp: 102 },
  { minL: 12.001, maxL: 13.0, cheap: 87.43, exp: 102 },
  { minL: 13.001, maxL: 14.0, cheap: 92.52, exp: 106 },
  { minL: 14.001, maxL: 15.0, cheap: 96.58, exp: 111 },
  { minL: 15.001, maxL: 17.0, cheap: 96.58, exp: 119 },
  { minL: 17.001, maxL: 20.0, cheap: 110.82, exp: 131 },
  { minL: 20.001, maxL: 25.0, cheap: 118.95, exp: 143 },
  { minL: 25.001, maxL: 30.0, cheap: 131.15, exp: 162 },
  { minL: 30.001, maxL: 35.0, cheap: 146.4, exp: 177 },
  { minL: 35.001, maxL: 40.0, cheap: 156.57, exp: 195 },
  { minL: 40.001, maxL: 45.0, cheap: 175.88, exp: 209 },
  { minL: 45.001, maxL: 50.0, cheap: 189.1, exp: 228 },
  { minL: 50.001, maxL: 60.0, cheap: 207.4, exp: 244 },
  { minL: 60.001, maxL: 70.0, cheap: 230.78, exp: 279 },
  { minL: 70.001, maxL: 80.0, cheap: 249.08, exp: 299 },
  { minL: 80.001, maxL: 90.0, cheap: 274.5, exp: 344 },
  { minL: 90.001, maxL: 100.0, cheap: 284.67, exp: 371 },
  { minL: 100.001, maxL: 125.0, cheap: 331.43, exp: 436 },
  { minL: 125.001, maxL: 150.0, cheap: 381.25, exp: 503 },
  { minL: 150.001, maxL: 175.0, cheap: 436.15, exp: 578 },
  { minL: 175.001, maxL: 200.0, cheap: 483.93, exp: 692 },
  { minL: 200.001, maxL: 400.0, cheap: 805.2, exp: 1026 },
  { minL: 400.001, maxL: 600.0, cheap: 805.2, exp: 1457 },
  { minL: 600.001, maxL: 800.0, cheap: 805.2, exp: 1891 },
  { minL: 800.001, maxL: null, cheap: 805.2, exp: 2232 },
]

// ══════════════════════════════════════════════════════════════════════════════
// ── ТАРИФНАЯ ТАБЛИЦА OZON (детальная, по парам кластеров) ────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// Загружается из tariffs.json (pre-built из logistikafbofbs01052026...xlsx).
// Ключ: "cluster_from|cluster_to", значение: [[minL, maxL|null, cheap, exp], ...]
type TariffEntry = [number, number | null, number, number]
let TARIFF_FULL: Record<string, TariffEntry[]> = {}
try {
  const raw = readFileSync(join(__dirname, 'tariffs.json'), 'utf-8')
  TARIFF_FULL = JSON.parse(raw)
  console.log(`[tariffs] loaded ${Object.keys(TARIFF_FULL).length} cluster pairs`)
} catch (e: any) {
  console.warn('[tariffs] tariffs.json not found, falling back to default table:', e.message)
}

// Ищет тариф логистики для конкретной пары кластеров + объём + цена товара.
// Если пара не найдена в детальной таблице — fallback на таблицу "по умолчанию".
function getLogisticsNormByCluster(clusterFrom: string, clusterTo: string, volumeLiters: number, priceRub: number): number | null {
  const key = `${clusterFrom}|${clusterTo}`
  const entries = TARIFF_FULL[key]
  if (entries && entries.length > 0) {
    const entry = entries.find(([minL, maxL]) => volumeLiters >= minL && (maxL === null || volumeLiters <= maxL))
    if (entry) return priceRub < 300 ? entry[2] : entry[3]
  }
  // Fallback на упрощённую таблицу без кластеров
  return getLogisticsNorm(volumeLiters, priceRub)
}

// ── НАЦЕНКА ЗА НЕЛОКАЛЬНОСТЬ ─────────────────────────────────────────────────
// Актуально на 19 июня 2026. Применяется к FBO-заказам при >= 50 заказов FBO/7д.
// Источник: seller-edu.ozon.ru/libra/commissions-tariffs/legal-information/...
const NON_LOCAL_SURCHARGE: Record<string, number> = {
  // 12%
  'Омск': 12, 'Оренбург': 12, 'Пермь': 12, 'Самара': 12,
  // 8% — основная часть РФ
  'Москва, МО и Дальние регионы': 8, 'Санкт-Петербург и СЗО': 8,
  'Екатеринбург': 8, 'Казань': 8, 'Краснодар': 8, 'Новосибирск': 8,
  'Ростов': 8, 'Дальний Восток': 8, 'Воронеж': 8, 'Уфа': 8,
  'Тюмень': 8, 'Ярославль': 8, 'Тверь': 8, 'Саратов': 8,
  'Невинномысск': 8, 'Красноярск': 8, 'Махачкала': 8, 'Калининград': 8,
  // 6% — СНГ
  'Алматы': 6, 'Астана': 6, 'Беларусь': 6,
  // 0% — остальные (Азербайджан, Армения, Грузия, Кыргызстан, Узбекистан и т.д.)
}
function getNonLocalSurcharge(clusterTo: string): number {
  return NON_LOCAL_SURCHARGE[clusterTo] ?? 0
}

// ── КЭШ ЧИСЛА FBO-ЗАКАЗОВ ЗА 7 ДНЕЙ ─────────────────────────────────────────
// Наценка за нелокальность применяется только если >= 50 заказов FBO/нед.
// Кэш обновляется раз в час — достаточно точно, не тратим запросы на каждый posting.
interface FboCountCache { count: number; updatedAt: number }
const fboCountCache = new Map<string, FboCountCache>()
async function getFboWeeklyCount(clientId: string): Promise<number> {
  const cached = fboCountCache.get(clientId)
  if (cached && Date.now() - cached.updatedAt < 60 * 60 * 1000) return cached.count
  try {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const to    = new Date().toISOString()
    let count = 0
    for (const status of ['awaiting_deliver', 'delivering', 'delivered', 'awaiting_packaging'] as const) {
      const res = await ozonCall<any>('/v2/posting/fbo/list', {
        filter: { since, to, status },
        with: { analytics_data: false, financial_data: false },
        dir: 'asc', offset: 0, limit: 1000,
      }, clientId)
      count += (res?.result ?? res ?? []).length
    }
    fboCountCache.set(clientId, { count, updatedAt: Date.now() })
    return count
  } catch { return 0 }
}

// Норма логистики для товара с данным литражом и ценой (по тарифной сетке "по умолчанию").
// price < 300 — действует льготный тариф ("для товаров до 300 руб."), иначе обычный.
function getLogisticsNorm(volumeLiters: number, priceRub: number): number | null {
  const row = LOGISTICS_TARIFF_DEFAULT.find(r => volumeLiters >= r.minL && (r.maxL === null || volumeLiters <= r.maxL))
  if (!row) return null
  return priceRub < 300 ? row.cheap : row.exp
}

// Синхронизирует литраж (volume_weight × 5) всех товаров аккаунта с историей
// в БД. Вызывается фоном при первом подключении аккаунта и периодически —
// если литраж товара изменился с прошлой синхронизации, syncVolume() сама
// закроет старую запись и откроет новую (см. db.ts). Если не изменился —
// ничего не делает. Это и даёт детектору логистики возможность не путать
// "продавец поменял габариты" с "логистика реально выросла без причины".
async function syncVolumesForAccount(clientId: string): Promise<void> {
  try {
    const productList = await ozonCall<any>('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: '', limit: 1000 }, clientId)
    const offerIds: string[] = (productList?.result?.items ?? []).map((it: any) => it.offer_id).filter(Boolean)
    let synced = 0
    for (let i = 0; i < offerIds.length; i += 100) {
      const batch = offerIds.slice(i, i + 100)
      const info = await ozonCall<any>('/v3/product/info/list', { offer_id: batch }, clientId)
      for (const item of info?.items ?? []) {
        if (!item.offer_id || !item.volume_weight) continue
        const volumeLiters = Math.round(Number(item.volume_weight) * 5 * 100) / 100
        if (volumeLiters > 0) { await syncVolume(clientId, item.offer_id, volumeLiters); synced++ }
      }
    }
    console.log('[volume sync]', clientId, '—', synced, 'товаров обработано')
  } catch (e: any) {
    console.warn('[volume sync] failed for', clientId, ':', e.message)
  }
}

// Синхронизация снимка цен товаров: цена в ЛК, цена по карте Ozon и соинвест.
// Данные берём из /v5/product/info/prices где есть все три цены.
// Соинвест Ozon (coinvest) = priceCard - priceBuyer (Ozon доплачивает разницу сам).
// Вызывается каждые 30 минут для актуальности налоговой базы.
async function syncPricesForAccount(clientId: string): Promise<void> {
  try {
    const data = await ozonCall<any>('/v5/product/info/prices', {
      filter: { visibility: 'ALL' }, cursor: '', limit: 1000,
    }, clientId)
    let synced = 0
    for (const it of data?.items ?? []) {
      const offerId = it.offer_id
      if (!offerId) continue
      const priceInLk  = Number(it.price?.price) || 0
      // Цена по карте Ozon (маркетинговая цена)
      const priceCard  = Number(it.price?.marketing_price ?? it.price?.min_price ?? 0) || null
      // Реальная цена покупателя — минимум из всех доступных цен
      // (ozon_card_price если есть, иначе marketing_price, иначе price)
      const priceBuyer = Number(
        it.price?.ozon_card_price ?? it.price?.marketing_price ?? it.price?.price ?? 0
      ) || null
      // Соинвест = разница между ценой в ЛК и ценой покупателя (Ozon доплачивает)
      const coinvestRub = (priceInLk > 0 && priceBuyer != null && priceBuyer < priceInLk)
        ? Math.round((priceInLk - priceBuyer) * 100) / 100
        : null
      if (priceInLk > 0) {
        await upsertPriceSnapshot(clientId, offerId, { priceInLk, priceCard, priceBuyer, coinvestRub })
        synced++
      }
    }
    console.log('[price sync]', clientId, '—', synced, 'товаров')
  } catch (e: any) {
    console.warn('[price sync] failed for', clientId, ':', e.message)
  }
}

// fetchTxnsOneMonth, fetchTxnsChunked — импортированы из ./ozon.js
// (UTC-баг с границами месяцев исправлен прямо в ozon.ts при подключении модуля)

// ══════════════════════════════════════════════════════════════════════════════
// ── РЕКЛАМНЫЙ РАСХОД НА ЕДИНИЦУ (ДРР per-unit) ───────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// advPerUnit — расход на рекламу ÷ число выкупов, ОБА за одно и то же 30-дневное
// окно, в котором Performance API отдаёт статистику (см. loadPerfStats).
// Это стабильный показатель юнит-экономики товара, который затем можно применять
// к любому количеству продаж в произвольном периоде (ABC, /api/products), потому
// что он не привязан к конкретному месяцу, а характеризует "рекламную нагрузку"
// на единицу товара в среднем за последние ~2 месяца.
//
// ВАЖНО: если у товара резко изменился бюджет на рекламу за последние недели,
// advPerUnit будет отражать средние 60 дней, а не "только последнюю неделю" —
// это сознательный компромисс между точностью и стабильностью числа.
//
// perfCache (getPerfSpendByOffer) уже хранит расход по offer_id — маппинг sku→offerId
// происходит один раз внутри loadPerfStats. Здесь нужен только знаменатель:
// число доставок за те же 30 дней по каждому offer_id, через offer_id→sku из
// /v3/product/info/list (тот же sku, которым Performance API помечает товар в items[].sku
// транзакций доставки).
// Кэш "расход на рекламу / 1 продажа" — ключ Map это clientId. Раньше кэш был
// одной глобальной переменной на весь процесс: при нескольких аккаунтах это
// означало, что рекламные показатели одного продавца могли быть отданы как
// ответ другому (не просто гонка дублирующих запросов, а реальное перемешивание
// чужих данных). Теперь — отдельная запись на каждый clientId, как и perfCache.
interface AdvPerUnitCacheEntry { map: Map<string, number>; updatedAt: number }
const _advPerUnitCache = new Map<string, AdvPerUnitCacheEntry>()
const _advPerUnitInflight = new Map<string, Promise<Map<string, number>>>()
const ADV_PER_UNIT_TTL = 15 * 60 * 1000  // 15 минут — синхронно с perf кэшем

async function getAdvPerUnitMap(clientId?: string): Promise<Map<string, number>> {
  const creds = await resolveCreds(clientId)
  const key = creds.clientId

  const cached = _advPerUnitCache.get(key)
  if (cached && Date.now() - cached.updatedAt < ADV_PER_UNIT_TTL) {
    return cached.map
  }
  // Защита от гонки: /api/products и /api/abc могут вызвать эту функцию почти
  // одновременно (один за другим в рамках loadBase + ABC/Economics на фронте).
  // Без этой защиты оба видят пустой кэш и независимо тянут транзакции за 30 дней —
  // именно это давало дублирующиеся "[txns chunked] period: ..." в логах и было
  // причиной зависания ABC/Economics (слишком много параллельных запросов разом).
  // Ключ inflight — тот же clientId, поэтому параллельные запросы РАЗНЫХ
  // аккаунтов не блокируют друг друга, только дубли одного и того же.
  const inflight = _advPerUnitInflight.get(key)
  if (inflight) return inflight

  const task = (async () => {
    const result = new Map<string, number>()
    try {
      const spendMap = await getPerfSpendByOffer(key)
      if (!spendMap || spendMap.size === 0) { _advPerUnitCache.set(key, { map: result, updatedAt: Date.now() }); return result }

      // offer_id → sku, чтобы посчитать продажи за 30 дней по каждому офферу из транзакций
      const productList = await ozonCall<any>('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: '', limit: 1000 }, key)
      const offerIds: string[] = (productList?.result?.items ?? []).map((it: any) => it.offer_id).filter(Boolean)
      const offerToSkus = new Map<string, number[]>()  // offer_id → все варианты SKU
      for (let i = 0; i < offerIds.length; i += 100) {
        const batch = offerIds.slice(i, i + 100)
        const info = await ozonCall<any>('/v3/product/info/list', { offer_id: batch }, key)
        for (const item of info?.items ?? []) {
          if (!item.offer_id) continue
          const skus = [item.sku, item.fbo_sku, item.fbs_sku].filter(Boolean).map(Number)
          if (skus.length) offerToSkus.set(item.offer_id, skus)
        }
      }

      const txnTo   = new Date().toISOString()
      const txnFrom = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const ops = await fetchTxnsChunked(txnFrom, txnTo, key)
      const deliveryOps = ops.filter((op: any) => op.operation_type === 'OperationAgentDeliveredToCustomer')
      const salesBySku = new Map<number, number>()
      for (const op of deliveryOps) {
        for (const it of op.items ?? []) {
          const sku = Number(it.sku)
          if (sku) salesBySku.set(sku, (salesBySku.get(sku) ?? 0) + 1)
        }
      }

      for (const [offerId, spent] of spendMap) {
        if (spent <= 0) continue
        const skus = offerToSkus.get(offerId) ?? []
        // Суммируем продажи по всем вариантам SKU товара
        const sales = skus.reduce((s, sku) => s + (salesBySku.get(sku) ?? 0), 0)
        if (sales > 0) {
          result.set(offerId, Math.round((spent / sales) * 10) / 10)
        } else {
          // Нет продаж за 30 дней — делим на условный 1 чтобы показать
          // расход как "реклама без продаж", а не скрывать совсем
          result.set(offerId, Math.round(spent * 10) / 10)
        }
      }
    } catch (e: any) {
      console.warn('[advPerUnit] failed:', e.message)
    }
    _advPerUnitCache.set(key, { map: result, updatedAt: Date.now() })
    return result
  })()

  _advPerUnitInflight.set(key, task)
  try {
    return await task
  } finally {
    _advPerUnitInflight.delete(key)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.use(async (req, res, next) => {
  if (req.path === '/health') return next()

  // Rate limiting по IP
  // X-Forwarded-For доверяем только если явно разрешено (за reverse proxy)
  const trustProxy = process.env.TRUST_PROXY === 'true'
  const ip = (trustProxy ? (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() : null)
    ?? req.socket.remoteAddress
    ?? 'unknown'
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

  // ── Определение clientId для ТЕКУЩЕГО запроса ────────────────────────────────
  // ВАЖНО: раньше здесь стояло "автопереключение" — sellerId из X-Seller-Id
  // записывался в БД как глобальный is_active аккаунт (setActiveAccount +
  // invalidateCredsCache). Это работало для одного человека, переключающегося
  // между своими кабинетами, но при множестве разных пользователей создавало
  // гонку: пока запрос пользователя А ждал результата (например, долгий
  // /api/analytics), параллельный запрос пользователя Б мог переключить
  // глобальный активный аккаунт на себя — и запрос А мог улететь к Ozon уже
  // с чужими API-ключами. Теперь никакой записи в БД здесь нет: clientId просто
  // прокидывается дальше как часть ЭТОГО конкретного запроса (res.locals),
  // resolveCreds() в ozon.ts читает нужный аккаунт по ключу напрямую.
  const sellerId = req.header('X-Seller-Id')
  if (sellerId && /^\d{4,10}$/.test(sellerId)) {
    res.locals.clientId = sellerId
  }
  // Если заголовка нет (старые запросы / нет cookie sc_company_id на странице) —
  // res.locals.clientId остаётся undefined, и resolveCreds() в ozon.ts сама
  // фолбэкнется на getActiveAccount()/config.ozon.* — поведение как раньше,
  // для единичного режима, не участвует в межпользовательской гонке.

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
  } catch (e: unknown) { const err = safeError(e, '/api/accounts'); res.status(err.status).json({ error: err.message }) }
})

app.post('/api/accounts', async (req, res) => {
  try {
    const { clientId, apiKey, perfApiKey, perfClientId, perfClientSecret, name, taxSystem, annualRevenue, setActive } = req.body ?? {}
    if (typeof clientId !== 'string' || typeof apiKey !== 'string') return res.status(400).json({ error: 'clientId и apiKey обязательны' })
    if (!/^\d{4,10}$/.test(clientId)) return res.status(400).json({ error: 'clientId: только цифры, 4-10 символов' })
    if (apiKey.length < 10 || apiKey.length > 200) return res.status(400).json({ error: 'apiKey: неверная длина' })
    const VALID_TAX = ['usn6', 'usn6_nds5', 'usn6_nds7', 'osno_nds22']
    if (taxSystem && !VALID_TAX.includes(taxSystem)) return res.status(400).json({ error: 'Неверная система налогообложения' })
    if (name && (typeof name !== 'string' || name.length > 100)) return res.status(400).json({ error: 'name: макс 100 символов' })
    if (annualRevenue !== undefined && (typeof annualRevenue !== 'number' || annualRevenue < 0 || annualRevenue > 1e12)) return res.status(400).json({ error: 'annualRevenue: неверное значение' })

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
    // Если у этого аккаунта уже был закэширован токен Performance API под
    // старыми ключами — он больше не годится для новых ключей с тем же perfClientId.
    if (perfClientId) invalidatePerfToken(perfClientId)
    if (setActive === true || isFirst) { await setActiveAccount(clientId); realizCache.clear() }
    // Синхронизация литража — фоном, не блокируем ответ пользователю. При
    // первом подключении это может занять время (много товаров), но для UX
    // привязки аккаунта это не критично — данные о потерях по логистике
    // понадобятся только когда пользователь откроет вкладку «Экономика».
    syncVolumesForAccount(clientId).catch(e => console.warn('[volume sync] background failed:', e.message))
    syncPricesForAccount(clientId).catch(e => console.warn('[price sync] background failed:', e.message))
    res.json({ ok: true, isActive: setActive === true || isFirst })
  } catch (e: any) {
    const err = safeError(e, 'accounts POST'); res.status(err.status).json({ error: err.message })
  }
})

app.post('/api/accounts/switch', async (req, res) => {
  try {
    const { clientId } = req.body ?? {}
    if (typeof clientId !== 'string' || !/^\d{4,10}$/.test(clientId)) return res.status(400).json({ error: 'clientId: только цифры, 4-10 символов' })
    await setActiveAccount(clientId)
    res.json({ ok: true })
  } catch (e: unknown) { const err = safeError(e, '/api/accounts/switch'); res.status(err.status).json({ error: err.message }) }
})

app.delete('/api/accounts/:clientId', async (req, res) => {
  try {
    if (!/^\d{4,10}$/.test(req.params.clientId)) return res.status(400).json({ error: 'Неверный clientId' })
    const acc = await getAccountByClientId(req.params.clientId)
    if (acc?.perfApiKey) {
      const perfClientId = acc.perfApiKey.split('::')[0]
      if (perfClientId) invalidatePerfToken(perfClientId)
    }
    await deleteAccount(req.params.clientId)
    res.json({ ok: true })
  }
  catch (e: unknown) { const err = safeError(e, 'accounts DELETE'); res.status(err.status).json({ error: err.message }) }
})

app.patch('/api/accounts/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params
    if (!/^\d{4,10}$/.test(clientId)) return res.status(400).json({ error: 'Неверный clientId' })
    const { taxSystem, annualRevenue, name } = req.body ?? {}
    const VALID_TAX = ['usn6', 'usn6_nds5', 'usn6_nds7', 'osno_nds22']
    if (taxSystem && !VALID_TAX.includes(taxSystem)) return res.status(400).json({ error: 'Неверная система налогообложения' })
    if (name && (typeof name !== 'string' || name.length > 100)) return res.status(400).json({ error: 'name: макс 100 символов' })
    if (annualRevenue !== undefined && (typeof annualRevenue !== 'number' || annualRevenue < 0 || annualRevenue > 1e12)) return res.status(400).json({ error: 'annualRevenue: неверное значение' })
    const accs = await getAllAccounts()
    const acc = accs.find(a => a.clientId === clientId)
    if (!acc) return res.status(404).json({ error: 'Аккаунт не найден' })
    await upsertAccount({ ...acc, name: name ?? acc.name, taxSystem: taxSystem ?? acc.taxSystem, annualRevenue: annualRevenue ?? acc.annualRevenue })
    res.json({ ok: true })
  } catch (e: unknown) { const err = safeError(e, '/api/accounts/:clientId'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/accounts/active', async (_req, res) => {
  try {
    const acc = await getActiveAccount()
    if (!acc) return res.json({ account: null })
    res.json({ account: { ...acc, apiKey: '***', perfApiKey: acc.perfApiKey ? '***' : null } })
  } catch (e: unknown) { const err = safeError(e, '/api/accounts/active'); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── СЕБЕСТОИМОСТЬ ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/cost', async (req, res) => {
  const { offerId, cost, targetMarginPct } = req.body ?? {}
  if (typeof offerId !== 'string' || offerId.length > 100 || !/^[\w\-_.]+$/.test(offerId)) {
    return res.status(400).json({ error: 'offerId обязателен и должен быть строкой' })
  }
  // cost опционален — можно сохранить только целевую маржу без себестоимости
  if (cost !== undefined && cost !== null && (typeof cost !== 'number' || cost < 0 || cost > 1_000_000 || !isFinite(cost))) {
    return res.status(400).json({ error: 'cost: число от 0 до 1000000' })
  }
  if (targetMarginPct !== undefined && targetMarginPct !== null && (typeof targetMarginPct !== 'number' || targetMarginPct < -100 || targetMarginPct > 100 || !isFinite(targetMarginPct))) {
    return res.status(400).json({ error: 'targetMarginPct: число от -100 до 100' })
  }
  if ((cost == null) && (targetMarginPct == null)) {
    return res.status(400).json({ error: 'Нужно передать хотя бы одно из: cost, targetMarginPct' })
  }
  await setCost(offerId, cost ?? null, targetMarginPct === undefined ? undefined : (targetMarginPct ?? null))
  res.json({ ok: true })
})

// ══════════════════════════════════════════════════════════════════════════════
// ── ТОВАРЫ ────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const PRODUCTS_CACHE_FILE = join(CACHE_DIR, 'products-cache.json')
const PRODUCTS_CACHE_TTL  = 20 * 60 * 1000  // 20 минут

interface ProductsCacheEntry { clientId: string; items: any[]; updatedAt: number }

function saveProductsCache(clientId: string, items: any[]) {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
    const entry: ProductsCacheEntry = { clientId, items, updatedAt: Date.now() }
    writeFileSync(PRODUCTS_CACHE_FILE, encrypt(JSON.stringify(entry)), 'utf8')
  } catch {}
}

function loadProductsCache(clientId: string): any[] | null {
  try {
    if (!existsSync(PRODUCTS_CACHE_FILE)) return null
    const entry: ProductsCacheEntry = JSON.parse(decrypt(readFileSync(PRODUCTS_CACHE_FILE, 'utf8')))
    if (entry.clientId !== clientId) return null
    if (Date.now() - entry.updatedAt > PRODUCTS_CACHE_TTL) return null
    return entry.items
  } catch { return null }
}

// Инвалидация кэша продуктов (вызывается при закрытии страницы)
app.post('/api/products/invalidate', async (_req, res) => {
  try {
    if (existsSync(PRODUCTS_CACHE_FILE)) {
      writeFileSync(PRODUCTS_CACHE_FILE, encrypt(JSON.stringify({ clientId: '', items: [], updatedAt: 0 })), 'utf8')
    }
    res.json({ ok: true })
  } catch { res.json({ ok: false }) }
})

app.get('/api/products', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const cached = loadProductsCache(creds.clientId)
    if (cached) return res.json({ items: cached, fromCache: true, cacheAge: 'fresh' })

    const pricesData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId)
    const priceItems = pricesData?.items ?? pricesData?.result?.items ?? []
    const costsObj = await getAllCosts() as Record<string, number>
    const targetMargins = await getAllTargetMargins() as Record<string, number>
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'

    // Реклама на единицу — считается отдельно от computeEconomics (тот контракт
    // "без рекламы" не трогаем), накладываем поверх как netWithAds/marginWithAdsPct,
    // чтобы на фронте можно было показать обе цифры и не множить путаницу.
    const advMap = await getAdvPerUnitMap(creds.clientId).catch(() => new Map<string, number>())

    const items = priceItems.map((it: any) => {
      const p = it.price ?? {}, c = it.commissions ?? {}
      const price = Number(p.price) || 0
      const commBoth = getCommissionBoth(c)
      const salesPercent = commBoth.fbo || commBoth.fbs || 0
      const logistics = (Number(c.fbo_fulfillment_amount)||0) + (Number(c.fbo_deliv_to_customer_amount)||0) + (Number(c.fbo_direct_flow_trans_max_amount)||0) + (Number(c.fbo_return_flow_amount)||0)
      const cost = costsObj[it.offer_id] ?? null
      const targetMarginPct = targetMargins[it.offer_id] ?? null
      const economics = computeEconomics({ offerId: it.offer_id, price, commissionPercent: salesPercent, logistics, cost })
      const taxBreakdown = cost != null && economics.net != null
        ? calcTax({ taxSystem, payout: Math.round(price - economics.commissionRub - logistics), cost, price, commissionRub: economics.commissionRub })
        : null
      const advPerUnit = advMap.get(it.offer_id) ?? null
      const netWithAds = economics.net != null && advPerUnit != null ? Math.round(economics.net - advPerUnit) : null
      const marginWithAdsPct = netWithAds != null && price > 0 ? Math.round((netWithAds / price) * 100) : null
      const lightWithAds = marginWithAdsPct == null ? economics.light
        : marginWithAdsPct >= config.margin.green ? 'green'
        : marginWithAdsPct >= config.margin.yellow ? 'yellow'
        : 'red'
      return { ...economics, commissionPctFbo: commBoth.fbo, commissionPctFbs: commBoth.fbs, targetMarginPct, taxBreakdown, taxSystem, advPerUnit, netWithAds, marginWithAdsPct, lightWithAds }
    })
    saveProductsCache(creds.clientId, items)
    res.json({ items })
  } catch (e: unknown) { const err = safeError(e, '/api/products'); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── P&L ВИДЖЕТА ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/profit', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const { dateFrom, dateTo } = parseDateRange(req.query)
    const now = new Date()
    function isoStart(d: Date): string { const c = new Date(d); c.setUTCHours(0,0,0,0); return c.toISOString() }
    const todayStart  = isoStart(now)
    const yesterStart = isoStart(new Date(Date.now() - 86_400_000))
    const weekStart   = isoStart(new Date(Date.now() - 6 * 86_400_000))

    const costsObj  = await getAllCosts() as Record<string, number>
    const hasCosts  = Object.values(costsObj).some(v => v > 0)
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'

    const skuToCost  = new Map<number, number>()
    const skuToPrice = new Map<number, number>()
    const pricesData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId)
    const priceByOffer = new Map<string, number>((pricesData?.items ?? []).map((it: any) => [it.offer_id, Number(it.price?.price) || 0]))
    if (hasCosts || true) {
      try {
        const si = await ozonCall<any>('/v4/product/info/stocks', { filter: { offer_id: Array.from(priceByOffer.keys()), visibility: 'ALL' }, limit: 1000, last_id: '' }, creds.clientId)
        for (const item of si?.result?.items ?? si?.items ?? []) {
          const sku = Number(item.stocks?.find((s: any) => s.type === 'fbo')?.sku ?? item.stocks?.[0]?.sku)
          const cost = costsObj[item.offer_id]
          const price = priceByOffer.get(item.offer_id) ?? 0
          if (sku && cost != null) skuToCost.set(sku, cost)
          if (sku && price > 0)    skuToPrice.set(sku, price)
        }
      } catch {}
    }

    async function calcFromTxns(from: string, to: string) {
      const ops = await fetchTxnsChunked(from, to, creds.clientId)
      // Оборот = цена покупателя × кол-во доставленных (не выплата, а реальная цена продажи)
      // Для каждой доставки берём цену из ЛК по SKU. Это приближение — реальная цена
      // покупателя могла отличаться (скидки, СПП), но точнее будет только из реализации,
      // которая закрывается лишь 5-го числа — транзакции это лучшее что есть для сегодня/вчера.
      let totalRevenue = 0, totalNet = 0, totalCost = 0
      const missing = new Set<number>()
      for (const op of ops) {
        if (op.operation_type === 'OperationAgentDeliveredToCustomer') {
          for (const item of op.items ?? []) {
            const sku = Number(item.sku)
            const price = skuToPrice.get(sku)
            if (price != null) totalRevenue += price
            if (hasCosts) {
              if (skuToCost.has(sku)) totalCost += skuToCost.get(sku)!
              else missing.add(sku)
            }
          }
          totalNet += Number(op.amount) || 0  // выплата (для расчёта прибыли)
        } else {
          totalNet += Number(op.amount) || 0  // возвраты, списания и прочее
        }
      }
      return { revenue: Math.round(totalRevenue), net: Math.round(totalNet), profit: hasCosts ? Math.round(totalNet - totalCost) : null, missing }
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
        const { all } = await getMonths(2, creds.clientId)
        const statsMap = await aggregateRealization(all.slice(0, 2), creds.clientId)
        const pricesData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId)
        const priceMap = new Map<string, { price: number; commissionRub: number }>((pricesData?.items ?? []).map((it: any) => [it.offer_id, {
          price: Number(it.price?.price) || 0,
          commissionRub: Math.round(Number(it.price?.price || 0) * getCommissionPct(it.commissions) / 100),
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
  } catch (e: unknown) { const err = safeError(e, '/api/profit'); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── ABC-АНАЛИЗ ────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/abc', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const { dateFrom, dateTo } = parseDateRange(req.query)
    const costsObj  = await getAllCosts() as Record<string, number>
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'

    const pricesData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId)
    const priceItems = pricesData?.items ?? []
    const priceById  = new Map<string, { price: number; commissionRub: number }>(priceItems.map((it: any) => [it.offer_id, {
      price: Number(it.price?.price) || 0,
      commissionRub: Math.round(Number(it.price?.price || 0) * getCommissionPct(it.commissions) / 100),
    }]))

    const { all: allMonths } = await getMonths(14, creds.clientId)
    const months = monthsInRange(allMonths, dateFrom, dateTo)
    if (months.length === 0) {
      return res.json({ items: [], totalRevenue: 0, totalProfit: 0, avgMarginPct: 0, ordersTotal: 0, months: 0, warning: 'Нет данных за период. Ozon закрывает отчёт ~5-го числа следующего месяца.' })
    }

    const statsMap = await aggregateRealization(months, creds.clientId)

    // Остатки FBO
    const offerIds = Array.from(statsMap.keys())
    const stockMap = new Map<string, { fbo: number; fbs: number }>()
    try {
      const si = await ozonCall<any>('/v4/product/info/stocks', { filter: { offer_id: offerIds, visibility: 'ALL' }, limit: 100, last_id: '' }, creds.clientId)
      for (const item of si?.result?.items ?? si?.items ?? []) {
        stockMap.set(item.offer_id, {
          fbo: item.stocks?.find((s: any) => s.type === 'fbo')?.present ?? 0,
          fbs: item.stocks?.find((s: any) => s.type === 'fbs')?.present ?? 0,
        })
      }
    } catch {}

    const dayCount = Math.max(1, (dateTo.getTime() - dateFrom.getTime()) / 86_400_000)
    const monthCount = months.length

    // advPerUnit — расход на рекламу на 1 продажу, посчитан за последние 30 дней
    // (см. getAdvPerUnitMap). Применяем этот per-unit показатель к фактическому
    // числу продаж за запрошенный период ABC — это корректно, потому что advPerUnit
    // характеризует юнит-экономику товара, а не конкретный месяц.
    const advMap = await getAdvPerUnitMap(creds.clientId).catch(() => new Map<string, number>())

    const rows = Array.from(statsMap.entries()).map(([offerId, stats]) => {
      const pm = priceById.get(offerId)
      const price = pm?.price ?? 0
      const cost = costsObj[offerId] ?? 0
      const netQty = Math.max(0, stats.deliveryCount - stats.returnCount)
      const netPayout = Math.max(0, stats.deliveryAmount - stats.returnAmount)
      const revenue = stats.buyerPriceTotal  // оборот по цене покупателя
      const netQtyForCalc = netQty > 0 ? netQty : 1
      const payoutPerUnit = netQty > 0 ? netPayout / netQty : 0
      // Реальная комиссия из транзакций (сумма удержаний Ozon за комиссию по всем продажам).
      // Это точнее чем тарифный процент — учитывает реальный микс FBO/FBS.
      // Если commissionTotal == 0 (поле не пришло в отчёте) — fallback на тарифный расчёт.
      const realCommPerUnit = stats.commissionTotal > 0
        ? stats.commissionTotal / netQtyForCalc
        : (pm ? price * pm.commissionRub / (pm.price || 1) : 0)
      const taxB = price > 0 ? calcTax({ taxSystem, payout: payoutPerUnit, cost, price, commissionRub: Math.round(realCommPerUnit) }) : null
      const taxPerUnit = taxB?.totalTax ?? 0
      const advPerUnit = advMap.get(offerId) ?? 0
      const profitRub = netPayout - netQty * cost - netQty * taxPerUnit - netQty * advPerUnit
      const marginPct = revenue > 0 ? parseFloat((profitRub / revenue * 100).toFixed(1)) : 0
      const stocks = stockMap.get(offerId) ?? { fbo: 0, fbs: 0 }
      const totalStock = stocks.fbo + stocks.fbs
      const dailySales = netQty / dayCount
      const stockDays = dailySales > 0 ? Math.round(totalStock / dailySales) : (totalStock > 0 ? 999 : 0)
      return { offerId, price, revenue: Math.round(revenue), payout: Math.round(netPayout), ordersCount: netQty, returnCount: stats.returnCount, marginPct, profitRub: Math.round(profitRub), stockDays, fboStock: stocks.fbo, fbsStock: stocks.fbs, hasCost: cost > 0, isCurrent: stats.includesCurrent, taxBreakdown: taxB, advPerUnit: advPerUnit > 0 ? advPerUnit : null, hasAdvData: advMap.size > 0, commissionPerUnit: Math.round(realCommPerUnit), commissionTotal: Math.round(stats.commissionTotal) }
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
  } catch (e: unknown) { const err = safeError(e, '/api/abc'); res.status(err.status).json({ error: err.message }) }
})

// ══════════════════════════════════════════════════════════════════════════════
// ── ЭКОНОМИКА: ДЕТЕКТОР ПОТЕРЬ ПО 6 КАТЕГОРИЯМ ───────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//
// Источник правды — реальные транзакции (/v3/finance/transaction/list), а не
// тарифный справочник. Все 6 категорий считаются на одном проходе по уже
// загруженным транзакциям за период — никаких дополнительных вызовов к Ozon
// сверх того, что уже нужно для sku→offer маппинга и (для категории 5) кэша
// расходов на рекламу.
//
// 1. Логистика — нелокальная доставка: у одного offer_id заказы идут с разных
//    складов, и логистика с одного склада заметно (>20%) выше другого.
// 2. Логистика — рост во времени: склад тот же, но логистика во второй
//    половине периода заметно (>20%) выше первой (смена упаковки/тарифа).
// 3. Хранение FBO — сумма платного хранения за период (MarketplaceServiceStorage*).
//    Сама по себе не аномалия, но это реальные деньги, о которых продавец
//    часто не знает, пока не откроет конкретный отчёт по хранению.
// 4. Отмены — логистика отмен (заказ поехал и не доехал) при cancelRate выше
//    нормы. Реальный пример из практики: 15.1% отмен у одного товара.
// 5. Реклама без продаж — расход в Performance API за период при 0 продаж
//    этого товара за тот же период. Деньги потрачены, выхлопа нет.
// 6. Эквайринг выше среднего — если эквайринг/шт у конкретного товара заметно
//    (>30%) выше среднего эквайринга/шт по всему магазину. Сам процент
//    эквайринга задаёт банк-эквайер, продавец на него не влияет напрямую,
//    но заметное отклонение — повод проверить способы оплаты/настройки.

type LossType = 'logistics_warehouse' | 'storage' | 'cancels' | 'ads_eating_profit' | 'acquiring'

interface LossItem {
  type: LossType
  label: string
  amountRub: number
  detail: string
}

interface EconomicsRow {
  offerId: string
  ordersCount: number
  totalLossRub: number
  losses: LossItem[]
}

function extractServiceRub(op: any, names: Set<string>): number {
  const svcs = (op.services ?? []).filter((sv: any) => names.has(sv.name))
  return svcs.reduce((s: number, sv: any) => s + Math.abs(Number(sv.price) || 0), 0)
}

// ══════════════════════════════════════════════════════════════════════════════
// ── АКТИВНЫЕ ЗАКАЗЫ FBO (юнит-экономика в реальном времени) ──────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/postings', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)

    // Получаем активные заказы по всем актуальным статусам
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const to    = new Date().toISOString()
    const statuses = ['awaiting_packaging', 'awaiting_deliver', 'delivering'] as const
    const allPostings: any[] = []
    await Promise.all(statuses.map(async (status) => {
      try {
        const r = await ozonCall<any>('/v2/posting/fbo/list', {
          filter: { since, to, status },
          with: { analytics_data: true, financial_data: true, translit: false },
          dir: 'desc', offset: 0, limit: 1000,
        }, creds.clientId)
        const items = Array.isArray(r) ? r : (r?.result ?? [])
        console.log(`[postings] status=${status} → ${items.length} items`)
        allPostings.push(...items)
      } catch (e: any) {
        console.warn(`[postings] status=${status} failed:`, e.message)
      }
    }))

    if (allPostings.length === 0) return res.json({ postings: [], fboWeeklyCount: 0 })

    // Собираем уникальные offer_id для батч-запросов
    const offerIds = [...new Set(allPostings.flatMap((p: any) => p.products?.map((pr: any) => pr.offer_id) ?? []))]

    // Цены, комиссии, объём — параллельно
    const [priceData, activeAcc, costsObj, targetMargins, volumeMap, fboWeeklyCount, priceSnapshots] = await Promise.all([
      ozonCall<any>('/v5/product/info/prices', { filter: { offer_id: offerIds, visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId).catch(() => null),
      getAccountByClientId(creds.clientId),
      getAllCosts(),
      getAllTargetMargins(),
      getCurrentVolumes(creds.clientId),
      getFboWeeklyCount(creds.clientId),
      getAllPriceSnapshots(creds.clientId),
    ])

    const taxSystem = activeAcc?.taxSystem ?? 'usn6'
    const priceByOffer = new Map<string, { price: number; commBoth: ReturnType<typeof getCommissionBoth> }>()
    for (const it of priceData?.items ?? []) {
      priceByOffer.set(it.offer_id, { price: Number(it.price?.price) || 0, commBoth: getCommissionBoth(it.commissions) })
    }

    // Расход на рекламу (кэш) — для среднего расхода/заказ по артикулу
    const advMap = await getAdvPerUnitMap(creds.clientId).catch(() => new Map<string, number>())
    // advCacheReady: true если advPerUnit кэш уже загружен и непустой,
    // false если ещё не инициализирован (покажем спиннер в модалке)
    const advCacheEntry = _advPerUnitCache.get(creds.clientId)
    const advCacheReady = !!(advCacheEntry && advCacheEntry.updatedAt > 0)

    // Применяем ли наценку за нелокальность?
    const applyNonLocal = fboWeeklyCount >= 50

    const postings = allPostings.map((p: any) => {
      const product = p.products?.[0]
      if (!product) return null
      const offerId    = product.offer_id
      const buyerPrice = Number(product.price) || 0
      const qty        = Number(product.quantity) || 1
      const pm         = priceByOffer.get(offerId)
      const cost       = (costsObj as Record<string,number>)[offerId] ?? null
      const targetMarginPct = (targetMargins as Record<string,number>)[offerId] ?? null
      const volumeLiters    = volumeMap[offerId] ?? null
      const clusterFrom = p.financial_data?.cluster_from ?? ''
      const clusterTo   = p.financial_data?.cluster_to ?? ''
      const scheme      = 'fbo'  // этот эндпоинт только FBO

      // Комиссия по схеме FBO
      const commPct = pm ? getCommissionPct(pm.commBoth, 'fbo') : 0
      const commRub = Math.round(buyerPrice * commPct / 100)

      // Логистика: по детальной таблице если есть кластеры, иначе по умолчанию
      const logisticsNorm = volumeLiters != null && clusterFrom && clusterTo
        ? getLogisticsNormByCluster(clusterFrom, clusterTo, volumeLiters, buyerPrice)
        : (volumeLiters != null ? getLogisticsNorm(volumeLiters, buyerPrice) : null)

      // Наценка за нелокальность (только при >= 50 FBO/нед)
      const nonLocalPct = applyNonLocal && clusterFrom && clusterTo && clusterFrom !== clusterTo
        ? getNonLocalSurcharge(clusterTo)
        : 0
      const nonLocalRub = logisticsNorm != null ? Math.round(logisticsNorm * nonLocalPct / 100) : 0
      const logisticsTotal = logisticsNorm != null ? Math.round(logisticsNorm + nonLocalRub) : null

      // Эквайринг (~1.5%)
      const acquiringRub = Math.round(buyerPrice * 0.015)

      // Выплата от Ozon (до рекламы и с/с)
      const payoutRub = buyerPrice - commRub - (logisticsTotal ?? 0) - acquiringRub

      // Цена для налога — берём реальную цену из posting (она уже известна точно),
      // а coinvest из снимка (он нужен только для отображения, не для расчёта налога).
      // Снимок цен может содержать обычную цену без учёта акции — это не та база.
      const snap = priceSnapshots[offerId]
      const taxBuyerPrice = buyerPrice  // всегда используем реальную цену покупателя из posting
      const coinvestRub = snap?.coinvestRub != null && snap.priceInLk > buyerPrice
        ? Math.round((snap.priceInLk - buyerPrice) * 100) / 100
        : null

      // Налог — передаём реальную цену покупателя и логистику для корректного ОСНО
      const taxB = cost != null && logisticsTotal != null
        ? calcTax({ taxSystem, payout: payoutRub, cost, price: taxBuyerPrice, buyerPrice: taxBuyerPrice, commissionRub: commRub, logisticsRub: logisticsTotal })
        : null

      // Реклама — среднее из Performance API кэша
      const advPerUnit = advMap.get(offerId) ?? null

      // Прибыль если выкупят
      const profitIfBought = cost != null && logisticsTotal != null
        ? Math.round(payoutRub - cost - (taxB?.totalTax ?? 0) - (advPerUnit ?? 0))
        : null

      // Убыток если не выкупят (обратная логистика = тариф без наценки за нелокальность)
      const returnLogistics = logisticsNorm != null ? Math.round(logisticsNorm * 0.5) : null  // возврат ≈ 50% от прямой логистики
      const lossIfNotBought = logisticsTotal != null
        ? -Math.round((logisticsTotal) + (returnLogistics ?? 0))
        : null

      return {
        postingNumber: p.posting_number,
        status: p.status,
        substatus: p.substatus,
        createdAt: p.created_at,
        offerId,
        productName: product.name,
        qty,
        buyerPrice,
        scheme,
        clusterFrom,
        clusterTo,
        warehouseName: p.analytics_data?.warehouse_name ?? '',
        deliveryType: p.analytics_data?.delivery_type ?? '',
        commPct, commRub,
        logisticsNorm, nonLocalPct, nonLocalRub, logisticsTotal,
        acquiringRub,
        cost, targetMarginPct,
        payoutRub: Math.round(payoutRub),
        taxRub: taxB?.totalTax ?? null,
        taxBuyerPrice: Math.round(taxBuyerPrice),
        coinvestRub,
        advPerUnit,
        profitIfBought,
        lossIfNotBought,
        returnLogistics,
        applyNonLocal,
      }
    }).filter(Boolean)

    res.json({ postings, fboWeeklyCount, applyNonLocal, advCacheReady })
  } catch (e: unknown) { const err = safeError(e, '/api/postings'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/economics', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const { dateFrom, dateTo } = parseDateRange(req.query)
    const ops = await fetchTxnsChunked(dateFrom.toISOString(), dateTo.toISOString(), creds.clientId)
    const deliveryOps  = ops.filter((op: any) => op.operation_type === 'OperationAgentDeliveredToCustomer')
    const acquiringOps = ops.filter((op: any) => op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation')
    const cancelOps: any[] = []
    for (const op of ops.filter((op: any) => op.operation_type === 'OperationItemReturn')) {
      const svcs: string[] = (op.services ?? []).map((s: any) => s.name)
      // ReturnAfterDelivToCustomer = настоящий возврат (товар доехал и вернулся).
      // Всё остальное под OperationItemReturn — отмена (товар не доехал).
      // Для Economics нас интересуют именно отмены — это логистика "в одну
      // сторону без продажи", настоящие возвраты — отдельная история (товар
      // хотя бы был продан и доставлен, возврат — это поведение покупателя,
      // а не операционная потеря продавца в том же смысле).
      if (!svcs.includes('MarketplaceServiceItemReturnAfterDelivToCustomer')) cancelOps.push(op)
    }

    if (deliveryOps.length === 0) {
      return res.json({ items: [], warning: 'Нет доставленных заказов за период.' })
    }

    // offer_id не приходит в транзакциях напрямую — есть только sku в items[].
    const skuToOffer = new Map<number, string>()
    try {
      const productList = await ozonCall<any>('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: '', limit: 1000 }, creds.clientId)
      const offerIds: string[] = (productList?.result?.items ?? []).map((it: any) => it.offer_id).filter(Boolean)
      for (let i = 0; i < offerIds.length; i += 100) {
        const batch = offerIds.slice(i, i + 100)
        const info = await ozonCall<any>('/v3/product/info/list', { offer_id: batch }, creds.clientId)
        for (const item of info?.items ?? []) {
          if (item.offer_id && item.sku) skuToOffer.set(Number(item.sku), item.offer_id)
        }
      }
    } catch (e: any) {
      console.warn('[economics] sku→offer resolution failed:', e.message)
    }
    const skuOf = (op: any): number | null => {
      const sku = Number(op.items?.[0]?.sku)
      return Number.isFinite(sku) && sku > 0 ? sku : null
    }

    // Цены товаров — нужны для нормы логистики (тариф зависит от того, дешевле
    // или дороже товар 300₽) и для расчёта юнит-экономики в категории "реклама".
    const priceByOffer = new Map<string, number>()
    try {
      const priceData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId)
      for (const it of priceData?.items ?? []) priceByOffer.set(it.offer_id, Number(it.price?.price) || 0)
    } catch (e: any) { console.warn('[economics] price fetch failed:', e.message) }

    // История литража — нужна, чтобы для КАЖДОЙ конкретной доставки взять
    // литраж, действовавший именно на момент этой транзакции, а не текущий.
    const volumeHistoryByOffer = await getAllVolumeHistory(creds.clientId)
    function getVolumeAtTime(offerId: string, ts: number): number | null {
      const records = volumeHistoryByOffer[offerId]
      if (!records || records.length === 0) return null
      // records отсортированы по validFrom desc (см. db.ts) — ищем запись,
      // действовавшую на момент ts: validFrom <= ts < validTo (или validTo == null)
      for (const r of records) {
        if (r.validFrom <= ts && (r.validTo === null || ts < r.validTo)) return r.volumeLiters
      }
      // Если транзакция старше самой ранней записи истории (например, у нас
      // история началась только с момента подключения аккаунта, а транзакция
      // была раньше) — используем самую раннюю известную запись как лучшее приближение.
      return records[records.length - 1]?.volumeLiters ?? null
    }

    // Себестоимость и целевая маржа — для категории "реклама как потеря".
    const costsObj = await getAllCosts() as Record<string, number>
    const targetMargins = await getAllTargetMargins() as Record<string, number>
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystemForEcon = activeAcc?.taxSystem ?? 'usn6'

    // ── Группируем доставки по offer_id (для логистики, как и раньше) ────────
    interface DeliveryPoint { ts: number; logisticsRub: number; warehouseId: string; scheme: string }
    const byOfferDelivery = new Map<string, DeliveryPoint[]>()
    // ── Хранение, отмены, эквайринг — считаем сразу по offer_id ──────────────
    const storageByOffer  = new Map<string, number>()
    const cancelByOffer   = new Map<string, { amountRub: number; count: number }>()
    const acquiringByOffer = new Map<string, { amountRub: number; count: number }>()
    const ordersByOffer   = new Map<string, number>()

    for (const op of deliveryOps) {
      const logisticsRub = extractServiceRub(op, LOGISTICS_SERVICES)
      const storageRub   = extractServiceRub(op, STORAGE_SERVICES)
      const warehouseId  = String(op.posting?.warehouse_id ?? '0')
      const scheme       = op.posting?.delivery_schema || 'unknown'
      const ts           = new Date(op.posting?.order_date ?? op.operation_date).getTime()
      for (const it of op.items ?? []) {
        const sku = Number(it.sku)
        const offerId = skuToOffer.get(sku)
        if (!offerId) continue
        ordersByOffer.set(offerId, (ordersByOffer.get(offerId) ?? 0) + 1)
        if (logisticsRub > 0) {
          if (!byOfferDelivery.has(offerId)) byOfferDelivery.set(offerId, [])
          byOfferDelivery.get(offerId)!.push({ ts, logisticsRub, warehouseId, scheme })
        }
        if (storageRub > 0) storageByOffer.set(offerId, (storageByOffer.get(offerId) ?? 0) + storageRub)
      }
    }
    for (const op of cancelOps) {
      const sku = skuOf(op)
      const offerId = sku != null ? skuToOffer.get(sku) : null
      if (!offerId) continue
      const amountRub = Math.abs(Number(op.amount) || 0)
      const prev = cancelByOffer.get(offerId) ?? { amountRub: 0, count: 0 }
      cancelByOffer.set(offerId, { amountRub: prev.amountRub + amountRub, count: prev.count + 1 })
    }
    for (const op of acquiringOps) {
      const sku = skuOf(op)
      const offerId = sku != null ? skuToOffer.get(sku) : null
      if (!offerId) continue
      const amountRub = Math.abs(Number(op.amount) || 0)
      const prev = acquiringByOffer.get(offerId) ?? { amountRub: 0, count: 0 }
      acquiringByOffer.set(offerId, { amountRub: prev.amountRub + amountRub, count: prev.count + 1 })
    }

    // Средний эквайринг/заказ по всему магазину — нужен как база для категории 6
    const totalAcqRub   = Array.from(acquiringByOffer.values()).reduce((s, v) => s + v.amountRub, 0)
    const totalAcqCount = Array.from(acquiringByOffer.values()).reduce((s, v) => s + v.count, 0)
    const avgAcqPerOrder = totalAcqCount > 0 ? totalAcqRub / totalAcqCount : 0

    // Расход на рекламу по каждому товару за последние 30 дней (то, что
    // умеет отдавать Performance API кэш — см. getPerfSpendByOffer). Раньше
    // здесь фильтровалось только "расход есть, продаж нет", теперь критерий
    // другой — реклама учитывается в категории 5 если она проваливает маржу
    // товара ниже порога, независимо от факта продаж как такового.
    let adsSpendByOffer = new Map<string, number>()
    try {
      const spendMap = await getPerfSpendByOffer(creds.clientId)
      if (spendMap) for (const [offerId, spent] of spendMap) if (spent > 0) adsSpendByOffer.set(offerId, spent)
    } catch (e: any) { console.warn('[economics] ads check failed:', e.message) }

    // ── Собираем итоговый список по объединению всех offer_id, встреченных
    //    в любой из 6 категорий (не только в логистике, как было раньше) ─────
    const allOfferIds = new Set<string>([
      ...byOfferDelivery.keys(), ...storageByOffer.keys(), ...cancelByOffer.keys(),
      ...acquiringByOffer.keys(), ...adsSpendByOffer.keys(),
    ])

    const items: EconomicsRow[] = []
    for (const offerId of allOfferIds) {
      const losses: LossItem[] = []
      const points = byOfferDelivery.get(offerId) ?? []
      const ordersCount = ordersByOffer.get(offerId) ?? points.length

      // ── 1. Логистика выше нормы ────────────────────────────────────────
      // Норма берётся из официальной тарифной сетки Ozon для литража,
      // ДЕЙСТВОВАВШЕГО на момент каждой конкретной доставки (не текущего!).
      // Если продавец менял габариты товара — это не считается потерей: для
      // старых доставок используется старый литраж, для новых — новый, и
      // сравнение с нормой идёт корректно в обоих случаях.
      if (points.length >= 3) {
        const price = priceByOffer.get(offerId) ?? 0
        let overpayTotal = 0, overpayCount = 0, totalActual = 0, totalNorm = 0
        for (const p of points) {
          const volumeAtTime = getVolumeAtTime(offerId, p.ts)
          if (volumeAtTime == null) continue  // нет данных по литражу на этот момент — пропускаем точку, не гадаем
          const norm = getLogisticsNorm(volumeAtTime, price)
          if (norm == null) continue
          totalActual += p.logisticsRub; totalNorm += norm
          if (p.logisticsRub > norm * 1.15) {  // 15% запас, чтобы не реагировать на нормальный шум округления
            overpayTotal += p.logisticsRub - norm
            overpayCount++
          }
        }
        if (overpayCount > 0 && overpayTotal > 0) {
          const avgActual = Math.round(totalActual / points.length)
          const avgNorm = Math.round(totalNorm / points.length)
          losses.push({
            type: 'logistics_warehouse',
            label: 'Логистика выше нормы',
            amountRub: Math.round(overpayTotal),
            detail: `${overpayCount} из ${points.length} доставок дороже тарифной нормы Ozon (в среднем ${avgActual}₽ vs норма ${avgNorm}₽ для текущего литража) — проверьте склад отправления и упаковку`,
          })
        }
      }

      // ── 3. Хранение FBO ─────────────────────────────────────────────────
      const storageRub = storageByOffer.get(offerId) ?? 0
      if (storageRub > 0) {
        losses.push({
          type: 'storage', label: 'Платное хранение FBO',
          amountRub: Math.round(storageRub),
          detail: `Начислено хранение за период, ${ordersCount} заказ(ов) за то же время`,
        })
      }

      // ── 4. Отмены ───────────────────────────────────────────────────────
      const cancel = cancelByOffer.get(offerId)
      if (cancel && cancel.count > 0) {
        const totalForRate = ordersCount + cancel.count
        const cancelRate = totalForRate > 0 ? Math.round(cancel.count / totalForRate * 1000) / 10 : 0
        if (cancelRate > 10) {  // порог взят из реального примера 15.1% как "уже заметно"
          losses.push({
            type: 'cancels', label: 'Высокий % отмен',
            amountRub: Math.round(cancel.amountRub),
            detail: `${cancelRate}% заказов отменено (${cancel.count} из ${totalForRate}) — логистика "туда-обратно" без продажи`,
          })
        }
      }

      // ── 5. Реклама съела прибыль ─────────────────────────────────────────
      // Считается ТОЛЬКО если пользователь задал целевую маржу для этого
      // товара — иначе продавцов, сознательно работающих на низкой марже
      // (ради оборота/доли рынка), мы бы ложно помечали как "теряющих деньги".
      const targetMarginPct = targetMargins[offerId]
      const adsSpent60d = adsSpendByOffer.get(offerId) ?? 0
      if (targetMarginPct != null && adsSpent60d > 0 && ordersCount > 0) {
        const cost = costsObj[offerId] ?? 0
        const price = priceByOffer.get(offerId) ?? 0
        if (cost > 0 && price > 0) {
          const acq = acquiringByOffer.get(offerId)
          const acquiringPerUnit = acq && acq.count > 0 ? acq.amountRub / acq.count : price * 0.015
          const cancel = cancelByOffer.get(offerId)
          const cancelPerUnit = cancel && ordersCount > 0 ? cancel.amountRub / ordersCount : 0
          const storagePerUnit = ordersCount > 0 ? (storageByOffer.get(offerId) ?? 0) / ordersCount : 0
          // Налог считаем тем же способом, что и в /api/analytics — на основе
          // системы налогообложения аккаунта, цены и комиссии (приблизительно,
          // т.к. точная комиссия по конкретному товару не всегда под рукой здесь).
          const commPct = 0  // если нет точных данных о комиссии — считаем без неё (консервативная оценка, не раздувает потерю)
          const taxB = calcTax({ taxSystem: taxSystemForEcon, payout: price, cost, price, commissionRub: Math.round(price * commPct / 100) })
          const adsPerUnit = adsSpent60d / ordersCount
          const marginBeforeAdsRub = price - cost - acquiringPerUnit - cancelPerUnit - storagePerUnit - (taxB?.totalTax ?? 0)
          const marginAfterAdsRub  = marginBeforeAdsRub - adsPerUnit
          const marginAfterAdsPct  = price > 0 ? (marginAfterAdsRub / price) * 100 : 0
          // Потеря — это часть рекламы, которая утащила маржу НИЖЕ порога 5%.
          // Если маржа и без рекламы была ниже 5% — это не вина рекламы, пункт не срабатывает.
          const marginBeforeAdsPct = price > 0 ? (marginBeforeAdsRub / price) * 100 : 0
          if (marginAfterAdsPct <= 5 && marginBeforeAdsPct > 5) {
            const lossPerUnit = (5 - marginAfterAdsPct) / 100 * price
            const lossTotal = Math.min(adsSpent60d, lossPerUnit * ordersCount)
            if (lossTotal > 0) {
              losses.push({
                type: 'ads_eating_profit', label: 'Реклама съела прибыль',
                amountRub: Math.round(lossTotal),
                detail: `Маржа без рекламы ${Math.round(marginBeforeAdsPct)}%, с рекламой — ${Math.round(marginAfterAdsPct)}% (цель ${targetMarginPct}%). Расход на рекламу за 30 дней: ${Math.round(adsSpent60d)}₽`,
              })
            }
          }
        }
      }

      // ── 6. Эквайринг выше среднего ──────────────────────────────────────
      const acq = acquiringByOffer.get(offerId)
      if (acq && acq.count >= 3 && avgAcqPerOrder > 0) {
        const acqPerOrder = acq.amountRub / acq.count
        const diffPct = Math.round(((acqPerOrder - avgAcqPerOrder) / avgAcqPerOrder) * 1000) / 10
        if (diffPct > 30) {
          const extraRub = Math.round((acqPerOrder - avgAcqPerOrder) * acq.count)
          losses.push({
            type: 'acquiring', label: 'Эквайринг выше среднего',
            amountRub: extraRub,
            detail: `${Math.round(acqPerOrder * 10) / 10}₽/заказ vs ${Math.round(avgAcqPerOrder * 10) / 10}₽/заказ в среднем по магазину (+${diffPct}%)`,
          })
        }
      }

      if (losses.length === 0) continue
      const totalLossRub = losses.reduce((s, l) => s + l.amountRub, 0)
      items.push({ offerId, ordersCount, totalLossRub, losses })
    }

    items.sort((a, b) => b.totalLossRub - a.totalLossRub)

    res.json({
      items,
      totalAnalyzed: allOfferIds.size,
      withLosses: items.length,
      totalLossRub: items.reduce((s, i) => s + i.totalLossRub, 0),
      months: Math.round((dateTo.getTime() - dateFrom.getTime()) / 86_400_000 / 30 * 10) / 10,
    })
  } catch (e: unknown) { const err = safeError(e, '/api/economics'); res.status(err.status).json({ error: err.message }) }
})

// ── История маржи по артикулу (последние 6 месяцев) ─────────────────────────
app.get('/api/stock-forecast', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)

    // Берём продажи за последние 30 дней из реализации
    const { all: allMonths } = await getMonths(2, creds.clientId)
    const statsMap = await aggregateRealization(allMonths.slice(0, 1), creds.clientId)

    // Текущие остатки
    const offerIds = Array.from(statsMap.keys())
    const stockMap = new Map<string, { fbo: number; fbs: number }>()
    try {
      const si = await ozonCall<any>('/v4/product/info/stocks', { filter: { offer_id: offerIds, visibility: 'ALL' }, limit: 1000, last_id: '' }, creds.clientId)
      for (const item of si?.result?.items ?? si?.items ?? []) {
        stockMap.set(item.offer_id, {
          fbo: item.stocks?.find((s: any) => s.type === 'fbo')?.present ?? 0,
          fbs: item.stocks?.find((s: any) => s.type === 'fbs')?.present ?? 0,
        })
      }
    } catch {}

    const DAY_MS = 86_400_000
    const periodDays = 30
    const now = Date.now()

    const items = Array.from(statsMap.entries()).map(([offerId, stats]) => {
      const netQty = Math.max(0, stats.deliveryCount - stats.returnCount)
      const dailySales = netQty / periodDays
      const stocks = stockMap.get(offerId) ?? { fbo: 0, fbs: 0 }
      const totalStock = stocks.fbo + stocks.fbs

      // Дней до out-of-stock
      const daysLeft = dailySales > 0 ? Math.floor(totalStock / dailySales) : (totalStock > 0 ? 999 : 0)
      const outOfStockDate = dailySales > 0
        ? new Date(now + daysLeft * DAY_MS).toISOString().slice(0, 10)
        : null

      // Сколько нужно заказать на 30 дней запаса (с учётом срока производства/поставки — фиксировано 14 дней)
      const leadTimeDays = 14
      const reorderQty = Math.max(0, Math.ceil(dailySales * (periodDays + leadTimeDays) - totalStock))
      const urgent = daysLeft <= leadTimeDays && dailySales > 0

      return {
        offerId,
        fboStock: stocks.fbo,
        fbsStock: stocks.fbs,
        totalStock,
        dailySales: Math.round(dailySales * 10) / 10,
        daysLeft,
        outOfStockDate,
        reorderQty,
        urgent,   // нужно заказывать прямо сейчас
      }
    }).filter(r => r.dailySales > 0 || r.totalStock > 0)

    items.sort((a, b) => {
      // Сначала urgent (кончается в течение срока поставки), потом по числу дней
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
      return a.daysLeft - b.daysLeft
    })

    const urgentCount = items.filter(i => i.urgent).length
    res.json({ items, urgentCount, periodDays })
  } catch (e: unknown) { const err = safeError(e, '/api/stock-forecast'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/margin-history/:offerId', async (req, res) => {
  const { offerId } = req.params
  if (!offerId || offerId.length > 100 || !/^[\w\-_.]+$/.test(offerId)) {
    return res.status(400).json({ error: 'Неверный offerId' })
  }
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const { all: allMonths } = await getMonths(8, creds.clientId)
    const costsObj = await getAllCosts() as Record<string, number>
    const cost = costsObj[offerId] ?? 0
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'
    const priceData = await ozonCall<any>('/v5/product/info/prices', { filter: { offer_id: [offerId] }, cursor: '', limit: 10 }, creds.clientId).catch(() => null)
    const pi = (priceData?.items ?? [])[0]
    const commissionPct = getCommissionPct(pi?.commissions)

    const history: { month: string; deliveries: number; payout: number; marginPct: number | null; buyerPrice: number | null }[] = []

    for (const { year, month } of allMonths.slice(0, 6)) {
      try {
        const rows = await fetchRealizCached(year, month, creds.clientId)
        const myRows = rows.filter((r: any) => (r.item?.offer_id ?? r.offer_id) === offerId)
        if (myRows.length === 0) continue

        let deliveries = 0, totalPayout = 0, totalBuyerPrice = 0
        for (const r of myRows) {
          const parsed = parseRealizRow(r)
          if (!parsed || parsed.deliveryCount === 0) continue
          deliveries += parsed.deliveryCount
          totalPayout += parsed.deliveryAmount
          totalBuyerPrice += parsed.buyerPrice
        }
        if (deliveries === 0) continue

        const avgPayout = totalPayout / deliveries
        const avgBuyer = totalBuyerPrice / deliveries
        const taxB = avgBuyer > 0 && cost > 0
          ? calcTax({ taxSystem, payout: avgPayout, cost, price: avgBuyer, commissionRub: Math.round(avgBuyer * commissionPct / 100) })
          : null
        const netPerUnit = avgPayout - cost - (taxB?.totalTax ?? 0)
        const marginPct = avgPayout > 0 ? Math.round(netPerUnit / avgPayout * 100) : null

        history.push({
          month: `${year}-${String(month).padStart(2, '0')}`,
          deliveries,
          payout: Math.round(avgPayout),
          buyerPrice: Math.round(avgBuyer),
          marginPct,
        })
      } catch {}
    }

    res.json({ offerId, cost, history: history.reverse() })
  } catch (e: unknown) { const err = safeError(e, '/api/margin-history'); res.status(err.status).json({ error: err.message }) }
})

// ── Экспорт P&L по всем артикулам ────────────────────────────────────────────
app.get('/api/export/pnl', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const { all: allMonths } = await getMonths(3, creds.clientId)
    const costsObj = await getAllCosts() as Record<string, number>
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'
    const priceData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId).catch(() => null)
    const priceMap = new Map<string, { price: number; commissionPct: number }>()
    for (const it of priceData?.items ?? []) {
      priceMap.set(it.offer_id, {
        price: Number(it.price?.price) || 0,
        commissionPct: getCommissionPct(it.commissions),
      })
    }

    const statsMap = await aggregateRealization(allMonths.slice(0, 2), creds.clientId)
    const rows: any[] = []

    for (const [oid, stats] of statsMap) {
      const deliveries = Math.max(0, stats.deliveryCount - stats.returnCount)
      if (deliveries === 0) continue
      const cost = costsObj[oid] ?? 0
      const pm = priceMap.get(oid)
      const avgPayout = stats.deliveryAmount / deliveries
      const avgBuyer = stats.buyerPriceTotal > 0 ? stats.buyerPriceTotal / deliveries : (pm?.price ?? 0)
      // Реальная комиссия из транзакций: точнее чем тарифный процент,
      // учитывает реальный микс FBO/FBS за период.
      const realCommPerUnit = stats.commissionTotal > 0
        ? stats.commissionTotal / deliveries
        : Math.round(avgBuyer * (pm?.commissionPct ?? 0) / 100)
      const taxB = avgBuyer > 0 && cost > 0
        ? calcTax({ taxSystem, payout: avgPayout, cost, price: avgBuyer, commissionRub: Math.round(realCommPerUnit) })
        : null
      const netPerUnit = avgPayout - cost - (taxB?.totalTax ?? 0)
      const marginPct = avgBuyer > 0 ? Math.round(netPerUnit / avgBuyer * 100) : null

      rows.push({
        offerId: oid,
        deliveries,
        priceInLK: pm?.price ?? 0,
        avgBuyerPrice: Math.round(avgBuyer),
        avgPayout: Math.round(avgPayout),
        avgCommission: Math.round(realCommPerUnit),
        cost,
        tax: taxB?.totalTax ?? 0,
        taxSystem,
        netPerUnit: Math.round(netPerUnit),
        marginPct,
        revenue: Math.round(avgBuyer * deliveries),   // оборот по цене покупателя
        profit: Math.round(netPerUnit * deliveries),
      })
    }

    rows.sort((a, b) => b.revenue - a.revenue)
    res.json({ rows, months: allMonths.slice(0, 2).map(m => `${m.year}-${String(m.month).padStart(2,'0')}`).join(' + ') })
  } catch (e: unknown) { const err = safeError(e, '/api/export/pnl'); res.status(err.status).json({ error: err.message }) }
})

// ── Экспорт «Экономики» — все 6 категорий с исходными цифрами для ручной
//    проверки (число заказов, суммы по складам, период, и т.п.), а не только
//    итоговые проценты ────────────────────────────────────────────────────────
app.get('/api/export/economics', async (req, res) => {
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const { dateFrom, dateTo } = parseDateRange(req.query)
    const ops = await fetchTxnsChunked(dateFrom.toISOString(), dateTo.toISOString(), creds.clientId)
    const deliveryOps  = ops.filter((op: any) => op.operation_type === 'OperationAgentDeliveredToCustomer')
    const acquiringOps = ops.filter((op: any) => op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation')
    const cancelOps: any[] = []
    for (const op of ops.filter((op: any) => op.operation_type === 'OperationItemReturn')) {
      const svcs: string[] = (op.services ?? []).map((s: any) => s.name)
      if (!svcs.includes('MarketplaceServiceItemReturnAfterDelivToCustomer')) cancelOps.push(op)
    }

    const skuToOffer = new Map<number, string>()
    try {
      const productList = await ozonCall<any>('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: '', limit: 1000 }, creds.clientId)
      const offerIds: string[] = (productList?.result?.items ?? []).map((it: any) => it.offer_id).filter(Boolean)
      for (let i = 0; i < offerIds.length; i += 100) {
        const batch = offerIds.slice(i, i + 100)
        const info = await ozonCall<any>('/v3/product/info/list', { offer_id: batch }, creds.clientId)
        for (const item of info?.items ?? []) {
          if (item.offer_id && item.sku) skuToOffer.set(Number(item.sku), item.offer_id)
        }
      }
    } catch {}
    const skuOf = (op: any): number | null => {
      const sku = Number(op.items?.[0]?.sku)
      return Number.isFinite(sku) && sku > 0 ? sku : null
    }

    const priceByOffer = new Map<string, number>()
    try {
      const priceData = await ozonCall<any>('/v5/product/info/prices', { filter: { visibility: 'ALL' }, cursor: '', limit: 1000 }, creds.clientId)
      for (const it of priceData?.items ?? []) priceByOffer.set(it.offer_id, Number(it.price?.price) || 0)
    } catch {}

    const volumeHistoryByOffer = await getAllVolumeHistory(creds.clientId)
    function getVolumeAtTime(offerId: string, ts: number): number | null {
      const records = volumeHistoryByOffer[offerId]
      if (!records || records.length === 0) return null
      for (const r of records) if (r.validFrom <= ts && (r.validTo === null || ts < r.validTo)) return r.volumeLiters
      return records[records.length - 1]?.volumeLiters ?? null
    }

    const costsObj = await getAllCosts() as Record<string, number>
    const targetMargins = await getAllTargetMargins() as Record<string, number>
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystemForEcon = activeAcc?.taxSystem ?? 'usn6'

    let adsSpendByOffer = new Map<string, number>()
    try {
      const spendMap = await getPerfSpendByOffer(creds.clientId)
      if (spendMap) for (const [offerId, spent] of spendMap) if (spent > 0) adsSpendByOffer.set(offerId, spent)
    } catch {}

    const ordersByOffer    = new Map<string, number>()
    const cancelByOffer    = new Map<string, { amountRub: number; count: number }>()
    const acquiringByOffer = new Map<string, { amountRub: number; count: number }>()

    // ── Строка 1 — ЛОГИСТИКА: одна строка на каждую конкретную доставку.
    //    Показываем FBO/FBS (delivery_schema), литраж НА МОМЕНТ этой доставки,
    //    норму по тарифу Ozon для этого литража, факт, и явно — потеря или нет.
    interface LogisticsRow {
      kind: 'logistics'; offerId: string; date: string; scheme: string; warehouseId: string
      volumeLitersAtTime: number | null; priceRub: number
      logisticsFactRub: number; logisticsNormRub: number | null
      overpayRub: number; isLoss: 'да' | 'нет'
    }
    const logisticsRows: LogisticsRow[] = []
    for (const op of deliveryOps) {
      const logisticsRub = extractServiceRub(op, LOGISTICS_SERVICES)
      const warehouseId  = String(op.posting?.warehouse_id ?? '0')
      const scheme        = op.posting?.delivery_schema || 'неизвестно'
      const ts = new Date(op.posting?.order_date ?? op.operation_date).getTime()
      const dateStr = new Date(ts).toISOString().slice(0, 10)
      for (const it of op.items ?? []) {
        const sku = Number(it.sku)
        const offerId = skuToOffer.get(sku)
        if (!offerId) continue
        ordersByOffer.set(offerId, (ordersByOffer.get(offerId) ?? 0) + 1)
        if (logisticsRub <= 0) continue
        const price = priceByOffer.get(offerId) ?? 0
        const volumeAtTime = getVolumeAtTime(offerId, ts)
        const norm = volumeAtTime != null ? getLogisticsNorm(volumeAtTime, price) : null
        const overpay = norm != null && logisticsRub > norm * 1.15 ? Math.round((logisticsRub - norm) * 10) / 10 : 0
        logisticsRows.push({
          kind: 'logistics', offerId, date: dateStr, scheme, warehouseId,
          volumeLitersAtTime: volumeAtTime, priceRub: price,
          logisticsFactRub: Math.round(logisticsRub * 10) / 10,
          logisticsNormRub: norm != null ? Math.round(norm * 10) / 10 : null,
          overpayRub: overpay, isLoss: overpay > 0 ? 'да' : 'нет',
        })
      }
    }
    for (const op of cancelOps) {
      const sku = skuOf(op); const offerId = sku != null ? skuToOffer.get(sku) : null
      if (!offerId) continue
      const prev = cancelByOffer.get(offerId) ?? { amountRub: 0, count: 0 }
      cancelByOffer.set(offerId, { amountRub: prev.amountRub + Math.abs(Number(op.amount) || 0), count: prev.count + 1 })
    }
    for (const op of acquiringOps) {
      const sku = skuOf(op); const offerId = sku != null ? skuToOffer.get(sku) : null
      if (!offerId) continue
      const prev = acquiringByOffer.get(offerId) ?? { amountRub: 0, count: 0 }
      acquiringByOffer.set(offerId, { amountRub: prev.amountRub + Math.abs(Number(op.amount) || 0), count: prev.count + 1 })
    }
    const totalAcqRub   = Array.from(acquiringByOffer.values()).reduce((s, v) => s + v.amountRub, 0)
    const totalAcqCount = Array.from(acquiringByOffer.values()).reduce((s, v) => s + v.count, 0)
    const avgAcqPerOrder = totalAcqCount > 0 ? totalAcqRub / totalAcqCount : 0

    const storageByOffer = new Map<string, number>()
    for (const op of deliveryOps) {
      const storageRub = extractServiceRub(op, STORAGE_SERVICES)
      if (storageRub <= 0) continue
      for (const it of op.items ?? []) {
        const sku = Number(it.sku); const offerId = skuToOffer.get(sku)
        if (offerId) storageByOffer.set(offerId, (storageByOffer.get(offerId) ?? 0) + storageRub)
      }
    }

    // ── Строка 2 — СВОДКА ПО ТОВАРУ: хранение/отмены/эквайринг/реклама,
    //    с явной пометкой "потеря или справочная информация" для каждой суммы.
    interface SummaryRow {
      kind: 'summary'; offerId: string; ordersCount: number
      storageRubTotal: number; storageIsLoss: 'справочно (не потеря само по себе)'
      cancelCount: number; cancelAmountRub: number; cancelRatePct: number; cancelIsLoss: 'да' | 'нет'
      acquiringAmountRub: number; acquiringPerOrder: number; avgAcquiringShop: number; acquiringIsLoss: 'да' | 'нет'
      adsSpend60dRub: number; targetMarginPct: number | null; adsIsLoss: 'нет — нет целевой маржи' | 'требует расчёта в расширении'
    }
    const summaryRows: SummaryRow[] = []
    const allOfferIds = new Set<string>([...ordersByOffer.keys(), ...cancelByOffer.keys(), ...acquiringByOffer.keys(), ...adsSpendByOffer.keys(), ...storageByOffer.keys()])
    for (const offerId of allOfferIds) {
      const ordersCount = ordersByOffer.get(offerId) ?? 0
      const storageRubTotal = storageByOffer.get(offerId) ?? 0
      const cancel = cancelByOffer.get(offerId) ?? { amountRub: 0, count: 0 }
      const totalForRate = ordersCount + cancel.count
      const cancelRatePct = totalForRate > 0 ? Math.round(cancel.count / totalForRate * 1000) / 10 : 0
      const acq = acquiringByOffer.get(offerId) ?? { amountRub: 0, count: 0 }
      const acqPerOrder = acq.count > 0 ? acq.amountRub / acq.count : 0
      const adsSpend = adsSpendByOffer.get(offerId) ?? 0
      const targetMarginPct = targetMargins[offerId] ?? null

      summaryRows.push({
        kind: 'summary', offerId, ordersCount,
        storageRubTotal: Math.round(storageRubTotal * 10) / 10, storageIsLoss: 'справочно (не потеря само по себе)',
        cancelCount: cancel.count, cancelAmountRub: Math.round(cancel.amountRub * 10) / 10, cancelRatePct,
        cancelIsLoss: cancelRatePct > 10 ? 'да' : 'нет',
        acquiringAmountRub: Math.round(acq.amountRub * 10) / 10, acquiringPerOrder: Math.round(acqPerOrder * 10) / 10,
        avgAcquiringShop: Math.round(avgAcqPerOrder * 10) / 10,
        acquiringIsLoss: avgAcqPerOrder > 0 && acqPerOrder > avgAcqPerOrder * 1.3 ? 'да' : 'нет',
        adsSpend60dRub: Math.round(adsSpend * 10) / 10, targetMarginPct,
        adsIsLoss: targetMarginPct == null ? 'нет — нет целевой маржи' : 'требует расчёта в расширении',
      })
    }

    logisticsRows.sort((a, b) => a.offerId.localeCompare(b.offerId) || a.date.localeCompare(b.date))
    summaryRows.sort((a, b) => a.offerId.localeCompare(b.offerId))

    res.json({
      logisticsRows, summaryRows,
      period: { from: dateFrom.toISOString().slice(0, 10), to: dateTo.toISOString().slice(0, 10) },
      note: 'Источник: /v3/finance/transaction/list (Ozon Seller API). ЛИСТ ЛОГИСТИКА: одна строка на каждую доставку, scheme = FBO/FBS/rFBS из posting.delivery_schema, литраж — действовавший НА МОМЕНТ этой доставки (из истории litres, не текущий), норма — по официальной тарифной сетке Ozon для этого литража и цены товара, "потеря" = факт превышает норму более чем на 15%. ЛИСТ СВОДКА: хранение — справочно (не помечается как потеря автоматически, само по себе наличие платного хранения это не ошибка); отмены — потеря если % отмен >10; эквайринг — потеря если на 30%+ выше среднего по магазину; реклама — точный расчёт "съела ли прибыль" требует целевой маржи (поле рядом с себестоимостью) и полной юнит-экономики, см. расшифровку потерь в самом расширении по клику на артикул.',
    })
  } catch (e: unknown) { const err = safeError(e, '/api/export/economics'); res.status(err.status).json({ error: err.message }) }
})

async function getSkuForOffer(offerId: string, months: { year: number; month: number }[], clientId?: string): Promise<number | null> {
  for (const { year, month } of months) {
    const rows = await fetchRealizCached(year, month, clientId)
    const match = rows.find((r: any) => (r.item?.offer_id ?? r.offer_id) === offerId)
    if (match?.item?.sku) return Number(match.item.sku)
  }
  return null
}

app.get('/api/analytics/:offerId', async (req, res) => {
  const { offerId } = req.params
  if (!offerId || offerId.length > 100 || !/^[\w\-_.]+$/.test(offerId)) {
    return res.status(400).json({ error: 'Неверный offerId' })
  }
  try {
    const clientId = res.locals.clientId as string | undefined
    const creds = await resolveCreds(clientId)
    const { all: allMonths, closed: closedMonths } = await getMonths(12, creds.clientId)
    const sku = await getSkuForOffer(offerId, allMonths, creds.clientId)
    const activeAcc = await getAccountByClientId(creds.clientId)
    const taxSystem = activeAcc?.taxSystem ?? 'usn6'

    // ── Цена из ЛК и комиссия ────────────────────────────────────────────────
    const priceData = await ozonCall<any>('/v5/product/info/prices', { filter: { offer_id: [offerId] }, cursor: '', limit: 10 }, creds.clientId).catch(() => null)
    const pi = (priceData?.items??[])[0]
    const priceInLK       = Number(pi?.price?.price) || 0  // цена в ЛК (17 000)
    const commissionPct   = getCommissionPct(pi?.commissions)
    const commissionRub   = Math.round(priceInLK * commissionPct / 100)

    // ── Транзакции за 90 дней (апрель + май + июнь) ──────────────────────────
    const txnTo   = new Date().toISOString()
    const txnFrom = new Date(Date.now() - 90 * 86_400_000).toISOString()

    let deliveryOps: any[]   = []
    let acquiringOps: any[]  = []
    let returnOps: any[]     = []
    let cancelOps: any[]     = []
    let storageFromTxns      = 0

    if (sku) {
      try {
        const allOps = await fetchTxnsChunked(txnFrom, txnTo, creds.clientId)
        const myOps  = allOps.filter((op: any) => op.items?.some((it: any) => Number(it.sku) === sku))

        deliveryOps  = myOps.filter((op: any) => op.operation_type === 'OperationAgentDeliveredToCustomer')
        acquiringOps = myOps.filter((op: any) => op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation')

        for (const op of myOps.filter((op: any) => op.operation_type === 'OperationItemReturn')) {
          const svcs: string[] = (op.services ?? []).map((s: any) => s.name)
          if (svcs.includes('MarketplaceServiceItemReturnAfterDelivToCustomer')) returnOps.push(op)
          else cancelOps.push(op)
        }

        // Хранение из services
        for (const op of myOps) {
          for (const s of op.services ?? []) {
            if (STORAGE_SERVICES.has(s.name)) storageFromTxns += Math.abs(Number(s.price) || 0)
          }
        }
      } catch (e: any) { console.warn('[analytics] txn fetch:', e.message) }
    }

    // ── Расчёт по транзакциям доставки ──────────────────────────────────────
    const deliveryCount = deliveryOps.length

    // Средняя выплата от Ozon на единицу (amount = цена − комиссия − логистика)
    const totalPayout = deliveryOps.reduce((s, op) => s + Number(op.amount || 0), 0)
    const payoutPerUnit = deliveryCount > 0 ? Math.round(totalPayout / deliveryCount) : null

    // Средняя логистика на единицу (из services каждой доставки)
    const totalLogistics = deliveryOps.reduce((s, op) => {
      const logSvcs = (op.services ?? []).filter((sv: any) => LOGISTICS_SERVICES.has(sv.name))
      return s + logSvcs.reduce((ls: number, sv: any) => ls + Math.abs(Number(sv.price) || 0), 0)
    }, 0)
    const avgLogistics = deliveryCount > 0 ? Math.round(totalLogistics / deliveryCount) : null

    // Восстанавливаем среднюю цену покупателя: amount + логистика = цена − комиссия
    // → цена_покупателя = (amount + логистика) / (1 − commission%)
    // Используем для налога
    let avgBuyerPrice: number | null = null
    if (deliveryCount > 0 && commissionPct > 0) {
      const avgNet = totalPayout / deliveryCount
      const avgLog = totalLogistics / deliveryCount
      avgBuyerPrice = Math.round((avgNet + avgLog) / (1 - commissionPct / 100))
    }

    // Эквайринг — реальный из транзакций на единицу
    const totalAcquiring = acquiringOps.reduce((s, op) => s + Math.abs(Number(op.amount || 0)), 0)
    const acquiringPerUnit = deliveryCount > 0 ? Math.round(totalAcquiring / deliveryCount * 10) / 10 : 0

    // Возвраты и отмены
    const trueReturnCount = returnOps.length
    const cancelCount     = cancelOps.length
    const trueReturnAmount = returnOps.reduce((s, op) => s + Math.abs(Number(op.amount || 0)), 0)
    const cancelAmount     = cancelOps.reduce((s, op) => s + Math.abs(Number(op.amount || 0)), 0)

    const totalForRate  = deliveryCount + trueReturnCount
    const realReturnRate = totalForRate > 0 ? Math.round(trueReturnCount / totalForRate * 1000) / 10 : null
    const cancelRate     = (deliveryCount + cancelCount) > 0 ? Math.round(cancelCount / (deliveryCount + cancelCount) * 1000) / 10 : null

    const returnLogPerUnit    = deliveryCount > 0 ? Math.round(trueReturnAmount / deliveryCount * 10) / 10 : 0
    const clientRet           = { amount: 0 }  // ClientReturnAgentOperation — отдельно если нужно
    const clientRefundPerUnit = 0
    const cancelLogPerUnit    = deliveryCount > 0 ? Math.round(cancelAmount / deliveryCount * 10) / 10 : 0

    // Fallback на реализацию если нет транзакций
    // Реализация даёт точное число продаж по месяцам и цену покупателя
    const statsMap = await aggregateRealization(allMonths.slice(0, 3), creds.clientId)
    const stats = statsMap.get(offerId)
    const realizDeliveries = stats ? Math.max(0, stats.deliveryCount - stats.returnCount) : 0
    const realizNetPayout  = stats ? Math.max(0, stats.deliveryAmount - stats.returnAmount) : 0
    // Средняя цена покупателя из реализации (seller_price_per_instance)
    const avgBuyerPriceFromRealiz = stats && stats.deliveryCount > 0
      ? Math.round(stats.buyerPriceTotal / stats.deliveryCount)
      : null

    const effectiveDeliveryCount = deliveryCount || realizDeliveries
    const effectivePayoutPerUnit = payoutPerUnit ?? (realizDeliveries > 0 ? Math.round(realizNetPayout / realizDeliveries) : null)

    // "Получено от Ozon" = выплата − эквайринг − возвратная логистика − рефанды − отмены
    const netFromOzon = effectivePayoutPerUnit != null
      ? Math.round(effectivePayoutPerUnit - acquiringPerUnit - returnLogPerUnit - clientRefundPerUnit - cancelLogPerUnit)
      : null

    // ── Хранение ─────────────────────────────────────────────────────────────
    const storageTotal   = storageFromTxns > 0 ? Math.round(storageFromTxns) : 0
    const monthlySales   = effectiveDeliveryCount > 0 ? effectiveDeliveryCount / 3 : 1  // делим на 3 месяца
    const storagePerUnit = storageTotal > 0 ? Math.round(storageTotal / monthlySales * 10) / 10 : 0

    // ── Остатки ──────────────────────────────────────────────────────────────
    let fboAvailable = 0, fboTransit = 0, turnoverGrade: string | null = null, adsDaily: number | null = null, estimatedVolumeLiters: number | null = null
    try {
      const infos = await ozonCall<any>('/v3/product/info/list', { offer_id: [offerId] }, creds.clientId)
      const info = (infos?.items??[])[0]
      if (info?.volume_weight) estimatedVolumeLiters = Math.round(Number(info.volume_weight) * 5 * 10) / 10
    } catch {}
    if (sku) {
      try {
        const ad = await ozonCall<any>('/v1/analytics/stocks', { skus: [sku], limit: 100, offset: 0 }, creds.clientId)
        const items: any[] = ad?.items ?? []
        fboAvailable  = items.reduce((s, w) => s + (w.available_stock_count ?? 0), 0)
        fboTransit    = items.reduce((s, w) => s + (w.transit_stock_count ?? 0), 0)
        turnoverGrade = items[0]?.turnover_grade ?? null
        adsDaily      = items[0]?.ads != null ? Math.round(items[0].ads * 10) / 10 : null
      } catch {}
    }

    // ── Себестоимость ────────────────────────────────────────────────────────
    const costsObj = await getAllCosts() as Record<string, number>
    const cost = costsObj[offerId] ?? 0

    // ── Налог — от фактической цены покупателя из реализации ─────────────────
    // seller_price_per_instance = цена по которой клиент купил (с учётом скидок)
    const taxPrice = avgBuyerPriceFromRealiz ?? avgBuyerPrice ?? priceInLK
    const taxBreakdown = taxPrice > 0 && netFromOzon != null
      ? calcTax({ taxSystem, payout: netFromOzon, cost, price: taxPrice, commissionRub: Math.round(taxPrice * commissionPct / 100) })
      : null

    // ── Реклама — ДРР считаем от числа выкупов из транзакций ────────────────
    let advPerUnit: number | null = null, advTotal: number | null = null
    try {
      const spendMap = await getPerfSpendByOffer(creds.clientId)
      if (spendMap) {
        const skuStr = sku ? String(sku) : null
        const spent = spendMap.get(offerId) ?? (skuStr ? spendMap.get(skuStr) : undefined)
        console.log('[perf lookup] offerId:', offerId, 'found:', spent != null, 'mapSize:', spendMap.size)
        if (spent != null && spent > 0) {
          advTotal = Math.round(spent * 100) / 100
          // Делим на число выкупов из транзакций за тот же период (60 дней)
          // — это самые точные данные, совпадают с периодом Performance API
          const salesForAdv = effectiveDeliveryCount
          if (salesForAdv > 0) advPerUnit = Math.round(advTotal / salesForAdv * 10) / 10
          console.log('[perf] offerId:', offerId, 'advTotal:', advTotal, 'salesForAdv:', salesForAdv, 'advPerUnit:', advPerUnit)
        }
      }
    } catch {}

    const cacheEntry = perfCache.get(creds.clientId)
    const advLoadingFlag = advTotal === null && creds.perfApiKey != null && (cacheEntry?.loading ?? true)

    res.json({
      offerId, sku,
      closedMonthsCount: closedMonths.length,
      // Основные метрики
      deliveryCount: effectiveDeliveryCount,
      realizDeliveries,
      realizNetPayout,
      // Цены
      priceInLK,
      avgBuyerPrice: avgBuyerPriceFromRealiz ?? avgBuyerPrice,
      commissionPct,
      commissionRub,
      // Расходы по единице
      payoutPerUnit: effectivePayoutPerUnit,
      avgLogistics,
      acquiringPerUnit,
      returnLogPerUnit,
      clientRefundPerUnit,
      cancelLogPerUnit,
      netFromOzon,
      // Возвраты
      trueReturnCount, cancelCount, realReturnRate, cancelRate,
      // Прочее
      estimatedVolumeLiters, fboAvailable, fboTransit, turnoverGrade, adsDaily,
      storagePerUnit, storageTotal,
      storageSource: storageFromTxns > 0 ? 'transactions' : 'none',
      // Налог
      taxSystem, taxBreakdown, taxPrice,
      // Реклама
      advPerUnit, advTotal,
      advLoading: advLoadingFlag,
    })
  } catch (e: unknown) { const err = safeError(e, '/api/analytics/:offerId'); res.status(err.status).json({ error: err.message }) }
})

// ── Дебаг (только в development) ─────────────────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production'

app.get('/api/debug/realization/:year/:month', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const raw = await fetchRealizCached(Number(req.params.year), Number(req.params.month), res.locals.clientId)
    res.json({ rowsCount: raw.length, sample: raw.slice(0,3), parsed: raw.slice(0,3).map(parseRealizRow) })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/realization/:year/:month'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/months', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try { const { all, closed, current } = await getMonths(12, res.locals.clientId); res.json({ all, closed, current }) }
  catch (e: unknown) { const err = safeError(e, 'debug months'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/transactions', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const to = new Date().toISOString(), from = new Date(Date.now()-7*86400000).toISOString()
    const ops = await fetchTxnsOneMonth(from, to, res.locals.clientId)
    res.json({ total: ops.length, sample: ops.filter((o:any)=>o.services?.length>0).slice(0,3) })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/transactions'); res.status(err.status).json({ error: err.message }) }
})

// Проверка структуры поля posting (delivery_schema, warehouse_id) в реальном ответе
// Ozon — перед тем как строить детектор переплаты по логистике на этих полях,
// нужно подтвердить что они реально приходят и в каком формате.
app.get('/api/debug/posting-fields', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const to = new Date().toISOString(), from = new Date(Date.now() - 30*86400000).toISOString()
    const ops = await fetchTxnsOneMonth(from, to, res.locals.clientId)
    const deliveryOps = ops.filter((o: any) => o.operation_type === 'OperationAgentDeliveredToCustomer')
    res.json({
      totalOps: ops.length,
      deliveryOpsCount: deliveryOps.length,
      hasPostingField: deliveryOps.filter((o: any) => o.posting != null).length,
      hasDeliverySchema: deliveryOps.filter((o: any) => o.posting?.delivery_schema != null).length,
      hasWarehouseId: deliveryOps.filter((o: any) => o.posting?.warehouse_id != null).length,
      hasSaleCommission: deliveryOps.filter((o: any) => o.sale_commission != null).length,
      hasDeliveryCharge: deliveryOps.filter((o: any) => o.delivery_charge != null).length,
      // Полные сырые объекты первых 3 операций доставки — посмотреть реальные ключи и значения
      sample: deliveryOps.slice(0, 3),
    })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/posting-fields'); res.status(err.status).json({ error: err.message }) }
})

// Полный подсчёт продаж по артикулу из всех источников
app.get('/api/debug/sales-count/:offerId', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const { offerId } = req.params
    const { all: allMonths } = await getMonths(6, res.locals.clientId)
    const sku = await getSkuForOffer(offerId, allMonths, res.locals.clientId)

    // 1. Реализация по всем доступным месяцам
    const realizByMonth: any[] = []
    for (const { year, month, isCurrent } of allMonths) {
      try {
        const rows = await fetchRealizCached(year, month, res.locals.clientId)
        const row = rows.find((r: any) => {
          const oid = r.item?.offer_id ?? r.offer_id ?? r.article ?? r.vendor_code
          return oid === offerId
        })
        if (row) realizByMonth.push({
          period: `${year}-${String(month).padStart(2,'0')}`,
          isCurrent,
          delivery_count: row.delivery_count ?? row.delivered_count ?? row.qty ?? 0,
          delivery_amount: row.delivery_amount ?? row.delivered_amount ?? 0,
          return_count: row.return_count ?? row.returns_count ?? 0,
          raw_keys: Object.keys(row),
          raw_item: row.item,
          // Показываем все поля строки целиком
          full_row: row,
        })
      } catch {}
    }

    // 2. Транзакции за разные периоды
    const periods = [
      { label: '30 дней', from: new Date(Date.now() - 30*86400000).toISOString(), to: new Date().toISOString() },
      { label: '60 дней', from: new Date(Date.now() - 60*86400000).toISOString(), to: new Date().toISOString() },
      { label: '90 дней', from: new Date(Date.now() - 90*86400000).toISOString(), to: new Date().toISOString() },
    ]
    const txnCounts: any[] = []
    for (const p of periods) {
      try {
        const ops = await fetchTxnsChunked(p.from, p.to, res.locals.clientId)
        const myOps = ops.filter((op: any) => op.items?.some((it: any) => Number(it.sku) === sku))
        const delivered = myOps.filter((op: any) => op.operation_type === 'OperationAgentDeliveredToCustomer')
        txnCounts.push({
          period: p.label,
          totalOps: myOps.length,
          delivered: delivered.length,
          operationTypes: [...new Set(myOps.map((op: any) => op.operation_type))],
        })
      } catch (e: any) { txnCounts.push({ period: p.label, error: e.message }) }
    }

    res.json({ offerId, sku, realizByMonth, txnCounts })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/sales-count'); res.status(err.status).json({ error: err.message }) }
})
app.get('/api/debug/txn-offer/:offerId', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const { offerId } = req.params
    const { all: allMonths } = await getMonths(3, res.locals.clientId)
    const sku = await getSkuForOffer(offerId, allMonths, res.locals.clientId)
    if (!sku) return res.json({ error: 'SKU не найден', offerId })

    // Берём последние 60 дней
    const to = new Date().toISOString()
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const ops = await fetchTxnsChunked(from, to, res.locals.clientId)

    const myOps = ops.filter((op: any) => op.items?.some((it: any) => Number(it.sku) === sku))
    const deliveries = myOps.filter((op: any) => op.operation_type === 'OperationAgentDeliveredToCustomer')
    const acq        = myOps.filter((op: any) => op.operation_type === 'MarketplaceRedistributionOfAcquiringOperation')

    res.json({
      offerId, sku,
      period: { from, to },
      deliveriesCount: deliveries.length,
      // Первые 3 доставки — полная структура чтобы увидеть items[].price
      deliveriesSample: deliveries.slice(0, 3).map((op: any) => ({
        operation_type: op.operation_type,
        amount: op.amount,
        items: op.items,
        services: op.services,
      })),
      acquiringSample: acq.slice(0, 2).map((op: any) => ({
        operation_type: op.operation_type,
        amount: op.amount,
        items: op.items,
        services: op.services,
      })),
    })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/txn-offer'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/perf-token', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const auth = await getPerfToken(res.locals.clientId)
    if (!auth) return res.json({ ok: false, error: 'Не удалось получить токен' })
    res.json({ ok: true, clientId: auth.clientId.slice(0,30)+'...', tokenLength: auth.token.length })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/perf-token'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/perf-campaigns', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const creds = await resolveCreds(res.locals.clientId)
    // Сначала проверяем токен
    try { await getPerfToken(creds.clientId); } catch (e: any) { return res.json({ error: 'Токен Performance API: ' + e.message }) }
    // Все кампании без фильтра по типу
    const all = await perfGet<any>('/api/client/campaign', {}, creds.clientId)
    res.json({
      total: (all?.list ?? []).length,
      campaigns: (all?.list ?? []).map((c: any) => ({
        id: c.id, title: c.title, state: c.state,
        advObjectType: c.advObjectType,
        fromDate: c.fromDate, toDate: c.toDate,
      })),
    })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/perf-campaigns'); res.status(err.status).json({ error: err.message }) }
})

app.get('/api/debug/reset-adv-cache', async (_req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  const creds = await resolveCreds().catch(() => null)
  if (creds) _advPerUnitCache.delete(creds.clientId)
  res.json({ ok: true, message: 'advPerUnit cache cleared, will recalculate on next request' })
})

app.get('/api/debug/perf-cache', async (_req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const creds = await resolveCreds()
    const cached = perfCache.get(creds.clientId)
    const data = cached?.data ? Object.fromEntries(cached.data) : {}
    // Также покажем advPerUnit кэш
    const advCached = _advPerUnitCache.get(creds.clientId)
    const advData = advCached?.map ? Object.fromEntries(advCached.map) : {}
    res.json({
      cacheKey: creds.clientId,
      perfCacheEntries: cached?.data?.size ?? 0,
      perfCacheData: data,  // offer_id → spend
      advCacheEntries: advCached?.map?.size ?? 0,
      advCacheData: advData,  // offer_id → advPerUnit
      updatedAt: cached?.updatedAt ? new Date(cached.updatedAt).toISOString() : null,
      loading: cached?.loading ?? false,
    })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/perf-cache'); res.status(err.status).json({ error: err.message }) }
})

// DEBUG: разведка структуры FBO постингов — смотрим что реально приходит
// в financial_data, analytics_data, warehouse_id и прочих полях
// перед тем как писать production-логику расчёта юнит-экономики заказа.
app.get('/api/debug/postings-raw', async (req, res) => {
  if (!isDev) return res.status(404).json({ error: 'Not found' })
  try {
    const creds = await resolveCreds()
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const fbo = await ozonCall<any>('/v2/posting/fbo/list', {
      filter: { since, to: new Date().toISOString(), status: 'awaiting_deliver' },
      with: { analytics_data: true, financial_data: true, translit: false },
      dir: 'desc', offset: 0, limit: 3,
    }, creds.clientId)
    const fboDelivering = await ozonCall<any>('/v2/posting/fbo/list', {
      filter: { since, to: new Date().toISOString(), status: 'delivering' },
      with: { analytics_data: true, financial_data: true, translit: false },
      dir: 'desc', offset: 0, limit: 3,
    }, creds.clientId)
    const fboPackaging = await ozonCall<any>('/v2/posting/fbo/list', {
      filter: { since, to: new Date().toISOString(), status: 'awaiting_packaging' },
      with: { analytics_data: true, financial_data: true, translit: false },
      dir: 'desc', offset: 0, limit: 3,
    }, creds.clientId)
    // Список складов — для маппинга warehouse_id → кластер
    const warehouses = await ozonCall<any>('/v1/warehouse/list', {}, creds.clientId).catch(() => null)
    res.json({
      fbo_awaiting_deliver: fbo?.result ?? fbo,
      fbo_delivering: fboDelivering?.result ?? fboDelivering,
      fbo_awaiting_packaging: fboPackaging?.result ?? fboPackaging,
      warehouses: warehouses?.result ?? warehouses,
    })
  } catch (e: unknown) { const err = safeError(e, '/api/debug/postings-raw'); res.status(err.status).json({ error: err.message }) }
})

app.listen(config.port, () => {
  console.log(`Pomogator backend → http://localhost:${config.port}`)

  // 1. Загружаем кэш с диска — мгновенно, без API запросов.
  loadPerfCacheFromDisk()

  // 2. Прогреваем кэш только для АКТИВНОГО аккаунта (тот что сейчас выбран).
  //    Остальные аккаунты в БД грузятся лениво при первом реальном запросе.
  //    Это баланс между скоростью (не ждём 10 мин при открытии) и нагрузкой
  //    (не тратим Ozon API лимиты на неактивных пользователей).
  setTimeout(async () => {
    try {
      const active = await getActiveAccount()
      if (!active?.perfApiKey) return
      const cached = perfCache.get(active.clientId)
      const age = cached ? Date.now() - cached.updatedAt : Infinity
      if (age < PERF_CACHE_TTL) {
        console.log('[perf cache]', active.clientId, 'fresh (' + Math.round(age / 60_000) + 'min), skipping')
        return
      }
      console.log('[perf cache] warming up active account:', active.clientId)
      loadPerfStats(active.clientId).catch(e => console.warn('[perf cache] startup warmup failed:', e.message))
    } catch (e: any) {
      console.warn('[perf cache] startup warmup query failed:', e.message)
    }
  }, 30_000)

  // 3. Периодическое обновление — только активные аккаунты с устаревшим кэшем,
  //    только если пользователь был активен последние 20 минут.
  setInterval(async () => {
    if (!isUserActive()) return
    for (const [clientId, entry] of perfCache) {
      if (entry.loading) continue
      if (Date.now() - entry.updatedAt >= PERF_CACHE_TTL) {
        loadPerfStats(clientId).catch(e => console.warn('[perf cache] refresh failed for', clientId, ':', e.message))
      }
    }
  }, PERF_REFRESH_INTERVAL)

  // 4. Синхронизация цен — каждые 30 минут для всех аккаунтов.
  //    Нужна для актуальной налоговой базы (цена покупателя, соинвест Ozon).
  //    Первый запуск — через 30 секунд после старта.
  const PRICE_SYNC_INTERVAL = 30 * 60 * 1000  // 30 минут
  // Сбрасываем advPerUnit кэш при старте — чтобы reverse SKU lookup сработал
  // сразу, а не ждал истечения старого TTL.
  _advPerUnitCache.clear()
  console.log('[adv cache] cleared on startup — will recalculate with updated SKU mapping')
  setTimeout(async () => {
    const accs = await getAllAccounts().catch(() => [])
    console.log(`[price sync] initial sync for ${accs.length} account(s)...`)
    for (const acc of accs) {
      syncPricesForAccount(acc.clientId).catch(e => console.warn('[price sync] initial failed:', e.message))
    }
  }, 30_000)
  setInterval(async () => {
    if (!isUserActive()) return  // не тратим API-лимиты при неактивности
    const accs = await getAllAccounts().catch(() => [])
    for (const acc of accs) {
      syncPricesForAccount(acc.clientId).catch(e => console.warn('[price sync] interval failed:', e.message))
    }
  }, PRICE_SYNC_INTERVAL)

  // 5. Синхронизация литража — раз в сутки для ВСЕХ аккаунтов.
  setTimeout(async () => {
    try {
      const accs = await getAllAccounts()
      console.log(`[volume sync] daily sync for ${accs.length} account(s)...`)
      for (const acc of accs) {
        syncVolumesForAccount(acc.clientId).catch(e => console.warn('[volume sync] daily failed for', acc.clientId, ':', e.message))
      }
    } catch (e: any) {
      console.warn('[volume sync] daily query failed:', e.message)
    }
  }, 60_000)
  setInterval(async () => {
    try {
      const accs = await getAllAccounts()
      for (const acc of accs) {
        syncVolumesForAccount(acc.clientId).catch(e => console.warn('[volume sync] daily failed for', acc.clientId, ':', e.message))
      }
    } catch (e: any) {
      console.warn('[volume sync] daily query failed:', e.message)
    }
  }, 24 * 60 * 60 * 1000)
})
