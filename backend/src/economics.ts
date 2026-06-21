import fs from 'fs'
import path from 'path'

// ─── Типы данных ────────────────────────────────────────────────────────────

export type Scheme = 'FBO' | 'FBO_Fresh' | 'FBS' | 'RFBS'

interface CommissionsData {
  byCategory: Record<string, Record<string, {
    FBO: number[]
    FBO_Fresh: number[]
    FBS: number[]
    RFBS: number[]
  }>>
  priceThresholds: Record<Scheme, number[]>
}

interface LogisticsData {
  volumeRanges: string[]                                   // в порядке возрастания, как в прайс-листе Ozon
  tariffs: Record<string, Record<string, Record<string, [number, number]>>>  // vol -> from -> to -> [до300, св300]
}

let commissionsCache: CommissionsData | null = null
let logisticsCache: LogisticsData | null = null

function loadCommissions(): CommissionsData {
  if (commissionsCache) return commissionsCache
  const p = path.join(process.cwd(), 'data', 'commissions.json')
  commissionsCache = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return commissionsCache!
}

function loadLogistics(): LogisticsData {
  if (logisticsCache) return logisticsCache
  const p = path.join(process.cwd(), 'data', 'logistics_tariffs.json')
  logisticsCache = JSON.parse(fs.readFileSync(p, 'utf-8'))
  return logisticsCache!
}

// ─── Комиссия по категории/типу товара ────────────────────────────────────

export interface CommissionLookup {
  found: boolean
  category?: string
  itemType?: string
  percentByScheme?: Record<Scheme, number[]>  // доля (0.14 = 14%), массив = ценовые диапазоны
}

/** Точный поиск по паре категория+тип товара (как в карточке Ozon) */
export function findCommission(category: string, itemType: string): CommissionLookup {
  const db = loadCommissions()
  const cat = db.byCategory[category]
  if (!cat) return { found: false }
  const entry = cat[itemType]
  if (!entry) return { found: false }
  return {
    found: true,
    category,
    itemType,
    percentByScheme: {
      FBO: entry.FBO,
      FBO_Fresh: entry.FBO_Fresh,
      FBS: entry.FBS,
      RFBS: entry.RFBS,
    },
  }
}

/** Возвращает % комиссии (0..1) для конкретной схемы и цены */
export function commissionPercentForPrice(
  percentByScheme: Record<Scheme, number[]>,
  scheme: Scheme,
  price: number
): number {
  const thresholds = loadCommissions().priceThresholds[scheme]
  const values = percentByScheme[scheme]
  // thresholds — верхние границы диапазонов кроме последнего ("свыше")
  // FBO/FBO_Fresh/FBS: [100, 300, 1500, 5000, 10000] -> 6 диапазонов
  // RFBS: [1500, 5000, 10000] -> 4 диапазона
  for (let i = 0; i < thresholds.length; i++) {
    if (price <= thresholds[i]) return values[i]
  }
  return values[values.length - 1]  // "свыше" — последний диапазон
}

// ─── Тариф логистики ────────────────────────────────────────────────────────

/** Парсит границы диапазона объёма из строки вида "35,001-40 л" или "0-0,200 л" или "От 800,001 л" */
function parseVolumeRange(label: string): { min: number; max: number } {
  const clean = label.replace(' л', '').replace('От ', '').trim()
  if (clean.includes('-')) {
    const [a, b] = clean.split('-')
    return {
      min: parseFloat(a.replace(',', '.')),
      max: parseFloat(b.replace(',', '.')),
    }
  }
  // "От 800,001 л" — открытый верхний диапазон
  return { min: parseFloat(clean.replace(',', '.')), max: Infinity }
}

/** Находит подходящий диапазон объёма (литры) в списке диапазонов прайс-листа */
export function findVolumeRange(volumeLiters: number): string | null {
  const { volumeRanges } = loadLogistics()
  for (const label of volumeRanges) {
    const { min, max } = parseVolumeRange(label)
    if (volumeLiters >= min && volumeLiters <= max) return label
  }
  return null
}

export interface LogisticsTariffResult {
  found: boolean
  volumeRange?: string
  tariffLe300?: number   // тариф для цены товара ≤300₽
  tariffGt300?: number   // тариф для цены товара >300₽
}

/** Тариф логистики для конкретного объёма и направления кластер→кластер */
export function findLogisticsTariff(
  volumeLiters: number,
  clusterFrom: string,
  clusterTo: string
): LogisticsTariffResult {
  const { tariffs } = loadLogistics()
  const volumeRange = findVolumeRange(volumeLiters)
  if (!volumeRange) return { found: false }
  const fromData = tariffs[volumeRange]?.[clusterFrom]
  if (!fromData) return { found: false }
  const pair = fromData[clusterTo]
  if (!pair) return { found: false }
  return { found: true, volumeRange, tariffLe300: pair[0], tariffGt300: pair[1] }
}

/** Тариф логистики с учётом цены товара (порог 300₽ переключает тариф) */
export function logisticsForPrice(
  volumeLiters: number,
  clusterFrom: string,
  clusterTo: string,
  price: number
): number | null {
  const r = findLogisticsTariff(volumeLiters, clusterFrom, clusterTo)
  if (!r.found) return null
  return price <= 300 ? r.tariffLe300! : r.tariffGt300!
}

// ─── Симулятор цены ─────────────────────────────────────────────────────────

export interface SimulationInput {
  testPrice: number
  cost: number | null
  volumeLiters: number
  clusterFrom: string
  clusterTo: string
  scheme: Scheme            // FBO | FBO_Fresh | FBS | RFBS — продавец может торговать по нескольким схемам одновременно на разных артикулах
  percentByScheme: Record<Scheme, number[]>
  taxRatePercent: number    // ставка налога продавца, % от выручки (берётся из account.taxSystem)
}

export interface SimulationResult {
  testPrice: number
  scheme: Scheme
  commissionPercent: number
  commissionRub: number
  logisticsRub: number | null
  acquiringRub: number
  taxRub: number
  cost: number | null
  netProfit: number | null
  marginPct: number | null
}

const ACQUIRING_RATE = 0.015

export function simulatePrice(input: SimulationInput): SimulationResult {
  const { testPrice, cost, volumeLiters, clusterFrom, clusterTo, scheme, percentByScheme, taxRatePercent } = input

  const commissionPercent = commissionPercentForPrice(percentByScheme, scheme, testPrice)
  const commissionRub = Math.round(testPrice * commissionPercent)

  // RFBS логистику считает сам продавец/другой провайдер — здесь не из тарифной матрицы Ozon FBO/FBS
  const logisticsRub = (scheme === 'FBO' || scheme === 'FBO_Fresh' || scheme === 'FBS')
    ? logisticsForPrice(volumeLiters, clusterFrom, clusterTo, testPrice)
    : null

  const acquiringRub = Math.round(testPrice * ACQUIRING_RATE)
  const taxRub = Math.round(testPrice * (taxRatePercent / 100))

  let netProfit: number | null = null
  let marginPct: number | null = null
  if (cost != null && logisticsRub != null) {
    netProfit = Math.round(testPrice - commissionRub - logisticsRub - acquiringRub - taxRub - cost)
    marginPct = testPrice > 0 ? Math.round((netProfit / testPrice) * 1000) / 10 : 0
  }

  return {
    testPrice,
    scheme,
    commissionPercent: Math.round(commissionPercent * 1000) / 10,  // в %, 1 знак
    commissionRub,
    logisticsRub,
    acquiringRub,
    taxRub,
    cost,
    netProfit,
    marginPct,
  }
}

/** Прогоняет набор тестовых цен через симулятор для сравнения */
export function simulatePriceRange(
  testPrices: number[],
  base: Omit<SimulationInput, 'testPrice'>
): SimulationResult[] {
  return testPrices.map(testPrice => simulatePrice({ ...base, testPrice }))
}

// ─── Детектор переплаты по логистике ───────────────────────────────────────

export interface OverpaymentCheck {
  hasData: boolean
  expectedTariff?: number
  actualAvgLogistics?: number
  diffPercent?: number
  isOverpaying?: boolean
  reason?: 'volume_changed' | 'non_local_delivery' | 'unknown'
}

/**
 * Сравнивает реальную среднюю логистику (из транзакций Ozon) с тарифом,
 * рассчитанным по текущему объёму товара и кластеру отправления.
 * Если расхождение >20% — флаг переплаты.
 */
export function checkLogisticsOverpayment(args: {
  volumeLiters: number
  clusterFrom: string
  clusterTo: string
  price: number
  actualAvgLogistics: number
}): OverpaymentCheck {
  const { volumeLiters, clusterFrom, clusterTo, price, actualAvgLogistics } = args
  const expected = logisticsForPrice(volumeLiters, clusterFrom, clusterTo, price)
  if (expected == null) return { hasData: false }

  const diffPercent = expected > 0 ? Math.round(((actualAvgLogistics - expected) / expected) * 1000) / 10 : 0
  const isOverpaying = Math.abs(diffPercent) > 20

  let reason: OverpaymentCheck['reason'] = 'unknown'
  if (isOverpaying) {
    // Если кластер назначения отличается от кластера отправления — скорее всего, доля нелокальных доставок велика
    reason = clusterFrom !== clusterTo ? 'non_local_delivery' : 'volume_changed'
  }

  return {
    hasData: true,
    expectedTariff: expected,
    actualAvgLogistics: Math.round(actualAvgLogistics * 100) / 100,
    diffPercent,
    isOverpaying,
    reason,
  }
}
