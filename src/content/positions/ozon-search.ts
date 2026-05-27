export interface PositionResult {
  keyword: string
  position: number | null
  provider: 'ozon-search' | 'mpstats' | 'seller-api'
}

export async function getPositionOzonSearch(
  keyword: string,
  articleId: string
): Promise<PositionResult> {
  try {
    const url = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2` +
      `?url=${encodeURIComponent(`/search/?text=${keyword}&from_global=true`)}`

    const resp = await fetch(url, {
      credentials: 'include',
      headers: {
        'accept': 'application/json',
        'accept-language': 'ru-RU,ru;q=0.9',
      }
    })

    if (!resp.ok) return { keyword, position: null, provider: 'ozon-search' }

    const data = await resp.json()
    const widgetStates = data.widgetStates ?? {}
    const tileKey = Object.keys(widgetStates).find(k => k.startsWith('tileGridDesktop'))
    if (!tileKey) return { keyword, position: null, provider: 'ozon-search' }

    const items: any[] = JSON.parse(widgetStates[tileKey]).items ?? []
    const index = items.findIndex(item => String(item.sku) === String(articleId))
    return { keyword, position: index >= 0 ? index + 1 : null, provider: 'ozon-search' }
  } catch {
    return { keyword, position: null, provider: 'ozon-search' }
  }
}

export async function getPositionMPStats(
  keyword: string,
  _articleId: string
): Promise<PositionResult> {
  // TODO: POST https://mpstats.io/api/oz/get/item/by/keyword
  return { keyword, position: null, provider: 'mpstats' }
}

export async function getPosition(
  keyword: string,
  articleId: string,
  hasMPStats = false
): Promise<PositionResult> {
  if (hasMPStats) {
    return getPositionMPStats(keyword, articleId)
  }
  return getPositionOzonSearch(keyword, articleId)
}