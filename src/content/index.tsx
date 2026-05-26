import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { parseProduct, ProductData } from './parser'

function App() {
  const [data, setData] = useState<ProductData | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setData(parseProduct())
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

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
      <div style={{ color: '#00E5FF', fontWeight: 700, fontSize: '16px', marginBottom: '12px' }}>
        Pomogator.ai
      </div>

      {!data ? (
        <div style={{ color: '#8899BB' }}>Анализируем карточку...</div>
      ) : (
        <div>
          <div style={{ color: '#8899BB', marginBottom: '8px', fontSize: '12px' }}>
            ФОТО И МЕДИА
          </div>
          <Row label="Фото в галерее" value={String(data.photos.count)} />
          <Row label="Видео" value={data.photos.hasVideo ? 'Да' : 'Нет'} />
          <Row label="3D / 360°" value={data.photos.has360 ? 'Да' : 'Нет'} />
          <Row label="Инфографика" value={data.photos.hasInfographic ? 'Да' : 'Нет'} />

          <div style={{ color: '#8899BB', margin: '16px 0 8px', fontSize: '12px' }}>
            ХАРАКТЕРИСТИКИ
          </div>
          <Row label="Заполнено полей" value={String(data.attributes.count)} />
          <Row label="Обязательные" value={data.attributes.hasRequired ? 'Есть' : 'Нет'} />
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      padding: '6px 0',
      borderBottom: '1px solid #1E2D45',
    }}>
      <span style={{ color: '#8899BB' }}>{label}</span>
      <span style={{ color: '#F0F4FF', fontWeight: 600 }}>{value}</span>
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