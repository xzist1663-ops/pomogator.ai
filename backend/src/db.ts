import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, and, isNull, desc } from 'drizzle-orm'
import pg from 'pg'
import { config } from './config.js'
import { costPrices, accounts, volumeHistory, priceSnapshot } from './schema.js'
import { encryptOrNull, decryptOrNull, encrypt, decrypt } from './crypto.js'

const pool = new pg.Pool({ connectionString: config.databaseUrl })
export const db = drizzle(pool)

// ── Себестоимости + целевая маржа ───────────────────────────────────────────

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

// Целевая маржа, заданная пользователем — используется только в детекторе
// "реклама съела прибыль" (категория Economics №5). Если не задана для
// конкретного offer_id, эта категория для него просто не считается — чтобы не
// ложно помечать как "потерю" продавцов, сознательно работающих на низкой марже.
export async function getAllTargetMargins(): Promise<Record<string, number>> {
  const rows = await db.select().from(costPrices)
  const map: Record<string, number> = {}
  for (const r of rows) if (r.targetMarginPct != null) map[r.offerId] = r.targetMarginPct
  return map
}

export async function setCost(offerId: string, cost: number | null, targetMarginPct?: number | null): Promise<void> {
  const now = Date.now()
  if (targetMarginPct === undefined) {
    // Обновляем только cost, не трогаем targetMarginPct
    if (cost !== null) {
      await db
        .insert(costPrices)
        .values({ offerId, cost, updatedAt: now })
        .onConflictDoUpdate({ target: costPrices.offerId, set: { cost, updatedAt: now } })
    }
  } else {
    // Обновляем оба поля (cost может быть null — значит только маржа)
    if (cost !== null) {
      await db
        .insert(costPrices)
        .values({ offerId, cost, targetMarginPct, updatedAt: now })
        .onConflictDoUpdate({ target: costPrices.offerId, set: { cost, targetMarginPct, updatedAt: now } })
    } else {
      // cost не задан — обновляем только targetMarginPct через raw update
      await db
        .insert(costPrices)
        .values({ offerId, cost: 0, targetMarginPct, updatedAt: now })
        .onConflictDoUpdate({ target: costPrices.offerId, set: { targetMarginPct, updatedAt: now } })
    }
  }
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

// Чтение конкретного аккаунта по clientId — БЕЗ побочных эффектов (не трогает
// is_active). Это основной способ получения creds для многопользовательской
// модели: каждый запрос явно называет, чьи ключи ему нужны, вместо того чтобы
// читать общее "активное" состояние, которое могло переключиться параллельным
// запросом другого пользователя между чтением и использованием creds.
export async function getAccountByClientId(clientId: string): Promise<Account | null> {
  const rows = await db.select().from(accounts).where(eq(accounts.clientId, clientId))
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

// ── Снимок цен (обновляется каждые 30 минут) ────────────────────────────────

export interface PriceSnapshotRecord {
  offerId: string
  priceInLk: number
  priceCard: number | null
  priceBuyer: number | null
  coinvestRub: number | null
  updatedAt: number
}

// Все актуальные цены для аккаунта одним запросом
export async function getAllPriceSnapshots(clientId: string): Promise<Record<string, PriceSnapshotRecord>> {
  const rows = await db.select().from(priceSnapshot).where(eq(priceSnapshot.clientId, clientId))
  const map: Record<string, PriceSnapshotRecord> = {}
  for (const r of rows) map[r.offerId] = {
    offerId: r.offerId, priceInLk: r.priceInLk,
    priceCard: r.priceCard, priceBuyer: r.priceBuyer,
    coinvestRub: r.coinvestRub, updatedAt: Number(r.updatedAt),
  }
  return map
}

// Upsert снимка цен для одного товара
export async function upsertPriceSnapshot(clientId: string, offerId: string, data: {
  priceInLk: number; priceCard?: number | null; priceBuyer?: number | null; coinvestRub?: number | null
}): Promise<void> {
  const now = Date.now()
  await db.insert(priceSnapshot)
    .values({ clientId, offerId, priceInLk: data.priceInLk, priceCard: data.priceCard ?? null, priceBuyer: data.priceBuyer ?? null, coinvestRub: data.coinvestRub ?? null, updatedAt: now })
    .onConflictDoUpdate({
      target: [priceSnapshot.clientId, priceSnapshot.offerId],
      set: { priceInLk: data.priceInLk, priceCard: data.priceCard ?? null, priceBuyer: data.priceBuyer ?? null, coinvestRub: data.coinvestRub ?? null, updatedAt: now },
    })
}

// ── История литража товаров ─────────────────────────────────────────────────

export interface VolumeRecord { volumeLiters: number; validFrom: number; validTo: number | null }

// Все актуальные (validTo = null) записи литража аккаунта — для построения
// карты offer_id → текущий литраж одним запросом, без обращения к БД на
// каждый товар по отдельности.
export async function getCurrentVolumes(clientId: string): Promise<Record<string, number>> {
  const rows = await db.select().from(volumeHistory)
    .where(and(eq(volumeHistory.clientId, clientId), isNull(volumeHistory.validTo)))
  const map: Record<string, number> = {}
  for (const r of rows) map[r.offerId] = r.volumeLiters
  return map
}

// Вся история литража аккаунта (включая закрытые записи) — для расчёта
// "какой литраж действовал на дату конкретной транзакции". Загружается одним
// запросом и используется как таблица в памяти на время обработки запроса
// (число записей на одного продавца мало — по одной-две на товар обычно).
export async function getAllVolumeHistory(clientId: string): Promise<Record<string, VolumeRecord[]>> {
  const rows = await db.select().from(volumeHistory)
    .where(eq(volumeHistory.clientId, clientId))
    .orderBy(desc(volumeHistory.validFrom))
  const map: Record<string, VolumeRecord[]> = {}
  for (const r of rows) {
    if (!map[r.offerId]) map[r.offerId] = []
    map[r.offerId].push({ volumeLiters: r.volumeLiters, validFrom: r.validFrom, validTo: r.validTo })
  }
  return map
}

// Записывает текущий литраж товара. Если значение совпадает с уже
// действующим — ничего не делает (это не "изменение", просто повторная
// синхронизация). Если отличается — закрывает старую запись и открывает новую.
// Если записи по этому offer_id ещё не было вообще — создаёт первую (это
// случай первого подключения аккаунта).
export async function syncVolume(clientId: string, offerId: string, volumeLiters: number): Promise<void> {
  const now = Date.now()
  const current = await db.select().from(volumeHistory)
    .where(and(eq(volumeHistory.clientId, clientId), eq(volumeHistory.offerId, offerId), isNull(volumeHistory.validTo)))
  if (current.length > 0) {
    // Округляем до 2 знаков перед сравнением — volume_weight от Ozon может
    // дрожать в последнем знаке между синхронизациями без реального изменения
    // габаритов, и мы не хотим плодить записи на этот шум.
    const existingRounded = Math.round(current[0].volumeLiters * 100) / 100
    const newRounded = Math.round(volumeLiters * 100) / 100
    if (existingRounded === newRounded) return
    await db.update(volumeHistory).set({ validTo: now }).where(eq(volumeHistory.id, current[0].id))
  }
  await db.insert(volumeHistory).values({ clientId, offerId, volumeLiters, validFrom: now, validTo: null })
}
