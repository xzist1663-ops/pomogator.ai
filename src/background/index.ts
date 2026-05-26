 chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SEARCH_SERP') {
    searchSerp(message.keyword, message.articleId).then(sendResponse)
    return true
  }
})

async function searchSerp(keyword: string, articleId: string) {
  const url = `https://www.ozon.ru/search/?text=${encodeURIComponent(keyword)}`
  
  const tab = await chrome.tabs.create({ url, active: false })
  
  await new Promise(resolve => setTimeout(resolve, 3000))
  
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: (articleId: string) => {
      const items = document.querySelectorAll('[data-index]')
      let position = -1
      items.forEach((item, index) => {
        if (item.innerHTML.includes(articleId)) {
          position = index + 1
        }
      })
      return position
    },
    args: [articleId],
  })
  
  await chrome.tabs.remove(tab.id!)
  
  return { position: results[0]?.result ?? -1, keyword }
}
