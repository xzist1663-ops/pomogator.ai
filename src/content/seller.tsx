/**
 * Pomogator Pro — seller.ozon.ru
 */

import { API_BASE } from '../shared/config'
const FONT     = `'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif`
const SERIF    = `Georgia, serif`


// Санитизация строк перед вставкой в innerHTML
function esc(s: string | number | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}
// ─── API ─────────────────────────────────────────────────────────────────────
function bgFetch<T>(url: string, options?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 60_000)
    chrome.runtime.sendMessage({ type: 'API_REQUEST', url, options }, (res) => {
      clearTimeout(timeout)
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!res?.ok) return reject(new Error(res?.error ?? 'error'))
      resolve(res.data as T)
    })
  })
}
function getSellerIdHeader(): Record<string, string> {
  try {
    const m = document.cookie.match(/(?:^|;)\s*sc_company_id=(\d{4,10})/)
    if (m) return { 'X-Seller-Id': m[1] }
  } catch {}
  return {}
}

function apiGet<T>(path: string): Promise<T> {
  return bgFetch<T>(API_BASE + path, { headers: { ...getSellerIdHeader() } })
}
function apiPost<T>(path: string, body: unknown): Promise<T> {
  return bgFetch<T>(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getSellerIdHeader() },
    body: JSON.stringify(body),
  })
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
function findText(text: string): Element | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if ((node as Text).textContent?.trim() === text) return (node as Text).parentElement
  }
  return null
}

// ─── Типы ────────────────────────────────────────────────────────────────────
interface Product {
  offerId: string
  price: number
  commissionPercent: number
  commissionPctFbo: number
  commissionPctFbs: number
  commissionRub: number
  logistics: number
  cost: number | null
  targetMarginPct: number | null
  net: number | null
  marginPct: number | null
  light: 'green' | 'yellow' | 'red' | 'no_cost'
}

interface ProfitData {
  net: Record<'today'|'yesterday'|'week'|'month', number>
  profit: Record<'today'|'yesterday'|'week'|'month', number | null> | null
  avgMarginPct: number | null
  hasCosts: boolean
  noCostCount: number
  deltaTodayVsYesterdayPct: number | null
  taxSystem: string
}

interface TaxBreakdown {
  taxSystem: string
  nds: number
  incomeTax: number
  totalTax: number
  netAfterTax: number
  marginAfterTax: number
  ndsDeduction: number
}

interface AbcItem {
  offerId: string
  price: number
  revenue: number
  ordersCount: number
  returnCount: number
  marginPct: number
  profitRub: number
  stockDays: number
  fboStock: number
  fbsStock: number
  hasCost: boolean
  isCurrent: boolean
  abcSales: 'A'|'B'|'C'
  abcMargin: 'A'|'B'|'C'
  abcStock: 'A'|'B'|'C'
  abcTotal: string
  taxBreakdown: TaxBreakdown | null
}

interface AbcData {
  items: AbcItem[]
  totalRevenue: number
  totalProfit: number
  avgMarginPct: number
  ordersTotal: number
  months: number
  warning?: string
}

interface EconomicsLoss {
  type: 'logistics_warehouse' | 'storage' | 'cancels' | 'ads_eating_profit' | 'acquiring'
  label: string
  amountRub: number
  detail: string
}
interface EconomicsItem {
  offerId: string
  ordersCount: number
  totalLossRub: number
  losses: EconomicsLoss[]
}
interface EconomicsData {
  items: EconomicsItem[]
  totalAnalyzed: number
  withLosses: number
  totalLossRub: number
  months: number
  warning?: string
}

interface PostingItem {
  postingNumber: string
  status: string
  substatus: string
  createdAt: string
  offerId: string
  productName: string
  qty: number
  buyerPrice: number
  scheme: string
  clusterFrom: string
  clusterTo: string
  warehouseName: string
  deliveryType: string
  commPct: number
  commRub: number
  logisticsNorm: number | null
  nonLocalPct: number
  nonLocalRub: number
  logisticsTotal: number | null
  acquiringRub: number
  cost: number | null
  targetMarginPct: number | null
  payoutRub: number
  taxRub: number | null
  taxBuyerPrice: number
  coinvestRub: number | null
  advPerUnit: number | null
  profitIfBought: number | null
  lossIfNotBought: number | null
  returnLogistics: number | null
  applyNonLocal: boolean
}
interface PostingsData {
  postings: PostingItem[]
  fboWeeklyCount: number
  applyNonLocal: boolean
}

interface StockForecastItem {
  offerId: string
  fboStock: number
  fbsStock: number
  totalStock: number
  dailySales: number
  daysLeft: number
  outOfStockDate: string | null
  reorderQty: number
  urgent: boolean
}
interface StockForecastData {
  items: StockForecastItem[]
  urgentCount: number
  periodDays: number
}

interface AccountInfo {
  clientId: string
  name: string
  taxSystem: string
  annualRevenue: number
  isActive: boolean
  perfApiKey: string | null
}

const LIGHT = {
  green:   { bg: 'rgba(52,199,89,0.12)',   border: 'rgba(52,199,89,0.35)',  color: '#1a7a35' },
  yellow:  { bg: 'rgba(255,180,0,0.12)',   border: 'rgba(255,180,0,0.35)',  color: '#7a5500' },
  red:     { bg: 'rgba(255,59,48,0.10)',   border: 'rgba(255,59,48,0.3)',   color: '#c0392b' },
  no_cost: { bg: 'rgba(0,0,0,0.04)',       border: 'rgba(0,0,0,0.15)',      color: '#666'    },
}

// ─── Кэш товаров ─────────────────────────────────────────────────────────────
let cache: Record<string, Product> = {}
let cacheLoading = false
let cacheLoaded  = false
let cacheUpdatedAt = 0
const CACHE_TTL = 20 * 60 * 1000  // 20 минут

async function loadProducts(force = false) {
  if (cacheLoading) return
  // Не перезагружаем если данные свежие
  if (!force && cacheLoaded && Date.now() - cacheUpdatedAt < CACHE_TTL) return
  cacheLoading = true
  try {
    const d = await apiGet<{ items: Product[]; fromCache?: boolean }>('/api/products')
    cache = {}
    for (const p of d.items) cache[p.offerId] = p
    cacheLoaded = true
    cacheUpdatedAt = Date.now()
    // Убираем спиннеры — вставляем реальные данные
    document.querySelectorAll('.pmg-b[data-loading="1"]').forEach(el => {
      const oid = (el as HTMLElement).dataset.offer
      if (oid) { el.remove(); injectRow(oid) }
    })
  } catch (e) { console.warn('[PMG] loadProducts:', e) }
  finally { cacheLoading = false }
}

// При уходе со страницы — инвалидируем кэш на сервере
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon(API_BASE + '/api/products/invalidate', '')
})

// ─── Строки таблицы товаров ──────────────────────────────────────────────────
function findArticleContainer(el: Element): Element {
  let cur: Element = el
  for (let i = 0; i < 5; i++) {
    const p = cur.parentElement; if (!p) break
    if (p.textContent?.includes('SKU')) { cur = p; break }
    cur = p
  }
  return cur
}

function injectRow(offerId: string) {
  const textEl = findText(offerId); if (!textEl) return
  const container = findArticleContainer(textEl)
  const existingBadge = container.querySelector('.pmg-b') as HTMLElement | null
  const p = cache[offerId], light = p?.light ?? 'no_cost', c = LIGHT[light]

  // Если уже есть правильный бейдж с актуальными данными — не трогаем
  if (existingBadge) {
    const isLoadingBadge = existingBadge.dataset.loading === '1'
    const hasData = !!p
    // Если спиннер и данные уже есть — заменяем
    // Если обычный бейдж и данные не изменились — не перерисовываем
    if (!isLoadingBadge && hasData) return
    if (!isLoadingBadge && !hasData && !cacheLoaded) return
    // Удаляем старый бейдж чтобы перерисовать
    existingBadge.remove()
    container.querySelector('.pmg-c')?.remove()
    container.querySelector('.pmg-p')?.remove()
  }

  const badge = document.createElement('span')
  badge.className = 'pmg-b'; badge.dataset.offer = offerId

  // Кэш ещё грузится и данных нет — показываем спиннер
  if (!cacheLoaded && !p) {
    badge.dataset.loading = '1'
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:99px;margin-top:4px;' +
      'background:rgba(0,0,0,0.04);border:1px dashed rgba(0,0,0,0.15);font-family:' + FONT + ';font-size:11px;color:#888;white-space:nowrap;'
    badge.innerHTML =
      '<svg width="10" height="10" viewBox="0 0 10 10" style="animation:pmg-s .8s linear infinite;flex-shrink:0">' +
      '<circle cx="5" cy="5" r="4" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="1.5"/>' +
      '<path d="M5 1 A4 4 0 0 1 9 5" fill="none" stroke="#0a84ff" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg> расчёт…'
    container.appendChild(badge)
    return
  }

  badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:99px;margin-top:4px;' +
    'background:' + c.bg + ';border:0.5px solid ' + c.border + ';font-family:' + FONT + ';font-size:11px;font-weight:600;color:' + c.color + ';white-space:nowrap;cursor:' + (light !== 'no_cost' ? 'pointer' : 'default') + ';'
  badge.textContent = light === 'no_cost' ? '○ себест. не задана' : '● ' + p!.marginPct + '% маржа'
  if (light !== 'no_cost' && p) { badge.onclick = e => { e.stopPropagation(); openBreakdown(p) } }

  const costWrap = document.createElement('div'); costWrap.className = 'pmg-c'
  costWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:4px;flex-wrap:wrap;'
  const lbl = document.createElement('span')
  lbl.style.cssText = 'font-family:' + FONT + ';font-size:10px;color:#888;'
  lbl.textContent = 'с/с:'
  const inp = document.createElement('input'); inp.type = 'number'; inp.placeholder = '0'
  inp.value = p?.cost != null ? String(p.cost) : ''
  inp.style.cssText = 'width:64px;padding:3px 6px;border-radius:7px;border:1px solid #ddd;background:#fff;color:#333;font-family:' + FONT + ';font-size:12px;outline:none;'
  // Целевая маржа % — опциональное поле. Используется только в детекторе
  // "Реклама съела прибыль" во вкладке Экономика: без него эта категория для
  // товара просто не считается, чтобы не путать сознательную работу на низкой
  // марже с реальной потерей.
  const marginLbl = document.createElement('span')
  marginLbl.style.cssText = 'font-family:' + FONT + ';font-size:10px;color:#888;'
  marginLbl.textContent = 'цель маржи %:'
  const marginInp = document.createElement('input'); marginInp.type = 'number'; marginInp.placeholder = '—'
  marginInp.title = 'Целевая маржа — для детектора "Реклама съела прибыль" во вкладке Экономика'
  marginInp.value = p?.targetMarginPct != null ? String(p.targetMarginPct) : ''
  marginInp.style.cssText = 'width:50px;padding:3px 6px;border-radius:7px;border:1px solid #ddd;background:#fff;color:#333;font-family:' + FONT + ';font-size:12px;outline:none;'
  const saveBtn = document.createElement('button'); saveBtn.textContent = '✓'
  saveBtn.style.cssText = 'padding:3px 7px;border-radius:7px;border:none;cursor:pointer;background:#0a84ff;color:#fff;font-size:12px;font-family:' + FONT + ';'
  saveBtn.onclick = async () => {
    const cost = parseFloat(inp.value); if (isNaN(cost)) return
    const marginRaw = marginInp.value.trim()
    const targetMarginPct = marginRaw === '' ? null : parseFloat(marginRaw)
    if (marginRaw !== '' && isNaN(targetMarginPct as number)) return
    saveBtn.textContent = '…'
    try {
      await apiPost('/api/cost', { offerId, cost, targetMarginPct })
      saveBtn.textContent = '✓'; saveBtn.style.background = '#34c759'
      await loadProducts()
      container.querySelectorAll('.pmg-b,.pmg-c,.pmg-p').forEach(e => e.remove())
      injectRow(offerId)
    } catch { saveBtn.textContent = '!'; saveBtn.style.background = '#ff3b30' }
  }
  costWrap.append(lbl, inp, marginLbl, marginInp, saveBtn)

  const planBtn = document.createElement('button'); planBtn.className = 'pmg-p'
  planBtn.textContent = '📋 План'
  planBtn.style.cssText = 'margin-top:5px;padding:3px 9px;border-radius:7px;cursor:pointer;' +
    'background:rgba(0,0,0,0.04);color:#555;border:1px solid #ddd;' +
    'font-family:' + FONT + ';font-size:11px;font-weight:500;white-space:nowrap;display:block;'
  planBtn.onmouseenter = () => { planBtn.style.background = 'rgba(0,0,0,0.08)' }
  planBtn.onmouseleave = () => { planBtn.style.background = 'rgba(0,0,0,0.04)' }
  planBtn.onclick = () => openPlan(offerId)

  container.appendChild(badge); container.appendChild(costWrap); container.appendChild(planBtn)
}

function injectAllRows() { for (const id of Object.keys(cache)) injectRow(id) }

// ─── Кнопка "Ввод себестоимости шаблоном" рядом с поиском ───────────────────
function injectCostImportButton() {
  if (document.getElementById('pmg-import-btn')) return
  const searchInput = document.querySelector('input[placeholder*="Название"], input[placeholder*="артикул"], input[placeholder*="SKU"]') as HTMLInputElement | null
  if (!searchInput) return

  // Ищем строку поиска: поднимаемся вверх пока не найдём контейнер с "Фильтры"
  let row: HTMLElement | null = searchInput.parentElement
  for (let i = 0; i < 8; i++) {
    if (!row) break
    if (row.textContent?.includes('Фильтры')) break
    row = row.parentElement
  }
  if (!row || !row.contains(searchInput)) return

  const btn = document.createElement('button')
  btn.id = 'pmg-import-btn'
  btn.textContent = '📥 Себестоимость'
  btn.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:5px',
    'padding:6px 14px', 'border-radius:8px',
    'border:1px solid #ddd',
    'background:#fff', 'color:#333',
    'font-family:' + FONT, 'font-size:13px', 'font-weight:500',
    'cursor:pointer', 'white-space:nowrap', 'flex-shrink:0',
  ].join(';')
  btn.onmouseenter = () => { btn.style.background = '#f5f5f5' }
  btn.onmouseleave = () => { btn.style.background = '#fff' }
  btn.onclick = (e) => { e.stopPropagation(); openCostImportModal() }
  row.insertBefore(btn, row.firstChild)
}

// ─── Модальное окно импорта себестоимости ────────────────────────────────────
async function openCostImportModal() {
  if (document.getElementById('pmg-import-modal')) return

  const overlay = document.createElement('div')
  overlay.id = 'pmg-import-modal'
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:999999;
    background:rgba(0,0,0,0.5); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
    display:flex; align-items:center; justify-content:center;
  `

  const modal = document.createElement('div')
  modal.style.cssText = `
    background:rgba(255,255,255,0.09);backdrop-filter:blur(60px) saturate(180%) brightness(1.05);-webkit-backdrop-filter:blur(60px) saturate(180%) brightness(1.05);border-radius:22px;padding:28px 32px;border:0.5px solid rgba(255,255,255,0.15);width:520px;max-width:90vw;font-family:${FONT};box-shadow:0 1px 0 rgba(255,255,255,0.15) inset,0 28px 80px rgba(0,0,0,0.55);position:relative;
  `

  // Закрытие по клику вне
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }

  // Крестик
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText = `position:absolute;top:14px;right:18px;background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.12);width:28px;height:28px;border-radius:50%;font-size:16px;color:rgba(255,255,255,0.55);cursor:pointer;display:flex;align-items:center;justify-content:center;`
  closeBtn.onclick = () => overlay.remove()

  // Заголовок
  const title = document.createElement('div')
  title.style.cssText = `font-size:18px;font-weight:600;color:rgba(255,255,255,0.9);margin-bottom:6px;letter-spacing:-.2px;`
  title.textContent = 'Ввод себестоимости шаблоном'

  const sub = document.createElement('div')
  sub.style.cssText = `font-size:13px;color:rgba(255,255,255,0.4);margin-bottom:24px;`
  sub.textContent = 'Скачайте шаблон, заполните себестоимость и загрузите обратно'

  // Шаги
  const stepsEl = document.createElement('div')
  stepsEl.style.cssText = `display:flex;flex-direction:column;gap:14px;margin-bottom:28px;`

  function makeStep(num: string, title: string, content: HTMLElement) {
    const wrap = document.createElement('div')
    wrap.style.cssText = `display:flex;gap:12px;align-items:flex-start;`
    const numEl = document.createElement('div')
    numEl.style.cssText = `min-width:26px;height:26px;border-radius:50%;background:#0a84ff;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;`
    numEl.textContent = num
    const textWrap = document.createElement('div')
    textWrap.style.cssText = `flex:1;`
    const titleEl = document.createElement('div')
    titleEl.style.cssText = `font-size:14px;font-weight:500;color:rgba(255,255,255,0.8);margin-bottom:6px;`
    titleEl.textContent = title
    textWrap.appendChild(titleEl)
    textWrap.appendChild(content)
    wrap.appendChild(numEl); wrap.appendChild(textWrap)
    return wrap
  }

  // Шаг 1 — скачать шаблон с артикулами
  const step1Content = document.createElement('div')
  const dlBtn = document.createElement('button')
  dlBtn.textContent = '⬇ Скачать шаблон с артикулами'
  dlBtn.style.cssText = `padding:8px 16px;border-radius:8px;border:none;background:#0a84ff;color:#fff;font-family:${FONT};font-size:13px;font-weight:600;cursor:pointer;`
  dlBtn.onclick = async () => {
    dlBtn.textContent = '⏳ Загружаем артикулы...'
    dlBtn.disabled = true
    try {
      const data = await apiGet<{items: {offerId: string, cost: number|null}[]}>('/api/products')
      await downloadCostTemplate(data.items)
      dlBtn.textContent = '✅ Шаблон скачан!'
      dlBtn.style.background = '#4A8030'
    } catch {
      dlBtn.textContent = '❌ Ошибка'
      dlBtn.style.background = '#923020'
      dlBtn.disabled = false
    }
  }
  const step1Hint = document.createElement('div')
  step1Hint.style.cssText = `font-size:11px;color:rgba(255,255,255,0.35);margin-top:6px;`
  step1Hint.textContent = 'В шаблоне уже будут все ваши артикулы — заполните только столбец "Себестоимость"'
  step1Content.appendChild(dlBtn); step1Content.appendChild(step1Hint)

  // Шаг 2 — загрузить файл
  const step2Content = document.createElement('div')
  const dropZone = document.createElement('div')
  dropZone.style.cssText = `
    border:1.5px dashed rgba(255,255,255,0.2); border-radius:12px; padding:24px;
    text-align:center; cursor:pointer; transition:all .15s; background:rgba(255,255,255,0.05);
  `
  dropZone.innerHTML = `
    <div style="font-size:28px;margin-bottom:6px;">📂</div>
    <div style="font-size:13px;font-weight:500;color:rgba(255,255,255,0.72);margin-bottom:4px;">Перетащите файл сюда</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.35);">или нажмите для выбора · .xlsx, .xls, .csv</div>
  `
  const fileInput = document.createElement('input')
  fileInput.type = 'file'; fileInput.accept = '.xlsx,.xls,.csv'; fileInput.style.display = 'none'
  dropZone.onclick = () => fileInput.click()
  dropZone.ondragover = e => { e.preventDefault(); dropZone.style.borderColor = '#0a84ff'; dropZone.style.background = 'rgba(0,0,0,0.04)' }
  dropZone.ondragleave = () => { dropZone.style.borderColor = 'rgba(255,255,255,0.2)'; dropZone.style.background = 'rgba(255,255,255,0.05)' }
  dropZone.ondrop = e => { e.preventDefault(); dropZone.style.borderColor = 'rgba(255,255,255,0.2)'; if (e.dataTransfer?.files[0]) processFile(e.dataTransfer.files[0]) }
  fileInput.onchange = () => { if (fileInput.files?.[0]) processFile(fileInput.files[0]) }
  step2Content.appendChild(dropZone); step2Content.appendChild(fileInput)

  // Результат
  const resultEl = document.createElement('div')
  resultEl.style.cssText = `margin-top:14px;font-size:13px;color:rgba(255,255,255,0.75);display:none;`

  stepsEl.appendChild(makeStep('1', 'Скачайте шаблон и заполните себестоимость', step1Content))
  stepsEl.appendChild(makeStep('2', 'Загрузите заполненный файл', step2Content))
  stepsEl.appendChild(resultEl)

  modal.appendChild(closeBtn); modal.appendChild(title); modal.appendChild(sub); modal.appendChild(stepsEl)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  // ── Обработка файла ────────────────────────────────────────────────────────
  async function processFile(file: File) {
    dropZone.style.opacity = '0.5'
    resultEl.style.display = 'none'

    try {
      const rows = await parseExcelFile(file)
      if (rows.length === 0) throw new Error('Не найдено строк с данными')

      let saved = 0, errors = 0
      const errList: string[] = []

      resultEl.style.display = 'block'
      resultEl.innerHTML = `<div style="color:#666">⏳ Сохраняем ${rows.length} строк...</div>`

      for (const { offerId, cost, targetMarginPct } of rows) {
        if (!offerId || (cost === null && targetMarginPct === null)) {
          errors++; errList.push(offerId || '(пустой артикул)'); continue
        }
        try {
          const body: Record<string, unknown> = { offerId }
          if (cost !== null) body.cost = cost
          if (targetMarginPct !== null) body.targetMarginPct = targetMarginPct
          await apiPost('/api/cost', body)
          saved++
        } catch {
          errors++; errList.push(offerId)
        }
      }

      await loadProducts()
      injectAllRows()

      let html = `<div style="background:rgba(74,128,48,0.1);border:0.5px solid rgba(74,128,48,0.3);border-radius:10px;padding:14px;">`
      html += `<div style="font-size:15px;font-weight:700;color:#4A8030;margin-bottom:6px;">✅ Готово!</div>`
      html += `<div style="color:rgba(255,255,255,0.82);">Сохранено: <strong>${saved}</strong> артикулов</div>`
      if (errors > 0) {
        html += `<div style="color:#923020;margin-top:4px;">Ошибки (${errors}): ${esc(errList.slice(0, 5).join(', '))}${errList.length > 5 ? '...' : ''}</div>`
      }
      html += `</div>`
      resultEl.innerHTML = html

    } catch (e: any) {
      resultEl.style.display = 'block'
      resultEl.innerHTML = `<div style="color:#923020;">❌ Ошибка чтения файла: ${esc(e.message)}</div>`
    }

    dropZone.style.opacity = '1'
  }
}

// ─── Парсинг Excel/CSV файла ─────────────────────────────────────────────────
async function parseExcelFile(file: File): Promise<{offerId: string, cost: number | null, targetMarginPct: number | null}[]> {
  const name = file.name.toLowerCase()

  if (name.endsWith('.csv')) {
    // CSV — читаем как текст
    const text = await file.text()
    return parseCSVCosts(text)
  }

  // XLSX/XLS — читаем как бинарный
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)

  // Проверяем сигнатуру ZIP (xlsx)
  if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
    const csv = await xlsxToCSV(buf)
    return parseCSVCosts(csv)
  }

  throw new Error('Неподдерживаемый формат. Используйте .xlsx или .csv')
}

async function xlsxToCSV(buf: ArrayBuffer): Promise<string> {
  const data = new Uint8Array(buf)
  console.log('[PMG xlsx] file size:', data.length, 'sig:', data[0], data[1], data[2], data[3])
  const files = await unzipAsync(data)
  console.log('[PMG xlsx] extracted files:', Object.keys(files))
  console.log('[PMG xlsx] sharedStrings len:', (files['xl/sharedStrings.xml'] ?? '').length)
  console.log('[PMG xlsx] sheet1 len:', (files['xl/worksheets/sheet1.xml'] ?? '').length)

  const ssXml = files['xl/sharedStrings.xml'] ?? ''
  const shKey = Object.keys(files).find(k => /xl\/worksheets\/sheet\d+\.xml/.test(k))
  const shXml = files['xl/worksheets/sheet1.xml'] ?? (shKey ? files[shKey] : '') ?? ''
  if (!shXml) throw new Error(`Не найден лист данных. Извлечённые файлы: ${Object.keys(files).join(', ') || 'пусто'}`)

  // Парсим shared strings
  const strings: string[] = []
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let val = ''
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) val += t[1]
    strings.push(val.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'))
  }

  // Парсим ячейки
  const rows = new Map<number, Map<number, string>>()
  for (const rowM of shXml.matchAll(/<row[^>]+r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = parseInt(rowM[1])
    const rd = new Map<number, string>()
    for (const cellM of rowM[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const colStr = cellM[1], attrs = cellM[2], inner = cellM[3]
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/)
      if (!vm) continue
      let col = 0; for (const ch of colStr) col = col * 26 + ch.charCodeAt(0) - 64
      const val = attrs.includes('t="s"') ? (strings[parseInt(vm[1])] ?? '') : vm[1]
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

async function unzipAsync(data: Uint8Array): Promise<Record<string, string>> {
  const r: Record<string, string> = {}
  const dv = new DataView(data.buffer, data.byteOffset)
  const dec = new TextDecoder('utf-8')

  // Ищем EOCD с конца файла
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('ZIP: EOCD не найден')

  const cdOffset  = dv.getUint32(eocd + 16, true)
  const cdEntries = dv.getUint16(eocd + 10, true)

  // Читаем Central Directory — там правильные размеры (не LFH где бывает 0)
  const fileMap = new Map<string, { comp: number; csz: number; lhOffset: number }>()
  let cdPos = cdOffset
  for (let i = 0; i < cdEntries; i++) {
    if (dv.getUint32(cdPos, true) !== 0x02014B50) break
    const comp     = dv.getUint16(cdPos + 10, true)
    const csz      = dv.getUint32(cdPos + 20, true)
    const fnLen    = dv.getUint16(cdPos + 28, true)
    const exLen    = dv.getUint16(cdPos + 30, true)
    const comLen   = dv.getUint16(cdPos + 32, true)
    const lhOffset = dv.getUint32(cdPos + 42, true)
    const name     = dec.decode(data.slice(cdPos + 46, cdPos + 46 + fnLen))
    fileMap.set(name, { comp, csz, lhOffset })
    cdPos += 46 + fnLen + exLen + comLen
  }

  for (const [name, { comp, csz, lhOffset }] of fileMap) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
    const fnl = dv.getUint16(lhOffset + 26, true)
    const exl = dv.getUint16(lhOffset + 28, true)
    const ds  = lhOffset + 30 + fnl + exl
    const cd  = data.slice(ds, ds + csz)
    console.log('[PMG zip]', name, 'comp:', comp, 'csz:', csz)

    if (comp === 0) {
      r[name] = dec.decode(cd)
    } else if (comp === 8) {
      try {
        const stream = new (window as any).DecompressionStream('deflate-raw')
        const writer = stream.writable.getWriter()
        const reader = stream.readable.getReader()
        writer.write(cd); writer.close()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        const total = chunks.reduce((s: number, c: Uint8Array) => s + c.length, 0)
        const buf2 = new Uint8Array(total); let off = 0
        for (const c of chunks) { buf2.set(c, off); off += c.length }
        r[name] = dec.decode(buf2)
        console.log('[PMG zip] ok:', name, total, 'bytes')
      } catch (e: any) {
        console.warn('[PMG zip] failed:', name, e?.message)
      }
    }
  }
  return r
}

function parseCSVCosts(text: string): {offerId: string, cost: number | null, targetMarginPct: number | null}[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  if (lines.length < 2) return []

  const sep = lines[0].includes(';') ? ';' : ','
  const headers = lines[0].split(sep).map(h => h.trim().replace(/"/g, '').toLowerCase())

  const offerIdx  = headers.findIndex(h => /артикул|offer.?id|article/i.test(h))
  const costIdx   = headers.findIndex(h => /себест|cost|цена закуп/i.test(h))
  const marginIdx = headers.findIndex(h => /целев.*марж|target.*margin/i.test(h))

  if (offerIdx < 0) {
    throw new Error(`Не найдена колонка с артикулом. Найдено: ${headers.join(', ')}`)
  }

  const result: {offerId: string, cost: number | null, targetMarginPct: number | null}[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map(c => c.trim().replace(/"/g, ''))
    const offerId = cols[offerIdx]?.trim()
    if (!offerId) continue

    // Себестоимость — опциональна при импорте (пользователь мог заполнить только маржу)
    let cost: number | null = null
    if (costIdx >= 0) {
      const raw = (cols[costIdx] || '').replace(',', '.').replace(/[^\d.]/g, '')
      const parsed = parseFloat(raw)
      if (!isNaN(parsed) && parsed >= 0) cost = parsed
    }

    // Целевая маржа — тоже опциональна
    let targetMarginPct: number | null = null
    if (marginIdx >= 0) {
      const raw = (cols[marginIdx] || '').replace(',', '.').replace(/[^\d.\-]/g, '')
      const parsed = parseFloat(raw)
      if (!isNaN(parsed)) targetMarginPct = parsed
    }

    // Сохраняем строку если есть хотя бы одно из двух заполненных полей
    if (cost !== null || targetMarginPct !== null) {
      result.push({ offerId, cost, targetMarginPct })
    }
  }
  return result
}

// ─── Скачивание шаблона xlsx ─────────────────────────────────────────────────
async function downloadCostTemplate(products: {offerId: string, cost: number|null, targetMarginPct?: number|null}[]) {
  const BOM = '\uFEFF'
  const lines = [
    '# ИНСТРУКЦИЯ: Заполните столбцы "Себестоимость" и "Целевая маржа %" и загрузите файл обратно',
    '# Себестоимость = закупка + упаковка + фулфилмент + прочие расходы на единицу товара',
    '# Целевая маржа % — опционально. Если не задана, расширение НЕ будет считать',
    '# для этого товара потерю "Реклама съела прибыль" (вкладка Экономика), чтобы',
    '# не путать сознательную работу на низкой марже с реальной проблемой.',
    '# Не меняйте заголовки и артикулы. Строки с # игнорируются.',
    'Артикул;Себестоимость (₽);Целевая маржа %',
  ]
  for (const p of products) {
    const cost = p.cost != null && p.cost > 0 ? String(p.cost) : ''
    const margin = p.targetMarginPct != null ? String(p.targetMarginPct) : ''
    lines.push(`${p.offerId};${cost};${margin}`)
  }
  const csv = BOM + lines.join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = 'cost_template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

let tableStarted = false
async function initTable() {
  if (tableStarted) return; tableStarted = true

  // Сначала вставляем спиннеры во все видимые строки
  injectAllRows()
  // Грузим данные с сервера (кэш 20 мин)
  await loadProducts()
  injectAllRows()
  injectCostImportButton()

  // Каждые 2 сек проверяем новые строки
  setInterval(injectAllRows, 2000)
  // Кнопка себестоимости
  setInterval(injectCostImportButton, 3000)
  // Обновляем данные каждые 20 минут
  setInterval(async () => { await loadProducts(true); injectAllRows() }, CACHE_TTL)
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── PROFIT WIDGET ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const W_CSS = `
#pmg-profit {
  position:fixed; top:64px; right:14px; z-index:99997; width:420px;
  background:#1C1E2A; border:0.5px solid rgba(255,255,255,0.1); border-radius:16px;
  font-family:${FONT}; box-shadow:0 4px 24px rgba(0,0,0,0.35); overflow:hidden;
  --pmg-info-bg:rgba(10,132,255,0.10); --pmg-info-border:rgba(10,132,255,0.35);
  --pmg-text:rgba(255,255,255,0.82); --pmg-dim:rgba(255,255,255,0.35);
}
.pmg-hdr { display:flex; align-items:center; justify-content:space-between; padding:10px 14px;
  border-bottom:0.5px solid rgba(255,255,255,0.07); border-radius:16px 16px 0 0;
  cursor:pointer; user-select:none; position:relative; z-index:1; }
.pmg-hdr-l { display:flex; align-items:center; gap:8px; }
.pmg-hdr-title { font-size:14px; font-weight:500; color:rgba(255,255,255,0.82); letter-spacing:.02em; }
.pmg-pro { display:inline-flex; align-items:center; gap:3px; background:rgba(10,132,255,0.65);
  color:#fff; font-size:9px; font-weight:700; letter-spacing:.08em; padding:2px 7px; border-radius:99px; text-transform:uppercase; }
.pmg-hdr-r { display:flex; align-items:center; gap:4px; }
.pmg-ib { background:none; border:none; cursor:pointer; color:rgba(255,255,255,0.38); padding:3px 4px;
  border-radius:6px; font-size:14px; line-height:1; transition:background .15s,color .15s; }
.pmg-ib:hover { background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.82); }
.pmg-secs { display:flex; border-bottom:0.5px solid rgba(255,255,255,0.07); position:relative; z-index:1; }
.pmg-sec { flex:1; padding:9px 0; text-align:center; font-size:12px; font-weight:600; color:rgba(255,255,255,0.38);
  cursor:pointer; border-bottom:2px solid transparent; transition:all .15s; }
.pmg-sec.on { color:rgba(255,255,255,0.88); border-bottom-color:rgba(255,255,255,0.7); }
.pmg-sec:hover:not(.on) { color:rgba(255,255,255,0.6); }
.pmg-tabs { display:flex; gap:5px; padding:10px 14px 0; position:relative; z-index:1; }
.pmg-tab { flex:1; padding:5px 0; text-align:center; border:0.5px solid rgba(255,255,255,0.1);
  border-radius:8px; background:rgba(255,255,255,0.05); font-size:11.5px; font-weight:600; color:rgba(255,255,255,0.45); cursor:pointer; transition:all .15s; }
.pmg-tab.on { background:rgba(10,132,255,0.65); border-color:rgba(10,132,255,0.5); color:#fff; }
.pmg-tab:hover:not(.on) { background:rgba(255,255,255,0.09); color:rgba(255,255,255,0.7); }
.pmg-dates { display:flex; gap:6px; align-items:center; padding:8px 14px 0; position:relative; z-index:1; }
.pmg-dinp { flex:1; padding:5px 8px; border:0.5px solid rgba(255,255,255,0.1); border-radius:8px;
  background:rgba(255,255,255,0.07); color:rgba(255,255,255,0.82); font-size:12px; font-family:inherit; outline:none; }
.pmg-dgo { padding:5px 12px; background:rgba(10,132,255,0.65); color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; }
.pmg-body { padding:12px 14px 0; position:relative; z-index:1; }
.pmg-grid { display:grid; grid-template-columns:1fr 1fr; gap:9px; padding:12px 14px 14px; position:relative; z-index:1; }
.pmg-card { background:rgba(255,255,255,0.06); border:0.5px solid rgba(255,255,255,0.1); border-radius:14px;
  cursor:pointer; user-select:none; display:flex; flex-direction:column; align-items:center; gap:7px;
  padding:12px 8px 10px; transition:background .2s; position:relative; overflow:hidden; }
.pmg-card:hover { background:rgba(255,255,255,0.1); }
.pmg-card.full { grid-column:span 2; flex-direction:row; align-items:center; gap:12px; padding:10px 14px; }
.pmg-card-label { font-size:12px; color:rgba(255,255,255,0.72); font-weight:500; line-height:1.3; text-align:center; }
.pmg-card.full .pmg-card-label { text-align:left; }
.pmg-card-sub { font-size:11px; color:rgba(255,255,255,0.38); margin-top:2px; }
.pmg-ring-wrap { transition:transform 0.4s ease; }
.pmg-sec-header { display:flex; align-items:center; justify-content:space-between; margin:12px 14px 0;
  padding:10px 14px; background:rgba(255,255,255,0.06); border:0.5px solid rgba(255,255,255,0.1); border-radius:14px; position:relative; z-index:1; }
.pmg-metrics { display:flex; border-top:0.5px solid rgba(255,255,255,0.07); margin:0 14px; position:relative; z-index:1; }
.pmg-mc { flex:1; padding:9px 0; text-align:center; border-right:0.5px solid rgba(255,255,255,0.07); }
.pmg-mc:last-child { border-right:none; }
.pmg-mc-l { font-size:9.5px; color:rgba(255,255,255,0.35); text-transform:uppercase; letter-spacing:.05em; margin-bottom:2px; }
.pmg-mc-v { font-family:${SERIF}; font-size:15px; font-weight:400; color:rgba(255,255,255,0.82); }
.pmg-warn { margin:0 14px 10px; background:rgba(255,204,0,0.08); border:0.5px solid rgba(255,204,0,0.2);
  border-radius:10px; padding:8px 11px; font-size:11px; color:rgba(255,210,0,0.9); line-height:1.45; position:relative; z-index:1; }
.pmg-load-wrap { display:flex; flex-direction:column; align-items:center; gap:8px; padding:28px 14px; position:relative; z-index:1; }
.pmg-spin { width:18px; height:18px; border-radius:50%; border:2px solid rgba(255,255,255,0.1);
  border-top-color:rgba(255,255,255,0.7); animation:pmg-s .7s linear infinite; }
@keyframes pmg-s { to { transform:rotate(360deg) } }
@keyframes pmg-wave { 0%{transform:scale(0);opacity:.5} 100%{transform:scale(4);opacity:0} }
.pmg-pbar-wrap { width:180px; background:rgba(255,255,255,0.08); border-radius:99px; height:5px; overflow:hidden; }
.pmg-pbar { height:100%; background:rgba(10,132,255,0.7); border-radius:99px; transition:width .3s ease; }
.pmg-load-txt { font-size:12px; color:rgba(255,255,255,0.38); }
.pmg-abc-wrap { overflow-x:auto; padding:0 14px 14px; position:relative; z-index:1; }
.pmg-abc { width:100%; border-collapse:collapse; font-size:11px; }
.pmg-abc th { text-align:left; padding:4px 5px; color:rgba(255,255,255,0.35); font-size:9px; font-weight:700;
  text-transform:uppercase; letter-spacing:.05em; border-bottom:0.5px solid rgba(255,255,255,0.08); white-space:nowrap; }
.pmg-abc td { padding:6px 5px; border-bottom:0.5px solid rgba(255,255,255,0.06); color:rgba(255,255,255,0.75); vertical-align:middle; }
.pmg-abc tr:last-child td { border-bottom:none; }
.pmg-abc tr:hover td { background:rgba(255,255,255,0.04); }
.pmg-aname { max-width:85px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:10.5px; }
.pmg-cls { display:inline-block; width:17px; height:17px; line-height:17px; text-align:center; border-radius:4px; font-size:9.5px; font-weight:700; }
.pmg-cls-A { background:rgba(52,199,89,0.15); color:rgba(52,199,89,0.9); }
.pmg-cls-B { background:rgba(255,204,0,0.12); color:rgba(255,210,0,0.9); }
.pmg-cls-C { background:rgba(255,59,48,0.12); color:rgba(255,80,70,0.9); }
.pmg-tcls { font-weight:700; font-size:11.5px; letter-spacing:.03em; }
.pmg-div { height:0.5px; background:rgba(255,255,255,0.07); margin:8px 14px; position:relative; z-index:1; }
.pmg-foot { display:flex; align-items:center; justify-content:space-between; padding:7px 14px 12px; font-size:10.5px; color:rgba(255,255,255,0.28); position:relative; z-index:1; }
.pmg-foot a { color:rgba(10,132,255,0.85); text-decoration:none; font-weight:600; }
.pmg-foot a:hover { text-decoration:underline; }
.pmg-link-inp { width:100%; box-sizing:border-box; padding:7px 10px; border:0.5px solid rgba(255,255,255,0.12);
  border-radius:9px; background:rgba(255,255,255,0.07); color:rgba(255,255,255,0.82); font-family:inherit; font-size:13px; outline:none; margin-top:3px; }
.pmg-link-lbl { font-size:10px; color:rgba(255,255,255,0.35); display:block; text-transform:uppercase; letter-spacing:.04em; margin-top:8px; }
.pmg-link-btn { width:100%; padding:9px; border-radius:10px; border:none; cursor:pointer;
  background:rgba(10,132,255,0.65); color:#fff; font-family:inherit; font-size:13px; font-weight:600; margin-top:10px; }
.pmg-acc-dd { display:none; position:absolute; right:0; top:calc(100% + 4px);
  background:rgba(20,20,28,0.95); backdrop-filter:blur(30px); border:0.5px solid rgba(255,255,255,0.1);
  border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.4); min-width:180px; z-index:99999; overflow:hidden; }
.pmg-acc-item { padding:8px 12px; cursor:pointer; font-size:12px; color:rgba(255,255,255,0.75);
  border-bottom:0.5px solid rgba(255,255,255,0.07); }
.pmg-acc-item:hover { background:rgba(255,255,255,0.06); }
.pmg-acc-item.pmg-acc-on { background:rgba(10,132,255,0.15); font-weight:600; color:rgba(255,255,255,0.9); }
@keyframes pmg-in { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
#pmg-profit { animation:pmg-in .25s ease; }
#pmg-profit::before { content:''; position:absolute; width:280px; height:280px; border-radius:50%; background:rgba(88,86,214,0.18); filter:blur(70px); top:-80px; left:-60px; pointer-events:none; z-index:0; }
#pmg-profit::after { content:''; position:absolute; width:220px; height:220px; border-radius:50%; background:rgba(10,132,255,0.14); filter:blur(60px); bottom:-40px; right:-30px; pointer-events:none; z-index:0; }
@media(max-width:1320px){ #pmg-profit{width:370px;right:8px} }
@media(max-width:1100px){ #pmg-profit{width:320px;right:6px} }
`

// ─── Форматирование ───────────────────────────────────────────────────────────
function fmtR(n: number): string {
  const a = Math.abs(Math.round(n)), s = n >= 0 ? '+' : '\u2212'
  if (a >= 1_000_000) return s + (a/1_000_000).toFixed(1) + '\u041c \u20bd'
  if (a >= 1_000)     return s + (a/1_000).toFixed(0) + '\u041a \u20bd'
  return s + a.toLocaleString('ru') + ' \u20bd'
}
function fmtRA(n: number): string {
  const a = Math.abs(Math.round(n))
  if (a >= 1_000_000) return (a/1_000_000).toFixed(1) + '\u041c \u20bd'
  if (a >= 1_000)     return (a/1_000).toFixed(0) + '\u041a \u20bd'
  return a.toLocaleString('ru') + ' \u20bd'
}
function pctC(p: number) { return p >= 15 ? 'rgba(52,199,89,0.9)' : p >= 0 ? 'rgba(255,204,0,0.85)' : 'rgba(255,80,70,0.85)' }

function makeSvgRing(score: number, max: number, size: number): string {
  const sw = size >= 52 ? 7 : 5
  const r  = size >= 52 ? 21 : 15
  const c  = size / 2
  const circ = 2 * Math.PI * r
  const off  = max === 0 ? circ : circ * (1 - Math.min(Math.max(score, 0), max) / max)
  const col  = max === 0 ? '#A08060' : (score/max >= 0.75 ? 'rgba(52,199,89,0.9)' : score/max >= 0.45 ? 'rgba(255,204,0,0.85)' : 'rgba(255,80,70,0.85)')
  const fs   = size >= 52 ? 11 : 9
  const inset = sw + 1
  return '<div style="position:relative;width:' + size + 'px;height:' + size + 'px;flex-shrink:0">' +
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="transform:rotate(-90deg);display:block">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="rgba(255,255,255,0.08)" fill="none"/>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="' + col + '" fill="none"' +
    ' stroke-dasharray="' + circ + '" stroke-dashoffset="' + off + '" stroke-linecap="round"/>' +
    '</svg>' +
    '<div style="position:absolute;inset:' + inset + 'px;border-radius:50%;display:flex;align-items:center;justify-content:center">' +
    '<span style="font-family:' + SERIF + ';font-size:' + fs + 'px;color:rgba(255,255,255,0.85);line-height:1">' + score + '/' + max + '</span>' +
    '</div></div>'
}

function makePctRing(pct: number, size: number): string {
  const sw = 7, r = 21, c = size / 2
  const circ = 2 * Math.PI * r
  const off  = circ * (1 - Math.min(Math.max(pct, 0), 100) / 100)
  const col  = pctC(pct)
  const inset = sw + 1
  return '<div style="position:relative;width:' + size + 'px;height:' + size + 'px;flex-shrink:0">' +
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="transform:rotate(-90deg);display:block">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="rgba(255,255,255,0.08)" fill="none"/>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="' + col + '" fill="none"' +
    ' stroke-dasharray="' + circ + '" stroke-dashoffset="' + off + '" stroke-linecap="round"/>' +
    '</svg>' +
    '<div style="position:absolute;inset:' + inset + 'px;border-radius:50%;display:flex;align-items:center;justify-content:center">' +
    '<span style="font-family:' + SERIF + ';font-size:11px;color:rgba(255,255,255,0.85);line-height:1">' + pct.toFixed(1) + '%</span>' +
    '</div></div>'
}

function addTilt(cardEl: HTMLElement) {
  const rw = cardEl.querySelector('.pmg-ring-wrap') as HTMLElement | null
  if (!rw) return
  cardEl.addEventListener('mousemove', (e: MouseEvent) => {
    const rect = cardEl.getBoundingClientRect()
    const dx = (e.clientX - (rect.left + rect.width/2)) / (rect.width/2)
    const dy = (e.clientY - (rect.top  + rect.height/2)) / (rect.height/2)
    rw.style.transition = 'transform 0.08s ease'
    rw.style.transform  = 'rotate3d(' + (-dy*1.2) + ',' + (dx*1.2) + ',0,18deg) scale(1.06)'
  })
  cardEl.addEventListener('mouseleave', () => {
    rw.style.transition = 'transform 0.4s ease'
    rw.style.transform  = 'rotate3d(0,0,0,0deg) scale(1)'
  })
}

// ─── Состояние ───────────────────────────────────────────────────────────────
type Period = 'week' | 'month' | 'halfyear' | 'custom'
interface WS {
  collapsed: boolean; section: 'margin'|'abc'|'economics'|'orders'; period: Period
  expanded: boolean
  customFrom: string; customTo: string; loading: boolean
  loadMsg: string; loadPct: number
  profitData: ProfitData | null; abcData: AbcData | null; economicsData: EconomicsData | null
  postingsData: PostingsData | null; stockData: StockForecastData | null
  products: Product[]; refreshedAt: Date | null
  accounts: AccountInfo[]; activeAccount: AccountInfo | null
  showLinkForm: boolean; pendingClientId: string
}
const ws: WS = {
  collapsed: false, section: 'margin', period: 'month',
  expanded: false,
  customFrom: '', customTo: '', loading: false, loadMsg: 'Загружаю…', loadPct: 0,
  profitData: null, abcData: null, economicsData: null, postingsData: null, stockData: null,
  products: [], refreshedAt: null,
  accounts: [], activeAccount: null, showLinkForm: false, pendingClientId: '',
}
function safeProds(): Product[] { if (!Array.isArray(ws.products)) ws.products = []; return ws.products }

// ─── Аккаунты ────────────────────────────────────────────────────────────────
async function loadAccounts() {
  try {
    const data = await apiGet<{ accounts: AccountInfo[] }>('/api/accounts')
    ws.accounts = data.accounts ?? []
    ws.activeAccount = ws.accounts.find(a => a.isActive) ?? null
  } catch {}
}

// Читаем текущий активный Seller ID из cookie sc_company_id
// Это значение точно соответствует активному кабинету и меняется при переключении
function getCurrentSellerIdFromDom(): string | null {
  // Метод 1 (основной): cookie sc_company_id — самый надёжный
  try {
    const m = document.cookie.match(/(?:^|;)\s*sc_company_id=(\d{4,10})/)
    if (m) return m[1]
  } catch {}

  // Метод 2: localStorage vuex -> user.contentId (резервный)
  try {
    const vuex = JSON.parse(localStorage.getItem('vuex') || '{}')
    const id = vuex?.user?.contentId
    if (id && String(id).match(/^\d{4,10}$/)) return String(id)
  } catch {}

  return null
}

// Автосверка кабинета: читаем Seller ID из DOM и переключаем аккаунт если нужно
async function syncAccountWithDom(el: HTMLElement): Promise<boolean> {
  const domSellerId = getCurrentSellerIdFromDom()
  console.log('[PMG] getCurrentSellerIdFromDom result:', domSellerId)
  if (!domSellerId) {
    console.warn('[PMG] Could not detect Seller ID from DOM')
    return false
  }

  const activeId = ws.activeAccount?.clientId
  if (activeId === domSellerId) return true // уже правильный

  // Ищем этот аккаунт в списке привязанных
  const found = ws.accounts.find(a => a.clientId === domSellerId)
  if (found) {
    // Переключаем на нужный аккаунт
    console.log('[PMG] switching account to', domSellerId)
    try {
      await apiPost('/api/accounts/switch', { clientId: domSellerId })
      ws.activeAccount = { ...found, isActive: true }
      ws.accounts = ws.accounts.map(a => ({ ...a, isActive: a.clientId === domSellerId }))
    } catch (e) { console.warn('[PMG] switch failed:', e) }
    return true
  }

  // Кабинет не привязан — показываем форму привязки
  console.log('[PMG] account not found for Seller ID', domSellerId, '— showing link form')
  ws.showLinkForm = true
  // Предзаполняем clientId в форме
  ws.pendingClientId = domSellerId
  renderW(el)
  return false
}

// ─── Рендер ──────────────────────────────────────────────────────────────────
function renderW(el: HTMLElement) {
  if (!ws.customFrom) {
    const d = new Date(); d.setDate(1)
    ws.customFrom = d.toISOString().slice(0, 10)
    ws.customTo   = new Date().toISOString().slice(0, 10)
  }

  // Шапка — без кабинета, только название + PRO + обновить + свернуть
  const hdrHtml = '<div class="pmg-hdr" id="pmg-hdr">' +
    '<div class="pmg-hdr-l">' +
    '<span style="font-size:16px">🌿</span>' +
    '<span class="pmg-hdr-title">Pomogator.ai</span>' +
    '<span class="pmg-pro">★ PRO</span>' +
    '</div>' +
    '<div class="pmg-hdr-r">' +
    (ws.accounts.length > 0 ? '<button class="pmg-ib" id="pmg-ref" title="Обновить"><svg width="14" height="14" fill="none" viewBox="0 0 14 14"><path d="M12 7A5 5 0 1 1 8.5 2.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 1v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : '') +
    '<button class="pmg-ib" id="pmg-tog">' + (ws.collapsed ? '＋' : '－') + '</button>' +
    '</div></div>'

  const footHtml = '<div class="pmg-foot"><span>' +
    (ws.refreshedAt ? 'Обновлено ' + ws.refreshedAt.toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' }) : '—') +
    '</span><a href="https://pomogator.ai" target="_blank">pomogator.ai</a></div>'

  // Если нет аккаунтов — форма привязки
  if (ws.accounts.length === 0 || ws.showLinkForm) {
    el.innerHTML = hdrHtml +
      '<div id="pmg-bd" style="' + (ws.collapsed ? 'display:none' : '') + '">' +
      renderLinkForm() + footHtml + '</div>'
    bindHdr(el); bindLinkForm(el); return
  }

  // Основной виджет — главная страница: три кнопки
  const menuHtml =
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;padding:12px;position:relative;z-index:1">' +
    // Кнопка Сводка
    '<button class="pmg-sec" data-s="margin" style="padding:12px 9px;border:0.5px solid ' + (ws.section==='margin'?'rgba(10,132,255,0.4)':'rgba(255,255,255,0.1)') + ';border-radius:12px;cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:all .18s;background:' + (ws.section==='margin'?'rgba(10,132,255,0.12)':'rgba(255,255,255,0.04)') + ';font-family:' + FONT + ';text-align:left;width:100%">' +
    '<div style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center">' +
    '<svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="' + (ws.section==='margin'?'rgba(10,132,255,0.9)':'rgba(255,255,255,0.5)') + '" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="9" width="3" height="5" rx="1"/><rect x="6" y="5" width="3" height="9" rx="1"/><rect x="11" y="1" width="3" height="13" rx="1"/></svg>' +
    '</div>' +
    '<div><div style="font-size:11.5px;font-weight:600;color:' + (ws.section==='margin'?'rgba(10,132,255,0.95)':'rgba(255,255,255,0.82)') + ';letter-spacing:-.01em">Сводка</div>' +
    '<div style="font-size:9.5px;color:rgba(255,255,255,0.35);margin-top:2px">Маржа магазина</div></div>' +
    '</button>' +
    '<button class="pmg-sec" data-s="abc" style="padding:12px 9px;border:0.5px solid ' + (ws.section==='abc'?'rgba(10,132,255,0.4)':'rgba(255,255,255,0.1)') + ';border-radius:12px;cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:all .18s;background:' + (ws.section==='abc'?'rgba(10,132,255,0.12)':'rgba(255,255,255,0.04)') + ';font-family:' + FONT + ';text-align:left;width:100%">' +
    '<div style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center">' +
    '<svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="' + (ws.section==='abc'?'rgba(10,132,255,0.9)':'rgba(255,255,255,0.5)') + '" stroke-width="1.5" stroke-linecap="round"><path d="M1 4h13M1 8h9M1 12h6"/></svg>' +
    '</div>' +
    '<div><div style="font-size:11.5px;font-weight:600;color:' + (ws.section==='abc'?'rgba(10,132,255,0.95)':'rgba(255,255,255,0.82)') + ';letter-spacing:-.01em">АВС-анализ</div>' +
    '<div style="font-size:9.5px;color:rgba(255,255,255,0.35);margin-top:2px">По артикулам</div></div>' +
    '</button>' +
    '<button class="pmg-sec" data-s="economics" style="padding:12px 9px;border:0.5px solid ' + (ws.section==='economics'?'rgba(10,132,255,0.4)':'rgba(255,255,255,0.1)') + ';border-radius:12px;cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:all .18s;background:' + (ws.section==='economics'?'rgba(10,132,255,0.12)':'rgba(255,255,255,0.04)') + ';font-family:' + FONT + ';text-align:left;width:100%">' +
    '<div style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center">' +
    '<svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="' + (ws.section==='economics'?'rgba(10,132,255,0.9)':'rgba(255,255,255,0.5)') + '" stroke-width="1.5" stroke-linecap="round"><path d="M1 13l4-5 3 3 6-8"/><circle cx="13" cy="3" r="1.3"/></svg>' +
    '</div>' +
    '<div><div style="font-size:11.5px;font-weight:600;color:' + (ws.section==='economics'?'rgba(10,132,255,0.95)':'rgba(255,255,255,0.82)') + ';letter-spacing:-.01em">Экономика</div>' +
    '<div style="font-size:9.5px;color:rgba(255,255,255,0.35);margin-top:2px">Где переплата</div></div>' +
    '</button>' +
    // Кнопка Заказы (4-я вкладка)
    ((): string => {
      const active = ws.section === 'orders'
      const hasUrgent = ws.postingsData?.postings?.some((p: any) => p.profitIfBought != null && p.profitIfBought < 0)
      const badge = hasUrgent ? '<div style="position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:#ff3b30"></div>' : ''
      return '<button class="pmg-sec" data-s="orders" style="position:relative;padding:12px 9px;border:0.5px solid ' + (active?'rgba(10,132,255,0.4)':'rgba(255,255,255,0.1)') + ';border-radius:12px;cursor:pointer;display:flex;flex-direction:column;gap:7px;transition:all .18s;background:' + (active?'rgba(10,132,255,0.12)':'rgba(255,255,255,0.04)') + ';font-family:' + FONT + ';text-align:left;width:100%">' +
        badge +
        '<div style="width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center">' +
        '<svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="' + (active?'rgba(10,132,255,0.9)':'rgba(255,255,255,0.5)') + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="13" height="11" rx="2"/><path d="M5 3V2a2.5 2.5 0 0 1 5 0v1"/><path d="M1 7h13M5 10h5"/></svg>' +
        '</div>' +
        '<div><div style="font-size:11.5px;font-weight:600;color:' + (active?'rgba(10,132,255,0.95)':'rgba(255,255,255,0.82)') + ';letter-spacing:-.01em">Заказы</div>' +
        '<div style="font-size:9.5px;color:rgba(255,255,255,0.35);margin-top:2px">В пути · прогноз</div></div>' +
        '</button>'
    })() +
    '</div>'

  const TABS: Array<{id: Period, label: string}> = [
    {id:'week',label:'Неделя'},{id:'month',label:'Месяц'},{id:'halfyear',label:'6 мес.'},{id:'custom',label:'📅'},
  ]
  const tabsHtml = '<div class="pmg-tabs" style="position:relative;z-index:1">' +
    TABS.map(t => '<div class="pmg-tab' + (ws.period===t.id?' on':'') + '" data-p="' + t.id + '">' + t.label + '</div>').join('') +
    '</div>'

  const datesHtml = ws.period === 'custom'
    ? '<div class="pmg-dates"><input class="pmg-dinp" type="date" id="pmg-df" value="' + ws.customFrom + '"><input class="pmg-dinp" type="date" id="pmg-dt" value="' + ws.customTo + '"><button class="pmg-dgo" id="pmg-dgo">→</button></div>'
    : ''

  const loadHtml = !ws.expanded
    ? ''  // главная — только кнопки
    : ws.loading
      ? '<div class="pmg-load-wrap"><div class="pmg-spin"></div><div class="pmg-load-txt">' + ws.loadMsg + '</div>' +
        (ws.loadPct > 0 ? '<div class="pmg-pbar-wrap"><div class="pmg-pbar" style="width:' + ws.loadPct + '%"></div></div><div class="pmg-load-txt" style="font-size:10px">' + ws.loadPct + '%</div>' : '') +
        '</div>'
      : ws.section === 'margin' ? renderMargin() : ws.section === 'abc' ? renderAbc() : ws.section === 'orders' ? renderOrders() : renderEconomics()

  const contentHtml = ws.expanded
    ? '<div style="height:0.5px;background:rgba(255,255,255,0.07);margin:0 12px;position:relative;z-index:1"></div>' +
      tabsHtml + datesHtml +
      '<div class="pmg-body">' + loadHtml + '</div>'
    : ''

  el.innerHTML = hdrHtml +
    '<div id="pmg-bd" style="' + (ws.collapsed ? 'display:none' : '') + '">' +
    menuHtml +
    contentHtml +
    footHtml + '</div>'

  bindHdr(el); bindMain(el)
  el.querySelectorAll('.pmg-card').forEach(card => addTilt(card as HTMLElement))
}

function renderLinkForm(): string {
  const cancelBtn = ws.accounts.length > 0
    ? '<button id="pmg-link-cancel" style="width:100%;padding:7px;border-radius:10px;border:0.5px solid rgba(0,0,0,0.12);cursor:pointer;background:transparent;color:#666;font-family:inherit;font-size:12px;margin-top:5px;">Отмена</button>'
    : ''
  return '<div style="padding:16px 14px 4px">' +
    '<div style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.85);margin-bottom:6px">🔑 Привязка Ozon API</div>' +

    // Seller API
    '<div style="font-size:10px;color:#0a84ff;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin:10px 0 4px">Seller API</div>' +
    '<div style="font-size:10px;color:#666;margin-bottom:8px;line-height:1.5">Ozon Seller → Настройки → API-ключи → Seller API</div>' +
    '<label class="pmg-link-lbl">Client-ID *</label>' +
    '<input id="pmg-link-cid" class="pmg-link-inp" type="text" placeholder="123456" value="' + (ws.pendingClientId || '') + '">' +
    '<label class="pmg-link-lbl">API-Key *</label>' +
    '<input id="pmg-link-key" class="pmg-link-inp" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">' +

    // Performance API
    '<div style="font-size:10px;color:#0a84ff;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin:14px 0 4px">Performance API (реклама, опционально)</div>' +
    '<div style="font-size:10px;color:#666;margin-bottom:8px;line-height:1.5">Ozon Seller → Настройки → API-ключи → Performance API → Добавить ключ</div>' +
    '<label class="pmg-link-lbl">Performance Client-ID</label>' +
    '<input id="pmg-link-pcid" class="pmg-link-inp" type="text" placeholder="123456">' +
    '<label class="pmg-link-lbl">Performance Client-Secret</label>' +
    '<input id="pmg-link-psecret" class="pmg-link-inp" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">' +

    // Налог — сразу показываем, пользователь выбирает
    '<div style="margin-top:12px">' +
    '<label class="pmg-link-lbl">Система налогообложения *</label>' +
    '<select id="pmg-link-tax" class="pmg-link-inp" style="padding:7px 10px">' +
    '<option value="usn6">УСН 6% (выручка &lt; 20 млн/год)</option>' +
    '<option value="usn6_nds5">УСН 6% + НДС 5% (20–272 млн/год)</option>' +
    '<option value="usn6_nds7">УСН 6% + НДС 7% (272–490 млн/год)</option>' +
    '<option value="osno_nds22">ОСНО + НДС 22% (с вычетом)</option>' +
    '</select>' +
    '</div>' +

    '<div id="pmg-link-err" style="display:none;font-size:11px;padding:6px 0"></div>' +
    '<button id="pmg-link-btn" class="pmg-link-btn" style="margin-top:12px">Привязать аккаунт →</button>' +
    cancelBtn + '</div>'
}

function renderAccSwitcher(): string {
  if (ws.accounts.length === 0) return ''
  // Берём ID из DOM (текущий кабинет), а не из БД (может быть устаревшим)
  const domId = getCurrentSellerIdFromDom()
  const active = domId ? (ws.accounts.find(a => a.clientId === domId) ?? ws.activeAccount) : ws.activeAccount
  const items = ws.accounts.map(acc =>
    '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:0.5px solid rgba(0,0,0,0.08)">' +
    '<div class="pmg-acc-item' + (acc.isActive ? ' pmg-acc-on' : '') + '" data-cid="' + acc.clientId + '" style="flex:1;border-bottom:none">' +
    (acc.isActive ? '✓ ' : '') + (acc.name || 'Кабинет') +
    '<div style="font-size:10px;color:#666">' + (acc.taxSystem ?? '').toUpperCase() + '</div>' +
    '</div>' +
    '<div class="pmg-acc-del" data-cid="' + acc.clientId + '" title="Удалить кабинет" ' +
    'style="padding:8px 10px;cursor:pointer;color:#B85040;font-size:14px;flex-shrink:0;opacity:0.6" ' +
    'onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">✕</div>' +
    '</div>'
  ).join('')
  return '<div id="pmg-acc-wrap" style="position:relative">' +
    '<button id="pmg-acc-btn" style="background:rgba(0,0,0,0.05);border:0.5px solid rgba(0,0,0,0.15);border-radius:8px;padding:3px 8px;cursor:pointer;font-size:11px;color:#7A5020;display:flex;align-items:center;gap:4px;font-family:inherit">' +
    (active?.name && active.name !== active?.clientId ? active.name.slice(0, 16) : 'Кабинет') + ' <span style="font-size:9px">▼</span></button>' +
    '<div class="pmg-acc-dd" id="pmg-acc-dd">' + items +
    '<div id="pmg-acc-add" style="padding:8px 12px;cursor:pointer;font-size:12px;color:#0a84ff;font-weight:600">+ Добавить кабинет</div>' +
    '</div></div>'
}

// ─── Блок Маржа ──────────────────────────────────────────────────────────────
function renderMargin(): string {
  const pd = ws.profitData
  if (!pd || !pd.net) return '<div style="padding:20px 14px;text-align:center;color:#923020;font-size:12px">Нет данных. Бэкенд запущен?</div>'

  const hasCosts  = pd.hasCosts === true
  const useProfit = hasCosts && pd.profit != null
  const pKey: 'week'|'month' = ws.period === 'week' ? 'week' : 'month'
  const netPeriod    = (pd.net as any)[pKey] ?? 0
  const profitPeriod = useProfit ? ((pd.profit as any)[pKey] ?? 0) : null
  const todayVal     = useProfit ? ((pd.profit as any).today ?? 0) : (pd.net.today ?? 0)
  const yesterdVal   = useProfit ? ((pd.profit as any).yesterday ?? 0) : (pd.net.yesterday ?? 0)
  const mainVal      = useProfit ? (profitPeriod ?? 0) : netPeriod

  const mPct  = pd.avgMarginPct != null ? pd.avgMarginPct : 0
  const showMgn = hasCosts && pd.avgMarginPct != null
  const delta = pd.deltaTodayVsYesterdayPct ?? null
  const dStr  = delta !== null ? ((delta > 0 ? '▲' : delta < 0 ? '▼' : '—') + ' ' + Math.abs(delta) + '%') : '—'

  const prods = safeProds()
  const costCount = prods.filter(p => p.cost != null && p.cost > 0).length

  // Кружок итоговый
  const totCirc = 2 * Math.PI * 18
  const totOff  = showMgn ? totCirc * (1 - Math.min(Math.max(mPct, 0), 100) / 100) : totCirc
  const totCol  = showMgn ? pctC(mPct) : '#A08060'

  const warnHtml = !hasCosts
    ? '<div class="pmg-warn">⚠ Введите себестоимость во вкладке «Товары» — тогда покажем реальную маржу.</div>'
    : (pd.noCostCount ?? 0) > 0
    ? '<div class="pmg-warn">⚠ У ' + pd.noCostCount + ' арт. не введена с/с — они не учтены в марже.</div>'
    : ''

  const taxBadge = showMgn && pd.taxSystem
    ? '<span style="font-size:9px;color:#666;font-weight:400"> · ' + pd.taxSystem.toUpperCase() + '</span>'
    : ''

  return '<div class="pmg-sec-header">' +
    '<span style="font-size:14px;font-weight:500;color:rgba(255,255,255,0.85)">' + (showMgn ? 'Маржа магазина' : 'Выплаты Ozon') + taxBadge + '</span>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    '<button id="pmg-export-btn" title="Экспорт P&L в CSV" style="padding:4px 9px;border-radius:7px;border:0.5px solid rgba(0,0,0,0.2);background:rgba(0,0,0,0.04);color:#555;font-size:11px;font-weight:600;cursor:pointer;font-family:' + FONT + '">⬇ P&L</button>' +
    '<div style="position:relative;width:44px;height:44px">' +
    '<svg width="44" height="44" viewBox="0 0 44 44" style="transform:rotate(-90deg);display:block">' +
    '<circle cx="22" cy="22" r="18" stroke-width="4" stroke="rgba(255,255,255,0.08)" fill="none"/>' +
    '<circle cx="22" cy="22" r="18" stroke-width="4" stroke="' + totCol + '" fill="none"' +
    ' stroke-dasharray="' + totCirc + '" stroke-dashoffset="' + totOff + '" stroke-linecap="round"/>' +
    '</svg>' +
    '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:' + SERIF + ';font-size:11px;color:rgba(255,255,255,0.85)">' + (showMgn ? mPct.toFixed(0) + '%' : '—') + '</div>' +
    '</div>' +  // close ring div
    '</div>' +  // close flex (button + ring)
    '</div>' +  // close pmg-sec-header

    '<div class="pmg-metrics">' +
    '<div class="pmg-mc"><div class="pmg-mc-l">За период</div><div class="pmg-mc-v" style="color:' + (mainVal >= 0 ? '#333' : '#923020') + '">' + fmtR(mainVal) + '</div></div>' +
    '<div class="pmg-mc"><div class="pmg-mc-l">Сегодня</div><div class="pmg-mc-v" style="color:' + (todayVal >= 0 ? '#333' : '#923020') + '">' + fmtR(todayVal) + '</div></div>' +
    '<div class="pmg-mc"><div class="pmg-mc-l">Вчера</div><div class="pmg-mc-v">' + fmtR(yesterdVal) + '</div></div>' +
    '<div class="pmg-mc"><div class="pmg-mc-l">Динамика</div><div class="pmg-mc-v" style="font-size:12px;color:' + ((delta ?? 0) >= 0 ? '#4A8030' : '#923020') + '">' + dStr + '</div></div>' +
    '</div>' +

    warnHtml +

    '<div class="pmg-grid">' +
    '<div class="pmg-card" id="pmg-c-margin"><div class="pmg-ring-wrap">' + (showMgn ? makePctRing(mPct, 56) : makeSvgRing(0, 100, 56)) + '</div><div class="pmg-card-label">Маржа<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + pctC(mPct) + '">' + (showMgn ? mPct.toFixed(1) + '%' : '—') + '</span></div></div>' +
    '<div class="pmg-card" id="pmg-c-revenue"><div class="pmg-ring-wrap">' + makeSvgRing(costCount, Math.max(prods.length, 1), 56) + '</div><div class="pmg-card-label">Оборот<br><span style="font-family:' + SERIF + ';font-size:13px;color:rgba(255,255,255,0.85)">' + fmtRA(netPeriod) + '</span></div></div>' +
    '<div class="pmg-card" id="pmg-c-cost"><div class="pmg-ring-wrap">' + makeSvgRing(costCount, Math.max(prods.length, 1), 56) + '</div><div class="pmg-card-label">С/С введена<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + (costCount === prods.length && prods.length > 0 ? '#4A8030' : '#0a84ff') + '">' + costCount + '/' + prods.length + '</span></div></div>' +
    '<div class="pmg-card" id="pmg-c-profit"><div class="pmg-ring-wrap">' + makeSvgRing(useProfit ? Math.max(0, Math.round(mPct)) : 0, 100, 56) + '</div><div class="pmg-card-label">Прибыль<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + ((profitPeriod ?? 0) >= 0 ? '#4A8030' : '#923020') + '">' + (useProfit ? fmtR(profitPeriod ?? 0) : '—') + '</span></div></div>' +
    '<div class="pmg-card full" id="pmg-c-abc"><div class="pmg-ring-wrap">' + makeSvgRing(prods.length, Math.max(prods.length, 1), 38) + '</div><div><div class="pmg-card-label">ABC-анализ товаров</div><div class="pmg-card-sub">нажмите — детализация по артикулам</div></div></div>' +
    '</div>'
}

// ─── Блок ABC ─────────────────────────────────────────────────────────────────
function renderAbc(): string {
  const d = ws.abcData
  if (!d) return '<div style="padding:20px 14px;text-align:center;color:#666;font-size:12px">Нажмите «Обновить» для загрузки ABC-анализа</div>'
  if (d.warning) return '<div style="padding:16px 14px"><div class="pmg-warn">' + d.warning + '</div></div>'
  if (!d.items?.length) return '<div style="padding:16px 14px;text-align:center;color:#666;font-size:12px">Нет данных за выбранный период</div>'

  const aCount = d.items.filter(i => i.abcSales === 'A').length

  function clsBadge(c: string) { return '<span class="pmg-cls pmg-cls-' + c + '">' + c + '</span>' }
  function totalCol(s: string): string {
    const aNum = s.split('').filter(c => c === 'А').length
    return aNum >= 3 ? '#4A8030' : aNum >= 2 ? '#7A8030' : aNum >= 1 ? '#7a5500' : '#923020'
  }

  const rows = d.items.map(item => {
    const dc = item.marginPct >= 20 ? '#6B9952' : item.marginPct >= 10 ? '#0a84ff' : '#B85040'
    const stockStr = item.stockDays >= 999 ? '∞' : item.stockDays === 0 ? '<span style="color:#923020">0д</span>' : item.stockDays + 'д'
    return '<tr><td><div style="display:flex;align-items:center;gap:4px"><span style="width:6px;height:6px;border-radius:50%;background:' + dc + ';flex-shrink:0;display:inline-block"></span><div><div class="pmg-aname" title="' + item.offerId + '">' + (item.isCurrent ? '🔄 ' : '') + item.offerId + '</div><div style="font-size:9px;color:#666">' + item.price + ' ₽</div></div></div></td>' +
      '<td style="text-align:center">' + clsBadge(item.abcSales) + '</td>' +
      '<td style="text-align:center">' + clsBadge(item.abcMargin) + '</td>' +
      '<td style="text-align:center">' + clsBadge(item.abcStock) + '</td>' +
      '<td style="text-align:center"><span class="pmg-tcls" style="color:' + totalCol(item.abcTotal) + '">' + item.abcTotal + '</span></td>' +
      '<td style="text-align:right;font-size:10.5px">' + fmtRA(item.revenue) + '</td>' +
      '<td style="text-align:right;font-weight:700;font-size:11px;color:' + pctC(item.marginPct) + '">' + item.marginPct.toFixed(0) + '%</td>' +
      '<td style="text-align:center;font-size:10.5px">' + stockStr + '</td></tr>'
  }).join('')

  return '<div class="pmg-sec-header"><span style="font-size:14px;font-weight:500;color:rgba(255,255,255,0.85)">ABC-анализ</span>' +
    '<div style="display:flex;align-items:center;gap:12px">' +
    '<div style="text-align:center"><div style="font-family:' + SERIF + ';font-size:18px;color:rgba(255,255,255,0.85)">' + fmtRA(d.totalRevenue) + '</div><div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:.05em">Оборот</div></div>' +
    '<div style="text-align:center"><div style="font-family:' + SERIF + ';font-size:18px;color:' + pctC(d.avgMarginPct) + '">' + d.avgMarginPct.toFixed(0) + '%</div><div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:.05em">Маржа</div></div>' +
    '</div></div>' +

    '<div class="pmg-grid" style="padding-bottom:8px">' +
    '<div class="pmg-card" id="pmg-abc-margin"><div class="pmg-ring-wrap">' + makeSvgRing(Math.round(Math.max(0, d.avgMarginPct)), 100, 56) + '</div><div class="pmg-card-label">Средняя маржа<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + pctC(d.avgMarginPct) + '">' + d.avgMarginPct.toFixed(1) + '%</span></div></div>' +
    '<div class="pmg-card" id="pmg-abc-a"><div class="pmg-ring-wrap">' + makeSvgRing(aCount, d.items.length, 56) + '</div><div class="pmg-card-label">Лидеры (А)<br><span style="font-family:' + SERIF + ';font-size:13px;color:#4A8030">' + aCount + ' из ' + d.items.length + '</span></div></div>' +
    '</div>' +

    '<div style="padding:0 14px 6px;font-size:9.5px;color:#666">' + Math.round(d.months) + ' мес. · ' + d.ordersTotal.toLocaleString('ru') + ' заказов · из отчётов реализации Ozon</div>' +
    '<div class="pmg-div"></div>' +
    '<div class="pmg-abc-wrap"><table class="pmg-abc"><thead><tr>' +
    '<th>Артикул</th><th style="text-align:center">Прод.</th><th style="text-align:center">Маржа</th>' +
    '<th style="text-align:center">Остат.</th><th style="text-align:center">Сводный</th>' +
    '<th style="text-align:right">Оборот</th><th style="text-align:right">Маржа%</th><th style="text-align:center">Дней</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    // Блок прогноза стока
    ((): string => {
      const sd = ws.stockData
      if (!sd) return ''
      const urgent = sd.items.filter(i => i.urgent)
      if (urgent.length === 0) return '<div style="padding:8px 14px;font-size:10px;color:#4A8030">✓ Критических угроз стоку нет</div>'
      const urgentRows = urgent.map(i =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 14px">' +
        '<div><div style="font-size:11.5px;color:rgba(255,255,255,0.82)">' + esc(i.offerId) + '</div>' +
        '<div style="font-size:9.5px;color:#666">~' + i.dailySales + '/день · сток ' + i.totalStock + ' шт</div></div>' +
        '<div style="text-align:right"><div style="font-size:12px;font-weight:700;color:#923020">' + i.daysLeft + ' дн.</div>' +
        (i.reorderQty > 0 ? '<div style="font-size:9px;color:#923020">заказать ' + i.reorderQty + ' шт</div>' : '') +
        '</div></div>'
      ).join('<div style="height:0.5px;background:rgba(255,255,255,0.05);margin:0 14px"></div>')
      return '<div class="pmg-div"></div>' +
        '<div style="padding:8px 14px 4px;font-size:10px;font-weight:600;color:#923020">🔴 Кончается в течение срока поставки (' + urgent.length + ')</div>' +
        urgentRows
    })()
}

// ─── Блок Экономика ─────────────────────────────────────────────────────────
const LOSS_ICON: Record<string, string> = {
  logistics_warehouse: '🚚', storage: '📦',
  cancels: '🔄', ads_eating_profit: '📢', acquiring: '💳',
}

function renderEconomics(): string {
  const d = ws.economicsData
  if (!d) return '<div style="padding:20px 14px;text-align:center;color:#666;font-size:12px">Нажмите «Обновить» для поиска потерь</div>'
  if (d.warning) return '<div style="padding:16px 14px"><div class="pmg-warn">' + esc(d.warning) + '</div></div>'
  if (!d.items?.length) return '<div style="padding:16px 14px;text-align:center;color:#666;font-size:12px">Не нашли значимых потерь за период — хороший знак</div>'

  // Сводка по типам потерь — сколько артикулов затронуто каждым типом
  const countByType: Record<string, number> = {}
  for (const item of d.items) for (const l of item.losses) countByType[l.type] = (countByType[l.type] ?? 0) + 1
  const typeBadges = Object.entries(countByType).map(([type, count]) =>
    '<span style="font-size:10px;padding:2px 7px;border-radius:99px;background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.6);white-space:nowrap">' +
    LOSS_ICON[type] + ' ×' + count + '</span>'
  ).join('')

  const rows = d.items.map(item => {
    const lossIcons = Array.from(new Set(item.losses.map(l => LOSS_ICON[l.type]))).join(' ')
    return '<tr class="pmg-econ-row" data-offer="' + esc(item.offerId) + '" style="cursor:pointer">' +
      '<td><div class="pmg-aname" title="' + esc(item.offerId) + '">' + esc(item.offerId) + '</div>' +
      '<div style="font-size:10px;color:#666;margin-top:2px">' + lossIcons + ' ' + item.losses.length + (item.losses.length === 1 ? ' проблема' : item.losses.length < 5 ? ' проблемы' : ' проблем') + '</div></td>' +
      '<td style="text-align:center;font-size:10.5px">' + item.ordersCount + '</td>' +
      '<td style="text-align:right;font-weight:700;font-size:12px;color:#923020">−' + item.totalLossRub.toLocaleString('ru') + ' ₽</td></tr>'
  }).join('')

  return '<div class="pmg-sec-header"><span style="font-size:14px;font-weight:500;color:rgba(255,255,255,0.85)">Экономика</span>' +
    '<div style="display:flex;align-items:center;gap:8px">' +
    '<button id="pmg-econ-export-btn" title="Экспорт в CSV с исходными данными" style="padding:4px 9px;border-radius:7px;border:0.5px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.7);font-size:11px;font-weight:600;cursor:pointer;font-family:' + FONT + '">⬇ CSV</button>' +
    '<div style="text-align:center"><div style="font-family:' + SERIF + ';font-size:18px;color:#923020">−' + (d.totalLossRub >= 100000 ? Math.round(d.totalLossRub/1000)+'k' : d.totalLossRub.toLocaleString('ru')) + '</div><div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:.05em">Потери, ₽</div></div>' +
    '</div></div>' +

    (typeBadges ? '<div style="padding:0 14px 8px;display:flex;gap:6px;flex-wrap:wrap">' + typeBadges + '</div>' : '') +

    '<div style="padding:0 14px 8px"><div class="pmg-warn">⚠ ' + d.withLosses + ' из ' + d.totalAnalyzed + ' артикул' + (d.withLosses === 1 ? '' : d.withLosses < 5 ? 'а' : 'ов') + ' теряет деньги. Нажмите на артикул, чтобы увидеть полную расшифровку.</div></div>' +

    '<div style="padding:0 14px 6px;font-size:9.5px;color:#666">' + d.months + ' мес. · логистика, хранение, отмены, реклама без продаж, эквайринг — из реальных транзакций Ozon</div>' +
    '<div class="pmg-div"></div>' +
    '<div class="pmg-abc-wrap"><table class="pmg-abc"><thead><tr>' +
    '<th>Артикул</th><th style="text-align:center">Заказов</th><th style="text-align:right">Потери</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>'
}

// ─── Привязка событий ─────────────────────────────────────────────────────────
function bindHdr(el: HTMLElement) {
  el.querySelector('#pmg-hdr')?.addEventListener('click', () => { ws.collapsed = !ws.collapsed; renderW(el) })
  el.querySelector('#pmg-tog')?.addEventListener('click', e => { e.stopPropagation(); ws.collapsed = !ws.collapsed; renderW(el) })

  // Экспорт P&L
  el.querySelector('#pmg-export-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation()
    const btn = el.querySelector('#pmg-export-btn') as HTMLButtonElement
    if (btn) { btn.textContent = '⏳'; btn.disabled = true }
    try {
      const data = await apiGet<any>('/api/export/pnl')
      const rows = data.rows as any[]
      const BOM = '\uFEFF'
      const header = 'Артикул;Продаж;Цена в ЛК;Цена покупателя;Комиссия Ozon/шт (факт);Выплата Ozon/шт;Себестоимость;Налог/шт;Прибыль/шт;Маржа % (от цены покупателя);Выручка (цена покупателя);Прибыль итого;Период'
      const lines = rows.map(r =>
        [r.offerId, r.deliveries, r.priceInLK, r.avgBuyerPrice, r.avgCommission ?? '', r.avgPayout, r.cost, r.tax,
         r.netPerUnit, r.marginPct ?? '', r.revenue, r.profit, data.months].join(';')
      )
      const csv = BOM + header + '\n' + lines.join('\n')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'pnl_' + new Date().toISOString().slice(0,10) + '.csv'
      a.click(); URL.revokeObjectURL(url)
    } catch (err: any) { alert('Ошибка экспорта: ' + err.message) }
    finally { if (btn) { btn.textContent = '⬇ P&L'; btn.disabled = false } }
  })

  // Клик на строку в «Экономике» — открываем расшифровку именно НАЙДЕННЫХ
  // ПОТЕРЬ (не полную юнит-экономику товара, как в openBreakdown). Данные уже
  // есть в ws.economicsData — не нужно подгружать что-то дополнительно.
  el.querySelectorAll('.pmg-econ-row').forEach(row => row.addEventListener('click', () => {
    const offerId = (row as HTMLElement).dataset.offer
    if (!offerId || !ws.economicsData) return
    const item = ws.economicsData.items.find(i => i.offerId === offerId)
    if (item) openLossesBreakdown(item)
  }))

  // Экспорт «Экономики» — все 6 категорий с исходными цифрами для ручной
  // проверки в Excel (число заказов, суммы по складам, период и т.п.)
  el.querySelector('#pmg-econ-export-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation()
    const btn = el.querySelector('#pmg-econ-export-btn') as HTMLButtonElement
    if (btn) { btn.textContent = '⏳'; btn.disabled = true }
    try {
      const data = await apiGet<any>('/api/export/economics' + periodQS())
      const BOM = '\uFEFF'

      const logHeader = 'Артикул;Дата;Схема (FBO/FBS);Склад;Литраж на момент доставки;Цена товара;Логистика факт ₽;Логистика норма ₽;Переплата ₽;Это потеря?'
      const logLines = (data.logisticsRows as any[]).map(r =>
        [r.offerId, r.date, r.scheme, r.warehouseId, r.volumeLitersAtTime ?? 'нет данных', r.priceRub,
         r.logisticsFactRub, r.logisticsNormRub ?? 'нет нормы', r.overpayRub, r.isLoss].join(';')
      )

      const sumHeader = 'Артикул;Заказов;Хранение ₽ итого;Отмен шт;Сумма отмен ₽;% отмен;Отмены — потеря?;Эквайринг ₽ итого;Эквайринг ₽/заказ;Среднее по магазину ₽/заказ;Эквайринг — потеря?;Реклама за 60д ₽;Целевая маржа %;Реклама — потеря?'
      const sumLines = (data.summaryRows as any[]).map(r =>
        [r.offerId, r.ordersCount, r.storageRubTotal, r.cancelCount, r.cancelAmountRub, r.cancelRatePct, r.cancelIsLoss,
         r.acquiringAmountRub, r.acquiringPerOrder, r.avgAcquiringShop, r.acquiringIsLoss,
         r.adsSpend60dRub, r.targetMarginPct ?? 'не задана', r.adsIsLoss].join(';')
      )

      const csv = BOM +
        'ЛИСТ 1 — ЛОГИСТИКА (по каждой доставке)\n' + logHeader + '\n' + logLines.join('\n') +
        '\n\nЛИСТ 2 — СВОДКА ПО ТОВАРУ (хранение/отмены/эквайринг/реклама)\n' + sumHeader + '\n' + sumLines.join('\n') +
        '\n\nПериод: ' + data.period.from + ' — ' + data.period.to +
        '\n\n' + (data.note ?? '')
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'economics_' + new Date().toISOString().slice(0,10) + '.csv'
      a.click(); URL.revokeObjectURL(url)
    } catch (err: any) { alert('Ошибка экспорта: ' + err.message) }
    finally { if (btn) { btn.textContent = '⬇ CSV'; btn.disabled = false } }
  })
}

function bindLinkForm(el: HTMLElement) {
  el.querySelector('#pmg-link-cancel')?.addEventListener('click', () => { ws.showLinkForm = false; renderW(el) })
  el.querySelector('#pmg-link-btn')?.addEventListener('click', async () => {
    const cid     = (el.querySelector('#pmg-link-cid')    as HTMLInputElement)?.value?.trim()
    const key     = (el.querySelector('#pmg-link-key')    as HTMLInputElement)?.value?.trim()
    const pcid    = (el.querySelector('#pmg-link-pcid')   as HTMLInputElement)?.value?.trim()
    const psecret = (el.querySelector('#pmg-link-psecret')as HTMLInputElement)?.value?.trim()
    const taxSys  = (el.querySelector('#pmg-link-tax')    as HTMLSelectElement)?.value
    const errEl   = el.querySelector('#pmg-link-err') as HTMLElement | null
    const btn     = el.querySelector('#pmg-link-btn') as HTMLButtonElement | null

    const showErr = (msg: string) => {
      if (errEl) { errEl.textContent = msg; errEl.style.color = '#923020'; errEl.style.display = 'block' }
      if (btn)   { btn.textContent = 'Привязать аккаунт →'; btn.disabled = false }
    }

    if (!cid || !key) return showErr('Заполните Seller API: Client-ID и API-Key')
    // Performance API опционально — если не заполнено, пропускаем
    if (!taxSys) return showErr('Выберите систему налогообложения')

    if (btn) { btn.textContent = 'Сохраняю…'; btn.disabled = true }
    if (errEl) errEl.style.display = 'none'

    try {
      await apiPost<any>('/api/accounts', {
        clientId:        cid,
        apiKey:          key,
        perfClientId:    pcid,
        perfClientSecret: psecret,
        taxSystem:       taxSys,
        setActive:       true,
      })
      ws.showLinkForm = false; ws.accounts = []; ws.activeAccount = null
      await loadAccounts()
      await loadBase(el)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      showErr(msg.includes('401') || msg.includes('Неверные') ? 'Неверные ключи — проверьте данные' : 'Ошибка: ' + msg)
    }
  })
}

function bindMain(el: HTMLElement) {
  // Единая точка выбора, что грузить для текущей секции — чтобы не разводить
  // одну и ту же тройную проверку (margin/abc/economics) по разным хендлерам.
  function loadForCurrentSection() {
    if (ws.section === 'abc') loadAbc(el)
    else if (ws.section === 'economics') loadEconomics(el)
    else if (ws.section === 'orders') loadOrders(el)
    else loadBase(el)
  }

  el.querySelector('#pmg-ref')?.addEventListener('click', e => { e.stopPropagation(); loadAll(el) })

  el.querySelectorAll('.pmg-sec').forEach(t => t.addEventListener('click', e => {
    e.stopPropagation()
    const newSection = (t as HTMLElement).dataset.s as 'margin'|'abc'|'economics'|'orders'
    if (ws.expanded && ws.section === newSection) {
      // повторный клик — сворачиваем
      ws.expanded = false; renderW(el); return
    }
    ws.section = newSection
    ws.expanded = true
    renderW(el)
    if (!ws.loading) loadForCurrentSection()
  }))

  el.querySelector('#pmg-c-abc')?.addEventListener('click', e => {
    e.stopPropagation(); ws.section = 'abc'; renderW(el)
    if (!ws.loading) loadAbc(el)
  })

  el.querySelectorAll('.pmg-tab').forEach(t => t.addEventListener('click', e => {
    e.stopPropagation()
    ws.period = (t as HTMLElement).dataset.p as Period
    ws.abcData = null; ws.economicsData = null; renderW(el)
    if (ws.period !== 'custom') loadForCurrentSection()
  }))

  el.querySelector('#pmg-dgo')?.addEventListener('click', e => {
    e.stopPropagation()
    const f = (el.querySelector('#pmg-df') as HTMLInputElement)?.value
    const t = (el.querySelector('#pmg-dt') as HTMLInputElement)?.value
    if (f && t) { ws.customFrom = f; ws.customTo = t; ws.abcData = null; ws.economicsData = null; loadForCurrentSection() }
  })

  // Переключатель аккаунтов
  const accBtn = el.querySelector('#pmg-acc-btn') as HTMLElement | null
  const accDd  = el.querySelector('#pmg-acc-dd')  as HTMLElement | null
  accBtn?.addEventListener('click', e => {
    e.stopPropagation()
    if (accDd) accDd.style.display = accDd.style.display === 'none' ? 'block' : 'none'
  })
  const _closeAccDd = () => { if (accDd) accDd.style.display = 'none' }
  document.addEventListener('click', _closeAccDd, { once: true })
  el.querySelectorAll('.pmg-acc-item').forEach(item => item.addEventListener('click', async e => {
    e.stopPropagation()
    const cid = (item as HTMLElement).dataset.cid
    if (!cid || cid === ws.activeAccount?.clientId) return
    await apiPost('/api/accounts/switch', { clientId: cid })
    await loadAccounts(); ws.abcData = null; await loadBase(el)
  }))
  el.querySelector('#pmg-acc-add')?.addEventListener('click', e => {
    e.stopPropagation(); ws.showLinkForm = true; renderW(el)
  })

  // Удаление аккаунта
  el.querySelectorAll('.pmg-acc-del').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation()
    const cid = (btn as HTMLElement).dataset.cid
    if (!cid) return
    const accName = ws.accounts.find(a => a.clientId === cid)?.name || cid
    if (!confirm('Удалить кабинет «' + accName + '»?')) return
    try {
      await bgFetch(API_BASE + '/api/accounts/' + cid, { method: 'DELETE' })
      ws.accounts = ws.accounts.filter(a => a.clientId !== cid)
      if (ws.activeAccount?.clientId === cid) {
        ws.activeAccount = ws.accounts[0] ?? null
        ws.profitData = null; ws.abcData = null; ws.products = []
        if (ws.activeAccount) {
          await apiPost('/api/accounts/switch', { clientId: ws.activeAccount.clientId })
        }
      }
      renderW(el)
      if (ws.accounts.length > 0 && ws.activeAccount) await loadBase(el)
    } catch (e: any) {
      alert('Ошибка удаления: ' + String(e?.message ?? e))
    }
  }))

  // Клик на строку заказа → модалка с детализацией юнит-экономики
  el.querySelectorAll('.pmg-orders-row').forEach(row => row.addEventListener('click', () => {
    const postingNumber = (row as HTMLElement).dataset.posting
    if (!postingNumber || !ws.postingsData) return
    const p = ws.postingsData.postings.find(x => x.postingNumber === postingNumber)
    if (p) openPostingBreakdown(p)
  }))
}

// ─── Загрузка данных ──────────────────────────────────────────────────────────
function periodQS(): string {
  if (ws.period === 'custom') return '?from=' + ws.customFrom + '&to=' + ws.customTo
  const days = ws.period === 'week' ? 7 : ws.period === 'month' ? 30 : 183
  const to   = new Date(), from = new Date(Date.now() - days * 86_400_000)
  return '?from=' + from.toISOString().slice(0, 10) + '&to=' + to.toISOString().slice(0, 10)
}

// ─── Блок Заказы ─────────────────────────────────────────────────────────────
function renderOrders(): string {
  const d = ws.postingsData
  if (!d) return '<div style="padding:20px 14px;text-align:center;color:#666;font-size:12px">Нажмите «Обновить» для загрузки активных заказов</div>'
  if (!d.postings?.length) return '<div style="padding:16px 14px;text-align:center;color:#666;font-size:12px">Нет активных FBO-заказов за последние 14 дней</div>'

  const profitable = d.postings.filter(p => p.profitIfBought != null && p.profitIfBought >= 0).length
  const losing     = d.postings.filter(p => p.profitIfBought != null && p.profitIfBought < 0).length
  const noCost     = d.postings.filter(p => p.cost == null).length

  const STATUS_LABEL: Record<string, string> = {
    awaiting_packaging: '📦 Упаковка', awaiting_deliver: '🏭 На складе', delivering: '🚚 В пути',
  }

  const rows = d.postings.map(p => {
    const profit = p.profitIfBought
    const hasData = profit != null
    const pColor = !hasData ? '#666' : profit >= 0 ? '#4A8030' : '#923020'
    const pSign  = !hasData ? '' : profit >= 0 ? '+' : ''
    const profitStr = hasData ? pSign + profit.toLocaleString('ru') + ' ₽' : '—'
    const lossStr = p.lossIfNotBought != null ? p.lossIfNotBought.toLocaleString('ru') + ' ₽' : '—'
    const nonLocalBadge = p.nonLocalPct > 0
      ? '<span style="font-size:9px;padding:1px 5px;border-radius:99px;background:rgba(255,150,60,0.15);color:rgba(255,150,60,0.9);border:0.5px solid rgba(255,150,60,0.3)">+' + p.nonLocalPct + '% нелок.</span>'
      : ''
    const statusLabel = STATUS_LABEL[p.status] ?? p.status
    return '<tr class="pmg-orders-row" data-posting="' + esc(p.postingNumber) + '" style="cursor:pointer">' +
      '<td><div class="pmg-aname" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(p.productName) + '">' + esc(p.offerId) + '</div>' +
      '<div style="font-size:9px;color:#666;margin-top:2px">' + esc(statusLabel) + ' ' + nonLocalBadge + '</div></td>' +
      '<td style="text-align:center;font-size:10.5px">' + p.buyerPrice.toLocaleString('ru') + '</td>' +
      '<td style="text-align:right;font-weight:700;font-size:11.5px;color:' + pColor + '">' + profitStr + '</td>' +
      '<td style="text-align:right;font-size:10.5px;color:#923020">' + lossStr + '</td>' +
      '</tr>'
  }).join('')

  const nonLocalNote = d.applyNonLocal
    ? '<div style="font-size:9.5px;color:rgba(255,150,60,0.8);padding:0 14px 6px">⚠ Наценка за нелокальность применяется (' + d.fboWeeklyCount + ' FBO/нед ≥ 50)</div>'
    : (d.fboWeeklyCount > 0 ? '<div style="font-size:9.5px;color:#666;padding:0 14px 6px">ℹ Наценка за нелокальность не применяется (' + d.fboWeeklyCount + ' FBO/нед < 50)</div>' : '')

  return '<div class="pmg-sec-header">' +
    '<span style="font-size:14px;font-weight:500;color:rgba(255,255,255,0.85)">Заказы</span>' +
    '<div style="display:flex;gap:12px;align-items:center">' +
    (losing > 0 ? '<div style="text-align:center"><div style="font-family:' + SERIF + ';font-size:18px;color:#923020">' + losing + '</div><div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:.05em">Убыт.</div></div>' : '') +
    '<div style="text-align:center"><div style="font-family:' + SERIF + ';font-size:18px;color:#4A8030">' + profitable + '</div><div style="font-size:9px;color:#666;text-transform:uppercase;letter-spacing:.05em">Прибыл.</div></div>' +
    '</div></div>' +
    (noCost > 0 ? '<div style="padding:0 14px 8px"><div class="pmg-warn">⚠ У ' + noCost + ' заказ(а) не введена с/с — прибыль не считается. Введите в таблице товаров.</div></div>' : '') +
    nonLocalNote +
    '<div style="padding:0 14px 4px;font-size:9.5px;color:#666">' + d.postings.length + ' активных заказов · расчёт по тарифам Ozon · нажмите на строку для деталей</div>' +
    '<div class="pmg-div"></div>' +
    '<div class="pmg-abc-wrap"><table class="pmg-abc"><thead><tr>' +
    '<th>Артикул</th><th style="text-align:center">Цена</th><th style="text-align:right">Если выкупят</th><th style="text-align:right">Если не выкупят</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>'
}

async function loadBase(el: HTMLElement) {
  if (ws.accounts.length === 0) { await loadAccounts(); renderW(el); if (ws.accounts.length === 0) return }
  ws.loading = true; ws.loadMsg = 'Загружаю данные…'; ws.loadPct = 0; renderW(el)
  try {
    const qs = periodQS()
    const [profitData, productsData] = await Promise.all([
      apiGet<ProfitData>('/api/profit' + qs),
      apiGet<{ items: Product[] }>('/api/products'),
    ])
    ws.profitData = profitData ?? null
    ws.products   = Array.isArray(productsData?.items) ? productsData.items : []
    ws.refreshedAt = new Date()
  } catch (e: any) { console.error('[PMG] loadBase:', e) }
  finally { ws.loading = false; renderW(el) }
}

async function loadAbc(el: HTMLElement) {
  ws.loading = true; ws.loadMsg = 'Загружаю отчёты реализации…'; ws.loadPct = 10; renderW(el)
  try {
    const [abc, stock] = await Promise.all([
      apiGet<AbcData>('/api/abc' + periodQS()),
      apiGet<StockForecastData>('/api/stock-forecast'),
    ])
    ws.abcData = abc ?? null; ws.stockData = stock ?? null; ws.refreshedAt = new Date()
  } catch (e: any) { console.warn('[PMG] loadAbc:', e); ws.abcData = null }
  finally { ws.loading = false; renderW(el) }
}

async function loadEconomics(el: HTMLElement) {
  ws.loading = true; ws.loadMsg = 'Сравниваю логистику по транзакциям…'; ws.loadPct = 10; renderW(el)
  try {
    const data = await apiGet<EconomicsData>('/api/economics' + periodQS())
    ws.economicsData = data ?? null; ws.refreshedAt = new Date()
  } catch (e: any) { console.warn('[PMG] loadEconomics:', e); ws.economicsData = null }
  finally { ws.loading = false; renderW(el) }
}

async function loadOrders(el: HTMLElement) {
  ws.loading = true; ws.loadMsg = 'Загружаю активные заказы…'; ws.loadPct = 10; renderW(el)
  try {
    const data = await apiGet<PostingsData>('/api/postings')
    ws.postingsData = data ?? null; ws.refreshedAt = new Date()
    // Обновляем Chrome badge с числом заказов с отрицательной прибылью
    updateBadge()
  } catch (e: any) { console.warn('[PMG] loadOrders:', e); ws.postingsData = null }
  finally { ws.loading = false; renderW(el) }
}

// Chrome extension badge — показывает число "проблемных" заказов (убыточных)
function updateBadge() {
  try {
    const bad = ws.postingsData?.postings?.filter(p => p.profitIfBought != null && p.profitIfBought < 0).length ?? 0
    const total = ws.postingsData?.postings?.length ?? 0
    if (typeof chrome !== 'undefined' && chrome.action) {
      if (bad > 0) {
        chrome.action.setBadgeText({ text: String(bad) })
        chrome.action.setBadgeBackgroundColor({ color: '#ff3b30' })
      } else if (total > 0) {
        chrome.action.setBadgeText({ text: String(total) })
        chrome.action.setBadgeBackgroundColor({ color: '#34c759' })
      } else {
        chrome.action.setBadgeText({ text: '' })
      }
    }
  } catch {}  // не в контексте расширения
}

async function loadAll(el: HTMLElement) {
  await loadBase(el)
  if (ws.section === 'abc') await loadAbc(el)
  else if (ws.section === 'economics') await loadEconomics(el)
  else if (ws.section === 'orders') await loadOrders(el)
}

// ─── Инит ────────────────────────────────────────────────────────────────────
let profitStarted = false
async function initProfitWidget() {
  if (profitStarted) return; profitStarted = true
  document.getElementById('pmg-profit')?.remove()
  if (!document.getElementById('pmg-profit-css')) {
    const s = document.createElement('style'); s.id = 'pmg-profit-css'; s.textContent = W_CSS
    document.head.appendChild(s)
  }
  const el = document.createElement('div'); el.id = 'pmg-profit'; document.body.appendChild(el)
  renderW(el)
  await loadAccounts()
  renderW(el)
  if (ws.accounts.length === 0) {
    // Нет привязанных аккаунтов — показываем форму
    ws.pendingClientId = getCurrentSellerIdFromDom() ?? ''
    ws.showLinkForm = true
    renderW(el)
    return
  }
  // Синхронизируем активный аккаунт с текущим кабинетом из DOM
  await syncAccountWithDom(el)
  // НЕ загружаем данные при старте — только когда пользователь нажмёт кнопку
  renderW(el)
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── BREAKDOWN ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// ─── РАСШИФРОВКА ПОТЕРЬ (вкладка «Экономика») ───────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// Визуальный язык как у openBreakdown (стекло, цветные пятна, волна от мыши),
// но это ОТДЕЛЬНАЯ модалка с другим содержанием: показывает именно найденные
// потери по категориям с суммами, а не полную юнит-экономику товара.
const LOSS_LABEL_DETAIL: Record<string, string> = {
  logistics_warehouse: 'Логистика',
  storage: 'Хранение',
  cancels: 'Отмены',
  ads_eating_profit: 'Реклама',
  acquiring: 'Эквайринг',
}

// ── Детализация заказа (модалка «Заказы» → клик на строку) ──────────────────
function openPostingBreakdown(p: PostingItem) {
  document.getElementById('pmg-posting-bd')?.remove()
  if (!document.getElementById('pmg-profit-css')) {
    const s = document.createElement('style'); s.id = 'pmg-profit-css'; s.textContent = W_CSS
    document.head.appendChild(s)
  }
  const ov = document.createElement('div'); ov.id = 'pmg-posting-bd'
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0);backdrop-filter:blur(0px);transition:background .35s ease,backdrop-filter .35s ease;'

  const m = document.createElement('div')
  m.style.cssText = 'background:rgba(255,255,255,0.09);backdrop-filter:blur(60px) saturate(180%) brightness(1.05);-webkit-backdrop-filter:blur(60px) saturate(180%) brightness(1.05);border-radius:22px;border:0.5px solid rgba(255,255,255,0.15);box-shadow:0 1px 0 rgba(255,255,255,0.15) inset,0 28px 80px rgba(0,0,0,0.55);width:380px;max-width:95vw;max-height:90vh;overflow-y:auto;font-family:' + FONT + ';position:relative;opacity:0;transform:scale(0.94) translateY(10px);transition:opacity .3s ease,transform .35s cubic-bezier(.34,1.4,.64,1);'

  const glow1 = '<div style="position:absolute;width:220px;height:220px;border-radius:50%;background:rgba(10,132,255,0.15);filter:blur(60px);top:-60px;left:-40px;pointer-events:none;z-index:0"></div>'
  const glow2 = '<div style="position:absolute;width:180px;height:180px;border-radius:50%;background:rgba(52,199,89,0.1);filter:blur(50px);bottom:-40px;right:-20px;pointer-events:none;z-index:0"></div>'

  const ROW = (label: string, val: string, color = 'rgba(255,255,255,0.72)', sub = '') =>
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 20px" onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'transparent\'">' +
    '<div><div style="font-size:13px;color:rgba(255,255,255,0.72)">' + esc(label) + '</div>' +
    (sub ? '<div style="font-size:10.5px;color:rgba(255,255,255,0.32);margin-top:2px">' + esc(sub) + '</div>' : '') +
    '</div><div style="font-size:13px;font-weight:500;color:' + color + ';white-space:nowrap;margin-left:12px">' + val + '</div></div>'
  const DIV = () => '<div style="height:0.5px;background:rgba(255,255,255,0.07);margin:0"></div>'
  const SEC = (t: string) => '<div style="font-size:10px;color:rgba(255,255,255,0.28);text-transform:uppercase;letter-spacing:.09em;font-weight:600;padding:12px 20px 4px">' + t + '</div>'

  const profitColor = p.profitIfBought == null ? '#888' : p.profitIfBought >= 0 ? '#4A8030' : '#923020'
  const STATUS_LABEL: Record<string, string> = { awaiting_packaging: '📦 Упаковка', awaiting_deliver: '🏭 На складе', delivering: '🚚 В пути' }

  m.innerHTML = glow1 + glow2 + '<div style="position:relative;z-index:2">' +

    // Шапка
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:15px 20px 12px;border-bottom:0.5px solid rgba(255,255,255,0.07)">' +
    '<div><div style="font-size:10px;color:rgba(255,255,255,0.28);letter-spacing:.09em;text-transform:uppercase;margin-bottom:2px">' + esc(STATUS_LABEL[p.status] ?? p.status) + ' · FBO</div>' +
    '<div style="font-size:16px;font-weight:600;color:rgba(255,255,255,0.9);letter-spacing:-.3px">' + esc(p.offerId) + '</div>' +
    '<div style="font-size:10.5px;color:rgba(255,255,255,0.35);margin-top:3px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.productName) + '</div>' +
    '</div><button id="pmg-pb-x" style="width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">' +
    '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.8" stroke-linecap="round"><path d="M1 1l9 9M10 1L1 10"/></svg></button></div>' +

    SEC('Параметры доставки') +
    ROW('Маршрут', esc(p.clusterFrom) + ' → ' + esc(p.clusterTo), 'rgba(255,255,255,0.65)') +
    ROW('Склад', esc(p.warehouseName), 'rgba(255,255,255,0.55)') +
    ROW('Тип доставки', esc(p.deliveryType), 'rgba(255,255,255,0.55)') +
    DIV() +

    SEC('Расходы') +
    ROW('Цена покупателя', p.buyerPrice.toLocaleString('ru') + ' ₽', 'rgba(255,255,255,0.85)',
      p.coinvestRub != null && p.coinvestRub > 0
        ? 'соинвест Ozon ' + p.coinvestRub.toLocaleString('ru') + ' ₽ · налог с ' + p.taxBuyerPrice.toLocaleString('ru') + ' ₽'
        : 'налог считается с этой цены') +
    ROW('Комиссия Ozon', '−' + p.commRub.toLocaleString('ru') + ' ₽', 'rgba(255,80,70,0.9)', p.commPct + '% FBO') +
    ROW('Логистика',
      p.logisticsTotal != null ? '−' + p.logisticsTotal.toLocaleString('ru') + ' ₽' : '—',
      'rgba(255,80,70,0.9)',
      p.logisticsNorm != null ? ('норма ' + p.logisticsNorm + ' ₽' + (p.nonLocalPct > 0 ? ' +' + p.nonLocalPct + '% нелокальность (+' + p.nonLocalRub + ' ₽)' : '')) : 'нет данных по литражу') +
    ROW('Эквайринг', '−' + p.acquiringRub.toLocaleString('ru') + ' ₽', 'rgba(255,80,70,0.9)', '≈1.5%') +
    (p.taxRub != null ? ROW('Налог', '−' + p.taxRub.toLocaleString('ru') + ' ₽', 'rgba(255,80,70,0.9)') : '') +
    (p.cost != null ? ROW('Себестоимость', '−' + p.cost.toLocaleString('ru') + ' ₽', 'rgba(255,80,70,0.9)') : ROW('Себестоимость', 'не введена', '#888')) +
    (p.advPerUnit != null ? ROW('Реклама/заказ', '−' + Math.round(p.advPerUnit).toLocaleString('ru') + ' ₽', 'rgba(255,80,70,0.9)', 'среднее из Performance API') : '') +
    DIV() +

    SEC('Итог') +
    ROW('Выплата от Ozon', p.payoutRub.toLocaleString('ru') + ' ₽', 'rgba(255,255,255,0.72)', 'до вычета с/с и рекламы') +

    // Если выкупят
    '<div style="margin:10px 20px 6px;padding:12px 16px;border-radius:14px;background:' +
    (p.profitIfBought == null ? 'rgba(255,255,255,0.04)' : p.profitIfBought >= 0 ? 'rgba(52,199,89,0.08)' : 'rgba(255,59,48,0.08)') +
    ';border:0.5px solid ' + (p.profitIfBought == null ? 'rgba(255,255,255,0.1)' : p.profitIfBought >= 0 ? 'rgba(52,199,89,0.25)' : 'rgba(255,59,48,0.25)') + '">' +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
    '<div style="font-size:12px;color:rgba(255,255,255,0.6)">Если выкупят</div>' +
    '<div style="font-size:22px;font-weight:700;color:' + profitColor + '">' +
    (p.profitIfBought != null ? (p.profitIfBought >= 0 ? '+' : '') + p.profitIfBought.toLocaleString('ru') + ' ₽' : 'нет с/с') +
    '</div></div></div>' +

    // Если не выкупят
    '<div style="margin:0 20px 16px;padding:12px 16px;border-radius:14px;background:rgba(255,59,48,0.06);border:0.5px solid rgba(255,59,48,0.2)">' +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
    '<div><div style="font-size:12px;color:rgba(255,255,255,0.6)">Если не выкупят</div>' +
    (p.returnLogistics != null ? '<div style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:2px">обратная логистика ≈' + p.returnLogistics + ' ₽</div>' : '') +
    '</div><div style="font-size:20px;font-weight:700;color:#923020">' +
    (p.lossIfNotBought != null ? p.lossIfNotBought.toLocaleString('ru') + ' ₽' : '—') +
    '</div></div></div>' +

    '</div>'

  ov.appendChild(m); document.body.appendChild(ov)
  requestAnimationFrame(() => {
    ov.style.background = 'rgba(0,0,0,0.5)'; ov.style.backdropFilter = 'blur(8px)'
    ;(ov.style as any).webkitBackdropFilter = 'blur(8px)'
    requestAnimationFrame(() => { m.style.opacity = '1'; m.style.transform = 'scale(1) translateY(0)' })
  })
  const closeModal = () => {
    m.style.opacity = '0'; m.style.transform = 'scale(0.96) translateY(8px)'
    ov.style.background = 'rgba(0,0,0,0)'; ov.style.backdropFilter = 'blur(0px)'
    setTimeout(() => ov.remove(), 320)
  }
  ov.onclick = e => { if (e.target === ov) closeModal() }
  m.querySelector('#pmg-pb-x')?.addEventListener('click', closeModal)
}

function openLossesBreakdown(item: EconomicsItem) {
  document.getElementById('pmg-losses')?.remove()
  if (!document.getElementById('pmg-profit-css')) {
    const s = document.createElement('style'); s.id = 'pmg-profit-css'; s.textContent = W_CSS
    document.head.appendChild(s)
  }

  const ov = document.createElement('div'); ov.id = 'pmg-losses'
  ov.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0);
    backdrop-filter:blur(0px);
    transition:background .35s ease, backdrop-filter .35s ease;
  `

  const m = document.createElement('div')
  m.style.cssText = `
    background:rgba(255,255,255,0.09);
    backdrop-filter:blur(60px) saturate(180%) brightness(1.05);
    -webkit-backdrop-filter:blur(60px) saturate(180%) brightness(1.05);
    border-radius:22px;
    border:0.5px solid rgba(255,255,255,0.15);
    box-shadow:0 1px 0 rgba(255,255,255,0.15) inset, 0 28px 80px rgba(0,0,0,0.55);
    width:380px;max-width:95vw;max-height:90vh;
    overflow-y:auto;overflow-x:hidden;
    font-family:${FONT};
    position:relative;
    opacity:0;
    transform:scale(0.94) translateY(10px);
    transition:opacity .3s ease, transform .35s cubic-bezier(.34,1.4,.64,1);
  `

  const glow1 = document.createElement('div')
  glow1.style.cssText = 'position:absolute;width:220px;height:220px;border-radius:50%;background:rgba(214,86,86,0.18);filter:blur(60px);top:-60px;left:-40px;pointer-events:none;z-index:0'
  const glow2 = document.createElement('div')
  glow2.style.cssText = 'position:absolute;width:180px;height:180px;border-radius:50%;background:rgba(255,150,60,0.13);filter:blur(50px);bottom:-40px;right:-20px;pointer-events:none;z-index:0'

  let lastWaveT = 0
  m.addEventListener('mousemove', (e) => {
    const now = Date.now(); if (now - lastWaveT < 120) return; lastWaveT = now
    const r = m.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    const w = document.createElement('div')
    const sz = 80
    w.style.cssText = `position:absolute;border-radius:50%;border:1px solid rgba(255,255,255,0.12);width:${sz}px;height:${sz}px;left:${x-sz/2}px;top:${y-sz/2}px;transform:scale(0);pointer-events:none;z-index:1;animation:pmg-wave .7s cubic-bezier(0,.5,.5,1) forwards`
    m.appendChild(w); w.addEventListener('animationend', () => w.remove())
  })

  const ROW = (label: string, detail: string, val: string) =>
    `<div style="display:flex;justify-content:space-between;align-items:flex-start;
        padding:10px 20px;position:relative;overflow:hidden;cursor:default;"
      onmouseover="this.style.background='rgba(255,255,255,0.04)'"
      onmouseout="this.style.background='transparent'">
      <div style="flex:1;z-index:1;padding-right:10px">
        <div style="font-size:13px;color:rgba(255,255,255,0.82);font-weight:500">${esc(label)}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.42);margin-top:3px;line-height:1.4">${esc(detail)}</div>
      </div>
      <div style="font-size:14px;font-weight:600;color:rgba(255,107,107,0.95);white-space:nowrap;margin-left:8px;z-index:1">${val}</div>
    </div>`
  const DIV = () => '<div style="height:0.5px;background:rgba(255,255,255,0.07);margin:0"></div>'
  const SEC = (t: string) => `<div style="font-size:10px;color:rgba(255,255,255,0.28);text-transform:uppercase;letter-spacing:.09em;font-weight:600;padding:12px 20px 6px">${t}</div>`

  const rows = item.losses.map((l, idx) =>
    ROW(LOSS_LABEL_DETAIL[l.type] ?? l.label, l.detail, '−' + l.amountRub.toLocaleString('ru') + ' ₽') +
    (idx < item.losses.length - 1 ? DIV() : '')
  ).join('')

  m.innerHTML = `
    ${glow1.outerHTML}${glow2.outerHTML}
    <div style="position:relative;z-index:2">

    <div style="display:flex;align-items:center;justify-content:space-between;padding:15px 20px 12px;border-bottom:0.5px solid rgba(255,255,255,0.07)">
      <div>
        <div style="font-size:10px;color:rgba(255,255,255,0.28);letter-spacing:.09em;text-transform:uppercase;font-weight:500;margin-bottom:2px">Pomogator · Экономика</div>
        <div style="font-size:17px;font-weight:600;color:rgba(255,255,255,0.9);letter-spacing:-.3px">${esc(item.offerId)}</div>
      </div>
      <button id="pmg-loss-x" style="width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.8" stroke-linecap="round"><path d="M1 1l9 9M10 1L1 10"/></svg>
      </button>
    </div>

    ${SEC('Найденные потери · ' + item.ordersCount + ' заказ(ов) за период')}
    ${rows}

    <div style="margin:10px 20px 16px;padding:14px 16px;border-radius:14px;background:rgba(255,107,107,0.08);border:0.5px solid rgba(255,107,107,0.25);display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:13px;font-weight:500;color:rgba(255,255,255,0.7)">Итого потерь</div>
      <div style="font-size:22px;font-weight:600;color:rgba(255,107,107,0.95)">−${item.totalLossRub.toLocaleString('ru')} ₽</div>
    </div>

    </div>
  `

  ov.appendChild(m)
  document.body.appendChild(ov)

  requestAnimationFrame(() => {
    ov.style.background = 'rgba(0,0,0,0.5)'
    ov.style.backdropFilter = 'blur(8px)'
    ;(ov.style as any).webkitBackdropFilter = 'blur(8px)'
    requestAnimationFrame(() => {
      m.style.opacity = '1'
      m.style.transform = 'scale(1) translateY(0)'
    })
  })

  const closeModal = () => {
    m.style.opacity = '0'; m.style.transform = 'scale(0.96) translateY(8px)'
    ov.style.background = 'rgba(0,0,0,0)'; ov.style.backdropFilter = 'blur(0px)'
    setTimeout(() => ov.remove(), 320)
  }
  ov.onclick = e => { if (e.target === ov) closeModal() }
  m.querySelector('#pmg-loss-x')?.addEventListener('click', closeModal)
}

function openBreakdown(p: Product) {
  document.getElementById('pmg-breakdown')?.remove()
  // Инжектируем кейфреймы если ещё не загружены
  if (!document.getElementById('pmg-profit-css')) {
    const s = document.createElement('style'); s.id = 'pmg-profit-css'; s.textContent = W_CSS
    document.head.appendChild(s)
  }
  const price = p.price||0
  const commPctFbo = p.commissionPctFbo || p.commissionPercent || 0
  const commPctFbs = p.commissionPctFbs || 0
  const commPct = commPctFbo  // для основного расчёта (FBO дефолт)
  const commRub = Math.round(price * commPct / 100)
  // Текст комиссии — показываем оба процента если FBS отличается от FBO
  const commLabel = (commPctFbs > 0 && commPctFbs !== commPctFbo)
    ? `FBO ${commPctFbo}% · FBS ${commPctFbs}%`
    : `${commPctFbo}% от ${price.toLocaleString('ru')} ₽`
  const log = p.logistics||0, acq = Math.round(price*0.015), cost = p.cost||0
  const net = Math.round(price-commRub-log-acq-cost)
  const mColor = (p.marginPct??0)>=20?'rgba(52,199,89,0.95)':(p.marginPct??0)>=10?'rgba(255,204,0,0.9)':'rgba(255,80,70,0.95)'

  // Размываем страницу
  const pageContent = document.querySelector('#app, main, [class*="container"], [class*="page"]') as HTMLElement|null

  const ov = document.createElement('div'); ov.id = 'pmg-breakdown'
  ov.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,0);
    backdrop-filter:blur(0px);
    transition:background .35s ease, backdrop-filter .35s ease;
  `

  const m = document.createElement('div')
  m.style.cssText = `
    background:rgba(255,255,255,0.09);
    backdrop-filter:blur(60px) saturate(180%) brightness(1.05);
    -webkit-backdrop-filter:blur(60px) saturate(180%) brightness(1.05);
    border-radius:22px;
    border:0.5px solid rgba(255,255,255,0.15);
    box-shadow:0 1px 0 rgba(255,255,255,0.15) inset, 0 28px 80px rgba(0,0,0,0.55);
    width:380px;max-width:95vw;max-height:90vh;
    overflow-y:auto;overflow-x:hidden;
    font-family:${FONT};
    position:relative;
    opacity:0;
    transform:scale(0.94) translateY(10px);
    transition:opacity .3s ease, transform .35s cubic-bezier(.34,1.4,.64,1);
  `

  // Цветовые пятна внутри стекла
  const glow1 = document.createElement('div')
  glow1.style.cssText = 'position:absolute;width:220px;height:220px;border-radius:50%;background:rgba(88,86,214,0.2);filter:blur(60px);top:-60px;left:-40px;pointer-events:none;z-index:0'
  const glow2 = document.createElement('div')
  glow2.style.cssText = 'position:absolute;width:180px;height:180px;border-radius:50%;background:rgba(10,132,255,0.15);filter:blur(50px);bottom:-40px;right:-20px;pointer-events:none;z-index:0'

  // Волна при движении мыши
  let lastWaveT = 0
  m.addEventListener('mousemove', (e) => {
    const now = Date.now(); if (now - lastWaveT < 120) return; lastWaveT = now
    const r = m.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    const w = document.createElement('div')
    const sz = 80
    w.style.cssText = `position:absolute;border-radius:50%;border:1px solid rgba(255,255,255,0.12);width:${sz}px;height:${sz}px;left:${x-sz/2}px;top:${y-sz/2}px;transform:scale(0);pointer-events:none;z-index:1;animation:pmg-wave .7s cubic-bezier(0,.5,.5,1) forwards`
    m.appendChild(w); w.addEventListener('animationend', () => w.remove())
  })

  // Вспомогательные функции рендера
  const T = (s: string, c = 'rgba(255,255,255,0.75)', fw = '400', fs = '13px') =>
    `<span style="font-size:${fs};color:${c};font-weight:${fw}">${s}</span>`
  const ROW = (label: string, val: string, valColor = 'rgba(255,80,70,0.9)', sub = '', id = '') =>
    `<div ${id?`id="${id}"`:''}
      style="display:flex;justify-content:space-between;align-items:flex-start;
        padding:8px 20px;position:relative;overflow:hidden;cursor:default;"
      onmouseover="this.style.background='rgba(255,255,255,0.04)'"
      onmouseout="this.style.background='transparent'">
      <div style="flex:1;z-index:1">
        <div style="font-size:13px;color:rgba(255,255,255,0.72)">${label}</div>
        ${sub?`<div style="font-size:11px;color:rgba(255,255,255,0.32);margin-top:1px">${sub}</div>`:''}
      </div>
      <div style="font-size:13px;font-weight:500;color:${valColor};white-space:nowrap;margin-left:8px;z-index:1">${val}</div>
    </div>`
  const DIV = () => '<div style="height:0.5px;background:rgba(255,255,255,0.07);margin:0"></div>'
  const SEC = (t: string) => `<div style="font-size:10px;color:rgba(255,255,255,0.28);text-transform:uppercase;letter-spacing:.09em;font-weight:600;padding:12px 20px 6px">${t}</div>`
  const BOX = (id: string, content: string, color = 'rgba(255,255,255,0.06)', border = 'rgba(255,255,255,0.1)') =>
    `<div id="${id}" style="margin:6px 20px;padding:10px 14px;border-radius:13px;background:${color};border:0.5px solid ${border}">${content}</div>`

  m.innerHTML = `
    ${glow1.outerHTML}${glow2.outerHTML}
    <div style="position:relative;z-index:2">

    <!-- Шапка -->
    <div style="display:flex;align-items:center;justify-content:space-between;padding:15px 20px 12px;border-bottom:0.5px solid rgba(255,255,255,0.07)">
      <div>
        <div style="font-size:10px;color:rgba(255,255,255,0.28);letter-spacing:.09em;text-transform:uppercase;font-weight:500;margin-bottom:2px">Pomogator</div>
        <div style="font-size:17px;font-weight:600;color:rgba(255,255,255,0.9);letter-spacing:-.3px">${esc(p.offerId)}</div>
      </div>
      <button id="pmg-bd-x" style="width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.8" stroke-linecap="round"><path d="M1 1l9 9M10 1L1 10"/></svg>
      </button>
    </div>

    <!-- Блок 1: Удержания Ozon -->
    ${SEC('Удержания Ozon')}
    ${ROW('Комиссия категории', '−'+commRub.toLocaleString('ru')+' ₽', 'rgba(255,80,70,0.9)', commLabel)}
    <div id="pmg-bd-log" style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 20px;cursor:default" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='transparent'">
      <div style="flex:1"><div style="font-size:13px;color:rgba(255,255,255,0.72)">Логистика FBO</div><div id="pmg-bd-log-sub" style="font-size:11px;color:rgba(255,255,255,0.32);margin-top:1px">⏳ уточняется…</div></div>
      <div id="pmg-bd-log-val" style="font-size:13px;font-weight:500;color:rgba(255,80,70,0.9);white-space:nowrap;margin-left:8px">−${log.toLocaleString('ru')} ₽</div>
    </div>
    <div id="pmg-bd-acq-row" style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 20px;cursor:default" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='transparent'">
      <div style="flex:1"><div style="font-size:13px;color:rgba(255,255,255,0.72)">Эквайринг</div><div id="pmg-bd-acq-sub" style="font-size:11px;color:rgba(255,255,255,0.32);margin-top:1px">≈1.5% · уточняется…</div></div>
      <div id="pmg-bd-acq-val" style="font-size:13px;font-weight:500;color:rgba(255,80,70,0.9);white-space:nowrap;margin-left:8px">−${acq.toLocaleString('ru')} ₽</div>
    </div>
    <div id="pmg-bd-adv-base"></div>
    ${DIV()}
    ${BOX('pmg-bd-after-ozon-box',
      '<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:12px;color:rgba(255,255,255,0.42)">Выплата от Ozon</span><span id="pmg-bd-after-ozon" style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.88)">⏳</span></div>'
    )}

    <!-- Блок 2: Ваши расходы -->
    ${SEC('Ваши расходы')}
    ${ROW('Себестоимость', cost>0?'−'+cost.toLocaleString('ru')+' ₽':'—', cost>0?'rgba(255,80,70,0.9)':'rgba(255,255,255,0.28)', cost>0?Math.round(cost/price*100)+'% от цены':'введите в поле с/с')}
    <div id="pmg-bd-analytics"></div>

    <!-- Итог -->
    <div id="pmg-bd-result" style="margin:8px 20px 12px;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:13px;font-weight:500;color:rgba(255,255,255,0.6)">Прибыль / шт</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.28);margin-top:2px">⏳ загружается…</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:24px;font-weight:600;color:${mColor}">${p.marginPct??0}%</div>
        <div style="font-size:13px;color:${mColor}">${net>=0?'+':''}${net.toLocaleString('ru')} ₽</div>
      </div>
    </div>

    <!-- История маржи -->
    <div id="pmg-bd-history"></div>

    <!-- Кнопка плана -->
    <div style="padding:0 20px 16px">
      <button id="pmg-bd-plan" style="width:100%;padding:11px;border-radius:13px;background:rgba(255,255,255,0.07);border:0.5px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.65);font-family:${FONT};font-size:13px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:background .15s">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="1" width="12" height="12" rx="2.5"/><path d="M4 5h6M4 7.5h6M4 10h3.5"/></svg>
        Открыть план
      </button>
    </div>

    </div>
  `

  ov.appendChild(m); document.body.appendChild(ov)

  // Анимация появления
  requestAnimationFrame(() => {
    ov.style.background = 'rgba(0,0,0,0.5)'
    ov.style.backdropFilter = 'blur(8px)'
    ;(ov.style as any).webkitBackdropFilter = 'blur(8px)'
    requestAnimationFrame(() => {
      m.style.opacity = '1'
      m.style.transform = 'scale(1) translateY(0)'
    })
  })

  const closeModal = () => {
    m.style.opacity = '0'; m.style.transform = 'scale(0.96) translateY(8px)'
    ov.style.background = 'rgba(0,0,0,0)'; ov.style.backdropFilter = 'blur(0px)'
    setTimeout(() => ov.remove(), 320)
  }

  ov.onclick = e => { if (e.target === ov) closeModal() }
  m.querySelector('#pmg-bd-x')!.addEventListener('click', closeModal)
  const planBtnEl = m.querySelector('#pmg-bd-plan') as HTMLButtonElement
  planBtnEl.onmouseenter = () => { planBtnEl.style.background = 'rgba(255,255,255,0.11)' }
  planBtnEl.onmouseleave = () => { planBtnEl.style.background = 'rgba(255,255,255,0.07)' }
  planBtnEl.onclick = () => { closeModal(); setTimeout(() => openPlan(p.offerId), 100) }

  // Загружаем аналитику с автоповтором пока реклама грузится
  const loadAnalytics = (retryCount = 0) => {
    apiGet<any>('/api/analytics/' + encodeURIComponent(p.offerId)).then(a => {
      const elA = document.getElementById('pmg-bd-analytics'); if (!elA) return

      // Если реклама ещё грузится — повторяем каждые 30 сек до 20 раз (10 минут)
      if (a.advLoading && retryCount < 20) {
        setTimeout(() => {
          // На повторах — только обновляем строку рекламы если модалка ещё открыта
          if (!document.getElementById('pmg-bd-analytics')) return
          apiGet<any>('/api/analytics/' + encodeURIComponent(p.offerId)).then(a2 => {
            const advEl = document.getElementById('pmg-adv-row')
            if (!advEl) return // модалка закрыта
            if (a2.advPerUnit != null) {
              // Нашли данные — заменяем спиннер на результат
              advEl.outerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:0.5px solid rgba(0,0,0,0.08)">' +
                '<div style="flex:1"><div style="font-size:15px;color:#444;font-weight:600">Реклама</div>' +
                '<div style="font-size:12px;color:#666;margin-top:2px;line-height:1.4">итого ' + (a2.advTotal ? Math.round(a2.advTotal).toLocaleString('ru') + ' ₽' : '') + ' · на ' + (a2.deliveryCount || a2.realizDeliveries || 0) + ' продаж</div></div>' +
                '<div style="font-family:' + SERIF + ';font-size:18px;color:#923020;font-weight:700;margin-left:16px;white-space:nowrap">−' + a2.advPerUnit + ' ₽</div></div>'
            } else if (a2.advLoading) {
              // Всё ещё грузится — следующая попытка
              setTimeout(() => loadAnalytics(retryCount + 1), 30_000)
            } else {
              // Загрузка завершена, артикул не в рекламе
              advEl.outerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:0.5px solid rgba(0,0,0,0.08)">' +
                '<div style="flex:1"><div style="font-size:15px;color:#444;font-weight:600">Реклама</div>' +
                '<div style="font-size:12px;color:#666;margin-top:2px">нет активных кампаний</div></div>' +
                '<div style="font-family:' + SERIF + ';font-size:18px;color:#666;font-weight:700;margin-left:16px">—</div></div>'
            }
          }).catch(() => {})
        }, 30_000)
      }
    if (a.avgLogistics != null) {
      const lv = document.getElementById('pmg-bd-log-val'), ls = document.getElementById('pmg-bd-log-sub')
      if (lv) lv.textContent = '−' + a.avgLogistics + ' ₽'
      let logSub = 'среднее · ' + Math.round(a.avgLogistics / price * 100) + '% от цены'
      if (a.nonLocalPct > 0 && a.avgLogisticsLocal != null && a.avgLogisticsNonLocal != null) {
        logSub += ' · ' + a.nonLocalPct + '% нелокальных (лок. ' + a.avgLogisticsLocal + ' ₽ / нелок. ' + a.avgLogisticsNonLocal + ' ₽)'
      } else if (a.nonLocalPct === 0 && (a.localCount || 0) > 0) {
        logSub += ' · все доставки локальные'
      }
      if (ls) ls.textContent = logSub
    }
    const acqReal = a.acquiringPerUnit ?? 0
    if (acqReal > 0) {
      const acqEl = document.getElementById('pmg-bd-acq-val'), acqSub = document.getElementById('pmg-bd-acq-sub')
      if (acqEl) acqEl.textContent = '−' + acqReal + ' ₽'
      if (acqSub) acqSub.textContent = 'реальный · ' + Math.round(acqReal / price * 100) + '% от цены'
    }

    const TAX_LABELS: Record<string,string> = { usn6:'УСН 6%', usn6_nds5:'УСН 6% + НДС 5%', usn6_nds7:'УСН 6% + НДС 7%', osno_nds22:'ОСНО + НДС 22%' }
    const rRow = (l: string, v: string, c = 'rgba(255,80,70,0.9)', s = '') =>
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 20px;cursor:default" onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'transparent\'">' +
      '<div style="flex:1"><div style="font-size:13px;color:rgba(255,255,255,0.72)">' + l + '</div>' +
      (s ? '<div style="font-size:11px;color:rgba(255,255,255,0.32);margin-top:1px">' + s + '</div>' : '') + '</div>' +
      '<div style="font-size:13px;font-weight:500;color:' + c + ';white-space:nowrap;margin-left:8px">' + v + '</div></div>'

    // Реклама → блок 1 (Ozon charges)
    const advEl = document.getElementById('pmg-bd-adv-base')
    if (advEl) {
      advEl.style.display = 'block'
      if (a.advPerUnit != null) {
        advEl.innerHTML = rRow('Реклама', '−' + a.advPerUnit + ' ₽/шт', '#923020',
          'итого ' + Math.round(a.advTotal ?? 0).toLocaleString('ru') + ' ₽ · ' + esc(a.deliveryCount || 0) + ' выкупов за 90 дней')
      } else if (a.advLoading) {
        advEl.innerHTML = '<div id="pmg-adv-row" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.08)">' +
          '<div><div style="font-size:12px;color:#444;font-weight:600">Реклама</div>' +
          '<div style="font-size:10px;color:#666;margin-top:1px">⏳ Загружается из Performance API…</div></div>' +
          '<div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:50%;border:2px solid rgba(0,0,0,0.1);border-top-color:#0a84ff;animation:pmg-s .7s linear infinite"></div>' +
          '<span style="font-size:10px;color:#666">~5 мин</span></div></div>'
      } else if (a.advTotal != null) {
        advEl.innerHTML = rRow('Реклама', '−' + Math.round(a.advTotal).toLocaleString('ru') + ' ₽', '#923020', 'итого за период')
      } else {
        // Реклама загружена, артикул не участвует в кампаниях
        advEl.innerHTML = rRow('Реклама', '—', '#666', 'нет активных кампаний')
      }
    }

    // "После вычета Ozon" = payoutPerUnit (то что реально пришло на счёт)
    const payoutVal = a.payoutPerUnit ?? null
    const afterOzonEl = document.getElementById('pmg-bd-after-ozon')
    if (afterOzonEl && payoutVal != null) {
      afterOzonEl.textContent = '+' + payoutVal.toLocaleString('ru') + ' ₽'
      afterOzonEl.title = 'Цена − комиссия − логистика − эквайринг · ' + (a.deliveryCount || 0) + ' доставок за 90 дней'
    }

    // Налог → блок 2
    const tb = a.taxBreakdown
    const taxRow = tb
      ? rRow('Налог', '−' + tb.totalTax + ' ₽/шт', '#923020',
          (TAX_LABELS[tb.taxSystem] ?? tb.taxSystem) +
          (a.avgBuyerPrice ? ' · цена покупателя ' + a.avgBuyerPrice.toLocaleString('ru') + ' ₽' : ''))
      : rRow('Налог', '—', '#666', cost > 0 ? 'нет данных' : 'введите себестоимость')

    const storageRow = a.storagePerUnit != null && Math.round(a.storagePerUnit * 10) > 0
      ? rRow('Хранение FBO', '≈−' + a.storagePerUnit + ' ₽',
          a.turnoverGrade === 'DEFICIT' ? '#4A8030' : '#0a84ff',
          (a.turnoverGrade === 'DEFICIT' ? 'Дефицит' : 'Норма') + (a.fboAvailable ? ' · ' + a.fboAvailable + ' шт' : ''))
      : ''

    // Прибыль = выплата от Ozon − себестоимость − реклама − налог − хранение
    const advCost = a.advPerUnit ?? 0
    const taxCost = tb?.totalTax ?? 0
    const storageCost = a.storagePerUnit ?? 0
    const netReal = payoutVal != null ? Math.round(payoutVal - cost - advCost - taxCost - storageCost) : null
    const mgnReal = payoutVal != null && payoutVal > 0 ? Math.round((netReal ?? 0) / payoutVal * 100) : null
    const rC = (mgnReal ?? 0) >= 20 ? '#4A8030' : (mgnReal ?? 0) >= 10 ? '#7a5500' : '#923020'

    // Обновляем бейдж
    if (cache[p.offerId] && mgnReal !== null) {
      cache[p.offerId].marginPct = mgnReal
      cache[p.offerId].light = mgnReal >= 20 ? 'green' : mgnReal >= 10 ? 'yellow' : 'red'
      const b = document.querySelector('[data-offer="' + p.offerId + '"].pmg-b') as HTMLElement | null
      if (b) { const lc = LIGHT[cache[p.offerId].light]; b.style.background = lc.bg; b.style.borderColor = lc.border; b.style.color = lc.color; b.textContent = '● ' + mgnReal + '% маржа'; b.style.cursor = 'pointer' }
    }

    // Заполняем блок 2
    elA.innerHTML = taxRow + storageRow +
      (a.cancelCount > 0 ? rRow('Отмены', '−' + a.cancelLogPerUnit + ' ₽', '#0a84ff', a.cancelRate + '% · ' + a.cancelCount + ' шт') : '')

    // Итог
    const re = document.getElementById('pmg-bd-result')
    if (re) {
      const subText = 'выплата − с/с − реклама − налог' + (storageCost > 0 ? ' − хранение' : '')
      re.style.background = netReal != null && netReal >= 0 ? 'rgba(107,153,82,0.08)' : 'rgba(184,80,64,0.08)'
      re.style.borderColor = netReal != null && netReal >= 0 ? 'rgba(107,153,82,0.3)' : 'rgba(184,80,64,0.3)'
      re.innerHTML =
        '<div><div style="font-size:12px;color:#444;font-weight:700">Прибыль / шт</div>' +
        '<div style="font-size:10px;color:#666;margin-top:2px">' + subText + '</div></div>' +
        '<div style="text-align:right">' +
        '<div style="font-family:' + SERIF + ';font-size:22px;color:' + rC + ';font-weight:700">' + (mgnReal ?? '—') + (mgnReal != null ? '%' : '') + '</div>' +
        (netReal != null ? '<div style="font-family:' + SERIF + ';font-size:13px;color:' + rC + '">' + (netReal >= 0 ? '+' : '') + netReal.toLocaleString('ru') + ' ₽</div>' : '') +
        '</div>'
    }

    }).catch(err => {
      const elA = document.getElementById('pmg-bd-analytics')
      if (elA) elA.innerHTML = '<span style="color:#923020;font-size:12px">Ошибка: ' + esc(err.message) + '</span>'
    })
  }
  loadAnalytics()

  // История маржи
  apiGet<any>('/api/margin-history/' + encodeURIComponent(p.offerId)).then(h => {
    const el = document.getElementById('pmg-bd-history'); if (!el || !h.history?.length) return
    const months = h.history as { month: string; deliveries: number; payout: number; marginPct: number | null; buyerPrice: number | null }[]
    const maxAbs = Math.max(...months.map(m => Math.abs(m.marginPct ?? 0)), 1)

    el.innerHTML =
      '<div style="font-size:10px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:8px">История маржи · ' + months.length + ' мес</div>' +
      '<div style="display:flex;align-items:flex-end;gap:6px;height:60px;margin-bottom:4px">' +
      months.map(m => {
        const pct = m.marginPct ?? 0
        const barH = Math.round(Math.abs(pct) / maxAbs * 54)
        const col = pct >= 15 ? 'rgba(52,199,89,0.85)' : pct >= 0 ? 'rgba(255,204,0,0.85)' : 'rgba(255,59,48,0.85)'
        const label = m.month.slice(5)
        return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">' +
          '<div style="font-size:9px;color:' + col + ';font-weight:700">' + pct + '%</div>' +
          '<div title="' + label + ': ' + pct + '% · ' + m.deliveries + ' шт · выплата ' + m.payout + ' ₽" style="width:100%;background:' + col + ';border-radius:3px 3px 0 0;height:' + barH + 'px;min-height:3px;cursor:default;opacity:0.8"></div>' +
          '<div style="font-size:8px;color:rgba(255,255,255,0.28)">' + label + '</div></div>'
      }).join('') + '</div>'
  }).catch(() => {})
}

// ─── PLAN ────────────────────────────────────────────────────────────────────
function openPlan(offerId: string) {
  document.getElementById('pmg-plan')?.remove()
  const p = cache[offerId] ?? { offerId, price:0, commissionPercent:0, commissionRub:0, logistics:0, cost:null, net:null, marginPct:null, light:'no_cost' as const }
  const ov = document.createElement('div'); ov.id = 'pmg-plan'
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;'
  const m = document.createElement('div')
  m.style.cssText = 'background:rgba(255,255,255,0.08);backdrop-filter:blur(50px) saturate(160%);-webkit-backdrop-filter:blur(50px) saturate(160%);border-radius:20px;border:0.5px solid rgba(255,255,255,0.13);padding:28px 32px;width:420px;max-width:95vw;font-family:' + FONT + ';position:relative;box-shadow:0 1px 0 rgba(255,255,255,0.12) inset,0 24px 64px rgba(0,0,0,0.6);'
  const field = (id: string, label: string, val: number) =>
    '<div><label style="font-size:11px;color:#666;display:block;margin-bottom:4px">' + label + '</label>' +
    '<input id="' + id + '" type="number" value="' + val + '" style="width:100%;padding:9px 12px;border-radius:10px;box-sizing:border-box;border:0.5px solid rgba(0,0,0,0.15);background:rgba(255,255,255,0.9);color:#333;font-family:' + FONT + ';font-size:14px;outline:none;"></div>'
  m.innerHTML =
    '<button id="pmg-plan-x" style="position:absolute;top:14px;right:16px;background:none;border:none;cursor:pointer;font-size:20px;color:#666;">✕</button>' +
    '<div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Pomogator · План</div>' +
    '<div style="font-family:' + SERIF + ';font-size:20px;color:rgba(255,255,255,0.85);margin-bottom:20px">' + esc(offerId) + '</div>' +
    '<div style="display:grid;gap:10px;margin-bottom:16px">' + field('pmg-qty','Желаемое кол-во продаж, шт',100) + field('pmg-drr','Целевой ДРР, %',15) + field('pmg-mgn','Целевая маржа, %',25) + '</div>' +
    '<div id="pmg-res" style="padding:14px 16px;background:rgba(255,255,255,0.7);border:0.5px solid rgba(0,0,0,0.12);border-radius:14px;margin-bottom:14px;"></div>' +
    '<button id="pmg-calc" style="width:100%;padding:11px;border-radius:12px;border:none;cursor:pointer;background:#0a84ff;color:#fff;font-family:' + FONT + ';font-size:14px;font-weight:600;">Рассчитать</button>'
  ov.appendChild(m); document.body.appendChild(ov)
  ov.onclick = e => { if (e.target === ov) ov.remove() }
  m.querySelector('#pmg-plan-x')!.addEventListener('click', () => ov.remove())
  function calc() {
    const qty  = Number((m.querySelector('#pmg-qty') as HTMLInputElement).value)||0
    const drr  = Number((m.querySelector('#pmg-drr') as HTMLInputElement).value)||0
    const tMgn = Number((m.querySelector('#pmg-mgn') as HTMLInputElement).value)||0
    const res  = m.querySelector('#pmg-res')!
    const price=p.price||0, commPct=p.commissionPercent||0, log=p.logistics||0, cost=p.cost||0
    const commRub=Math.round(price*commPct/100), acq=Math.round(price*0.015), ad=Math.round(price*drr/100)
    const net=Math.round(price-commRub-log-acq-cost-ad), aMgn=price>0?Math.round(net/price*100):0
    const coef=1-commPct/100-0.015-drr/100-tMgn/100, minP=coef>0?Math.round((log+cost)/coef):null
    const mc=aMgn>=20?'#4A8030':aMgn>=10?'#7a5500':'#923020'
    const row=(l:string,v:string,c='#333')=>'<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:0.5px solid rgba(0,0,0,0.1)"><span style="font-size:12px;color:#444">'+l+'</span><span style="font-family:'+SERIF+';font-size:13px;color:'+c+'">'+v+'</span></div>'
    res.innerHTML=row('Кол-во',qty+' шт')+row('Выручка',(price*qty).toLocaleString('ru')+' ₽')+row('Комиссия','−'+(commRub*qty).toLocaleString('ru')+' ₽','#923020')+row('Логистика','−'+(log*qty).toLocaleString('ru')+' ₽','#923020')+row('Реклама ('+drr+'%)','−'+(ad*qty).toLocaleString('ru')+' ₽','#923020')+row('Маржа факт.',aMgn+'%',mc)+row('Чистыми',(net>=0?'+':'')+(net*qty).toLocaleString('ru')+' ₽',net>=0?'#4A8030':'#923020')+(minP!==null?row('Мин. цена ('+tMgn+'%)',minP.toLocaleString('ru')+' ₽',minP<=price?'#4A8030':'#923020'):'')+
    (aMgn<tMgn?'<div style="margin-top:8px;padding:7px 10px;background:rgba(184,80,64,0.08);border-radius:8px;font-size:11px;color:#923020">⚠ Маржа ниже цели'+(cost===0?' — введите с/с':'')+'</div>':'<div style="margin-top:8px;padding:7px 10px;background:rgba(107,153,82,0.08);border-radius:8px;font-size:11px;color:#4A8030">✓ Цель достигается</div>')
  }
  m.querySelector('#pmg-calc')!.addEventListener('click', calc); calc()
}

// ─── Роутер ───────────────────────────────────────────────────────────────────
function isProducts(p: string) {
  // Только /app/products и /app/products/ — ничего больше
  return p === '/app/products' || p === '/app/products/'
}
function isMain(p: string) { return p.includes('dashboard') || p.includes('main') || p==='/app' || p==='/app/' }

function init() {
  const path = window.location.pathname
  console.log('[PMG] init:', path)
  if (isMain(path))     initProfitWidget()
  if (isProducts(path)) initTable()
  setInterval(() => {
    const cur = window.location.pathname
    if (isMain(cur) && !document.getElementById('pmg-profit')) initProfitWidget()
    if (isProducts(cur)) initTable()
    // Убираем элементы таблицы если ушли со страницы товаров
    if (!isProducts(cur)) {
      document.getElementById('pmg-import-btn')?.remove()
      tableStarted = false
    }
  }, 1000)

  // Следим за сменой кабинета — проверяем каждые 3 секунды
  let lastSellerIdCheck = ''
  setInterval(async () => {
    const domId = getCurrentSellerIdFromDom()
    if (!domId || domId === lastSellerIdCheck) return
    lastSellerIdCheck = domId
    const el = document.getElementById('pmg-profit')
    if (!el) return
    // Кабинет сменился — синхронизируем
    const activeId = ws.activeAccount?.clientId
    if (activeId !== domId) {
      console.log('[PMG] seller changed in DOM:', domId)
      ws.abcData = null; ws.profitData = null; ws.products = []
      await loadAccounts()
      const synced = await syncAccountWithDom(el)
      if (synced) await loadBase(el)
    }
  }, 3000)
}

init()
