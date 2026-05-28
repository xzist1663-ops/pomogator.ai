// UnitCalc.tsx — Калькулятор юнит-экономики для Pomogator.ai
// Вставить в src/content/index.tsx или импортировать отдельно
// Зависимости: commissions.json и logistics.json должны лежать в public/

import { useState, useEffect, useCallback } from 'react'

// ─── Типы ────────────────────────────────────────────────────────────────────

interface CommissionsDB {
  fbo: number[][]   // палитра наборов [6 ценовых диапазонов]
  fbs: number[][]
  types: Record<string, [number, number]>  // type_lower -> [fbo_idx, fbs_idx]
}

interface LogisticsDB {
  avg: Record<string, number>        // среднее из Москвы, свыше 300 руб
  universal: Record<string, number>  // fallback без кластера
  vol_order: string[]
}

// ─── Константы ───────────────────────────────────────────────────────────────

// Ценовые диапазоны комиссий: индекс 0..5
const PRICE_BRACKETS = [100, 300, 1500, 5000, 10000]

// Наценки за нелокальность (из документа Ozon)
const SURCHARGE_RATES = [0, 6, 8, 12]

// ─── Вспомогательные функции ─────────────────────────────────────────────────

function getPriceBracketIdx(price: number): number {
  const idx = PRICE_BRACKETS.filter(b => price > b).length
  return Math.min(idx, 5)
}

function getVolumeKey(liters: number, volOrder: string[]): string | null {
  // Диапазоны вида "0-0,200 л", "0,201-0,4 л" и т.д.
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

function getCommission(
  productType: string,
  scheme: 'fbo' | 'fbs',
  price: number,
  db: CommissionsDB
): number | null {
  const key = productType.toLowerCase().trim()
  const entry = db.types[key]
  if (!entry) return null
  const rates = scheme === 'fbo' ? db.fbo[entry[0]] : db.fbs[entry[1]]
  if (!rates) return null
  return rates[getPriceBracketIdx(price)]
}

function getLogistics(
  liters: number,
  db: LogisticsDB
): number | null {
  const key = getVolumeKey(liters, db.vol_order)
  if (!key) return null
  return db.avg[key] ?? db.universal[key] ?? null
}

// ─── Налоговые системы ───────────────────────────────────────────────────────

interface TaxSystem {
  id: string
  label: string
  calc: (revenue: number, costs: number) => number
}

const TAX_SYSTEMS: TaxSystem[] = [
  { id: 'usn6',   label: 'УСН Доходы 6%',              calc: (rev) => rev * 0.06 },
  { id: 'usn15',  label: 'УСН Доходы−Расходы 15%',     calc: (rev, costs) => Math.max(0, (rev - costs)) * 0.15 },
  { id: 'ausn8',  label: 'АУСН Доходы 8%',             calc: (rev) => rev * 0.08 },
  { id: 'ausn20', label: 'АУСН Доходы−Расходы 20%',    calc: (rev, costs) => Math.max(0, (rev - costs)) * 0.20 },
  { id: 'nds5',   label: 'УСН + НДС 5%',               calc: (rev, costs) => rev * 0.06 + rev * 0.05 },
  { id: 'nds7',   label: 'УСН + НДС 7%',               calc: (rev, costs) => rev * 0.06 + rev * 0.07 },
  { id: 'osn',    label: 'ОСН (НДС 22% + прибыль 25%)', calc: (rev, costs) => rev * 0.22 + Math.max(0, rev - costs) * 0.25 },
]

// ─── Основной компонент ───────────────────────────────────────────────────────

interface UnitCalcProps {
  price: number           // цена товара из карточки (₽)
  productType: string     // тип товара из хлебных крошек
}

export function UnitCalc({ price: initialPrice, productType }: UnitCalcProps) {
  // Данные из JSON
  const [commissionsDB, setCommissionsDB] = useState<CommissionsDB | null>(null)
  const [logisticsDB, setLogisticsDB]     = useState<LogisticsDB | null>(null)
  const [cnyRate, setCnyRate]             = useState<number>(13.5) // fallback

  // Пользовательские вводы
  const [price, setPrice]           = useState<number>(initialPrice)
  const [costCny, setCostCny]       = useState<string>('')
  const [volume, setVolume]         = useState<string>('')
  const [scheme, setScheme]         = useState<'fbo' | 'fbs'>('fbo')
  const [taxId, setTaxId]           = useState<string>('usn6')
  const [showSurcharge, setShowSurcharge] = useState<boolean>(false)

  // Загрузка JSON
  useEffect(() => {
    fetch(chrome.runtime.getURL('commissions.json'))
      .then(r => r.json())
      .then(setCommissionsDB)
      .catch(() => {})

    fetch(chrome.runtime.getURL('logistics.json'))
      .then(r => r.json())
      .then(setLogisticsDB)
      .catch(() => {})

    fetch('https://www.cbr-xml-daily.ru/daily_json.js')
      .then(r => r.json())
      .then(d => { if (d?.Valute?.CNY?.Value) setCnyRate(d.Valute.CNY.Value) })
      .catch(() => {})
  }, [])

  // Обновляем цену если карточка изменилась
  useEffect(() => {
    setPrice(initialPrice)
  }, [initialPrice])

  // ─── Расчёты ───────────────────────────────────────────────────────────────

  const liters      = parseFloat(volume.replace(',', '.')) || 0
  const costRub     = parseFloat(costCny.replace(',', '.')) * cnyRate || 0
  const taxSystem   = TAX_SYSTEMS.find(t => t.id === taxId) ?? TAX_SYSTEMS[0]

  const commission  = commissionsDB
    ? (getCommission(productType, scheme, price, commissionsDB) ?? null)
    : null

  const logistics   = logisticsDB && liters > 0
    ? (getLogistics(liters, logisticsDB) ?? null)
    : null

  const commissionRub  = commission != null ? Math.round(price * commission / 100) : null
  const logisticsRub   = logistics
  const acquiring      = Math.round(price * 0.015)
  const deliveryFee    = 25
  const processingFee  = scheme === 'fbs' ? 20 : 0

  const totalExpenses = commissionRub != null && logisticsRub != null
    ? commissionRub + logisticsRub + acquiring + deliveryFee + processingFee + costRub
    : null

  const taxAmount = totalExpenses != null
    ? Math.round(taxSystem.calc(price, costRub))
    : null

  const profit = totalExpenses != null && taxAmount != null
    ? Math.round(price - totalExpenses - taxAmount)
    : null

  const margin = profit != null && price > 0
    ? Math.round(profit / price * 100)
    : null

  const marginColor = margin == null ? '#9BA8B8'
    : margin >= 25 ? '#7AFFA0'
    : margin >= 10 ? '#FFB454'
    : '#FF6B6B'

  // ─── UI ────────────────────────────────────────────────────────────────────

  const inputStyle: React.CSSProperties = {
    background: 'rgba(255,252,244,0.15)',
    border: '1px solid rgba(255,252,244,0.25)',
    borderRadius: 8,
    padding: '6px 10px',
    color: '#3D2B1F',
    fontSize: 13,
    width: '100%',
    outline: 'none',
    fontFamily: 'Outfit, sans-serif',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: '#7A6654',
    marginBottom: 3,
    display: 'block',
    fontFamily: 'Outfit, sans-serif',
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '4px 0',
    borderBottom: '1px solid rgba(61,43,31,0.07)',
    fontSize: 12,
    fontFamily: 'Outfit, sans-serif',
  }

  return (
    <div style={{ padding: '12px 0' }}>

      {/* ── Схема FBO / FBS ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['fbo', 'fbs'] as const).map(s => (
          <button
            key={s}
            onClick={() => setScheme(s)}
            style={{
              flex: 1,
              padding: '6px 0',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'Outfit, sans-serif',
              fontSize: 13,
              fontWeight: 600,
              background: scheme === s ? '#C4873A' : 'rgba(61,43,31,0.08)',
              color: scheme === s ? '#fff' : '#7A6654',
              transition: 'all 0.15s',
            }}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ── Поля ввода ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>

        <div>
          <label style={labelStyle}>Цена товара, ₽</label>
          <input
            style={inputStyle}
            type="number"
            value={price}
            onChange={e => setPrice(parseFloat(e.target.value) || 0)}
          />
        </div>

        <div>
          <label style={labelStyle}>Себестоимость, ¥</label>
          <input
            style={inputStyle}
            type="number"
            placeholder="0"
            value={costCny}
            onChange={e => setCostCny(e.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle}>Объём товара, л</label>
          <input
            style={inputStyle}
            type="number"
            placeholder="0.4"
            value={volume}
            onChange={e => setVolume(e.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle}>Налоговая система</label>
          <select
            style={{ ...inputStyle, cursor: 'pointer' }}
            value={taxId}
            onChange={e => setTaxId(e.target.value)}
          >
            {TAX_SYSTEMS.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Курс юаня ── */}
      <div style={{ fontSize: 11, color: '#9BA8B8', marginBottom: 12, fontFamily: 'Outfit, sans-serif' }}>
        Курс ЦБ: 1 ¥ = {cnyRate.toFixed(2)} ₽
        {costCny && (
          <span style={{ marginLeft: 8, color: '#7A6654' }}>
            → {Math.round(parseFloat(costCny.replace(',','.')) * cnyRate)} ₽
          </span>
        )}
      </div>

      {/* ── Разбивка расходов ── */}
      <div style={{
        background: 'rgba(255,252,244,0.35)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 12,
      }}>
        <div style={{ fontSize: 11, color: '#7A6654', marginBottom: 6, fontWeight: 600, fontFamily: 'Outfit, sans-serif' }}>
          РАСХОДЫ
        </div>

        <div style={rowStyle}>
          <span style={{ color: '#3D2B1F' }}>
            Комиссия Ozon
            {commission != null && (
              <span style={{ color: '#9BA8B8', marginLeft: 4 }}>({commission}%)</span>
            )}
          </span>
          <span style={{ fontWeight: 600, color: '#3D2B1F' }}>
            {commissionRub != null ? `${commissionRub} ₽` : '—'}
          </span>
        </div>

        {/* Логистика + наценка */}
        <div style={rowStyle}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: '#3D2B1F' }}>Логистика</span>
              <span style={{ fontWeight: 600, color: '#3D2B1F' }}>
                {logisticsRub != null ? `${logisticsRub} ₽` : liters > 0 ? '—' : 'введите объём'}
              </span>
            </div>

            {/* Галочка наценки */}
            <div style={{ marginTop: 6 }}>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11, color: '#7A6654', cursor: 'pointer',
                fontFamily: 'Outfit, sans-serif',
              }}>
                <input
                  type="checkbox"
                  checked={showSurcharge}
                  onChange={e => setShowSurcharge(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                Наценка за нелокальность
              </label>

              {/* Раскрывающийся список наценок */}
              {showSurcharge && (
                <div style={{
                  marginTop: 6,
                  background: 'rgba(61,43,31,0.05)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}>
                  {SURCHARGE_RATES.map(rate => (
                    <div key={rate} style={{
                      display: 'flex', justifyContent: 'space-between',
                      fontSize: 11, fontFamily: 'Outfit, sans-serif',
                    }}>
                      <span style={{ color: '#7A6654' }}>Наценка {rate}%</span>
                      <span style={{ color: '#3D2B1F', fontWeight: 600 }}>
                        {Math.round(price * rate / 100)} ₽
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={rowStyle}>
          <span style={{ color: '#3D2B1F' }}>Эквайринг (1.5%)</span>
          <span style={{ fontWeight: 600, color: '#3D2B1F' }}>{acquiring} ₽</span>
        </div>

        <div style={rowStyle}>
          <span style={{ color: '#3D2B1F' }}>Доставка до выдачи</span>
          <span style={{ fontWeight: 600, color: '#3D2B1F' }}>до {deliveryFee} ₽</span>
        </div>

        {scheme === 'fbs' && (
          <div style={rowStyle}>
            <span style={{ color: '#3D2B1F' }}>Обработка отправления</span>
            <span style={{ fontWeight: 600, color: '#3D2B1F' }}>{processingFee} ₽</span>
          </div>
        )}

        {costRub > 0 && (
          <div style={rowStyle}>
            <span style={{ color: '#3D2B1F' }}>Себестоимость</span>
            <span style={{ fontWeight: 600, color: '#3D2B1F' }}>{Math.round(costRub)} ₽</span>
          </div>
        )}

        {taxAmount != null && taxAmount > 0 && (
          <div style={rowStyle}>
            <span style={{ color: '#3D2B1F' }}>{taxSystem.label}</span>
            <span style={{ fontWeight: 600, color: '#3D2B1F' }}>{taxAmount} ₽</span>
          </div>
        )}
      </div>

      {/* ── Итог ── */}
      {commission == null && commissionsDB && (
        <div style={{
          fontSize: 11, color: '#FFB454', marginBottom: 8,
          fontFamily: 'Outfit, sans-serif', padding: '4px 8px',
          background: 'rgba(255,180,84,0.1)', borderRadius: 6,
        }}>
          Тип товара «{productType}» не найден в базе — введите комиссию вручную
        </div>
      )}

      <div style={{
        background: 'rgba(255,252,244,0.5)',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 11, color: '#7A6654', fontFamily: 'Outfit, sans-serif' }}>
            Прибыль с единицы
          </div>
          <div style={{
            fontFamily: 'DM Serif Display, serif',
            fontSize: 22,
            fontWeight: 700,
            color: profit != null ? marginColor : '#9BA8B8',
          }}>
            {profit != null ? `${profit} ₽` : '—'}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: '#7A6654', fontFamily: 'Outfit, sans-serif' }}>
            Маржинальность
          </div>
          <div style={{
            fontFamily: 'DM Serif Display, serif',
            fontSize: 22,
            fontWeight: 700,
            color: marginColor,
          }}>
            {margin != null ? `${margin}%` : '—'}
          </div>
        </div>
      </div>

      {/* Подсказка по марже */}
      {margin != null && (
        <div style={{
          marginTop: 8, fontSize: 11, fontFamily: 'Outfit, sans-serif',
          color: margin >= 25 ? '#7AFFA0' : margin >= 10 ? '#FFB454' : '#FF6B6B',
          textAlign: 'center',
        }}>
          {margin >= 25 ? '✓ Хорошая маржинальность' 
            : margin >= 10 ? '⚠ Низкая маржинальность' 
            : '✗ Экономика не сходится'}
        </div>
      )}
    </div>
  )
}
