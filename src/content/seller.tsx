/**
 * Pomogator Pro — seller.ozon.ru
 */

const API_BASE = 'http://localhost:3000'
const FONT     = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif`
const SERIF    = `Georgia, serif`

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
  commissionRub: number
  logistics: number
  cost: number | null
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

interface AccountInfo {
  clientId: string
  name: string
  taxSystem: string
  annualRevenue: number
  isActive: boolean
  perfApiKey: string | null
}

const LIGHT = {
  green:   { bg: 'rgba(107,153,82,0.15)',  border: 'rgba(107,153,82,0.4)',  color: '#4A8030' },
  yellow:  { bg: 'rgba(196,131,42,0.15)',  border: 'rgba(196,131,42,0.4)',  color: '#A06010' },
  red:     { bg: 'rgba(184,80,64,0.15)',   border: 'rgba(184,80,64,0.4)',   color: '#923020' },
  no_cost: { bg: 'rgba(160,130,80,0.10)',  border: 'rgba(160,130,80,0.3)',  color: '#9A7040' },
}

// ─── Кэш товаров ─────────────────────────────────────────────────────────────
let cache: Record<string, Product> = {}
async function loadProducts() {
  try {
    const d = await apiGet<{ items: Product[] }>('/api/products')
    cache = {}
    for (const p of d.items) cache[p.offerId] = p
  } catch (e) { console.warn('[PMG] loadProducts:', e) }
}

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
  if (container.querySelector('.pmg-b')) return
  const p = cache[offerId], light = p?.light ?? 'no_cost', c = LIGHT[light]

  const badge = document.createElement('span')
  badge.className = 'pmg-b'; badge.dataset.offer = offerId
  badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:99px;margin-top:4px;' +
    'background:' + c.bg + ';border:0.5px solid ' + c.border + ';font-family:' + FONT + ';font-size:11px;font-weight:600;color:' + c.color + ';white-space:nowrap;'
  badge.textContent = light === 'no_cost' ? '○ себест. не задана' : '● ' + p!.marginPct + '% маржа'
  if (light !== 'no_cost' && p) { badge.style.cursor = 'pointer'; badge.onclick = e => { e.stopPropagation(); openBreakdown(p) } }

  const costWrap = document.createElement('div'); costWrap.className = 'pmg-c'; costWrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:4px;'
  const lbl = document.createElement('span'); lbl.style.cssText = 'font-family:' + FONT + ';font-size:10px;color:#9A7040;'; lbl.textContent = 'с/с:'
  const inp = document.createElement('input'); inp.type = 'number'; inp.placeholder = '0'; inp.value = p?.cost != null ? String(p.cost) : ''
  inp.style.cssText = 'width:64px;padding:3px 6px;border-radius:7px;border:0.5px solid rgba(200,175,130,0.5);background:rgba(245,237,216,0.95);color:#5C3E1E;font-family:' + FONT + ';font-size:12px;outline:none;'
  const saveBtn = document.createElement('button'); saveBtn.textContent = '✓'
  saveBtn.style.cssText = 'padding:3px 7px;border-radius:7px;border:none;cursor:pointer;background:#C4832A;color:#fff;font-size:12px;font-family:' + FONT + ';'
  saveBtn.onclick = async () => {
    const cost = parseFloat(inp.value); if (isNaN(cost)) return
    saveBtn.textContent = '…'
    try { await apiPost('/api/cost', { offerId, cost }); saveBtn.textContent = '✓'; saveBtn.style.background = '#4A8030'; await loadProducts(); container.querySelectorAll('.pmg-b,.pmg-c,.pmg-p').forEach(e => e.remove()); injectRow(offerId) }
    catch { saveBtn.textContent = '!'; saveBtn.style.background = '#923020' }
  }
  costWrap.append(lbl, inp, saveBtn)
  const planBtn = document.createElement('button'); planBtn.className = 'pmg-p'; planBtn.textContent = '📋 План'
  planBtn.style.cssText = 'margin-top:5px;padding:3px 9px;border-radius:7px;border:none;cursor:pointer;background:#F5EDD8;color:#7A5532;border:0.5px solid rgba(180,150,100,0.45);font-family:' + FONT + ';font-size:11px;font-weight:600;white-space:nowrap;display:block;'
  planBtn.onclick = () => openPlan(offerId)
  container.appendChild(badge); container.appendChild(costWrap); container.appendChild(planBtn)
}

function injectAllRows() { for (const id of Object.keys(cache)) injectRow(id) }
let tableStarted = false
async function initTable() {
  if (tableStarted) return; tableStarted = true
  await loadProducts(); injectAllRows()
  setInterval(injectAllRows, 2000)
  setInterval(async () => { await loadProducts(); injectAllRows() }, 120_000)
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── PROFIT WIDGET ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const W_CSS = `
#pmg-profit {
  position:fixed; top:64px; right:14px; z-index:99997; width:420px;
  background:#F5EDD8; border:0.5px solid rgba(200,175,130,0.5); border-radius:16px;
  font-family:${FONT}; box-shadow:0 8px 32px rgba(60,35,10,0.15),0 2px 8px rgba(0,0,0,0.06); overflow:hidden;
}
.pmg-hdr { display:flex; align-items:center; justify-content:space-between; padding:10px 14px;
  background:rgba(255,252,244,0.7); border-bottom:0.5px solid rgba(200,175,130,0.4);
  border-radius:16px 16px 0 0; cursor:pointer; user-select:none; }
.pmg-hdr-l { display:flex; align-items:center; gap:8px; }
.pmg-hdr-title { font-size:14px; font-weight:500; color:#5C3E1E; letter-spacing:.02em; }
.pmg-pro { display:inline-flex; align-items:center; gap:3px; background:linear-gradient(135deg,#C4832A,#D4912A);
  color:#fff; font-size:9px; font-weight:700; letter-spacing:.08em; padding:2px 7px; border-radius:99px; text-transform:uppercase; }
.pmg-hdr-r { display:flex; align-items:center; gap:4px; }
.pmg-ib { background:none; border:none; cursor:pointer; color:#9A7040; padding:3px 4px;
  border-radius:6px; font-size:14px; line-height:1; transition:background .15s,color .15s; }
.pmg-ib:hover { background:rgba(196,131,42,0.12); color:#5C3E1E; }
.pmg-secs { display:flex; border-bottom:0.5px solid rgba(200,175,130,0.3); }
.pmg-sec { flex:1; padding:9px 0; text-align:center; font-size:12px; font-weight:600; color:#9A7040;
  cursor:pointer; border-bottom:2px solid transparent; transition:all .15s; }
.pmg-sec.on { color:#C4832A; border-bottom-color:#C4832A; }
.pmg-sec:hover:not(.on) { color:#5C3E1E; }
.pmg-tabs { display:flex; gap:5px; padding:10px 14px 0; }
.pmg-tab { flex:1; padding:5px 0; text-align:center; border:0.5px solid rgba(200,175,130,0.45);
  border-radius:8px; background:rgba(255,252,244,0.6); font-size:11.5px; font-weight:600; color:#9A7040; cursor:pointer; transition:all .15s; }
.pmg-tab.on { background:#C4832A; border-color:#C4832A; color:#fff; }
.pmg-tab:hover:not(.on) { background:rgba(196,131,42,0.1); }
.pmg-dates { display:flex; gap:6px; align-items:center; padding:8px 14px 0; }
.pmg-dinp { flex:1; padding:5px 8px; border:0.5px solid rgba(200,175,130,0.4); border-radius:8px;
  background:rgba(255,252,244,0.8); color:#5C3E1E; font-size:12px; font-family:inherit; outline:none; }
.pmg-dgo { padding:5px 12px; background:#C4832A; color:#fff; border:none; border-radius:8px; font-size:12px; font-weight:600; cursor:pointer; }
.pmg-body { padding:12px 14px 0; }
.pmg-grid { display:grid; grid-template-columns:1fr 1fr; gap:9px; padding:12px 14px 14px; }
.pmg-card { background:rgba(255,252,244,0.6); border:0.5px solid rgba(200,175,130,0.5); border-radius:14px;
  cursor:pointer; user-select:none; display:flex; flex-direction:column; align-items:center; gap:7px;
  padding:12px 8px 10px; transition:box-shadow .15s; }
.pmg-card:hover { box-shadow:0 2px 12px rgba(196,131,42,0.15); }
.pmg-card.full { grid-column:span 2; flex-direction:row; align-items:center; gap:12px; padding:10px 14px; }
.pmg-card-label { font-size:12px; color:#6B4E28; font-weight:500; line-height:1.3; text-align:center; }
.pmg-card.full .pmg-card-label { text-align:left; }
.pmg-card-sub { font-size:11px; color:#9A7040; margin-top:2px; }
.pmg-ring-wrap { transition:transform 0.4s ease; }
.pmg-sec-header { display:flex; align-items:center; justify-content:space-between; margin:12px 14px 0;
  padding:10px 14px; background:rgba(255,252,244,0.7); border:0.5px solid rgba(200,175,130,0.4); border-radius:14px; }
.pmg-metrics { display:flex; border-top:0.5px solid rgba(200,175,130,0.2); margin:0 14px; }
.pmg-mc { flex:1; padding:9px 0; text-align:center; border-right:0.5px solid rgba(200,175,130,0.2); }
.pmg-mc:last-child { border-right:none; }
.pmg-mc-l { font-size:9.5px; color:#9A7040; text-transform:uppercase; letter-spacing:.05em; margin-bottom:2px; }
.pmg-mc-v { font-family:${SERIF}; font-size:15px; font-weight:400; }
.pmg-warn { margin:0 14px 10px; background:rgba(196,131,42,0.07); border:0.5px solid rgba(196,131,42,0.22);
  border-radius:10px; padding:8px 11px; font-size:11px; color:#7A5020; line-height:1.45; }
.pmg-load-wrap { display:flex; flex-direction:column; align-items:center; gap:8px; padding:28px 14px; }
.pmg-spin { width:18px; height:18px; border-radius:50%; border:2px solid rgba(196,131,42,0.2);
  border-top-color:#C4832A; animation:pmg-s .7s linear infinite; }
@keyframes pmg-s { to { transform:rotate(360deg) } }
.pmg-pbar-wrap { width:180px; background:rgba(180,150,100,0.15); border-radius:99px; height:5px; overflow:hidden; }
.pmg-pbar { height:100%; background:#C4832A; border-radius:99px; transition:width .3s ease; }
.pmg-load-txt { font-size:12px; color:#9A7040; }
.pmg-abc-wrap { overflow-x:auto; padding:0 14px 14px; }
.pmg-abc { width:100%; border-collapse:collapse; font-size:11px; }
.pmg-abc th { text-align:left; padding:4px 5px; color:#9A7040; font-size:9px; font-weight:700;
  text-transform:uppercase; letter-spacing:.05em; border-bottom:0.5px solid rgba(200,175,130,0.25); white-space:nowrap; }
.pmg-abc td { padding:6px 5px; border-bottom:0.5px solid rgba(200,175,130,0.12); color:#5C3E1E; vertical-align:middle; }
.pmg-abc tr:last-child td { border-bottom:none; }
.pmg-abc tr:hover td { background:rgba(196,131,42,0.04); }
.pmg-aname { max-width:85px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:10.5px; }
.pmg-cls { display:inline-block; width:17px; height:17px; line-height:17px; text-align:center; border-radius:4px; font-size:9.5px; font-weight:700; }
.pmg-cls-A { background:rgba(107,153,82,0.18); color:#4A8030; }
.pmg-cls-B { background:rgba(196,131,42,0.15); color:#A06010; }
.pmg-cls-C { background:rgba(184,80,64,0.13); color:#923020; }
.pmg-tcls { font-weight:700; font-size:11.5px; letter-spacing:.03em; }
.pmg-div { height:0.5px; background:rgba(200,175,130,0.2); margin:8px 14px; }
.pmg-foot { display:flex; align-items:center; justify-content:space-between; padding:7px 14px 12px; font-size:10.5px; color:#B09060; }
.pmg-foot a { color:#C4832A; text-decoration:none; font-weight:600; }
.pmg-foot a:hover { text-decoration:underline; }
.pmg-link-inp { width:100%; box-sizing:border-box; padding:7px 10px; border:0.5px solid rgba(200,175,130,0.5);
  border-radius:9px; background:rgba(255,252,244,0.9); color:#5C3E1E; font-family:inherit; font-size:13px; outline:none; margin-top:3px; }
.pmg-link-lbl { font-size:10px; color:#9A7040; display:block; text-transform:uppercase; letter-spacing:.04em; margin-top:8px; }
.pmg-link-btn { width:100%; padding:9px; border-radius:10px; border:none; cursor:pointer;
  background:#C4832A; color:#fff; font-family:inherit; font-size:13px; font-weight:600; margin-top:10px; }
.pmg-acc-dd { display:none; position:absolute; right:0; top:calc(100% + 4px);
  background:#F5EDD8; border:0.5px solid rgba(200,175,130,0.5); border-radius:12px;
  box-shadow:0 8px 24px rgba(0,0,0,0.12); min-width:180px; z-index:99999; overflow:hidden; }
.pmg-acc-item { padding:8px 12px; cursor:pointer; font-size:12px; color:#5C3E1E;
  border-bottom:0.5px solid rgba(200,175,130,0.2); }
.pmg-acc-item:hover { background:rgba(196,131,42,0.07); }
.pmg-acc-item.pmg-acc-on { background:rgba(196,131,42,0.08); font-weight:600; }
@keyframes pmg-in { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
#pmg-profit { animation:pmg-in .25s ease; }
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
function pctC(p: number) { return p >= 20 ? '#6B9952' : p >= 10 ? '#C4832A' : p >= 0 ? '#C4832A' : '#B85040' }

function makeSvgRing(score: number, max: number, size: number): string {
  const sw = size >= 52 ? 7 : 5
  const r  = size >= 52 ? 21 : 15
  const c  = size / 2
  const circ = 2 * Math.PI * r
  const off  = max === 0 ? circ : circ * (1 - Math.min(Math.max(score, 0), max) / max)
  const col  = max === 0 ? '#A08060' : (score/max >= 0.75 ? '#6B9952' : score/max >= 0.45 ? '#C4832A' : '#B85040')
  const fs   = size >= 52 ? 11 : 9
  const inset = sw + 1
  return '<div style="position:relative;width:' + size + 'px;height:' + size + 'px;flex-shrink:0">' +
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="transform:rotate(-90deg);display:block">' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="rgba(160,130,80,0.35)" fill="none"/>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="' + col + '" fill="none"' +
    ' stroke-dasharray="' + circ + '" stroke-dashoffset="' + off + '" stroke-linecap="round"/>' +
    '</svg>' +
    '<div style="position:absolute;inset:' + inset + 'px;background:#F5EDD8;border-radius:50%;display:flex;align-items:center;justify-content:center">' +
    '<span style="font-family:' + SERIF + ';font-size:' + fs + 'px;color:#5C3E1E;line-height:1">' + score + '/' + max + '</span>' +
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
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="rgba(160,130,80,0.35)" fill="none"/>' +
    '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" stroke-width="' + sw + '" stroke="' + col + '" fill="none"' +
    ' stroke-dasharray="' + circ + '" stroke-dashoffset="' + off + '" stroke-linecap="round"/>' +
    '</svg>' +
    '<div style="position:absolute;inset:' + inset + 'px;background:#F5EDD8;border-radius:50%;display:flex;align-items:center;justify-content:center">' +
    '<span style="font-family:' + SERIF + ';font-size:11px;color:#5C3E1E;line-height:1">' + pct.toFixed(1) + '%</span>' +
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
  collapsed: boolean; section: 'margin'|'abc'; period: Period
  customFrom: string; customTo: string; loading: boolean
  loadMsg: string; loadPct: number
  profitData: ProfitData | null; abcData: AbcData | null
  products: Product[]; refreshedAt: Date | null
  accounts: AccountInfo[]; activeAccount: AccountInfo | null
  showLinkForm: boolean; pendingClientId: string
}
const ws: WS = {
  collapsed: false, section: 'margin', period: 'month',
  customFrom: '', customTo: '', loading: false, loadMsg: 'Загружаю…', loadPct: 0,
  profitData: null, abcData: null, products: [], refreshedAt: null,
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

  // Шапка — одинакова для всех состояний
  const hdrHtml = '<div class="pmg-hdr" id="pmg-hdr">' +
    '<div class="pmg-hdr-l">' +
    '<span style="font-size:16px">🌿</span>' +
    '<span class="pmg-hdr-title">Pomogator.ai</span>' +
    '<span class="pmg-pro">★ Pro</span>' +
    renderAccSwitcher() +
    '</div>' +
    '<div class="pmg-hdr-r">' +
    (ws.accounts.length > 0 ? '<button class="pmg-ib" id="pmg-ref" title="Обновить"><svg width="14" height="14" fill="none" viewBox="0 0 14 14"><path d="M12 7A5 5 0 1 1 8.5 2.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 1v3h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : '') +
    '<button class="pmg-ib" id="pmg-tog">' + (ws.collapsed ? '+' : '−') + '</button>' +
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

  // Основной виджет
  const TABS: Array<{id: Period, label: string}> = [
    {id:'week',label:'Неделя'},{id:'month',label:'Месяц'},{id:'halfyear',label:'6 мес.'},{id:'custom',label:'📅'},
  ]
  const tabsHtml = '<div class="pmg-tabs">' +
    TABS.map(t => '<div class="pmg-tab' + (ws.period===t.id?' on':'') + '" data-p="' + t.id + '">' + t.label + '</div>').join('') +
    '</div>'

  const datesHtml = ws.period === 'custom'
    ? '<div class="pmg-dates"><input class="pmg-dinp" type="date" id="pmg-df" value="' + ws.customFrom + '"><input class="pmg-dinp" type="date" id="pmg-dt" value="' + ws.customTo + '"><button class="pmg-dgo" id="pmg-dgo">→</button></div>'
    : ''

  const loadHtml = ws.loading
    ? '<div class="pmg-load-wrap"><div class="pmg-spin"></div><div class="pmg-load-txt">' + ws.loadMsg + '</div>' +
      (ws.loadPct > 0 ? '<div class="pmg-pbar-wrap"><div class="pmg-pbar" style="width:' + ws.loadPct + '%"></div></div><div class="pmg-load-txt" style="font-size:10px">' + ws.loadPct + '%</div>' : '') +
      '</div>'
    : ws.section === 'margin' ? renderMargin() : renderAbc()

  el.innerHTML = hdrHtml +
    '<div id="pmg-bd" style="' + (ws.collapsed ? 'display:none' : '') + '">' +
    '<div class="pmg-secs">' +
    '<div class="pmg-sec' + (ws.section==='margin'?' on':'') + '" data-s="margin">📊 Маржа магазина</div>' +
    '<div class="pmg-sec' + (ws.section==='abc'?' on':'') + '" data-s="abc">▦ ABC-анализ</div>' +
    '</div>' +
    tabsHtml + datesHtml +
    '<div class="pmg-body">' + loadHtml + '</div>' +
    footHtml + '</div>'

  bindHdr(el); bindMain(el)
  el.querySelectorAll('.pmg-card').forEach(card => addTilt(card as HTMLElement))
}

function renderLinkForm(): string {
  const cancelBtn = ws.accounts.length > 0
    ? '<button id="pmg-link-cancel" style="width:100%;padding:7px;border-radius:10px;border:0.5px solid rgba(200,175,130,0.4);cursor:pointer;background:transparent;color:#9A7040;font-family:inherit;font-size:12px;margin-top:5px;">Отмена</button>'
    : ''
  return '<div style="padding:16px 14px 4px">' +
    '<div style="font-size:13px;font-weight:600;color:#5C3E1E;margin-bottom:6px">🔑 Привязка Ozon API</div>' +

    // Seller API
    '<div style="font-size:10px;color:#C4832A;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin:10px 0 4px">Seller API</div>' +
    '<div style="font-size:10px;color:#9A7040;margin-bottom:8px;line-height:1.5">Ozon Seller → Настройки → API-ключи → Seller API</div>' +
    '<label class="pmg-link-lbl">Client-ID *</label>' +
    '<input id="pmg-link-cid" class="pmg-link-inp" type="text" placeholder="123456" value="' + (ws.pendingClientId || '') + '">' +
    '<label class="pmg-link-lbl">API-Key *</label>' +
    '<input id="pmg-link-key" class="pmg-link-inp" type="text" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">' +

    // Performance API
    '<div style="font-size:10px;color:#C4832A;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin:14px 0 4px">Performance API (реклама, опционально)</div>' +
    '<div style="font-size:10px;color:#9A7040;margin-bottom:8px;line-height:1.5">Ozon Seller → Настройки → API-ключи → Performance API → Добавить ключ</div>' +
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
    '<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:0.5px solid rgba(200,175,130,0.2)">' +
    '<div class="pmg-acc-item' + (acc.isActive ? ' pmg-acc-on' : '') + '" data-cid="' + acc.clientId + '" style="flex:1;border-bottom:none">' +
    (acc.isActive ? '✓ ' : '') + (acc.name || 'Кабинет') +
    '<div style="font-size:10px;color:#9A7040">' + (acc.taxSystem ?? '').toUpperCase() + '</div>' +
    '</div>' +
    '<div class="pmg-acc-del" data-cid="' + acc.clientId + '" title="Удалить кабинет" ' +
    'style="padding:8px 10px;cursor:pointer;color:#B85040;font-size:14px;flex-shrink:0;opacity:0.6" ' +
    'onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.6">✕</div>' +
    '</div>'
  ).join('')
  return '<div id="pmg-acc-wrap" style="position:relative">' +
    '<button id="pmg-acc-btn" style="background:rgba(196,131,42,0.1);border:0.5px solid rgba(196,131,42,0.3);border-radius:8px;padding:3px 8px;cursor:pointer;font-size:11px;color:#7A5020;display:flex;align-items:center;gap:4px;font-family:inherit">' +
    (active?.name && active.name !== active?.clientId ? active.name.slice(0, 16) : 'Кабинет') + ' <span style="font-size:9px">▼</span></button>' +
    '<div class="pmg-acc-dd" id="pmg-acc-dd">' + items +
    '<div id="pmg-acc-add" style="padding:8px 12px;cursor:pointer;font-size:12px;color:#C4832A;font-weight:600">+ Добавить кабинет</div>' +
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
    ? '<span style="font-size:9px;color:#9A7040;font-weight:400"> · ' + pd.taxSystem.toUpperCase() + '</span>'
    : ''

  return '<div class="pmg-sec-header">' +
    '<span style="font-size:14px;font-weight:500;color:#5C3E1E">' + (showMgn ? 'Маржа магазина' : 'Выплаты Ozon') + taxBadge + '</span>' +
    '<div style="position:relative;width:44px;height:44px">' +
    '<svg width="44" height="44" viewBox="0 0 44 44" style="transform:rotate(-90deg);display:block">' +
    '<circle cx="22" cy="22" r="18" stroke-width="4" stroke="rgba(160,130,80,0.35)" fill="none"/>' +
    '<circle cx="22" cy="22" r="18" stroke-width="4" stroke="' + totCol + '" fill="none"' +
    ' stroke-dasharray="' + totCirc + '" stroke-dashoffset="' + totOff + '" stroke-linecap="round"/>' +
    '</svg>' +
    '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:' + SERIF + ';font-size:11px;color:#5C3E1E">' + (showMgn ? mPct.toFixed(0) + '%' : '—') + '</div>' +
    '</div></div>' +

    '<div class="pmg-metrics">' +
    '<div class="pmg-mc"><div class="pmg-mc-l">За период</div><div class="pmg-mc-v" style="color:' + (mainVal >= 0 ? '#5C3E1E' : '#923020') + '">' + fmtR(mainVal) + '</div></div>' +
    '<div class="pmg-mc"><div class="pmg-mc-l">Сегодня</div><div class="pmg-mc-v" style="color:' + (todayVal >= 0 ? '#5C3E1E' : '#923020') + '">' + fmtR(todayVal) + '</div></div>' +
    '<div class="pmg-mc"><div class="pmg-mc-l">Вчера</div><div class="pmg-mc-v">' + fmtR(yesterdVal) + '</div></div>' +
    '<div class="pmg-mc"><div class="pmg-mc-l">Динамика</div><div class="pmg-mc-v" style="font-size:12px;color:' + ((delta ?? 0) >= 0 ? '#4A8030' : '#923020') + '">' + dStr + '</div></div>' +
    '</div>' +

    warnHtml +

    '<div class="pmg-grid">' +
    '<div class="pmg-card" id="pmg-c-margin"><div class="pmg-ring-wrap">' + (showMgn ? makePctRing(mPct, 56) : makeSvgRing(0, 100, 56)) + '</div><div class="pmg-card-label">Маржа<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + pctC(mPct) + '">' + (showMgn ? mPct.toFixed(1) + '%' : '—') + '</span></div></div>' +
    '<div class="pmg-card" id="pmg-c-revenue"><div class="pmg-ring-wrap">' + makeSvgRing(costCount, Math.max(prods.length, 1), 56) + '</div><div class="pmg-card-label">Оборот<br><span style="font-family:' + SERIF + ';font-size:13px;color:#5C3E1E">' + fmtRA(netPeriod) + '</span></div></div>' +
    '<div class="pmg-card" id="pmg-c-cost"><div class="pmg-ring-wrap">' + makeSvgRing(costCount, Math.max(prods.length, 1), 56) + '</div><div class="pmg-card-label">С/С введена<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + (costCount === prods.length && prods.length > 0 ? '#4A8030' : '#C4832A') + '">' + costCount + '/' + prods.length + '</span></div></div>' +
    '<div class="pmg-card" id="pmg-c-profit"><div class="pmg-ring-wrap">' + makeSvgRing(useProfit ? Math.max(0, Math.round(mPct)) : 0, 100, 56) + '</div><div class="pmg-card-label">Прибыль<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + ((profitPeriod ?? 0) >= 0 ? '#4A8030' : '#923020') + '">' + (useProfit ? fmtR(profitPeriod ?? 0) : '—') + '</span></div></div>' +
    '<div class="pmg-card full" id="pmg-c-abc"><div class="pmg-ring-wrap">' + makeSvgRing(prods.length, Math.max(prods.length, 1), 38) + '</div><div><div class="pmg-card-label">ABC-анализ товаров</div><div class="pmg-card-sub">нажмите — детализация по артикулам</div></div></div>' +
    '</div>'
}

// ─── Блок ABC ─────────────────────────────────────────────────────────────────
function renderAbc(): string {
  const d = ws.abcData
  if (!d) return '<div style="padding:20px 14px;text-align:center;color:#9A7040;font-size:12px">Нажмите «Обновить» для загрузки ABC-анализа</div>'
  if (d.warning) return '<div style="padding:16px 14px"><div class="pmg-warn">' + d.warning + '</div></div>'
  if (!d.items?.length) return '<div style="padding:16px 14px;text-align:center;color:#9A7040;font-size:12px">Нет данных за выбранный период</div>'

  const aCount = d.items.filter(i => i.abcSales === 'A').length

  function clsBadge(c: string) { return '<span class="pmg-cls pmg-cls-' + c + '">' + c + '</span>' }
  function totalCol(s: string): string {
    const aNum = s.split('').filter(c => c === 'А').length
    return aNum >= 3 ? '#4A8030' : aNum >= 2 ? '#7A8030' : aNum >= 1 ? '#A06010' : '#923020'
  }

  const rows = d.items.map(item => {
    const dc = item.marginPct >= 20 ? '#6B9952' : item.marginPct >= 10 ? '#C4832A' : '#B85040'
    const stockStr = item.stockDays >= 999 ? '∞' : item.stockDays === 0 ? '<span style="color:#923020">0д</span>' : item.stockDays + 'д'
    return '<tr><td><div style="display:flex;align-items:center;gap:4px"><span style="width:6px;height:6px;border-radius:50%;background:' + dc + ';flex-shrink:0;display:inline-block"></span><div><div class="pmg-aname" title="' + item.offerId + '">' + (item.isCurrent ? '🔄 ' : '') + item.offerId + '</div><div style="font-size:9px;color:#9A7040">' + item.price + ' ₽</div></div></div></td>' +
      '<td style="text-align:center">' + clsBadge(item.abcSales) + '</td>' +
      '<td style="text-align:center">' + clsBadge(item.abcMargin) + '</td>' +
      '<td style="text-align:center">' + clsBadge(item.abcStock) + '</td>' +
      '<td style="text-align:center"><span class="pmg-tcls" style="color:' + totalCol(item.abcTotal) + '">' + item.abcTotal + '</span></td>' +
      '<td style="text-align:right;font-size:10.5px">' + fmtRA(item.revenue) + '</td>' +
      '<td style="text-align:right;font-weight:700;font-size:11px;color:' + pctC(item.marginPct) + '">' + item.marginPct.toFixed(0) + '%</td>' +
      '<td style="text-align:center;font-size:10.5px">' + stockStr + '</td></tr>'
  }).join('')

  return '<div class="pmg-sec-header"><span style="font-size:14px;font-weight:500;color:#5C3E1E">ABC-анализ</span>' +
    '<div style="display:flex;align-items:center;gap:12px">' +
    '<div style="text-align:center"><div style="font-family:' + SERIF + ';font-size:18px;color:#5C3E1E">' + fmtRA(d.totalRevenue) + '</div><div style="font-size:9px;color:#9A7040;text-transform:uppercase;letter-spacing:.05em">Оборот</div></div>' +
    '<div style="text-align:center"><div style="font-family:' + SERIF + ';font-size:18px;color:' + pctC(d.avgMarginPct) + '">' + d.avgMarginPct.toFixed(0) + '%</div><div style="font-size:9px;color:#9A7040;text-transform:uppercase;letter-spacing:.05em">Маржа</div></div>' +
    '</div></div>' +

    '<div class="pmg-grid" style="padding-bottom:8px">' +
    '<div class="pmg-card" id="pmg-abc-margin"><div class="pmg-ring-wrap">' + makeSvgRing(Math.round(Math.max(0, d.avgMarginPct)), 100, 56) + '</div><div class="pmg-card-label">Средняя маржа<br><span style="font-family:' + SERIF + ';font-size:13px;color:' + pctC(d.avgMarginPct) + '">' + d.avgMarginPct.toFixed(1) + '%</span></div></div>' +
    '<div class="pmg-card" id="pmg-abc-a"><div class="pmg-ring-wrap">' + makeSvgRing(aCount, d.items.length, 56) + '</div><div class="pmg-card-label">Лидеры (А)<br><span style="font-family:' + SERIF + ';font-size:13px;color:#4A8030">' + aCount + ' из ' + d.items.length + '</span></div></div>' +
    '</div>' +

    '<div style="padding:0 14px 6px;font-size:9.5px;color:#9A7040">' + Math.round(d.months) + ' мес. · ' + d.ordersTotal.toLocaleString('ru') + ' заказов · из отчётов реализации Ozon</div>' +
    '<div class="pmg-div"></div>' +
    '<div class="pmg-abc-wrap"><table class="pmg-abc"><thead><tr>' +
    '<th>Артикул</th><th style="text-align:center">Прод.</th><th style="text-align:center">Маржа</th>' +
    '<th style="text-align:center">Остат.</th><th style="text-align:center">Сводный</th>' +
    '<th style="text-align:right">Оборот</th><th style="text-align:right">Маржа%</th><th style="text-align:center">Дней</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>'
}

// ─── Привязка событий ─────────────────────────────────────────────────────────
function bindHdr(el: HTMLElement) {
  el.querySelector('#pmg-hdr')?.addEventListener('click', () => { ws.collapsed = !ws.collapsed; renderW(el) })
  el.querySelector('#pmg-tog')?.addEventListener('click', e => { e.stopPropagation(); ws.collapsed = !ws.collapsed; renderW(el) })
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
  el.querySelector('#pmg-ref')?.addEventListener('click', e => { e.stopPropagation(); loadAll(el) })

  el.querySelectorAll('.pmg-sec').forEach(t => t.addEventListener('click', e => {
    e.stopPropagation()
    ws.section = (t as HTMLElement).dataset.s as any
    renderW(el)
    if (ws.section === 'abc' && !ws.loading) loadAbc(el)
  }))

  el.querySelector('#pmg-c-abc')?.addEventListener('click', e => {
    e.stopPropagation(); ws.section = 'abc'; renderW(el)
    if (!ws.loading) loadAbc(el)
  })

  el.querySelectorAll('.pmg-tab').forEach(t => t.addEventListener('click', e => {
    e.stopPropagation()
    ws.period = (t as HTMLElement).dataset.p as Period
    ws.abcData = null; renderW(el)
    if (ws.period !== 'custom') {
      if (ws.section === 'abc') loadAbc(el); else loadBase(el)
    }
  }))

  el.querySelector('#pmg-dgo')?.addEventListener('click', e => {
    e.stopPropagation()
    const f = (el.querySelector('#pmg-df') as HTMLInputElement)?.value
    const t = (el.querySelector('#pmg-dt') as HTMLInputElement)?.value
    if (f && t) { ws.customFrom = f; ws.customTo = t; ws.abcData = null; if (ws.section === 'abc') loadAbc(el); else loadBase(el) }
  })

  // Переключатель аккаунтов
  const accBtn = el.querySelector('#pmg-acc-btn') as HTMLElement | null
  const accDd  = el.querySelector('#pmg-acc-dd')  as HTMLElement | null
  accBtn?.addEventListener('click', e => {
    e.stopPropagation()
    if (accDd) accDd.style.display = accDd.style.display === 'none' ? 'block' : 'none'
  })
  document.addEventListener('click', () => { if (accDd) accDd.style.display = 'none' }, { once: true })
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
      await bgFetch(API_BASE + '/api/accounts/' + cid, { method: 'DELETE', headers: {} })
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
}

// ─── Загрузка данных ──────────────────────────────────────────────────────────
function periodQS(): string {
  if (ws.period === 'custom') return '?from=' + ws.customFrom + '&to=' + ws.customTo
  const days = ws.period === 'week' ? 7 : ws.period === 'month' ? 30 : 180
  const to   = new Date(), from = new Date(Date.now() - days * 86_400_000)
  return '?from=' + from.toISOString().slice(0, 10) + '&to=' + to.toISOString().slice(0, 10)
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
    const abc = await apiGet<AbcData>('/api/abc' + periodQS())
    ws.abcData = abc ?? null; ws.refreshedAt = new Date()
  } catch (e: any) { console.warn('[PMG] loadAbc:', e); ws.abcData = null }
  finally { ws.loading = false; renderW(el) }
}

async function loadAll(el: HTMLElement) { await loadBase(el); if (ws.section === 'abc') await loadAbc(el) }

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
  await loadBase(el)
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── BREAKDOWN ───────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
function openBreakdown(p: Product) {
  document.getElementById('pmg-breakdown')?.remove()
  const price = p.price||0, commPct = p.commissionPercent||0, commRub = Math.round(price*commPct/100)
  const log = p.logistics||0, acq = Math.round(price*0.015), cost = p.cost||0
  const net = Math.round(price-commRub-log-acq-cost)
  const mColor = (p.marginPct??0)>=20?'#4A8030':(p.marginPct??0)>=10?'#A06010':'#923020'

  const ov = document.createElement('div'); ov.id = 'pmg-breakdown'
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;'
  const m = document.createElement('div')
  m.style.cssText = 'background:#F5EDD8;border-radius:20px;border:0.5px solid rgba(180,150,100,0.3);padding:28px 32px;width:420px;max-width:95vw;max-height:90vh;overflow-y:auto;font-family:' + FONT + ';position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.25);'

  const row = (label: string, value: string, color = '#5C3E1E', sub = '') =>
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:0.5px solid rgba(200,175,130,0.25)">' +
    '<div style="flex:1"><div style="font-size:12px;color:#6B4E28;font-weight:500">' + label + '</div>' + (sub ? '<div style="font-size:10px;color:#9A7040;margin-top:1px">' + sub + '</div>' : '') + '</div>' +
    '<div style="font-family:' + SERIF + ';font-size:14px;color:' + color + ';font-weight:600;margin-left:12px;white-space:nowrap">' + value + '</div></div>'

  const section = (t: string) => '<div style="font-size:10px;color:#9A7040;text-transform:uppercase;letter-spacing:0.08em;margin:14px 0 4px;font-weight:600">' + t + '</div>'
  const pctBar = (s: number) => { const pct = price > 0 ? Math.round(s/price*100) : 0; return '<div style="height:3px;border-radius:2px;background:rgba(200,175,130,0.2);margin-top:3px;overflow:hidden;width:100px"><div style="height:100%;width:' + Math.min(pct,100) + '%;background:#C4832A;border-radius:2px"></div></div><span style="font-size:10px;color:#9A7040">' + pct + '% от цены</span>' }

  m.innerHTML =
    '<button id="pmg-bd-x" style="position:absolute;top:14px;right:16px;background:none;border:none;cursor:pointer;font-size:20px;color:#9A7040;">✕</button>' +
    '<div style="font-size:10px;color:#9A7040;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Pomogator · Расшифровка</div>' +
    '<div style="font-family:' + SERIF + ';font-size:20px;color:#5C3E1E;margin-bottom:16px">' + p.offerId + '</div>' +
    section('Базовые расходы') +
    row('Цена продажи', price.toLocaleString('ru') + ' ₽', '#5C3E1E', 'Ваша цена в ЛК') +
    row('Комиссия Ozon', '−' + commRub.toLocaleString('ru') + ' ₽', '#923020', commPct + '% · ' + pctBar(commRub)) +
    '<div id="pmg-bd-log" style="display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:0.5px solid rgba(200,175,130,0.25)">' +
    '<div style="flex:1"><div style="font-size:12px;color:#6B4E28;font-weight:500">Логистика (FBO)</div><div id="pmg-bd-log-sub" style="font-size:10px;color:#9A7040;margin-top:1px">⏳ уточняется…</div></div>' +
    '<div id="pmg-bd-log-val" style="font-family:' + SERIF + ';font-size:14px;color:#923020;font-weight:600;margin-left:12px;white-space:nowrap">−' + log.toLocaleString('ru') + ' ₽</div></div>' +
    row('Эквайринг', '−' + acq.toLocaleString('ru') + ' ₽', '#923020', '1.5% · ' + pctBar(acq)) +
    row('Себестоимость', cost > 0 ? '−' + cost.toLocaleString('ru') + ' ₽' : '—', cost > 0 ? '#923020' : '#9A7040', cost > 0 ? pctBar(cost) : 'введите в поле с/с') +
    section('Реальные данные из кабинета') +
    '<div id="pmg-bd-analytics" style="padding:10px 0;color:#9A7040;font-size:12px">⏳ Загрузка…</div>' +
    '<div id="pmg-bd-result" style="margin-top:8px;padding:12px 16px;border-radius:14px;background:' + ((p.marginPct??0)>=0?'rgba(107,153,82,0.08)':'rgba(184,80,64,0.08)') + ';border:0.5px solid ' + ((p.marginPct??0)>=0?'rgba(107,153,82,0.3)':'rgba(184,80,64,0.3)') + ';display:flex;justify-content:space-between;align-items:center;">' +
    '<div><div style="font-size:12px;color:#6B4E28;font-weight:600">Чистыми (без рекламы)</div><div style="font-size:10px;color:#9A7040;margin-top:2px">реклама — в разделе «План»</div></div>' +
    '<div style="text-align:right"><div style="font-family:' + SERIF + ';font-size:20px;color:' + mColor + ';font-weight:700">' + (p.marginPct??0) + '%</div><div style="font-family:' + SERIF + ';font-size:13px;color:' + mColor + '">' + (net>=0?'+':'') + net.toLocaleString('ru') + ' ₽/шт</div></div></div>' +
    '<div id="pmg-bd-tax" style="margin-top:10px;background:rgba(255,252,244,0.7);border:0.5px solid rgba(200,175,130,0.3);border-radius:12px;padding:10px 12px">' +
    '<div style="font-size:9.5px;color:#9A7040;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px">Налоговый расчёт</div>' +
    '<div id="pmg-bd-tax-body" style="color:#9A7040;font-size:11px">⏳ Загрузка…</div></div>' +
    '<button id="pmg-bd-plan" style="width:100%;margin-top:14px;padding:10px;border-radius:12px;border:0.5px solid rgba(196,131,42,0.3);cursor:pointer;background:rgba(196,131,42,0.12);color:#7A5532;font-family:' + FONT + ';font-size:13px;font-weight:600;">📋 Открыть план →</button>'

  ov.appendChild(m); document.body.appendChild(ov)
  ov.onclick = e => { if (e.target === ov) ov.remove() }
  m.querySelector('#pmg-bd-x')!.addEventListener('click', () => ov.remove())
  m.querySelector('#pmg-bd-plan')!.addEventListener('click', () => { ov.remove(); openPlan(p.offerId) })

  apiGet<any>('/api/analytics/' + encodeURIComponent(p.offerId)).then(a => {
    const elA = document.getElementById('pmg-bd-analytics'); if (!elA) return
    if (a.avgLogistics != null) {
      const lv = document.getElementById('pmg-bd-log-val'), ls = document.getElementById('pmg-bd-log-sub')
      if (lv) lv.textContent = '−' + a.avgLogistics + ' ₽'
      if (ls) ls.innerHTML = 'реально из ' + (a.realizDeliveries || a.deliveryCount) + ' доставок · ' + Math.round(a.avgLogistics/price*100) + '% от цены'
    }
    const acqV = Math.round(a.acquiringPerUnit*1.22*10)/10
    const netOzon = a.netFromOzon ?? net
    const realNet = Math.round(netOzon - cost - (acqV - a.acquiringPerUnit))
    const realNetFull = Math.round(realNet - (a.storagePerUnit ?? 0))
    const rMgn = price > 0 ? Math.round(realNet/price*100) : 0
    const rMgnF = price > 0 ? Math.round(realNetFull/price*100) : 0
    const rC = rMgn>=20?'#4A8030':rMgn>=10?'#A06010':'#923020'
    const fC = rMgnF>=20?'#4A8030':rMgnF>=10?'#A06010':'#923020'

    if (cache[p.offerId]) {
      cache[p.offerId].marginPct = rMgn
      cache[p.offerId].light = rMgn >= 20 ? 'green' : rMgn >= 10 ? 'yellow' : 'red'
      const b = document.querySelector('[data-offer="' + p.offerId + '"].pmg-b') as HTMLElement | null
      if (b) { const c = LIGHT[cache[p.offerId].light]; b.style.background = c.bg; b.style.borderColor = c.border; b.style.color = c.color; b.textContent = '● ' + rMgn + '% маржа' }
    }

    const rRow = (l: string, v: string, c = '#5C3E1E', s = '') =>
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:9px 0;border-bottom:0.5px solid rgba(200,175,130,0.2)">' +
      '<div style="flex:1"><div style="font-size:13px;color:#6B4E28;font-weight:600">' + l + '</div>' + (s ? '<div style="font-size:10px;color:#9A7040;margin-top:2px;line-height:1.4">' + s + '</div>' : '') + '</div>' +
      '<div style="font-family:' + SERIF + ';font-size:15px;color:' + c + ';font-weight:700;margin-left:16px;white-space:nowrap">' + v + '</div></div>'

    elA.innerHTML =
      rRow('Получено от Ozon', '+' + a.payoutPerUnit + ' ₽', '#5C3E1E', 'после вычета комиссии и логистики') +
      rRow('Эквайринг (вкл. НДС 22%)', '−' + acqV + ' ₽', '#923020') +
      (a.cancelCount > 0 ? rRow('Отмены', '−' + a.cancelLogPerUnit + ' ₽', '#C4832A', a.cancelRate + '% (' + a.cancelCount + ' шт)') : '') +
      (a.clientRefundPerUnit > 0 ? rRow('Возвраты покупателям', '−' + a.clientRefundPerUnit + ' ₽', '#923020') : '') +
      (a.storagePerUnit != null ? rRow('Хранение FBO', '≈−' + a.storagePerUnit + ' ₽', a.turnoverGrade === 'DEFICIT' ? '#4A8030' : '#C4832A', (a.turnoverGrade === 'DEFICIT' ? 'Дефицит' : 'Норма/избыток') + ' · ' + a.avgStockUnits + ' шт') : '') +
      (a.advPerUnit != null
        ? rRow('Реклама', '−' + a.advPerUnit + ' ₽', '#923020',
            'итого ' + (a.advTotal ? Math.round(a.advTotal).toLocaleString('ru') + ' ₽' : '') + ' · на ' + (a.deliveryCount || a.realizDeliveries || 0) + ' продаж')
        : a.advLoading
        ? '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:0.5px solid rgba(200,175,130,0.25)">' +
          '<div><div style="font-size:12px;color:#6B4E28;font-weight:500">Реклама</div>' +
          '<div style="font-size:10px;color:#9A7040;margin-top:1px">⏳ Загружается из Performance API…</div></div>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
          '<div style="width:14px;height:14px;border-radius:50%;border:2px solid rgba(196,131,42,0.2);border-top-color:#C4832A;animation:pmg-s .7s linear infinite"></div>' +
          '<span style="font-size:12px;color:#9A7040">~1 мин</span></div></div>'
        : rRow('Реклама', 'нет данных', '#9A7040', 'Performance API не привязан'))

    const re = document.getElementById('pmg-bd-result')
    if (re) {
      re.style.flexDirection = 'column'
      re.innerHTML = '<div style="width:100%">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
        '<div><div style="font-size:14px;color:#6B4E28;font-weight:700">Прибыль (без рекламы)</div></div>' +
        '<div style="text-align:right"><div style="font-family:' + SERIF + ';font-size:24px;color:' + rC + ';font-weight:700">' + rMgn + '%</div>' +
        '<div style="font-family:' + SERIF + ';font-size:14px;color:' + rC + '">' + (realNet>=0?'+':'') + realNet + ' ₽/шт</div></div></div>' +
        '<div style="display:flex;justify-content:space-between;padding-top:8px;border-top:0.5px solid rgba(200,175,130,0.2)">' +
        '<div><div style="font-size:13px;color:#6B4E28;font-weight:600">С хранением FBO</div></div>' +
        '<div style="text-align:right"><div style="font-family:' + SERIF + ';font-size:18px;color:' + fC + ';font-weight:700">' + rMgnF + '%</div>' +
        '<div style="font-family:' + SERIF + ';font-size:13px;color:' + fC + '">' + (realNetFull>=0?'+':'') + realNetFull + ' ₽/шт</div></div></div>' +
        (a.cancelRate > 10 ? '<div style="margin-top:8px;padding:7px 10px;background:rgba(196,131,42,0.08);border-radius:8px;font-size:11px;color:#A06010;border:0.5px solid rgba(196,131,42,0.3)">⚠ Высокий % отмен — ' + a.cancelRate + '%</div>' : '') +
        '</div>'
    }

    // Налоговый блок
    const taxEl = document.getElementById('pmg-bd-tax-body')
    if (taxEl) {
      if (a.taxBreakdown) {
        const tb = a.taxBreakdown
        const TAX_LABELS: Record<string,string> = { usn6:'УСН 6%', usn6_nds5:'УСН 6% + НДС 5%', usn6_nds7:'УСН 6% + НДС 7%', osno_nds22:'ОСНО + НДС 22%' }
        taxEl.innerHTML =
          '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
          '<span style="color:#9A7040">Режим: ' + (TAX_LABELS[tb.taxSystem] ?? tb.taxSystem) + '</span>' +
          '<span style="font-weight:600;color:' + (tb.marginAfterTax>=15?'#4A8030':tb.marginAfterTax>=5?'#A06010':'#923020') + '">После налогов: ' + tb.marginAfterTax.toFixed(1) + '%</span>' +
          '</div>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px">' +
          (tb.nds > 0 ? '<div><span style="color:#9A7040">НДС:</span> <span style="color:#923020">−' + tb.nds + ' ₽</span></div>' : '') +
          (tb.ndsDeduction > 0 ? '<div><span style="color:#9A7040">Вычет:</span> <span style="color:#4A8030">+' + tb.ndsDeduction + ' ₽</span></div>' : '') +
          '<div><span style="color:#9A7040">' + (tb.taxSystem==='osno_nds22'?'Прибыль 20%':'УСН') + ':</span> <span style="color:#923020">−' + tb.incomeTax + ' ₽</span></div>' +
          '<div><span style="color:#9A7040">Итого:</span> <span style="color:#923020;font-weight:700">−' + tb.totalTax + ' ₽/шт</span></div>' +
          '<div><span style="color:#9A7040">Чистыми:</span> <span style="font-weight:700;color:' + (tb.netAfterTax>=0?'#4A8030':'#923020') + '">' + (tb.netAfterTax>=0?'+':'') + tb.netAfterTax + ' ₽/шт</span></div>' +
          '</div>'
      } else {
        taxEl.textContent = 'Введите себестоимость для расчёта налогов'
      }
    }
  }).catch(err => {
    const elA = document.getElementById('pmg-bd-analytics')
    if (elA) elA.innerHTML = '<span style="color:#923020;font-size:12px">Ошибка: ' + err.message + '</span>'
  })
}

// ─── PLAN ────────────────────────────────────────────────────────────────────
function openPlan(offerId: string) {
  document.getElementById('pmg-plan')?.remove()
  const p = cache[offerId] ?? { offerId, price:0, commissionPercent:0, commissionRub:0, logistics:0, cost:null, net:null, marginPct:null, light:'no_cost' as const }
  const ov = document.createElement('div'); ov.id = 'pmg-plan'
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;'
  const m = document.createElement('div')
  m.style.cssText = 'background:#F5EDD8;border-radius:20px;border:0.5px solid rgba(180,150,100,0.3);padding:28px 32px;width:420px;max-width:95vw;font-family:' + FONT + ';position:relative;box-shadow:0 20px 60px rgba(0,0,0,0.25);'
  const field = (id: string, label: string, val: number) =>
    '<div><label style="font-size:11px;color:#9A7040;display:block;margin-bottom:4px">' + label + '</label>' +
    '<input id="' + id + '" type="number" value="' + val + '" style="width:100%;padding:9px 12px;border-radius:10px;box-sizing:border-box;border:0.5px solid rgba(200,175,130,0.5);background:rgba(255,252,244,0.9);color:#5C3E1E;font-family:' + FONT + ';font-size:14px;outline:none;"></div>'
  m.innerHTML =
    '<button id="pmg-plan-x" style="position:absolute;top:14px;right:16px;background:none;border:none;cursor:pointer;font-size:20px;color:#9A7040;">✕</button>' +
    '<div style="font-size:10px;color:#9A7040;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Pomogator · План</div>' +
    '<div style="font-family:' + SERIF + ';font-size:20px;color:#5C3E1E;margin-bottom:20px">' + offerId + '</div>' +
    '<div style="display:grid;gap:10px;margin-bottom:16px">' + field('pmg-qty','Желаемое кол-во продаж, шт',100) + field('pmg-drr','Целевой ДРР, %',15) + field('pmg-mgn','Целевая маржа, %',25) + '</div>' +
    '<div id="pmg-res" style="padding:14px 16px;background:rgba(255,252,244,0.7);border:0.5px solid rgba(200,175,130,0.4);border-radius:14px;margin-bottom:14px;"></div>' +
    '<button id="pmg-calc" style="width:100%;padding:11px;border-radius:12px;border:none;cursor:pointer;background:#C4832A;color:#fff;font-family:' + FONT + ';font-size:14px;font-weight:600;">Рассчитать</button>'
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
    const mc=aMgn>=20?'#4A8030':aMgn>=10?'#A06010':'#923020'
    const row=(l:string,v:string,c='#5C3E1E')=>'<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:0.5px solid rgba(200,175,130,0.25)"><span style="font-size:12px;color:#6B4E28">'+l+'</span><span style="font-family:'+SERIF+';font-size:13px;color:'+c+'">'+v+'</span></div>'
    res.innerHTML=row('Кол-во',qty+' шт')+row('Выручка',(price*qty).toLocaleString('ru')+' ₽')+row('Комиссия','−'+(commRub*qty).toLocaleString('ru')+' ₽','#923020')+row('Логистика','−'+(log*qty).toLocaleString('ru')+' ₽','#923020')+row('Реклама ('+drr+'%)','−'+(ad*qty).toLocaleString('ru')+' ₽','#923020')+row('Маржа факт.',aMgn+'%',mc)+row('Чистыми',(net>=0?'+':'')+(net*qty).toLocaleString('ru')+' ₽',net>=0?'#4A8030':'#923020')+(minP!==null?row('Мин. цена ('+tMgn+'%)',minP.toLocaleString('ru')+' ₽',minP<=price?'#4A8030':'#923020'):'')+
    (aMgn<tMgn?'<div style="margin-top:8px;padding:7px 10px;background:rgba(184,80,64,0.08);border-radius:8px;font-size:11px;color:#923020">⚠ Маржа ниже цели'+(cost===0?' — введите с/с':'')+'</div>':'<div style="margin-top:8px;padding:7px 10px;background:rgba(107,153,82,0.08);border-radius:8px;font-size:11px;color:#4A8030">✓ Цель достигается</div>')
  }
  m.querySelector('#pmg-calc')!.addEventListener('click', calc); calc()
}

// ─── Роутер ───────────────────────────────────────────────────────────────────
function isProducts(p: string) { return p.includes('product') }
function isMain(p: string) { return p.includes('dashboard') || p.includes('main') || p==='/app' || p==='/app/' }

function init() {
  const path = window.location.pathname
  console.log('[PMG] init:', path)
  if (isMain(path))     initProfitWidget()
  if (isProducts(path)) initTable()
  setInterval(() => {
    const cur = window.location.pathname
    if (isMain(cur))     initProfitWidget()
    if (isProducts(cur)) initTable()
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
