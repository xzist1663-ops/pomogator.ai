chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SEARCH_SERP') {
    searchSerp(message.keyword, message.articleId)
      .then(sendResponse)
      .catch(() => sendResponse({ position: -1, keyword: message.keyword }))
    return true
  }
})

async function searchSerp(keyword: string, articleId: string) {
  const url = `https://www.ozon.ru/search/?text=${encodeURIComponent(keyword)}&from_global=true`

  const tab = await chrome.tabs.create({ url, active: false })
  if (!tab.id) return { position: -1, keyword }

  // Ждём загрузки страницы
  await new Promise<void>(resolve => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    })
  })

  // Дополнительная пауза для рендера React
  await new Promise(resolve => setTimeout(resolve, 2000))

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (articleId: string) => {
      const links = document.querySelectorAll('.tile-root a[href*="/product/"]')
      let position = -1
      links.forEach((link, index) => {
        const href = (link as HTMLAnchorElement).href
        const match = href.match(/\d{9,10}/)
        if (match && match[0] === articleId) {
          position = index + 1
        }
      })
      return position
    },
    args: [articleId],
  })

  await chrome.tabs.remove(tab.id)

  return {
    position: results[0]?.result ?? -1,
    keyword,
    total: 24
  }
}