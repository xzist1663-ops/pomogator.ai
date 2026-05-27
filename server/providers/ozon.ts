export async function getPositionFromOzon(
  keyword: string,
  articleId: string,
  cookies?: string
): Promise<number | null> {
  const url = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2` +
    `?url=${encodeURIComponent(`/search/?text=${keyword}&from_global=true`)}`

  const headers: Record<string, string> = {
    'accept': 'application/json',
    'accept-language': 'ru-RU,ru;q=0.9',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-o3-app-name': 'ozonweb',
    'x-o3-app-version': '6.0',
  }

  if (cookies) headers['cookie'] = cookies

  const resp = await fetch(url, { redirect: 'follow', headers })

  console.log('status:', resp.status, 'url:', resp.url)

  if (!resp.ok) return null

  const data = await resp.json()
  const widgetStates = data.widgetStates ?? {}
  const tileKey = Object.keys(widgetStates).find(k => k.startsWith('tileGridDesktop'))
  console.log('tileKey:', tileKey)
  if (!tileKey) return null

  const items: any[] = JSON.parse(widgetStates[tileKey]).items ?? []
  console.log('items count:', items.length)
  const index = items.findIndex(item => String(item.sku) === String(articleId))
  return index >= 0 ? index + 1 : null
}