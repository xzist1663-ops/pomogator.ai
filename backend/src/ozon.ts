import { getActiveAccount } from './db.js'
import { config } from './config.js'

// ══════════════════════════════════════════════════════════════════════════════
// ── RATE LIMITER ──────────────────────────────────────────────────────────────
// Ozon Seller API: не более 1 запроса в секунду на метод (рекомендуется)
// Performance API: не более 1 одновременного запроса
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

// Seller API: до 5 параллельных, пауза 200мс (≈5 req/sec — безопасно)
const sellerLimiter = new RateLimiter(5, 200)
// Performance API: строго 1 одновременный
const perfLimiter = new RateLimiter(1, 500)

// ══════════════════════════════════════════════════════════════════════════════
// ── SELLER API CLIENT ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

let _activeCredsCache: { clientId: string; apiKey: string; perfApiKey?: string | null } | null = null
let _credsCacheTs = 0

export async function getActiveCreds(): Promise<{ clientId: string; apiKey: string; perfApiKey?: string | null }> {
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

export function invalidateCredsCache() {
  _activeCredsCache = null
  _perfTokenCache = null
}

export async function ozonCall<T>(path: string, body: unknown): Promise<T> {
  return sellerLimiter.run(async () => {
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
  })
}

// ══════════════════════════════════════════════════════════════════════════════
// ── PERFORMANCE API CLIENT ────────────────────────────────────────════════════
// ══════════════════════════════════════════════════════════════════════════════

let _perfTokenCache: { token: string; clientId: string; expiresAt: number } | null = null

export async function getPerfToken(): Promise<{ token: string; clientId: string } | null> {
  const creds = await getActiveCreds()
  if (!creds.perfApiKey) return null
  const parts = creds.perfApiKey.split('::')
  if (parts.length !== 2) return null
  const [perfClientId, perfClientSecret] = parts
  if (_perfTokenCache && _perfTokenCache.clientId === perfClientId && Date.now() < _perfTokenCache.expiresAt - 60_000) {
    return { token: _perfTokenCache.token, clientId: _perfTokenCache.clientId }
  }
  return perfLimiter.run(async () => {
    // Проверяем ещё раз после ожидания в очереди
    if (_perfTokenCache && _perfTokenCache.clientId === perfClientId && Date.now() < _perfTokenCache.expiresAt - 60_000) {
      return { token: _perfTokenCache.token, clientId: _perfTokenCache.clientId }
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
    _perfTokenCache = { token: data.access_token, clientId: perfClientId, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 }
    return { token: _perfTokenCache.token, clientId: perfClientId }
  })
}

export async function perfGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return perfLimiter.run(async () => {
    const auth = await getPerfToken()
    if (!auth) throw new Error('Нет Performance API ключей или не удалось получить токен')
    const url = 'https://api-performance.ozon.ru' + path + (params ? '?' + new URLSearchParams(params).toString() : '')
    const res = await fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId } })
    if (!res.ok) { const text = await res.text(); throw new Error('Perf GET ' + path + ' → ' + res.status + ': ' + text) }
    return res.json() as Promise<T>
  })
}

export async function perfPost<T>(path: string, body: unknown): Promise<T> {
  return perfLimiter.run(async () => {
    const auth = await getPerfToken()
    if (!auth) throw new Error('Нет Performance API ключей или не удалось получить токен')
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
export async function perfPoll<T>(path: string): Promise<T> {
  const auth = await getPerfToken()
  if (!auth) throw new Error('Нет токена')
  const url = 'https://api-performance.ozon.ru' + path
  const res = await fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId } })
  if (!res.ok) { const text = await res.text(); throw new Error('Perf POLL ' + path + ' → ' + res.status + ': ' + text) }
  return res.json() as Promise<T>
}

export async function perfDownload(url: string): Promise<Buffer> {
  const auth = await getPerfToken()
  if (!auth) throw new Error('Нет токена')
  const fullUrl = url.startsWith('http') ? url : 'https://api-performance.ozon.ru' + (url.startsWith('/') ? '' : '/') + url
  const res = await fetch(fullUrl, { headers: { 'Authorization': 'Bearer ' + auth.token, 'Client-Id': auth.clientId } })
  if (!res.ok) throw new Error('Download ' + res.status)
  return Buffer.from(await res.arrayBuffer())
}

// ══════════════════════════════════════════════════════════════════════════════
// ── ТРАНЗАКЦИИ С РАЗБИВКОЙ ПО МЕСЯЦАМ ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

export async function fetchTxnsOneMonth(from: string, to: string): Promise<any[]> {
  const all: any[] = []
  let page = 1
  for (let i = 0; i < 50; i++) {
    const d = await ozonCall<any>('/v3/finance/transaction/list', {
      filter: { date: { from, to }, transaction_type: 'all' }, page, page_size: 1000,
    })
    all.push(...(d?.result?.operations ?? []))
    if (page >= Number(d?.result?.page_count ?? 1)) break
    page++
  }
  return all
}

export async function fetchTxnsChunked(from: string, to: string): Promise<any[]> {
  const fromD = new Date(from), toD = new Date(to)
  const chunks: { from: string; to: string }[] = []
  let cur = new Date(Date.UTC(fromD.getFullYear(), fromD.getMonth(), 1))
  while (cur <= toD) {
    const chunkEnd = new Date(Date.UTC(cur.getFullYear(), cur.getMonth() + 1, 1) - 1)
    chunks.push({ from: (cur < fromD ? fromD : cur).toISOString(), to: (chunkEnd > toD ? toD : chunkEnd).toISOString() })
    cur = new Date(Date.UTC(cur.getFullYear(), cur.getMonth() + 1, 1))
  }
  const all: any[] = []
  for (const chunk of chunks) {
    try { all.push(...await fetchTxnsOneMonth(chunk.from, chunk.to)) }
    catch (e: any) { console.warn('[txns chunk]', chunk.from, e.message) }
  }
  return all
}
