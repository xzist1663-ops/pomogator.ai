export interface PositionResult {
  keyword: string
  position: number | null
  provider: 'ozon-search' | 'mpstats' | 'seller-api'
}

export async function getPositionOzonSearch(
  keyword: string,
  _articleId: string
): Promise<PositionResult> {
  // Позиции недоступны без бэкенда с российским IP
  return { keyword, position: null, provider: 'ozon-search' }
}

export async function getPositionMPStats(
  keyword: string,
  _articleId: string
): Promise<PositionResult> {
  // TODO: реализовать через MPStats API когда пользователь введёт токен
  return { keyword, position: null, provider: 'mpstats' }
}

export async function getPosition(
  keyword: string,
  articleId: string,
  hasMPStats = false
): Promise<PositionResult> {
  if (hasMPStats) return getPositionMPStats(keyword, articleId)
  return getPositionOzonSearch(keyword, articleId)
}