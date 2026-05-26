 const STOP_WORDS = new Set([
  'и', 'в', 'на', 'с', 'для', 'по', 'из', 'от', 'до', 'к', 'у', 'о',
  'не', 'а', 'но', 'или', 'что', 'как', 'это', 'все', 'так', 'же',
])

export function extractKeywords(title: string, limit = 3): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))

  // Фразы из 2 слов имеют приоритет — берём первые слова названия
  const phrases: string[] = []
  if (words.length >= 2) {
    phrases.push(`${words[0]} ${words[1]}`)
  }
  phrases.push(...words.slice(0, limit))

  return [...new Set(phrases)].slice(0, limit)
}
