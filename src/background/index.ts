// background/index.ts — Service Worker Pomogator.ai

const ALLOWED_API_BASE = 'http://localhost:3000'

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

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === 'SEARCH_SERP') {
    sendResponse({ position: null })
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

  // ── Парсинг XLSX файла — извлекаем CSV из ZIP структуры ──────────────────
  if (message.type === 'PARSE_XLSX') {
    ;(async () => {
      try {
        const bytes = new Uint8Array(message.data as number[])
        const csv = await parseXlsxToCsv(bytes)
        sendResponse({ csv })
      } catch (e: any) {
        sendResponse({ error: e?.message ?? 'Ошибка парсинга xlsx' })
      }
    })()
    return true
  }

  // ── Прокси для запросов к localhost ──────────────────────────────────────────
  // Валидируем URL — только запросы к нашему бэкенду
  if (message.type === 'API_REQUEST') {
    ;(async () => {
      try {
        const url: string = message.url ?? ''
        if (!url.startsWith(ALLOWED_API_BASE)) {
          sendResponse({ ok: false, error: 'Запрещённый URL: ' + url })
          return
        }
        const res = await fetch(url, message.options ?? {})
        const data = await res.json()
        sendResponse({ ok: true, data })
      } catch (e: any) {
        sendResponse({ ok: false, error: String(e?.message ?? e) })
      }
    })()
    return true
  }

})

// ─── XLSX → CSV парсер (без внешних библиотек) ───────────────────────────────
async function parseXlsxToCsv(bytes: Uint8Array): Promise<string> {
  const files = await unzipXlsx(bytes)
  const ssXml = files['xl/sharedStrings.xml'] ?? ''
  const shKey = Object.keys(files).find(k => /xl\/worksheets\/sheet\d+\.xml/.test(k))
  const shXml = files['xl/worksheets/sheet1.xml'] ?? (shKey ? files[shKey] : '') ?? ''
  if (!shXml) throw new Error('Не найден лист данных в файле')

  const strings: string[] = []
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let val = ''
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) val += t[1]
    strings.push(xmlDec(val))
  }

  const rows = new Map<number, Map<number, string>>()
  for (const rowM of shXml.matchAll(/<row[^>]+r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = parseInt(rowM[1])
    const rd = new Map<number, string>()
    for (const cellM of rowM[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const col = colN(cellM[1]), attrs = cellM[2], inner = cellM[3]
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/)
      if (!vm) continue
      const val = attrs.includes('t="s"') ? (strings[parseInt(vm[1])] ?? '') : xmlDec(vm[1])
      rd.set(col, val)
    }
    if (rd.size > 0) rows.set(rn, rd)
  }
  if (rows.size === 0) throw new Error('Лист пустой')

  const maxR = Math.max(...rows.keys())
  const maxC = Math.max(...[...rows.values()].flatMap(r => [...r.keys()]))
  const out: string[] = []
  for (let r = 1; r <= maxR; r++) {
    const row = rows.get(r)
    const cols: string[] = []
    for (let c = 1; c <= maxC; c++) cols.push(row?.get(c) ?? '')
    out.push(cols.join(';'))
  }
  return out.join('\n')
}

function colN(s: string): number { let n = 0; for (const c of s) n = n * 26 + c.charCodeAt(0) - 64; return n }
function xmlDec(s: string): string { return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'") }

async function unzipXlsx(data: Uint8Array): Promise<Record<string, string>> {
  const r: Record<string, string> = {}
  const dv = new DataView(data.buffer, data.byteOffset)
  const dec = new TextDecoder('utf-8')
  let pos = 0
  while (pos < data.length - 30) {
    if (dv.getUint32(pos, true) !== 0x04034B50) { pos++; continue }
    const comp = dv.getUint16(pos + 8, true)
    const csz  = dv.getUint32(pos + 18, true)
    const fnl  = dv.getUint16(pos + 26, true)
    const exl  = dv.getUint16(pos + 28, true)
    const name = dec.decode(data.slice(pos + 30, pos + 30 + fnl))
    const dstart = pos + 30 + fnl + exl
    const cd = data.slice(dstart, dstart + csz)
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      if (comp === 0) {
        r[name] = dec.decode(cd)
      } else if (comp === 8) {
        try {
          const stream = new (globalThis as any).DecompressionStream('deflate-raw')
          const writer = stream.writable.getWriter()
          const reader = stream.readable.getReader()
          writer.write(cd); writer.close()
          const chunks: Uint8Array[] = []
          while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value) }
          const total = chunks.reduce((s, c) => s + c.length, 0)
          const buf = new Uint8Array(total); let off = 0
          for (const c of chunks) { buf.set(c, off); off += c.length }
          r[name] = dec.decode(buf)
        } catch { r[name] = '' }
      }
    }
    pos = dstart + csz
  }
  return r
}

