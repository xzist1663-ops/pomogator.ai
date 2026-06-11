import { writeFileSync } from 'fs'

const CLIENT_ID = '4002592'
const API_KEY = '37409c6a-f6e6-4edc-91a7-6a968d088bb8'
const DELAY_MS = 200

async function ozonPost(endpoint, body) {
  const resp = await fetch(`https://api-seller.ozon.ru${endpoint}`, {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`${resp.status}`)
  return resp.json()
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Собираем ВСЕ узлы у которых есть type_id
function collectAllNodes(nodes, result = []) {
  for (const node of nodes) {
    const types = node.children?.filter(c => c.type_id && !c.disabled) ?? []
    const subcats = node.children?.filter(c => c.category_name) ?? []

    if (types.length > 0 && node.description_category_id) {
      result.push({
        id: node.description_category_id,
        name: node.category_name,
        types: types.map(t => ({ id: t.type_id, name: t.type_name }))
      })
    }

    // Рекурсивно обходим подкатегории
    if (subcats.length > 0) collectAllNodes(subcats, result)
  }
  return result
}

async function main() {
  console.log('Загружаем дерево...')
  const tree = await ozonPost('/v1/description-category/tree', { language: 'DEFAULT' })
  const nodes = collectAllNodes(tree.result)
  console.log(`Узлов с типами: ${nodes.length}`)

  const db = {}
  let done = 0

  for (const cat of nodes) {
    const mainType = cat.types[0]
    if (!mainType) continue
    try {
      await sleep(DELAY_MS)
      const data = await ozonPost('/v1/description-category/attribute', {
        description_category_id: cat.id,
        type_id: mainType.id,
        language: 'DEFAULT'
      })
      if (!data.result?.length) continue

      const withGroup = data.result.filter(a => a.group_name && a.group_name !== '')
      db[cat.name.toLowerCase()] = {
        cat_id: cat.id,
        types: cat.types.map(t => [t.id, t.name]),
        total: data.result.length,
        totalChars: withGroup.length,
        req: data.result.filter(a => a.is_required).length,
        reqAttrs: data.result.filter(a => a.is_required).map(a => a.name),
        groups: [...new Set(withGroup.map(a => a.group_name).filter(Boolean))].slice(0, 10),
      }
      done++
      if (done % 20 === 0) console.log(`  ${done}/${nodes.length}`)
    } catch(e) {
      console.warn(`Ошибка "${cat.name}": ${e.message}`)
    }
  }

  writeFileSync('attrs_db.json', JSON.stringify(db, null, 0))
  console.log(`Готово! Категорий: ${done}`)
}

main().catch(console.error)