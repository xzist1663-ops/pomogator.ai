import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { parseProduct, ProductData } from './parser'
import { getPositionOzonSearch } from './positions/ozon-search'

interface KeywordEntry {
  kw: string
  pop: number
  months: number
  cc: number
  oc: number
  comp: number
}

interface KeywordMatch {
  kw: string
  pop: number
  found: boolean
}

function scorePhotos(p: ProductData['photos']) {
  let s = 0
  if (p.count >= 8) s += 16; else if (p.count >= 5) s += 10; else s += 4
  if (p.hasVideo) s += 3
  if (p.has360) s += 2
  if (p.hasInfographic) s += 1
  return Math.min(s, 22)
}
function scoreAttributes(a: ProductData['attributes']) {
  let s = 0
  if (a.count >= 15) s += 10; else if (a.count >= 8) s += 7; else s += 3
  if (a.hasRequired) s += 5
  s += Math.min(a.count, 3)
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
  if (d.speedDays === 0) return 12
  if (d.speedDays === 1) return 10
  if (d.speedDays === 2) return 7
  if (d.speedDays <= 5) return 4
  return 1
}
function scoreDescription(d: ProductData['description']) {
  if (d.length >= 1000) return 10
  if (d.length >= 500) return 7
  if (d.length >= 200) return 4
  return 1
}
function scoreRich(r: ProductData['rich']) {
  if (r.imageCount >= 3) return 5
  if (r.imageCount >= 1) return 3
  return 0
}
function scorePrice(p: ProductData['price']) {
  if (p.hasDiscount && p.discountPercent >= 20) return 2
  if (p.hasDiscount) return 1
  return 0
}
function scoreKeywords(matches: KeywordMatch[]) {
  if (matches.length === 0) return 0
  const found = matches.filter(m => m.found).length
  const ratio = found / matches.length
  if (ratio >= 0.7) return 8
  if (ratio >= 0.4) return 5
  if (ratio >= 0.1) return 2
  return 0
}

function getColor(score: number, max: number) {
  if (max === 0) return '#8899BB'
  const pct = score / max
  if (pct >= 0.75) return '#10B981'
  if (pct >= 0.45) return '#F59E0B'
  return '#EF4444'
}

function formatPop(pop: number): string {
  if (pop >= 1_000_000) return `${(pop / 1_000_000).toFixed(1)}M`
  if (pop >= 1_000) return `${(pop / 1_000).toFixed(0)}K`
  return String(pop)
}

const STOPWORDS = new Set(['для','от','не','из','или','это','как','так','при','под','над','без','про','был','все','там','что','где','кто','они','мне','его','её','нет','уже','еще','ещё','пол','нут','ред'])

function wordBoundary(kw: string, text: string): boolean {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(^|\\s|,)${escaped}(\\s|,|$)`, 'i')
  return regex.test(text)
}

async function matchKeywords(data: ProductData): Promise<KeywordMatch[]> {
  try {
    const url = chrome.runtime.getURL('keywords_db.json')
    const resp = await fetch(url)
    const text = await resp.text()
    const db: KeywordEntry[] = JSON.parse(text)
    const cardText = [
      data.title.raw ?? '',
      data.description.raw ?? '',
      data.attributes.raw ?? '',
    ].join(' ').toLowerCase()
    const found: KeywordMatch[] = db
      .filter(entry => {
        const kw = entry.kw.toLowerCase()
        return kw.length >= 4 && !STOPWORDS.has(kw) && wordBoundary(kw, cardText)
      })
      .sort((a, b) => b.pop - a.pop)
      .slice(0, 15)
      .map(entry => ({ kw: entry.kw, pop: entry.pop, found: true }))
    return found
  } catch (e) {
    console.error('Pomogator keywords error:', e)
    return []
  }
}

function Block({ title, score, max, children }: {
  title: string, score: number, max: number, children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const color = getColor(score, max)
  const scoreLabel = max > 0 ? `${score}/${max}` : '—'
  return (
    <div style={{ borderBottom: '1px solid #1E2D45' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ fontSize: '12px', color: '#8899BB' }}>{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color }}>{scoreLabel}</span>
          <span style={{ color: '#8899BB', fontSize: '10px' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, good }: { label: string, value: string, good?: boolean | null }) {
  const color = good == null ? '#8899BB' : good ? '#10B981' : '#EF4444'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '11px' }}>
      <span style={{ color: '#8899BB' }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

function KeywordsBlock({ data }: { data: ProductData }) {
  const [matches, setMatches] = useState<KeywordMatch[] | null>(null)
  const [positions, setPositions] = useState<Record<string, number | null>>({})
  const [open, setOpen] = useState(false)

  const articleId = window.location.href.match(/\/(\d{7,10})\/?/)?.[1] ?? ''

  useEffect(() => {
    matchKeywords(data).then(setMatches)
  }, [data])

  useEffect(() => {
    if (!matches || matches.length === 0 || !articleId) return
    matches.forEach(async (m) => {
      try {
        const result = await getPositionOzonSearch(m.kw, articleId)
        setPositions(prev => ({ ...prev, [m.kw]: result.position }))
      } catch {
        setPositions(prev => ({ ...prev, [m.kw]: null }))
      }
    })
  }, [matches, articleId])

  const score = matches ? scoreKeywords(matches) : 0
  const color = getColor(score, 8)
  const scoreLabel = matches === null ? '...' : `${score}/8`

  return (
    <div style={{ borderBottom: '1px solid #1E2D45' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ fontSize: '12px', color: '#8899BB' }}>Ключи и позиции</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color }}>{scoreLabel}</span>
          <span style={{ color: '#8899BB', fontSize: '10px' }}>{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: '0 12px 10px' }}>
          {matches === null && (
            <div style={{ fontSize: '11px', color: '#8899BB' }}>Загрузка...</div>
          )}
          {matches !== null && matches.length === 0 && (
            <div style={{ fontSize: '11px', color: '#8899BB' }}>
              Ключевые слова из базы не найдены в карточке
            </div>
          )}
          {matches !== null && matches.length > 0 && (
            <>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '2px 0 4px', fontSize: '10px', color: '#556677',
                borderBottom: '1px solid #1E2D45', marginBottom: '4px'
              }}>
                <span>Ключ</span>
                <div style={{ display: 'flex', gap: '24px' }}>
                  <span>Попул.</span>
                  <span style={{ minWidth: '40px', textAlign: 'right' }}>Место</span>
                </div>
              </div>

              {matches.map(m => {
                const pos = positions[m.kw]
                const posLabel = pos === undefined ? '—' : pos === null ? '—' : `#${pos}`
                const posColor = '#556677'

                return (
                  <div key={m.kw} style={{
                    display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', padding: '3px 0', fontSize: '11px',
                  }}>
                    <span style={{ color: '#C8D8F0', flex: 1, marginRight: '8px' }}>{m.kw}</span>
                    <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
                      <span style={{ color: '#8899BB' }}>{formatPop(m.pop)}</span>
                      <span style={{
                        color: posColor, fontWeight: 700,
                        minWidth: '40px', textAlign: 'right'
                      }}>{posLabel}</span>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function App() {
  const [data, setData] = useState<ProductData | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      const d = parseProduct()
      setData(d)
    }, 2000)
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
    if (cartWidget?.parentElement) {
      cartWidget.parentElement.insertBefore(wrapper, cartWidget.nextSibling)
    } else {
      container.appendChild(wrapper)
    }
    ReactDOM.createRoot(wrapper).render(<Widget data={data} />)
    setMounted(true)
  }, [data])

  return null
}

function Widget({ data }: { data: ProductData }) {
  const scores = {
    photos: scorePhotos(data.photos),
    attributes: scoreAttributes(data.attributes),
    reviews: scoreReviews(data.reviews),
    title: scoreTitle(data.title),
    delivery: scoreDelivery(data.delivery),
    description: scoreDescription(data.description),
    rich: scoreRich(data.rich),
    price: scorePrice(data.price),
  }
  const total = Object.values(scores).reduce((a, b) => a + b, 0)
  const totalColor = getColor(total, 99)

  return (
    <div style={{
      background: '#0A0E17', border: '1px solid #1E2D45',
      borderRadius: '12px', margin: '12px 0',
      fontFamily: 'sans-serif', overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 12px', borderBottom: '1px solid #1E2D45',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ color: '#00E5FF', fontWeight: 700, fontSize: '13px' }}>Pomogator.ai</span>
        <span style={{ color: totalColor, fontWeight: 700, fontSize: '16px' }}>{total}/99</span>
      </div>

      <Block title="Фото и медиа" score={scores.photos} max={22}>
        <Row label="Фото" value={String(data.photos.count)} good={data.photos.count >= 8} />
        <Row label="Видео" value={data.photos.hasVideo ? 'Есть' : 'Нет'} good={data.photos.hasVideo} />
        <Row label="3D/360°" value={data.photos.has360 ? 'Есть' : 'Нет'} good={data.photos.has360} />
        <Row label="Инфографика" value={data.photos.hasInfographic ? 'Есть' : 'Нет'} good={data.photos.hasInfographic} />
      </Block>

      <Block title="Характеристики" score={scores.attributes} max={18}>
        <Row label="Заполнено полей" value={String(data.attributes.count)} good={data.attributes.count >= 8} />
        <Row label="Обязательные" value={data.attributes.hasRequired ? 'Есть' : 'Нет'} good={data.attributes.hasRequired} />
      </Block>

      <Block title="Отзывы и рейтинг" score={scores.reviews} max={16}>
        <Row label="Рейтинг" value={String(data.reviews.rating)} good={data.reviews.rating >= 4.5} />
        <Row label="Отзывов" value={String(data.reviews.reviewCount)} good={data.reviews.reviewCount >= 50} />
        <Row label="Фото в отзывах" value={data.reviews.hasPhotos ? 'Есть' : 'Нет'} good={data.reviews.hasPhotos} />
      </Block>

      <Block title="Название и SEO" score={scores.title} max={14}>
        <Row label="Длина" value={`${data.title.length} симв.`} good={data.title.length >= 60} />
        <Row label="Бренд" value={data.title.hasBrand ? 'Есть' : 'Нет'} good={data.title.hasBrand} />
        <Row label="Ключи" value={data.title.keywords[0] || '—'} />
      </Block>

      <Block title="Доставка" score={scores.delivery} max={12}>
        <Row label="Срок" value={data.delivery.speedText} good={data.delivery.speedDays <= 1} />
        <Row label="Экспресс" value={data.delivery.hasExpress ? 'Есть' : 'Нет'} good={data.delivery.hasExpress} />
      </Block>

      <Block title="Описание" score={scores.description} max={10}>
        <Row label="Длина" value={`${data.description.length} симв.`} good={data.description.length >= 500} />
      </Block>

      <Block title="Rich-контент" score={scores.rich} max={5}>
        <Row label="Фото в описании" value={String(data.rich.imageCount)} good={data.rich.imageCount >= 1} />
      </Block>

      <Block title="Цена и акции" score={scores.price} max={2}>
        <Row label="Скидка" value={data.price.hasDiscount ? `${data.price.discountPercent}%` : 'Нет'} good={data.price.hasDiscount} />
      </Block>

      <KeywordsBlock data={data} />
    </div>
  )
}

const host = document.createElement('div')
host.id = 'pomogator-root'
document.body.appendChild(host)
const shadow = host.attachShadow({ mode: 'open' })
const container = document.createElement('div')
shadow.appendChild(container)
ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)