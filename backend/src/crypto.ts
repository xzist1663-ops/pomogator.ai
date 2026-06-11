/**
 * crypto.ts — шифрование API-ключей перед записью в БД
 * Алгоритм: AES-256-GCM (аутентифицированное шифрование)
 * Ключ шифрования: DB_ENCRYPTION_KEY в .env (64 hex-символа = 32 байта)
 *
 * Генерация ключа (выполнить один раз):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LEN    = 12  // 96 бит — рекомендовано для GCM
const TAG_LEN   = 16  // 128 бит auth tag

function getKey(): Buffer {
  const hex = process.env.DB_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) {
    throw new Error(
      'DB_ENCRYPTION_KEY не задан в .env или неверная длина. ' +
      'Сгенерируй: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Шифрует строку. Возвращает base64: iv(12) + tag(16) + ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv  = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Формат: iv || tag || ciphertext — всё в одной base64-строке
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/**
 * Расшифровывает строку, зашифрованную через encrypt()
 */
export function decrypt(ciphertext: string): string {
  const key  = getKey()
  const data = Buffer.from(ciphertext, 'base64')
  const iv   = data.subarray(0, IV_LEN)
  const tag  = data.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const enc  = data.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc).toString('utf8') + decipher.final('utf8')
}

/**
 * Безопасно шифрует строку или null
 */
export function encryptOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  return encrypt(value)
}

/**
 * Безопасно расшифровывает строку или null
 */
export function decryptOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return decrypt(value)
  } catch {
    // Если расшифровка не удалась — значит значение ещё не зашифровано (миграция)
    // Возвращаем как есть, но логируем
    console.warn('[crypto] decrypt failed — возможно plaintext из старой БД')
    return value
  }
}
