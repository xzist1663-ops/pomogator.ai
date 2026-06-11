import {readFileSync} from 'fs'  
const db = JSON.parse(readFileSync('attrs_db.json', 'utf8'))  
const val = db['кулеры для воды']  
console.log('attrs:', val.attrs?.length)  
const wg = val.attrs?.filter(a= 
console.log('withGroup:', wg?.length)  
