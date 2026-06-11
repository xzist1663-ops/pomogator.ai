import { pgTable, text, doublePrecision, bigint, boolean } from 'drizzle-orm/pg-core'

// Себестоимость по offer_id
export const costPrices = pgTable('cost_prices', {
  offerId:   text('offer_id').primaryKey(),
  cost:      doublePrecision('cost').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

// Аккаунты Ozon (мультикабинет)
// taxSystem: 'usn6' | 'usn6_nds5' | 'usn6_nds7' | 'osno_nds22'
// annualRevenue: млн ₽/год — для определения нужного налогового режима
export const accounts = pgTable('accounts', {
  clientId:      text('client_id').primaryKey(),
  apiKey:        text('api_key').notNull(),
  perfApiKey:    text('perf_api_key'),            // Performance API (реклама)
  name:          text('name').notNull().default(''),
  taxSystem:     text('tax_system').notNull().default('usn6'),
  annualRevenue: doublePrecision('annual_revenue').notNull().default(0),
  isActive:      boolean('is_active').notNull().default(false),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:     bigint('updated_at', { mode: 'number' }).notNull(),
})
