import { getPositionFromOzon } from './providers/ozon'

const PORT = 3001

const cache = new Map<string, { position: number | null, ts: number }>()
const CACHE_TTL = 60 * 60 * 1000

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers })
  }

  if (url.pathname === '/position') {
    const keyword = url.searchParams.get('keyword') ?? ''
    const articleId = url.searchParams.get('articleId') ?? ''

    if (!keyword || !articleId) {
      return new Response(
        JSON.stringify({ error: 'keyword and articleId required' }),
        { status: 400, headers }
      )
    }

    const cacheKey = `${keyword}:${articleId}`
    const cached = cache.get(cacheKey)

    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return new Response(
        JSON.stringify({ position: cached.position, keyword, cached: true }),
        { headers }
      )
    }

    const cookies = url.searchParams.get('cookies') ?? undefined
    const position = await getPositionFromOzon(keyword, articleId, cookies)

    return new Response(
      JSON.stringify({ position, keyword, cached: false }),
      { headers }
    )
  }

  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ ok: true }), { headers })
  }

  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers })
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  fetch: handleRequest,
})

console.log(`[Pomogator API] запущен на http://localhost:${PORT}`)