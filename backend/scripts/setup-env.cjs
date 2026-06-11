const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ENV_PATH = path.join(__dirname, '..', '.env')
const forceRegen = process.argv.includes('--regen')

function generateKey() {
  return crypto.randomBytes(32).toString('hex')
}

let existing = {}
if (fs.existsSync(ENV_PATH)) {
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n')
  for (const line of lines) {
    if (line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key) existing[key] = val
  }
  console.log('Найден существующий .env')
} else {
  console.log('.env не найден — создаём новый')
}

let changed = false

if (!existing['DB_ENCRYPTION_KEY'] || existing['DB_ENCRYPTION_KEY'] === 'ЗАМЕНИ_НА_64_HEX_СИМВОЛОВ' || forceRegen) {
  const oldKey = existing['DB_ENCRYPTION_KEY']
  existing['DB_ENCRYPTION_KEY'] = generateKey()
  if (forceRegen && oldKey) {
    console.log('DB_ENCRYPTION_KEY перегенерирован (--regen)')
    console.log('СТАРЫЙ ключ (для расшифровки старых данных):', oldKey)
  } else {
    console.log('Сгенерирован новый DB_ENCRYPTION_KEY')
  }
  changed = true
} else {
  console.log('DB_ENCRYPTION_KEY уже задан — пропускаем (используй --regen для перегенерации)')
}

const defaults = {
  PORT: '3000',
  DATABASE_URL: 'postgres://pomogator:pomogator@localhost:5432/pomogator',
  OZON_API_BASE: 'https://api-seller.ozon.ru',
  OZON_CLIENT_ID: '',
  OZON_API_KEY: '',
  MARGIN_GREEN: '20',
  MARGIN_YELLOW: '10',
}
for (const [key, val] of Object.entries(defaults)) {
  if (existing[key] === undefined) existing[key] = val
}

// Убираем ACCESS_TOKEN если он вдруг остался
delete existing['ACCESS_TOKEN']

const content = [
  '# Сгенерировано setup-env.cjs — не коммить этот файл!',
  '',
  '# Сервер',
  `PORT=${existing['PORT']}`,
  '',
  '# Ключ шифрования API-ключей в БД (AES-256-GCM)',
  '# ВАЖНО: сохрани копию в менеджере паролей',
  `DB_ENCRYPTION_KEY=${existing['DB_ENCRYPTION_KEY']}`,
  '',
  '# PostgreSQL',
  `DATABASE_URL=${existing['DATABASE_URL']}`,
  '',
  '# Ozon API (ключи вводятся через UI и хранятся в БД)',
  `OZON_API_BASE=${existing['OZON_API_BASE']}`,
  `OZON_CLIENT_ID=${existing['OZON_CLIENT_ID']}`,
  `OZON_API_KEY=${existing['OZON_API_KEY']}`,
  '',
  '# Пороги светофора маржи',
  `MARGIN_GREEN=${existing['MARGIN_GREEN']}`,
  `MARGIN_YELLOW=${existing['MARGIN_YELLOW']}`,
].join('\n') + '\n'

fs.writeFileSync(ENV_PATH, content, 'utf8')

if (changed) {
  console.log('\n✅ backend/.env обновлён')
  console.log('\n⚠️  СОХРАНИ этот ключ в менеджере паролей:')
  console.log('DB_ENCRYPTION_KEY=' + existing['DB_ENCRYPTION_KEY'])
} else {
  console.log('✅ .env актуален')
}

console.log('\nДальше запусти:')
console.log('  npx drizzle-kit push')
console.log('  npm run dev')
