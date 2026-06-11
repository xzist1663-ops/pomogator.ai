import 'dotenv/config'

// Проверяем обязательные переменные при старте
const REQUIRED_ENV = ['DB_ENCRYPTION_KEY', 'DATABASE_URL'] as const

export function validateEnv() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k])
  if (missing.length > 0) {
    throw new Error(
      `[config] Отсутствуют обязательные переменные окружения: ${missing.join(', ')}\n` +
      `Скопируй backend/.env.example в backend/.env и заполни значения.`
    )
  }
  if (process.env.DB_ENCRYPTION_KEY && process.env.DB_ENCRYPTION_KEY.length !== 64) {
    throw new Error('[config] DB_ENCRYPTION_KEY должен быть 64 hex-символа (32 байта)')
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  databaseUrl: process.env.DATABASE_URL ?? '',

  ozon: {
    baseUrl: process.env.OZON_API_BASE ?? 'https://api-seller.ozon.ru',
    clientId: process.env.OZON_CLIENT_ID ?? '',
    apiKey:   process.env.OZON_API_KEY ?? '',
  },

  margin: {
    green:  Number(process.env.MARGIN_GREEN  ?? 20),
    yellow: Number(process.env.MARGIN_YELLOW ?? 10),
  },
}

export function assertOzonKeys() {
  if (!config.ozon.clientId && !config.ozon.apiKey) {
    console.log('[config] OZON_CLIENT_ID/OZON_API_KEY не заданы — используются ключи из БД')
  }
}
