 import { useState, useEffect } from 'react'

export interface SerpResult {
  keyword: string
  position: number
  loading: boolean
}

export function useSerpSearch(
  keywords: string[],
  articleId: string
): SerpResult[] {
  const [results, setResults] = useState<SerpResult[]>(
    keywords.map(k => ({ keyword: k, position: -1, loading: true }))
  )

  useEffect(() => {
    if (!keywords.length || !articleId) return

    keywords.forEach((keyword, index) => {
      // Задержка между запросами чтобы не спамить
      setTimeout(() => {
        chrome.runtime.sendMessage(
          { type: 'SEARCH_SERP', keyword, articleId },
          (response) => {
            setResults(prev => prev.map((r, i) =>
              i === index
                ? { keyword, position: response?.position ?? -1, loading: false }
                : r
            ))
          }
        )
      }, index * 4000) // 4 сек между запросами
    })
  }, [keywords.join(','), articleId])

  return results
}
