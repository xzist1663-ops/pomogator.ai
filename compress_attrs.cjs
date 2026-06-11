const { readFileSync, writeFileSync } = require('fs')

const db = JSON.parse(readFileSync('attrs_db.json', 'utf8'))

const compressed = {}
for (const [key, val] of Object.entries(db)) {
  const withGroup = val.attrs.filter(a => a.group)

  compressed[key] = {
    id: val.cat_id,
    types: val.types.map(t => [t.id, t.name]),
    total: val.total,
    totalChars: withGroup.length,
    req: val.required,
    reqAttrs: val.attrs.filter(a => a.required).map(a => a.name),
    groups: [...new Set(withGroup.map(a => a.group).filter(Boolean))].slice(0, 10),
  }
}

const out = JSON.stringify(compressed, null, 0)
writeFileSync('attrs_db_compressed.json', out)
console.log(`Готово: ${(out.length / 1024).toFixed(0)} KB`)