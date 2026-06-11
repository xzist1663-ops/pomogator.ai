const CLIENT_ID = '4002592';
const API_KEY = '5104c0b7-4e7c-4fce-83e4-798d9bb82d4d';

// Сначала получим список товаров аккаунта
const productsResp = await fetch('https://api-seller.ozon.ru/v2/product/list', {
  method: 'POST',
  headers: {
    'Client-Id': CLIENT_ID,
    'Api-Key': API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    filter: {},
    last_id: '',
    limit: 5
  }),
});

const productsData = await productsResp.json();
console.log('Products:', JSON.stringify(productsData, null, 2));