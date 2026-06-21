import { pgTable, text, doublePrecision, bigint, boolean, serial, unique } from 'drizzle-orm/pg-core'

// Себестоимость по offer_id + целевая маржа (для детектора "реклама съела прибыль")
export const costPrices = pgTable('cost_prices', {
  offerId:        text('offer_id').primaryKey(),
  cost:           doublePrecision('cost').notNull(),
  targetMarginPct: doublePrecision('target_margin_pct'),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
})

// Аккаунты Ozon (мультикабинет)
export const accounts = pgTable('accounts', {
  clientId:      text('client_id').primaryKey(),
  apiKey:        text('api_key').notNull(),
  perfApiKey:    text('perf_api_key'),
  name:          text('name').notNull().default(''),
  taxSystem:     text('tax_system').notNull().default('usn6'),
  annualRevenue: doublePrecision('annual_revenue').notNull().default(0),
  isActive:      boolean('is_active').notNull().default(false),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:     bigint('updated_at', { mode: 'number' }).notNull(),
})

// История литража товара
export const volumeHistory = pgTable('volume_history', {
  id:           serial('id').primaryKey(),
  clientId:     text('client_id').notNull(),
  offerId:      text('offer_id').notNull(),
  volumeLiters: doublePrecision('volume_liters').notNull(),
  validFrom:    bigint('valid_from', { mode: 'number' }).notNull(),
  validTo:      bigint('valid_to', { mode: 'number' }),
})

// Снимок цен товара (обновляется каждые 30 минут).
// Хранит три разных цены для корректного расчёта налоговой базы:
// - priceInLk:      цена в личном кабинете продавца (та, что устанавливает продавец)
// - priceCard:      цена по карте Ozon (со скидкой банка/coinvestment)
// - priceBuyer:     реальная цена покупателя в акциях/промо (может быть ниже карты)
// - coinvestRub:    рублей соинвестирования от Ozon (доплачивает Ozon из своего)
//
// Для расчёта НДС и налога на прибыль при ОСНО важна именно priceBuyer —
// именно с неё считается налоговая база, а не с priceInLk.
// coinvestRub — это не выручка продавца, Ozon компенсирует разницу.
export const priceSnapshot = pgTable('price_snapshot', {
  id:           serial('id').primaryKey(),
  clientId:     text('client_id').notNull(),
  offerId:      text('offer_id').notNull(),
  priceInLk:    doublePrecision('price_in_lk').notNull(),
  priceCard:    doublePrecision('price_card'),
  priceBuyer:   doublePrecision('price_buyer'),
  coinvestRub:  doublePrecision('coinvest_rub'),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({ uniq: unique().on(t.clientId, t.offerId) }))
