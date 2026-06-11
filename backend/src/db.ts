import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { config } from './config.js'
import { costPrices, accounts } from './schema.js'
import { encryptOrNull, decryptOrNull, encrypt, decrypt } from './crypto.js'

const pool = new pg.Pool({ connectionString: config.databaseUrl })
export const db = drizzle(pool)

// ── Себестоимости ─────────────────────────────────────────────────────────────

export async function getCost(offerId: string): Promise<number | null> {
  const rows = await db.select().from(costPrices).where(eq(costPrices.offerId, offerId))
  return rows.length ? rows[0].cost : null
}

export async function getAllCosts(): Promise<Record<string, number>> {
  const rows = await db.select().from(costPrices)
  const map: Record<string, number> = {}
  for (const r of rows) map[r.offerId] = r.cost
  return map
}

export async function setCost(offerId: string, cost: number): Promise<void> {
  await db
    .insert(costPrices)
    .values({ offerId, cost, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: costPrices.offerId,
      set: { cost, updatedAt: Date.now() },
    })
}

// ── Аккаунты (мультикабинет) ──────────────────────────────────────────────────

export interface Account {
  clientId:      string
  apiKey:        string   // в памяти всегда plaintext
  perfApiKey:    string | null
  name:          string
  taxSystem:     string
  annualRevenue: number
  isActive:      boolean
  createdAt:     number
  updatedAt:     number
}

/** Расшифровывает строку из БД в объект Account с plaintext-ключами */
function decryptAccount(row: typeof accounts.$inferSelect): Account {
  return {
    ...row,
    apiKey:     decrypt(row.apiKey),
    perfApiKey: decryptOrNull(row.perfApiKey),
  }
}

export async function getAllAccounts(): Promise<Account[]> {
  const rows = await db.select().from(accounts)
  return rows.map(decryptAccount)
}

export async function getActiveAccount(): Promise<Account | null> {
  const rows = await db.select().from(accounts).where(eq(accounts.isActive, true))
  return rows.length ? decryptAccount(rows[0]) : null
}

export async function upsertAccount(acc: Omit<Account, 'createdAt' | 'updatedAt'>): Promise<void> {
  const now = Date.now()
  // Шифруем перед записью в БД
  const encApiKey     = encrypt(acc.apiKey)
  const encPerfApiKey = encryptOrNull(acc.perfApiKey)

  await db
    .insert(accounts)
    .values({ ...acc, apiKey: encApiKey, perfApiKey: encPerfApiKey, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: accounts.clientId,
      set: {
        apiKey:        encApiKey,
        perfApiKey:    encPerfApiKey,
        name:          acc.name,
        taxSystem:     acc.taxSystem,
        annualRevenue: acc.annualRevenue,
        isActive:      acc.isActive,
        updatedAt:     now,
      },
    })
}

export async function setActiveAccount(clientId: string): Promise<void> {
  await db.update(accounts).set({ isActive: false, updatedAt: Date.now() })
  await db.update(accounts)
    .set({ isActive: true, updatedAt: Date.now() })
    .where(eq(accounts.clientId, clientId))
}

export async function deleteAccount(clientId: string): Promise<void> {
  await db.delete(accounts).where(eq(accounts.clientId, clientId))
}
