// background/index.ts — Service Worker Pomogator.ai

// ─── Локальная БД атрибутов ───────────────────────────────────────────────────

let attrsDbCache: Record<string, any> | null = null

async function getAttrsDb(): Promise<Record<string, any>> {
  if (attrsDbCache) return attrsDbCache
  const resp = await fetch(chrome.runtime.getURL('attrs_db.json'))
  attrsDbCache = await resp.json()
  return attrsDbCache!
}

// Расстояние Левенштейна
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    }
  }
  return dp[m][n]
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen
}

function stem(word: string): string { return word.slice(0, 6) }

function findCategoryInDb(db: Record<string, any>, breadcrumb: string): { key: string; data: any } | null {
  const q = breadcrumb.toLowerCase().trim()
  const qWords = q.split(/\s+/).filter(w => w.length > 3)

  if (db[q]) return { key: q, data: db[q] }

  for (const key of Object.keys(db)) {
    if (q.includes(key) || key.includes(q)) return { key, data: db[key] }
  }

  let bestKey: string | null = null
  let bestScore = 0
  for (const key of Object.keys(db)) {
    const keyWords = key.split(/\s+/).filter(w => w.length > 3)
    let score = 0
    for (const qw of qWords) {
      for (const kw of keyWords) {
        const sim = similarity(qw, kw)
        if (sim >= 0.8) score += sim
      }
    }
    if (score > bestScore) { bestScore = score; bestKey = key }
  }
  if (bestKey && bestScore >= 0.8) return { key: bestKey, data: db[bestKey] }

  for (const qw of qWords) {
    const qStem = stem(qw)
    for (const key of Object.keys(db)) {
      if (key.split(/\s+/).some(kw => stem(kw) === qStem)) {
        return { key, data: db[key] }
      }
    }
  }

  return null
}

async function handleGetCategoryAttrs(categoryName: string): Promise<{
  totalCount?: number
  totalChars?: number
  requiredCount?: number
  reqAttrs?: string[]
  groups?: string[]
  matchedCategory?: string
  error?: string
}> {
  const db = await getAttrsDb()
  const found = findCategoryInDb(db, categoryName)
  if (!found) return { error: `Категория «${categoryName}» не найдена` }
  return {
    totalCount: found.data.total,
    totalChars: found.data.totalChars,
    requiredCount: found.data.req,
    reqAttrs: found.data.reqAttrs,
    groups: found.data.groups,
    matchedCategory: found.key,
  }
}

// ─── API handlers ─────────────────────────────────────────────────────────────

async function getCreds(): Promise<{ clientId: string; apiKey: string }> {
  const creds = await chrome.storage.local.get(['clientId', 'apiKey'])
  return { clientId: creds['clientId'] as string, apiKey: creds['apiKey'] as string }
}

async function handleTestApi(clientId: string, apiKey: string): Promise<object> {
  const resp = await fetch('https://api-seller.ozon.ru/v1/analytics/product-queries', {
    method: 'POST',
    headers: { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_from: '2026-04-01', date_to: '2026-04-30', limit: 10, offset: 0 }),
  })
  return resp.json()
}

async function handleGetProductInfo(articleId: string, clientId: string, apiKey: string): Promise<{ volume?: number; error?: string }> {
  try {
    const resp = await fetch('https://api-seller.ozon.ru/v3/product/info/list', {
      method: 'POST',
      headers: { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: [parseInt(articleId)] }),
    })
    if (!resp.ok) return { error: `API ответил ${resp.status}` }
    const data = await resp.json()
    const item = data?.items?.[0]
    if (!item) return { error: 'Товар не найден в вашем ЛК' }
    const depth = item.depth ?? item.package_depth ?? 0
    const width = item.width ?? item.package_width ?? 0
    const height = item.height ?? item.package_height ?? 0
    if (depth && width && height) return { volume: Math.round(depth * width * height / 1_000_000 * 1000) / 1000 }
    if (item.volume_weight) return { volume: item.volume_weight }
    return { error: 'Габариты не указаны' }
  } catch (e: any) {
    return { error: e?.message }
  }
}

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === 'SEARCH_SERP') {
    sendResponse({ position: null })
    return true
  }

  if (message.type === 'TEST_API') {
    ;(async () => {
      try {
        const { clientId, apiKey } = await getCreds()
        sendResponse({ success: true, data: await handleTestApi(clientId, apiKey) })
      } catch (e: any) {
        sendResponse({ success: false, error: e?.message })
      }
    })()
    return true
  }

  if (message.type === 'GET_PRODUCT_INFO') {
    ;(async () => {
      try {
        sendResponse(await handleGetProductInfo(message.articleId, message.clientId, message.apiKey))
      } catch (e: any) {
        sendResponse({ error: e?.message })
      }
    })()
    return true
  }

  if (message.type === 'GET_CATEGORY_ATTRS') {
    ;(async () => {
      try {
        sendResponse(await handleGetCategoryAttrs(message.categoryName))
      } catch (e: any) {
        sendResponse({ error: e?.message })
      }
    })()
    return true
  }

  // ── Прокси для запросов к localhost (Private Network Access блокирует
  // прямые fetch из контент-скрипта на HTTPS-странице к http://localhost).
  // Бэкграунд-воркер не ограничен этой политикой.
  if (message.type === 'API_REQUEST') {
    ;(async () => {
      try {
        const res = await fetch(message.url, message.options ?? {})
        const data = await res.json()
        sendResponse({ ok: true, data })
      } catch (e: any) {
        sendResponse({ ok: false, error: String(e?.message ?? e) })
      }
    })()
    return true
  }

})
