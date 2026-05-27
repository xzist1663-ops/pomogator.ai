chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TEST_API') {
    testApi(sendResponse)
    return true
  }
  if (message.type === 'GET_POSITION') {
    getPositionBackground(message.keyword, message.articleId, sendResponse)
    return true
  }
})

async function getPositionBackground(keyword: string, articleId: string, sendResponse: (r: unknown) => void) {
  try {
    const url = `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2` +
      `?url=${encodeURIComponent(`/search/?text=${keyword}&from_global=true`)}`

    const resp = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'accept-language': 'ru-RU,ru;q=0.9',
      }
    })

    if (!resp.ok) {
      sendResponse({ position: null, status: resp.status })
      return
    }

    const data = await resp.json()
    const widgetStates = data.widgetStates ?? {}
    const tileKey = Object.keys(widgetStates).find(k => k.startsWith('tileGridDesktop'))

    if (!tileKey) {
      sendResponse({ position: null, error: 'no tileGrid' })
      return
    }

    const items: any[] = JSON.parse(widgetStates[tileKey]).items ?? []
    const index = items.findIndex(item => String(item.sku) === String(articleId))
    sendResponse({ position: index >= 0 ? index + 1 : null })
  } catch (e) {
    sendResponse({ position: null, error: String(e) })
  }
}

async function testApi(sendResponse: (r: unknown) => void) {
  try {
    const creds = await chrome.storage.local.get(['clientId', 'apiKey'])
    if (!creds.clientId || !creds.apiKey) {
      sendResponse({ error: 'Нет ключей' })
      return
    }
    const response = await fetch('https://api-seller.ozon.ru/v1/analytics/product-queries', {
      method: 'POST',
      headers: {
        'Client-Id': creds.clientId as string,
        'Api-Key': creds.apiKey as string,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date_from: '2026-04-01T00:00:00.000Z',
        date_to: '2026-04-30T23:59:59.000Z',
        page: 1,
        page_size: 10,
      })
    })
    const data = await response.json()
    sendResponse({ ok: response.ok, status: response.status, data })
  } catch (e) {
    sendResponse({ error: String(e) })
  }
}