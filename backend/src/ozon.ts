import { getActiveAccount, getAccountByClientId } from './db.js'
import { config } from './config.js'

// ══════════════════════════════════════════════════════════════════════════════
// ── RATE LIMITER ──────────────────────────────────────────────────────────────
// Ozon Seller API: не более 1 запроса в секунду на метод (рекомендуется)
// Performance API: не более 1 одновременного запроса
//
// ВАЖНО: лимиты у Ozon выдаются НА КАЖДЫЙ Client-ID отдельно — у продавца А
// есть свой лимит, у продавца Б свой, они не делят его друг с другом. Раньше
// здесь были две ГЛОБАЛЬНЫЕ константы (sellerLimiter/perfLimiter) — одна
// очередь на весь процесс для абсолютно всех аккаунтов сразу. При нескольких
// активных пользователях это создавало искусственное узкое горлышко: продавец Б
// ждал в очереди слот, который физически принадлежит лимиту продавца А и никем
// не используется. При росте числа аккаунтов (проектируем на 1000+) это
// становится центральной причиной зависаний и медленных ответов.
//
// Решение — реестр лимитеров по clientId: каждый аккаунт получает свой
// собственный RateLimiter, создаваемый лениво при первом обращении. Внутри
// одного clientId параллелизм всё равно ограничен (защита от 429 по конкретному
// ключу), но разные аккаунты больше не блокируют друг друга.
// ══════════════════════════════════════════════════════════════════════════════

class RateLimiter {
  private queue: Array<() => void> = []
  private running = 0
  private readonly maxConcurrent: number
  private readonly minDelayMs: number
  private lastCallAt = 0

  constructor(maxConcurrent = 1, minDelayMs = 200) {
    this.maxConcurrent = maxConcurrent
    this.minDelayMs = minDelayMs
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => {
      if (this.running < this.maxConcurrent) {
        this.running++
        resolve()
      } else {
        this.queue.push(() => { this.running++; resolve() })
      }
    })

    // Минимальная пауза между запросами
    const now = Date.now()
    const elapsed = now - this.lastCallAt
    if (elapsed < this.minDelayMs) await new Promise(r => setTimeout(r, this.minDelayMs - elapsed))
    this.lastCallAt = Date.now()

    try {
      return await fn()
    } finally {
      this.running--
      if (this.queue.length > 0) this.queue.shift()!()
    }
  }
}

// Реестр лимитеров по ключу (clientId для Seller API, perfClientId для Performance API).
// Лимитеры создаются лениво и живут пока живёт процесс — это нормально, т.к.
// RateLimiter не хранит тяжёлых данных, только счётчики и очередь функций.
// При желании можно добавить вытеснение неактивных ключей по TTL, но при
// разумном числе одновременно активных аккаунтов (даже сотни) это не нужно —
// памяти на пустую очередь уходит исчезающе мало.
class RateLimiterRegistry {
  private limiters = new Map<string, RateLimiter>()
  constructor(private maxConcurrent: number, private minDelayMs: number) {}

  get(key: string): RateLimiter {
    let limiter = this.limiters.get(key)
    if (!limiter) {
      limiter = new RateLimiter(this.maxConcurrent, this.minDelayMs)
      this.limiters.set(key, limiter)
    }
    return limiter
  }

  get size() { return this.limiters.size }
}

// Seller API: до 5 параллельных, пауза 200мс на каждый clientId отдельно
const sellerLimiters = new RateLimiterRegistry(5, 200)
// Performance API: строго 1 одновременный запрос на каждый perfClientId отдельно
const perfLimiters = new RateLimiterRegistry(1, 500)

// ══════════════════════════════════════════════════════════════════════════════
// ── SELLER API CLIENT ─────────────────────────────────────────────────────────
//
// ВАЖНО (многопользовательская модель, 1000+ аккаунтов): раньше тут был
// ГЛОБАЛЬНЫЙ кэш "активного" аккаунта (_activeCredsCache), читавший is_active
// из БД — поле, общее на всю таблицу, переключаемое middleware при каждом
// запросе с другим X-Seller-Id. Это создавало настоящую гонку: запрос
// пользователя А мог получить creds пользователя Б, если между переключением
// is_active и фактическим использованием creds успевал проскочить параллельный
// запрос другого пользователя. Это не баг производительности — это утечка
// API-ключей между аккаунтами.
//
// Новая модель: clientId передаётся ЯВНО в каждый вызов (server.ts получает его
// из X-Seller-Id конкретного HTTP-запроса и передаёт по цепочке). Никакого
// глобального "переключения" в БД больше нет — getAccountByClientId всего лишь
// читает нужную строку, не трогая чужие. Если clientId не передан (старые
// запросы без cookie sc_company_id, или локальная разработка) — используется
// getActiveAccount()/config.ozon.* как и раньше, это сохраняет работоспособность
// для одиночного режима, но НЕ участвует в гонке между разными аккаунтами.
// ══════════════════════════════════════════════════════════════════════════════

export interface Creds { clientId: string; apiKey: string; perfApiKey?: string | null }

export async function resolveCreds(clientId?: string): Promise<Creds> {
  if (clientId) {
    const acc = await getAccountByClientId(clientId)
    if (acc) return { clientId: acc.clientId, apiKey: acc.apiKey, perfApiKey: acc.perfApiKey }
    // Запрошен конкретный clientId, но в БД его нет — НЕ подставляем чужие/дефолтные
    // креды молча, иначе можно случайно постучаться к Ozon под чужим именем.
    throw new Error(`Аккаунт ${clientId} не найден. Привяжите API-ключи в виджете.`)
  }
  // Без явного clientId — старое поведение для legacy-запросов и разработки
  const acc = await getActiveAccount()
  if (acc) return { clientId: acc.clientId, apiKey: acc.apiKey, perfApiKey: acc.perfApiKey }
  return { clientId: config.ozon.clientId, apiKey: config.ozon.apiKey }
}

export async function ozonCall<T>(path: string, body: unknown, clientId?: string): Promise<T> {
  const creds = await resolveCreds(clientId)
  if (!creds.clientId || !creds.apiKey) throw new Error('Нет привязанного аккаунта Ozon. Привяжите API-ключи в виджете.')
  // Лимитер выбирается ПО clientId — у каждого продавца свой собственный лимит
  // у Ozon, и его запросы не должны стоять в очереди за чужими аккаунтами.
  const limiter = sellerLimiters.get(creds.clientId)
  return limiter.run(async () => {
    // Явный таймаут — без него зависший fetch может не вернуться вообще (или
    // вернуться только через 30-300с дефолта undici), и при последовательном
    // переборе чанков транзакций (fetchTxnsChunked) один такой запрос блокирует
    // весь оставшийся цикл, что выглядит как "виджет повис".
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 25_000)
    try {
      const res = await fetch(config.ozon.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Client-Id': creds.clientId, 'Api-Key': creds.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Ozon ${path} → ${res.status}: ${text}`)
      }
      return res.json() as Promise<T>
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`Ozon ${path} → таймаут 25с`)
      throw e
    } finally {
      clearTimeout(timeoutId)
    }
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// ── PERFORMANCE API CLIENT ────────────────────────────────────────════════════
// ══════════════════════════════════════════════════════════════════════════════

// Кэш токенов Performance API — теперь ключ Map, а не одна переменная, т.к.
// у каждого perfClientId свой токен и они не должны вытеснять друг друга.
const _perfTokenCache = new Map<string, { token: string; expiresAt: number }>()

// Точечная инвалидация токена конкретного perfClientId — нужна, когда продавец
// обновляет свои Performance API ключи в виджете (старый токен от старых
// ключей больше не годится). В новой модели нет глобального кэша creds,
// который нужно было бы сбрасывать целиком — только этот точечный токен-кэш.
export function invalidatePerfToken(perfClientId: string) {
  _perfTokenCache.delete(perfClientId)
}

export async function getPerfToken(clientId?: string): Promise<{ token: string; clientId: string } | null> {
  const creds = await resolveCreds(clientId)
  if (!creds.perfApiKey) return null
  const parts = creds.perfApiKey.split('::')
  if (parts.length !== 2) return null
  const [perfClientId, perfClientSecret] = parts
  const cached = _perfTokenCache.get(perfClientId)
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return { token: cached.token, clientId: perfClientId }
  }
  const limiter = perfLimiters.get(perfClientId)
  return limiter.run(async () => {
    // Проверяем ещё раз после ожидания в очереди — другой запрос того же
    // аккаунта мог успеть обновить токен, пока мы стояли в очереди этого лимитера.
    const cachedAfterWait = _perfTokenCache.get(perfClientId)
    if (cachedAfterWait && Date.now() < cachedAfterWait.expiresAt - 60_000) {
      return { token: cachedAfterWait.token, clientId: perfClientId }
    }
    const params = new URLSearchParams()
    params.append('client_id', perfClientId)
    params.append('client_secret', perfClientSecret)
    params.append('grant_type', 'client_credentials')
    const res = await fetch('https://api-performance.ozon.ru/api/client/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(), redirect: 'follow',
    })
    const data = await res.json()
    if (!res.ok || !data?.access_token) { console.warn('[perf] token error:', JSON.stringify(data)); return null }
    _perfTokenCache.set(perfClientId, { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 })
    return { token: data.access_token, clientId: perfClientId }
  })
}

export async function perfGet<T>(path: string, params?: Record<string, string>, clientId?: string): Promise<T> {
  const auth = await getPerfToken(clientId)
  if (!auth) throw new Error('Нет Performance API ключей или не удалось получить токен')
  const limiter = perfLimiters.get(auth.clientId)
  return limiter.run(async () => {
    const url = 'https://api-performance.ozon.ru' + path + (params ? '?' + new URLSearchParams(params).toString() : '')
    const res = await fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId } })
    if (!res.ok) { const text = await res.text(); throw new Error('Perf GET ' + path + ' → ' + res.status + ': ' + text) }
    return res.json() as Promise<T>
  })
}

export async function perfPost<T>(path: string, body: unknown, clientId?: string): Promise<T> {
  const auth = await getPerfToken(clientId)
  if (!auth) throw new Error('Нет Performance API ключей или не удалось получить токен')
  const limiter = perfLimiters.get(auth.clientId)
  return limiter.run(async () => {
    const res = await fetch('https://api-performance.ozon.ru' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId },
      body: JSON.stringify(body),
    })
    if (!res.ok) { const text = await res.text(); throw new Error('Perf POST ' + path + ' → ' + res.status + ': ' + text) }
    return res.json() as Promise<T>
  })
}

// perfGet БЕЗ rate limiter — для polling статуса отчёта
// (не создаёт новый запрос к API, просто проверяет статус)
export async function perfPoll<T>(path: string, clientId?: string): Promise<T> {
  const auth = await getPerfToken(clientId)
  if (!auth) throw new Error('Нет токена')
  const url = 'https://api-performance.ozon.ru' + path
  const res = await fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId } })
  if (!res.ok) { const text = await res.text(); throw new Error('Perf POLL ' + path + ' → ' + res.status + ': ' + text) }
  return res.json() as Promise<T>
}

export async function perfDownload(url: string, clientId?: string): Promise<Buffer> {
  const auth = await getPerfToken(clientId)
  if (!auth) throw new Error('Нет токена')
  const fullUrl = url.startsWith('http') ? url : 'https://api-performance.ozon.ru' + (url.startsWith('/') ? '' : '/') + url
  const res = await fetch(fullUrl, { headers: { 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId } })
  if (!res.ok) throw new Error('Download ' + res.status)
  return Buffer.from(await res.arrayBuffer())
}

// ══════════════════════════════════════════════════════════════════════════════
// ── ТРАНЗАКЦИИ С РАЗБИВКОЙ ПО МЕСЯЦАМ ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

export async function fetchTxnsOneMonth(from: string, to: string, clientId?: string): Promise<any[]> {
  const all: any[] = []
  let page = 1
  for (let i = 0; i < 50; i++) {
    const d = await ozonCall<any>('/v3/finance/transaction/list', {
      filter: { date: { from, to }, transaction_type: 'all' }, page, page_size: 1000,
    }, clientId)
    all.push(...(d?.result?.operations ?? []))
    if (page >= Number(d?.result?.page_count ?? 1)) break
    page++
  }
  return all
}

export async function fetchTxnsChunked(from: string, to: string, clientId?: string): Promise<any[]> {
  const fromD = new Date(from), toD = new Date(to)
  const chunks: { from: string; to: string }[] = []

  // Разбиваем строго по UTC-месяцам, а не по локальному часовому поясу сервера —
  // иначе для серверов в UTC+N граница месяца сдвигается на N часов и может
  // задеть лишний день соседнего месяца или обрезать последний день текущего
  // (баг "too long period" — был найден и исправлен в server.ts, перенесён сюда).
  let cur = new Date(Date.UTC(fromD.getUTCFullYear(), fromD.getUTCMonth(), 1))
  while (cur <= toD) {
    const chunkEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1) - 1)
    const chunkFrom = cur < fromD ? fromD : cur
    const chunkTo   = chunkEnd > toD ? toD : chunkEnd
    chunks.push({ from: chunkFrom.toISOString(), to: chunkTo.toISOString() })
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1))
  }

  console.log('[txns chunked]', clientId ?? '(default)', 'period:', from, '→', to, 'chunks:', chunks.length, chunks.map(c => c.from.slice(0,10) + '→' + c.to.slice(0,10)))

  const all: any[] = []
  for (const chunk of chunks) {
    try { all.push(...await fetchTxnsOneMonth(chunk.from, chunk.to, clientId)) }
    catch (e: any) { console.warn('[txns chunk]', chunk.from, e.message) }
  }
  return all
}
