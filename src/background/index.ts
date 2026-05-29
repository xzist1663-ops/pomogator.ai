// background/index.ts — Service Worker Pomogator.ai

// ─── Локальная БД атрибутов ───────────────────────────────────────────────────

let attrsDbCache: Record<string, any> | null = null

async function getAttrsDb(): Promise<Record<string, any>> {
  if (attrsDbCache) return attrsDbCache
  const resp = await fetch(chrome.runtime.getURL('attrs_db.json'))
  attrsDbCache = await resp.json()
  return attrsDbCache!
}

function findCategoryInDb(db: Record<string, any>, breadcrumb: string): { key: string; data: any } | null {
  const q = breadcrumb.toLowerCase().trim()

  // 1. Точное совпадение
  if (db[q]) return { key: q, data: db[q] }

  // 2. Ключ содержится в запросе или наоборот
  for (const key of Object.keys(db)) {
    if (q.includes(key) || key.includes(q)) return { key, data: db[key] }
  }

  // 3. По словам запроса — ищем ключ содержащий хотя бы 2 слова из запроса
  const words = q.split(/\s+/).filter(w => w.length > 3)
  for (const key of Object.keys(db)) {
    const matches = words.filter(w => key.includes(w))
    if (matches.length >= 2) return { key, data: db[key] }
  }

  // 4. По первому значимому слову
  const firstWord = words[0]
  if (firstWord) {
    for (const key of Object.keys(db)) {
      if (key.includes(firstWord)) return { key, data: db[key] }
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

})
