const {readFileSync} = require('fs')
const db = JSON.parse(readFileSync('attrs_db.json', 'utf8'))
const val = db['кулеры для воды']
console.log('attrs length:', val.attrs?.length)
const withGroup = val.attrs?.filter(a => a.group)
console.log('withGroup:', withGroup?.length)