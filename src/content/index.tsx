 import React from 'react'
import ReactDOM from 'react-dom/client'

function App() {
  return (
    <div style={{
      position: 'fixed',
      top: '20px',
      right: '20px',
      zIndex: 999999,
      background: '#0A0E17',
      color: '#F0F4FF',
      padding: '20px',
      borderRadius: '12px',
      border: '1px solid #1E2D45',
      fontFamily: 'sans-serif',
      fontSize: '14px',
      width: '320px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    }}>
      <div style={{ color: '#00E5FF', fontWeight: 700, fontSize: '16px', marginBottom: '8px' }}>
        Pomogator.ai
      </div>
      <div style={{ color: '#8899BB' }}>
        Анализируем карточку...
      </div>
    </div>
  )
}

const host = document.createElement('div')
host.id = 'pomogator-root'
document.body.appendChild(host)

const shadow = host.attachShadow({ mode: 'open' })
const container = document.createElement('div')
shadow.appendChild(container)

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
