 const clientIdInput = document.getElementById('clientId') as HTMLInputElement
const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement
const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement
const status = document.getElementById('status') as HTMLDivElement
const connectedState = document.getElementById('connected-state') as HTMLDivElement
const registerBtn = document.getElementById('registerBtn') as HTMLButtonElement

// Загружаем сохранённые данные
chrome.storage.local.get(['clientId', 'apiKey'], (result) => {
  if (result.clientId) {
    clientIdInput.value = result.clientId as string
    connectedState.style.display = 'block'
  }
  if (result.apiKey) {
    apiKeyInput.value = result.apiKey as string
  }
})

// Сохраняем
saveBtn.addEventListener('click', () => {
  const clientId = clientIdInput.value.trim()
  const apiKey = apiKeyInput.value.trim()

  if (!clientId || !apiKey) {
    status.textContent = 'Заполните оба поля'
    status.className = 'status error'
    return
  }

  chrome.storage.local.set({ clientId, apiKey }, () => {
    status.textContent = '✓ Сохранено'
    status.className = 'status'
    connectedState.style.display = 'block'
    setTimeout(() => { status.textContent = '' }, 2000)
  })
})

// Кнопка регистрации
registerBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://pomogator.ai' })
})
