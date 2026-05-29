import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { parseProduct, ProductData } from './parser'
import { getPositionOzonSearch } from './positions/ozon-search'

interface KeywordEntry { kw: string; pop: number; months: number; cc: number; oc: number; comp: number }
interface KeywordMatch { kw: string; pop: number; found: boolean }

function scorePhotos(p: ProductData['photos']) {
  let s = 0
  if (p.count >= 8) s += 16; else if (p.count >= 5) s += 10; else s += 4
  if (p.hasVideo) s += 3; if (p.has360) s += 2; if (p.hasInfographic) s += 1
  return Math.min(s, 22)
}
function scoreAttributes(a: ProductData['attributes'], categoryAttrs?: CategoryAttrsResult | null) {
  // Если есть данные из API — считаем по реальному количеству атрибутов категории
  if (categoryAttrs?.totalCount && categoryAttrs.totalCount > 0) {
    const total = categoryAttrs.totalCount
    const filled = a.count
    const pct = filled / total
    if (pct >= 0.9) return 18
    if (pct >= 0.7) return 14
    if (pct >= 0.5) return 10
    if (pct >= 0.3) return 6
    return 3
  }
  // Fallback без API
  let s = 0
  if (a.count >= 15) s += 10; else if (a.count >= 8) s += 7; else s += 3
  if (a.hasRequired) s += 5; s += Math.min(a.count, 3)
  return Math.min(s, 18)
}
function scoreReviews(r: ProductData['reviews']) {
  let s = 0
  if (r.rating >= 4.8) s += 5; else if (r.rating >= 4.5) s += 3; else s += 1
  if (r.reviewCount >= 50) s += 4; else if (r.reviewCount >= 10) s += 2
  if (r.hasPhotos) s += 3
  return Math.min(s, 16)
}
function scoreTitle(t: ProductData['title']) {
  let s = 0
  if (t.length >= 100) s += 5; else if (t.length >= 60) s += 3; else s += 1
  if (t.hasBrand) s += 3
  if (t.keywords.length >= 2) s += 6; else s += 3
  return Math.min(s, 14)
}
function scoreDelivery(d: ProductData['delivery']) {
  if (d.speedDays === 0) return 12; if (d.speedDays === 1) return 10
  if (d.speedDays === 2) return 7; if (d.speedDays <= 5) return 4; return 1
}
function scoreDescription(d: ProductData['description']) {
  if (d.length >= 1000) return 10; if (d.length >= 500) return 7
  if (d.length >= 200) return 4; return 1
}
function scoreRich(r: ProductData['rich']) {
  if (r.imageCount >= 3) return 5; if (r.imageCount >= 1) return 3; return 0
}
function scorePrice(p: ProductData['price']) {
  if (p.hasDiscount && p.discountPercent >= 20) return 2
  if (p.hasDiscount) return 1; return 0
}
function scoreKeywords(matches: KeywordMatch[]) {
  if (matches.length === 0) return 0
  const ratio = matches.filter(m => m.found).length / matches.length
  if (ratio >= 0.7) return 8; if (ratio >= 0.4) return 5; if (ratio >= 0.1) return 2; return 0
}

function ringColor(score: number, max: number) {
  if (max === 0) return '#A08060'
  const pct = score / max
  if (pct >= 0.75) return '#6B9952'
  if (pct >= 0.45) return '#C4832A'
  return '#B85040'
}

function formatPop(pop: number) {
  if (pop >= 1_000_000) return `${(pop / 1_000_000).toFixed(1)}M`
  if (pop >= 1_000) return `${(pop / 1_000).toFixed(0)}K`
  return String(pop)
}

const STOPWORDS = new Set(['для','от','не','из','или','это','как','так','при','под','над','без','про','был','все','там','что','где','кто','они','мне','его','её','нет','уже','еще','ещё','пол','нут','ред'])

function wordBoundary(kw: string, text: string) {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s|,)${escaped}(\\s|,|$)`, 'i').test(text)
}

async function matchKeywords(data: ProductData): Promise<KeywordMatch[]> {
  try {
    const url = chrome.runtime.getURL('keywords_db.json')
    const text = await (await fetch(url)).text()
    const db: KeywordEntry[] = JSON.parse(text)
    const cardText = [data.title.raw ?? '', data.description.raw ?? '', data.attributes.raw ?? ''].join(' ').toLowerCase()
    return db.filter(e => {
      const kw = e.kw.toLowerCase()
      return kw.length >= 4 && !STOPWORDS.has(kw) && wordBoundary(kw, cardText)
    }).sort((a, b) => b.pop - a.pop).slice(0, 15).map(e => ({ kw: e.kw, pop: e.pop, found: true }))
  } catch { return [] }
}

function Ring({ score, max, size = 56 }: { score: number; max: number; size?: number }) {
  const r = size === 56 ? 23 : size === 52 ? 21 : size === 38 ? 15 : 18
  const sw = size === 56 ? 7 : size === 52 ? 7 : size === 38 ? 6 : 4
  const circ = 2 * Math.PI * r
  const offset = max === 0 ? circ : circ * (1 - score / max)
  const color = ringColor(score, max)
  const inset = sw + 1
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', display: 'block' }}>
        <circle cx={size/2} cy={size/2} r={r} strokeWidth={sw} stroke="rgba(160,130,80,0.35)" fill="none" />
        <circle cx={size/2} cy={size/2} r={r} strokeWidth={sw} stroke={color} fill="none"
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" />
      </svg>
      <div style={{ position: 'absolute', inset, background: '#F5EDD8', borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: size >= 52 ? 12 : 10, color: '#5C3E1E', lineHeight: 1 }}>
          {score}/{max}
        </span>
      </div>
    </div>
  )
}

function BlockCard({ score, max, label, full, sub, onClick }: {
  score: number; max: number; label: string; full?: boolean; sub?: string; onClick: () => void
}) {
  const ringRef = useRef<HTMLDivElement>(null)
  const blockRef = useRef<HTMLDivElement>(null)

  const handleMove = (e: React.MouseEvent) => {
    const el = blockRef.current; const ring = ringRef.current
    if (!el || !ring) return
    const r = el.getBoundingClientRect()
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
    ring.style.transition = 'transform 0.08s ease'
    ring.style.transform = `rotate3d(${-dy * 1.2},${dx * 1.2},0,18deg) scale(1.06)`
  }
  const handleLeave = () => {
    const ring = ringRef.current; if (!ring) return
    ring.style.transition = 'transform 0.4s ease'
    ring.style.transform = 'rotate3d(0,0,0,0deg) scale(1)'
  }

  const baseStyle: React.CSSProperties = {
    background: 'rgba(255,252,244,0.6)',
    border: '0.5px solid rgba(200,175,130,0.5)',
    borderRadius: 14, cursor: 'pointer', userSelect: 'none',
    ...(full
      ? { gridColumn: 'span 2', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }
      : { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, padding: '12px 8px 10px' }),
  }

  return (
    <div ref={blockRef} style={baseStyle} onClick={onClick}
      onMouseMove={handleMove} onMouseLeave={handleLeave}>
      <div ref={ringRef} style={{ transition: 'transform 0.4s ease' }}>
        <Ring score={score} max={max} size={full ? 38 : 56} />
      </div>
      <div style={full ? {} : { textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: '#6B4E28', fontWeight: 500, lineHeight: 1.3 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: '#9A7040', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  )
}

interface DetailRow { label: string; value: string; good?: boolean | null }

function DetailScreen({ title, score, max, rows, onBack, extra }: {
  title: string; score: number; max: number; rows: DetailRow[]; onBack: () => void; extra?: React.ReactNode
}) {
  const color = (good?: boolean | null) => good == null ? '#9A7040' : good ? '#4A8030' : '#923020'
  return (
    <div style={{ padding: 14 }}>
      <div onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
        marginBottom: 14, color: '#7A5532', fontSize: 13, fontWeight: 500,
        background: 'rgba(255,252,244,0.7)', border: '0.5px solid rgba(200,170,120,0.4)',
        borderRadius: 10, padding: '7px 12px', width: 'fit-content' }}>
        ← Назад
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16,
        padding: '12px 14px', background: 'rgba(255,252,244,0.7)',
        border: '0.5px solid rgba(200,170,120,0.4)', borderRadius: 14 }}>
        <Ring score={score} max={max} size={52} />
        <div>
          <div style={{ fontSize: 15, fontWeight: 500, color: '#5C3E1E' }}>{title}</div>
          <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#7A5532' }}>
            {score} из {max} баллов
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', background: 'rgba(255,252,244,0.6)',
            border: '0.5px solid rgba(200,175,130,0.45)', borderRadius: 12 }}>
            <span style={{ fontSize: 12, color: '#6B4E28', fontWeight: 500 }}>{row.label}</span>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: color(row.good) }}>{row.value}</span>
          </div>
        ))}
      </div>
      {extra}
    </div>
  )
}

// ─── Типы для баз данных ──────────────────────────────────────────────────────

interface CommissionsDB {
  fbo: number[][]
  fbs: number[][]
  types: Record<string, [number, number]>
}

interface LogisticsDB {
  avg: Record<string, number>
  universal: Record<string, number>
  vol_order: string[]
}

// ─── Налоговые системы ────────────────────────────────────────────────────────

interface TaxSystem { id: string; label: string; calc: (rev: number, costs: number) => number }

const TAX_SYSTEMS: TaxSystem[] = [
  // rev = цена без скидки банка (basePrice), costs = себестоимость в ₽
  { id: 'usn6',   label: 'УСН Доходы 6%',           calc: (rev) => Math.round(rev * 0.06) },
  { id: 'usn15',  label: 'УСН Доходы−Расходы 15%',  calc: (rev, costs) => {
    const tax = Math.max(0, rev - costs) * 0.15
    const minTax = rev * 0.01  // минимальный налог 1% от выручки
    return Math.round(Math.max(tax, minTax))
  }},
  { id: 'ausn8',  label: 'АУСН Доходы 8%',          calc: (rev) => Math.round(rev * 0.08) },
  { id: 'ausn20', label: 'АУСН Доходы−Расходы 20%', calc: (rev, costs) => Math.round(Math.max(0, rev - costs) * 0.20) },
  { id: 'nds',    label: 'НДС (ОСН) 22%',            calc: (rev, costs) => Math.round((rev - costs) * 22 / 122) },
]

// ─── Вспомогательные функции ─────────────────────────────────────────────────

const PRICE_BRACKETS = [100, 300, 1500, 5000, 10000]
const SURCHARGE_RATES = [0, 6, 8, 12]

function getPriceBracketIdx(price: number): number {
  return Math.min(PRICE_BRACKETS.filter(b => price > b).length, 5)
}

function getVolumeKey(liters: number, volOrder: string[]): string | null {
  for (const key of volOrder) {
    if (key.startsWith('От ')) {
      const min = parseFloat(key.replace('От ', '').replace(',', '.').replace(' л', ''))
      if (liters > min) return key
      continue
    }
    const parts = key.replace(' л', '').split('-')
    if (parts.length !== 2) continue
    const lo = parseFloat(parts[0].replace(',', '.'))
    const hi = parseFloat(parts[1].replace(',', '.'))
    if (liters >= lo && liters <= hi) return key
  }
  return null
}

// Карта категорий Ozon -> точный тип в таблице комиссий
// Используется когда алгоритм не может подобрать правильно
const CATEGORY_MAP: Record<string, string> = {
  'мужская обувь': 'кроссовки',
  'женская обувь': 'туфли',
  'детская обувь': 'кроссовки',
  'обувь': 'кроссовки',
  'женская одежда': 'футболка',
  'мужская одежда': 'футболка',
  'детская одежда': 'футболка',
  'одежда': 'футболка',
  'крупная бытовая техника': 'холодильник',
  'мелкая бытовая техника': 'чайник электрический',
  'бытовая техника': 'чайник электрический',
  'смартфоны и телефоны': 'смартфон',
  'телефоны': 'смартфон',
  'наушники и гарнитуры': 'наушники',
  'колонки и акустика': 'беспроводная колонка',
  'колонки': 'беспроводная колонка',
  'сумки': 'сумка женская',
  'рюкзаки': 'рюкзак',
  'часы и браслеты': 'смарт-часы',
  'игрушки': 'игрушка мягкая',
  'косметика': 'тональный крем',
  'парфюмерия': 'духи',
  'спортивное питание': 'протеин',
  'кресла и диваны': 'кресло',
  'столы': 'стол',
  'стулья': 'стул',
  'матрасы': 'матрас',
  'шины': 'шина',
}

// Запрещённые матчи — слова которые дают неверный результат
const STOP_MATCHES = new Set([
  'обувь для собак', 'обувь для куклы', 'обувь карнавальная',
  'обувь эротическая', 'обувь для ушу', 'бытовка',
  'кулич', 'водка', 'вода',
])

function getCommissionRate(
  productType: string,
  scheme: 'fbo' | 'fbs',
  price: number,
  db: CommissionsDB
): number | null {
  const key = productType.toLowerCase().trim()
  if (!key) return null

  const brackets = [100, 300, 1500, 5000, 10000]
  const idx = Math.min(brackets.filter(b => price > b).length, 5)

  const getRate = (entry: [number, number]) => {
    const rates = scheme === 'fbo' ? db.fbo[entry[0]] : db.fbs[entry[1]]
    return rates ? rates[idx] : null
  }

  // 1. Точное совпадение
  if (db.types[key]) return getRate(db.types[key])

  // 2. Карта категорий (для сложных/составных категорий)
  if (CATEGORY_MAP[key] && db.types[CATEGORY_MAP[key]])
    return getRate(db.types[CATEGORY_MAP[key]])

  // 3. По каждому значимому слову из хлебных крошек
  const words = key.replace(/,/g, ' ').split(' ').filter(w => w.length > 2)
  for (const word of words) {
    // перебираем варианты: полное слово и с обрезанными окончаниями
    const stems = [word, ...['еры','ери','еры','ки','жи','ши','ги','ни','и','ы','а','е']
      .filter(s => word.endsWith(s) && word.length - s.length >= 4)
      .map(s => word.slice(0, -s.length))]

    for (const stem of stems) {
      // сначала точное совпадение первого слова ключа
      const exact = Object.keys(db.types).find(k => k.split(' ')[0] === stem)
      if (exact && !STOP_MATCHES.has(exact) && db.types[exact]) {
        return getRate(db.types[exact])
      }
      // потом startswith (только для длинных стемов)
      if (stem.length >= 5) {
        const starts = Object.keys(db.types)
          .filter(k => k.split(' ')[0].startsWith(stem) && !STOP_MATCHES.has(k))
          .sort((a, b) => a.length - b.length)
        if (starts.length > 0 && db.types[starts[0]]) {
          return getRate(db.types[starts[0]])
        }
      }
    }
  }

  // 4. Последнее слово через карту
  const lastWord = words[words.length - 1]
  if (lastWord && CATEGORY_MAP[lastWord] && db.types[CATEGORY_MAP[lastWord]])
    return getRate(db.types[CATEGORY_MAP[lastWord]])

  return null
}

function getLogisticsTariff(liters: number, db: LogisticsDB): number | null {
  const key = getVolumeKey(liters, db.vol_order)
  if (!key) return null
  return db.avg[key] ?? db.universal[key] ?? null
}

// ─── Новый UnitCalc ───────────────────────────────────────────────────────────

function UnitCalc({ price: parsedPrice, basePrice: parsedBasePrice, productType }: { price: number; basePrice: number; productType: string }) {
  const [commissionsDB, setCommissionsDB] = useState<CommissionsDB | null>(null)
  const [logisticsDB, setLogisticsDB]     = useState<LogisticsDB | null>(null)
  const [cnyRate, setCnyRate]             = useState<number>(13.5)
  const [cnyLoading, setCnyLoading]       = useState(true)

  // Пользовательские вводы
  const [spp, setSpp]             = useState<number>(25)
  const [basePrice, setBasePrice]  = useState<number>(parsedBasePrice)          // СПП от Ozon %
  const [costCny, setCostCny]     = useState('')                  // себестоимость ¥
  const [volume, setVolume]       = useState('')                  // объём л
  const [scheme, setScheme]       = useState<'fbo' | 'fbs'>('fbo')
  const [taxId, setTaxId]         = useState('usn6')
  const [adRate, setAdRate]       = useState<number>(10)          // реклама %
  const [showSurcharge, setShowSurcharge] = useState(false)
  const [manualComm, setManualComm] = useState<string>('')        // ручная комиссия

  useEffect(() => {
    fetch(chrome.runtime.getURL('commissions.json'))
      .then(r => r.json())
      .then(d => { setCommissionsDB(d) })
      .catch(e => console.error('[Pomogator] commissions FAILED:', e))
    fetch(chrome.runtime.getURL('logistics.json'))
      .then(r => r.json())
      .then(d => { setLogisticsDB(d) })
      .catch(e => console.error('[Pomogator] logistics FAILED:', e))
    fetch('https://www.cbr-xml-daily.ru/daily_json.js')
      .then(r => r.json())
      .then(d => { if (d?.Valute?.CNY?.Value) setCnyRate(d.Valute.CNY.Value) })
      .catch(() => {})
      .finally(() => setCnyLoading(false))
  }, [])

  // Цена в ЛК = цена покупателя / (1 - СПП/100)
  const lkPrice    = Math.round(parsedPrice / (1 - spp / 100))

  // Расчёты
  const liters     = parseFloat(volume.replace(',', '.')) || 0
  const costRub    = parseFloat(costCny.replace(',', '.')) * cnyRate || 0
  const taxSystem  = TAX_SYSTEMS.find(t => t.id === taxId) ?? TAX_SYSTEMS[0]

  // Комиссия: авто или ручная
  const autoCommRate = commissionsDB
    ? getCommissionRate(productType, scheme, lkPrice, commissionsDB)
    : null
  const commRate = manualComm !== ''
    ? parseFloat(manualComm)
    : autoCommRate

  const logTariff  = logisticsDB && liters > 0 ? getLogisticsTariff(liters, logisticsDB) : null

  const commRub       = commRate != null ? Math.round(lkPrice * commRate / 100) : null
  const acquiring     = Math.round(lkPrice * 0.015)
  const deliveryFee   = 25
  const processingFee = scheme === 'fbs' ? 20 : 0
  const adRub         = Math.round(lkPrice * adRate / 100)

  // Налог всегда считается
  // Налог считается от цены без скидки банка (basePrice)
  const taxAmount = taxSystem.calc(basePrice, costRub)

  // Итог когда введены себестоимость и объём
  const canCalc       = costCny !== '' && volume !== ''
  const commRubSafe   = commRub ?? 0
  const logTariffSafe = logTariff ?? 0

  const totalExpenses = canCalc
    ? commRubSafe + logTariffSafe + acquiring + deliveryFee + processingFee + Math.round(costRub) + taxAmount + adRub
    : null

  const profit = totalExpenses != null
    ? Math.round(lkPrice - totalExpenses)
    : null

  const margin = profit != null && lkPrice > 0
    ? Math.round(profit / lkPrice * 100)
    : null

  const roi = profit != null && costRub > 0
    ? Math.round(profit / costRub * 100)
    : null

  const marginColor = margin == null ? '#9A7040'
    : margin >= 25 ? '#4A8030'
    : margin >= 10 ? '#A06010'
    : '#923020'

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: 10,
    border: '0.5px solid rgba(200,175,130,0.5)',
    background: 'rgba(255,252,244,0.8)', color: '#5C3E1E', fontSize: 13,
    fontFamily: "'Outfit', sans-serif", outline: 'none', boxSizing: 'border-box',
  }
  const rowStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 14px', background: 'rgba(255,252,244,0.6)',
    border: '0.5px solid rgba(200,175,130,0.45)', borderRadius: 10,
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: '#9A7040', marginBottom: 4,
    display: 'block', fontFamily: "'Outfit', sans-serif",
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: '#5C3E1E', marginBottom: 10 }}>
        Юнит-экономика
      </div>

      {/* FBO / FBS */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {(['fbo', 'fbs'] as const).map(s => (
          <button key={s} onClick={() => setScheme(s)} style={{
            flex: 1, padding: '7px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
            fontFamily: "'Outfit', sans-serif", fontSize: 13, fontWeight: 600,
            background: scheme === s ? '#C4832A' : 'rgba(200,175,130,0.2)',
            color: scheme === s ? '#fff' : '#9A7040', transition: 'all 0.15s',
          }}>
            {s.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Цена покупателя + СПП → цена в ЛК */}
      <div style={{ ...rowStyle, flexDirection: 'column', alignItems: 'stretch', gap: 8, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6B4E28' }}>Цена покупателя (с сайта)</span>
          <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#5C3E1E' }}>
            {parsedPrice.toLocaleString('ru')} ₽
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ ...labelStyle, marginBottom: 0, whiteSpace: 'nowrap' }}>СПП от Ozon</label>
          <input
            style={{ ...inputStyle, width: 60, textAlign: 'center' }}
            type="number" min="0" max="60" value={spp}
            onChange={e => setSpp(Math.min(60, Math.max(0, parseFloat(e.target.value) || 0)))}
          />
          <span style={{ fontSize: 12, color: '#9A7040' }}>%</span>
          <span style={{ marginLeft: 'auto', fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#5C3E1E' }}>
            → {lkPrice.toLocaleString('ru')} ₽ в ЛК
          </span>
        </div>
      </div>

      {/* Основные поля */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div>
          <label style={labelStyle}>
            Себест. ¥ {cnyLoading ? '·загрузка' : `· ${cnyRate.toFixed(2)}₽`}
          </label>
          <input style={inputStyle} type="number" placeholder="0" value={costCny}
            onChange={e => setCostCny(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Объём, л</label>
          <input style={inputStyle} type="number" placeholder="0.4" value={volume}
            onChange={e => setVolume(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Реклама, %</label>
          <input style={inputStyle} type="number" min="0" max="100" value={adRate}
            onChange={e => setAdRate(parseFloat(e.target.value) || 0)} />
        </div>
        <div>
          <label style={labelStyle}>Налог</label>
          <select style={{ ...inputStyle, cursor: 'pointer' }} value={taxId}
            onChange={e => setTaxId(e.target.value)}>
            {TAX_SYSTEMS.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Комиссия: авто + возможность изменить */}
      <div style={{ ...rowStyle, flexDirection: 'column', alignItems: 'stretch', gap: 6, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#6B4E28' }}>
            Комиссия Ozon
            {autoCommRate != null && manualComm === '' && (
              <span style={{ color: '#9A7040', marginLeft: 4 }}>
                (авто · {productType})
              </span>
            )}
          </span>
          <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
            {commRub != null ? `−${commRub.toLocaleString('ru')} ₽` : '—'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            style={{ ...inputStyle, width: 60, textAlign: 'center' }}
            type="number" min="0" max="100"
            placeholder={autoCommRate != null ? String(autoCommRate) : '—'}
            value={manualComm}
            onChange={e => setManualComm(e.target.value)}
          />
          <span style={{ fontSize: 11, color: '#9A7040' }}>
            % {manualComm !== '' ? '(вручную)' : autoCommRate != null ? '(определена авто)' : '(не определена — введите)'}
          </span>
          {manualComm !== '' && (
            <button onClick={() => setManualComm('')} style={{
              marginLeft: 'auto', fontSize: 11, color: '#9A7040', background: 'none',
              border: 'none', cursor: 'pointer', padding: '2px 6px',
            }}>сброс</button>
          )}
        </div>
      </div>

      {/* Расходы */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>

        {/* Логистика + наценка */}
        <div style={{ ...rowStyle, flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6B4E28' }}>Логистика (среднее)</span>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
              {logTariff != null ? `−${logTariff} ₽` : liters > 0 ? '—' : 'введите объём'}
            </span>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: '#9A7040', cursor: 'pointer' }}>
            <input type="checkbox" checked={showSurcharge}
              onChange={e => setShowSurcharge(e.target.checked)}
              style={{ cursor: 'pointer', accentColor: '#C4832A' }} />
            Учесть наценку за нелокальность
          </label>
          {showSurcharge && (
            <div style={{ background: 'rgba(196,131,42,0.07)', borderRadius: 8,
              padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {SURCHARGE_RATES.map(rate => (
                <div key={rate} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: '#9A7040' }}>Наценка {rate}%</span>
                  <span style={{ color: '#923020', fontFamily: "'DM Serif Display', serif" }}>
                    +{Math.round(lkPrice * rate / 100).toLocaleString('ru')} ₽
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={rowStyle}>
          <span style={{ fontSize: 12, color: '#6B4E28' }}>Реклама ({adRate}%)</span>
          <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
            −{adRub.toLocaleString('ru')} ₽
          </span>
        </div>

        <div style={rowStyle}>
          <span style={{ fontSize: 12, color: '#6B4E28' }}>Эквайринг (1.5%)</span>
          <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
            −{acquiring.toLocaleString('ru')} ₽
          </span>
        </div>

        <div style={rowStyle}>
          <span style={{ fontSize: 12, color: '#6B4E28' }}>Доставка до выдачи</span>
          <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
            до −{deliveryFee} ₽
          </span>
        </div>

        {scheme === 'fbs' && (
          <div style={rowStyle}>
            <span style={{ fontSize: 12, color: '#6B4E28' }}>Обработка отправления</span>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
              −{processingFee} ₽
            </span>
          </div>
        )}

        {costRub > 0 && (
          <div style={rowStyle}>
            <span style={{ fontSize: 12, color: '#6B4E28' }}>Себестоимость</span>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
              −{Math.round(costRub).toLocaleString('ru')} ₽
            </span>
          </div>
        )}

        <div style={rowStyle}>
          <span style={{ fontSize: 12, color: '#6B4E28' }}>
            {taxSystem.label}
            <span style={{ fontSize: 10, color: '#9A7040', marginLeft: 4 }}>
              (база: {basePrice.toLocaleString('ru')} ₽)
            </span>
          </span>
          <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 13, color: '#923020' }}>
            {taxAmount > 0 ? `−${taxAmount.toLocaleString('ru')} ₽` : '—'}
          </span>
        </div>
      </div>

      {/* Итог */}
      {profit != null && (
        <>
          <div style={{ ...rowStyle,
            background: profit > 0 ? 'rgba(107,153,82,0.12)' : 'rgba(184,80,64,0.10)',
            border: `0.5px solid ${profit > 0 ? 'rgba(107,153,82,0.4)' : 'rgba(184,80,64,0.4)'}`,
            marginBottom: 6,
          }}>
            <span style={{ fontSize: 13, color: '#5C3E1E', fontWeight: 500 }}>Чистая прибыль</span>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 14, color: marginColor, fontWeight: 600 }}>
              {profit > 0 ? '+' : ''}{profit.toLocaleString('ru')} ₽
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ ...rowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              <span style={{ fontSize: 11, color: '#9A7040' }}>Маржа (от цены ЛК)</span>
              <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 16, color: marginColor }}>
                {margin}%
              </span>
            </div>
            <div style={{ ...rowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              <span style={{ fontSize: 11, color: '#9A7040' }}>ROI</span>
              <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 16,
                color: roi != null && roi > 50 ? '#4A8030' : roi != null && roi > 0 ? '#A06010' : '#923020' }}>
                {roi != null ? `${roi}%` : '—'}
              </span>
            </div>
          </div>

          <div style={{ marginTop: 6, fontSize: 11, color: marginColor, textAlign: 'center',
            fontFamily: "'Outfit', sans-serif" }}>
            {margin != null && margin >= 25 ? '✓ Хорошая маржинальность'
              : margin != null && margin >= 10 ? '⚠ Низкая маржинальность'
              : '✗ Экономика не сходится'}
          </div>
        </>
      )}
    </div>
  )
}

interface CategoryAttrsResult {
  attrs?: any[]
  totalCount?: number
  totalChars?: number
  requiredCount?: number
  reqAttrs?: string[]
  groups?: string[]
  matchedCategory?: string
  categoryId?: number
  typeId?: number
  error?: string
}

function Widget({ data }: { data: ProductData }) {
  const [detail, setDetail] = useState<string | null>(null)
  const [matches, setMatches] = useState<KeywordMatch[] | null>(null)
  const [categoryAttrs, setCategoryAttrs] = useState<CategoryAttrsResult | null>(null)
  const [attrsLoading, setAttrsLoading] = useState(false)

  useEffect(() => { matchKeywords(data).then(setMatches) }, [data])

  // Загружаем атрибуты категории через API если есть ключи
  useEffect(() => {
    const categoryName = data.title.productType || ''
    if (!categoryName) return
    setAttrsLoading(true)
    chrome.runtime.sendMessage(
      { type: 'GET_CATEGORY_ATTRS', categoryName },
      (resp) => {
        setAttrsLoading(false)
        if (resp && !resp.error) setCategoryAttrs(resp)
        else setCategoryAttrs({ error: resp?.error })
      }
    )
  }, [data.title.productType])

  const sc = {
    photos: scorePhotos(data.photos),
    attrs: scoreAttributes(data.attributes, categoryAttrs),
    reviews: scoreReviews(data.reviews),
    seo: scoreTitle(data.title),
    delivery: scoreDelivery(data.delivery),
    desc: scoreDescription(data.description),
    rich: scoreRich(data.rich),
    price: scorePrice(data.price),
    keys: matches ? scoreKeywords(matches) : 0,
  }
  const total = Object.values(sc).reduce((a, b) => a + b, 0)
  const totalCirc = 2 * Math.PI * 18
  const totalOffset = totalCirc * (1 - total / 107)

  const wrapStyle: React.CSSProperties = {
    fontFamily: "'Outfit', sans-serif",
    width: '100%', background: '#F5EDD8',
    borderRadius: 20, border: '0.5px solid rgba(180,150,100,0.25)',
    overflow: 'hidden', margin: '12px 0',
  }

  const detailMap: Record<string, { title: string; score: number; max: number; rows: DetailRow[] }> = {
    photos: { title: 'Фото и медиа', score: sc.photos, max: 22, rows: [
      { label: 'Количество фото', value: String(data.photos.count), good: data.photos.count >= 8 },
      { label: 'Видео', value: data.photos.hasVideo ? 'Есть' : 'Нет', good: data.photos.hasVideo },
      { label: '3D / 360°', value: data.photos.has360 ? 'Есть' : 'Нет', good: data.photos.has360 },
      { label: 'Инфографика', value: data.photos.hasInfographic ? 'Есть' : 'Нет', good: data.photos.hasInfographic },
      { label: 'Рекомендуем', value: '8+ фото + видео', good: null },
    ]},
    attrs: { title: 'Характеристики', score: sc.attrs, max: 18, rows: (() => {
      const rows: DetailRow[] = []
      if (attrsLoading) {
        rows.push({ label: 'Загрузка данных...', value: '⏳', good: null })
      } else if (categoryAttrs?.totalCount) {
        // totalChars = только характеристики с группой (без служебных полей)
        const total = categoryAttrs.totalChars ?? categoryAttrs.totalCount
        const req = categoryAttrs.requiredCount ?? 0
        const filled = data.attributes.count
        const pct = Math.round(filled / total * 100)
        const toFill90 = Math.max(0, Math.ceil(total * 0.9) - filled)

        // Основные метрики
        rows.push({ label: 'Заполнено полей', value: `${filled} из ${total} (${pct}%)`, good: pct >= 90 })
        rows.push({ label: 'Обязательные поля', value: req > 0 ? `${req} шт` : 'нет', good: null })
        rows.push({ label: 'Категория Ozon', value: categoryAttrs.matchedCategory ?? '—', good: null })

        // Статус по алгоритму
        if (pct >= 90) {
          rows.push({ label: '✓ Алгоритм Ozon', value: 'Отличное заполнение (+20-30 позиций)', good: true })
        } else if (pct >= 70) {
          rows.push({ label: '⚠ Алгоритм Ozon', value: `Заполните ещё ${toFill90} полей для топа`, good: false })
        } else {
          rows.push({ label: '✗ Алгоритм Ozon', value: `Критически мало: нужно ещё ${toFill90} полей`, good: false })
        }

        // Группы которые стоит заполнить
        if (categoryAttrs.groups?.length && pct < 90) {
          rows.push({ label: 'Рекомендуем заполнить', value: categoryAttrs.groups.slice(0, 3).join(', '), good: null })
        }

        // Обязательные поля из БД
        if (categoryAttrs.reqAttrs?.length) {
          rows.push({ label: 'Обязательные поля', value: categoryAttrs.reqAttrs.join(', '), good: null })
        }
      } else {
        rows.push({ label: 'Заполнено полей', value: String(data.attributes.count), good: data.attributes.count >= 8 })
        rows.push({ label: 'Обязательные', value: data.attributes.hasRequired ? 'Все заполнены' : 'Не все', good: data.attributes.hasRequired })
        if (categoryAttrs?.error) rows.push({ label: 'Статус', value: categoryAttrs.error, good: null })
      }
      return rows
    })()},
    reviews: { title: 'Отзывы и рейтинг', score: sc.reviews, max: 16, rows: [
      { label: 'Рейтинг', value: String(data.reviews.rating), good: data.reviews.rating >= 4.5 },
      { label: 'Количество отзывов', value: String(data.reviews.reviewCount), good: data.reviews.reviewCount >= 50 },
      { label: 'Фото в отзывах', value: data.reviews.hasPhotos ? 'Есть' : 'Нет', good: data.reviews.hasPhotos },
    ]},
    seo: { title: 'Название и SEO', score: sc.seo, max: 14, rows: [
      { label: 'Длина названия', value: `${data.title.length} симв.`, good: data.title.length >= 60 },
      { label: 'Бренд', value: data.title.hasBrand ? 'Есть' : 'Нет', good: data.title.hasBrand },
      { label: 'Ключи в названии', value: data.title.keywords[0] || '—', good: data.title.keywords.length >= 2 },
    ]},
    delivery: { title: 'Доставка', score: sc.delivery, max: 12, rows: [
      { label: 'Срок доставки', value: data.delivery.speedText, good: data.delivery.speedDays <= 1 },
      { label: 'Экспресс', value: data.delivery.hasExpress ? 'Есть' : 'Нет', good: data.delivery.hasExpress },
      { label: 'Рекомендуем', value: 'Распределить на 3+ склада', good: null },
    ]},
    desc: { title: 'Описание', score: sc.desc, max: 10, rows: [
      { label: 'Длина описания', value: `${data.description.length} симв.`, good: data.description.length >= 500 },
      { label: 'Рекомендуем', value: 'Расширить до 1000+ симв.', good: null },
    ]},
    rich: { title: 'Rich-контент', score: sc.rich, max: 5, rows: [
      { label: 'Фото в описании', value: String(data.rich.imageCount), good: data.rich.imageCount >= 1 },
      { label: 'Рекомендуем', value: 'Добавить Rich-контент (+25% CTR)', good: null },
    ]},
    price: { title: 'Цена и акции', score: sc.price, max: 2, rows: [
      { label: 'Текущая цена', value: data.price.currentPrice ? `${data.price.currentPrice.toLocaleString('ru')} ₽` : '—', good: null },
      { label: 'Скидка', value: data.price.hasDiscount ? `${data.price.discountPercent}%` : 'Нет', good: data.price.hasDiscount },
      { label: 'Индекс цен Ozon', value: data.price.promoType ?? 'Нет (нет данных)', good: null },
    ]},
    keys: { title: 'Ключи и позиции', score: sc.keys, max: 8,
      rows: matches && matches.length > 0
        ? matches.map(m => ({ label: m.kw, value: formatPop(m.pop) + '/мес', good: true }))
        : [{ label: 'Ключи не найдены', value: '—', good: false }],
    },
  }

  if (detail && detailMap[detail]) {
    const d = detailMap[detail]
    return (
      <div style={wrapStyle}>
        <DetailScreen title={d.title} score={d.score} max={d.max} rows={d.rows} onBack={() => setDetail(null)}
          extra={detail === 'price'
            ? <UnitCalc price={data.price.currentPrice} basePrice={data.price.basePrice ?? data.price.currentPrice} productType={data.title.productType ?? ''} />
            : undefined}
        />
      </div>
    )
  }

  const keySub = matches === null ? 'Загрузка...' : matches.length > 0
    ? `${matches.length} ключей · нажмите для деталей`
    : 'Ключи не найдены'

  return (
    <div style={wrapStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        margin: '14px 14px 12px', padding: '10px 14px',
        background: 'rgba(255,252,244,0.7)', border: '0.5px solid rgba(200,170,120,0.4)', borderRadius: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: '#5C3E1E', letterSpacing: '0.02em' }}>Pomogator.ai</span>
        <div style={{ position: 'relative', width: 44, height: 44 }}>
          <svg width="44" height="44" viewBox="0 0 44 44" style={{ transform: 'rotate(-90deg)', display: 'block' }}>
            <circle cx="22" cy="22" r="18" strokeWidth="4" stroke="rgba(160,130,80,0.35)" fill="none" />
            <circle cx="22" cy="22" r="18" strokeWidth="4" stroke="#7A5532" fill="none"
              strokeDasharray={totalCirc} strokeDashoffset={totalOffset} strokeLinecap="round" />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'DM Serif Display', serif", fontSize: 11, color: '#5C3E1E' }}>
            {total}/107
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, padding: '0 14px 14px' }}>
        <BlockCard score={sc.photos} max={22} label="Фото и медиа" onClick={() => setDetail('photos')} />
        <BlockCard score={sc.attrs} max={18} label="Характеристики" onClick={() => setDetail('attrs')} />
        <BlockCard score={sc.reviews} max={16} label="Отзывы и рейтинг" onClick={() => setDetail('reviews')} />
        <BlockCard score={sc.seo} max={14} label="Название и SEO" onClick={() => setDetail('seo')} />
        <BlockCard score={sc.delivery} max={12} label="Доставка" onClick={() => setDetail('delivery')} />
        <BlockCard score={sc.desc} max={10} label="Описание" onClick={() => setDetail('desc')} />
        <BlockCard score={sc.rich} max={5} label="Rich-контент" onClick={() => setDetail('rich')} />
        <BlockCard score={sc.price} max={2} label="Цена и акции" onClick={() => setDetail('price')} />
        <BlockCard score={sc.keys} max={8} label="Ключи и позиции" full sub={keySub} onClick={() => setDetail('keys')} />
      </div>
    </div>
  )
}

function App() {
  const [data, setData] = useState<ProductData | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => { setData(parseProduct()) }, 2000)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!data || mounted) return
    const priceWidget = document.querySelector('[data-widget="webPrice"]')
    const container = priceWidget?.parentElement?.parentElement
    if (!container) return
    const cartWidget = container.querySelector('[data-widget="webAddToCart"]')
    const wrapper = document.createElement('div')
    wrapper.id = 'pomogator-inline'
    if (cartWidget?.parentElement) cartWidget.parentElement.insertBefore(wrapper, cartWidget.nextSibling)
    else container.appendChild(wrapper)
    ReactDOM.createRoot(wrapper).render(<Widget data={data} />)
    setMounted(true)
  }, [data])

  return null
}

const fontLink = document.createElement('link')
fontLink.rel = 'stylesheet'
fontLink.href = 'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Outfit:wght@400;500&display=swap'
document.head.appendChild(fontLink)

const host = document.createElement('div')
host.id = 'pomogator-root'
document.body.appendChild(host)
const shadow = host.attachShadow({ mode: 'open' })
const container = document.createElement('div')
shadow.appendChild(container)
ReactDOM.createRoot(container).render(<React.StrictMode><App /></React.StrictMode>)
