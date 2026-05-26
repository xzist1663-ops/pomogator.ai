# TECH_STACK.md
> Технологический стек Pomogator.ai с обоснованием каждого выбора.

---

## Итоговый стек

| Слой | Технология | Почему |
|------|-----------|--------|
| Фреймворк | React 18 + TypeScript | Компонентность, хуки, типы |
| Сборка | Vite + vite-plugin-web-extension | Быстро, нативная поддержка MV3 |
| Стили | Tailwind CSS + CSS Variables | Утилитарность + кастомные темы |
| Стейт | Zustand | Лёгкий, без бойлерплейта |
| Анимации | Framer Motion | Самый мощный для React |
| Конфетти | canvas-confetti | 3KB, никаких зависимостей |
| Шрифты | Syne + DM Sans | Характерная пара, не Inter |
| Иконки | Lucide React | Чистые, консистентные |
| Линтинг | ESLint + Prettier | Стандарт |

---

## Подробное обоснование

### React 18 + TypeScript
**Почему React, а не Vue/Svelte?**
- Самая большая экосистема Chrome-расширений на React
- Framer Motion работает только с React
- TypeScript обязателен — парсеры DOM хрупкие, типы ловят баги до рантайма

**Почему не ванильный JS?**
Sidebar — это мини-приложение с состоянием: загрузка, 9 блоков оценки, SERP-запросы, переключение темы. Без фреймворка это становится спагетти.

---

### Vite + vite-plugin-web-extension
**Почему не Webpack (стандарт для расширений)?**
- Webpack для MV3 — боль: медленная сборка, сложная конфигурация hot reload
- `vite-plugin-web-extension` решает ВСЕ специфичные проблемы MV3: service worker bundling, content script isolation, `web_accessible_resources` автогенерация
- HMR во время разработки sidebar — скорость х3

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import webExtension from 'vite-plugin-web-extension'

export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: './public/manifest.json',
    }),
  ],
})
```

---

### Tailwind CSS + CSS Variables
**Почему Tailwind?**
- Утилитарные классы = быстрая вёрстка sidebar-компонентов
- Не конфликтует с CSS страницы Ozon (используем shadow DOM для изоляции)

**Почему ещё и CSS Variables?**
- Tailwind не умеет переключать темы на лету без перегенерации
- CSS Variables меняются через `document.documentElement.setAttribute('data-theme', 'dark')` мгновенно
- Вся палитра в одном месте — легко менять

---

### Zustand (вместо Redux/Context)
**Почему не Redux?**
- Redux для MVP расширения = оверинжиниринг
- Boilerplate (actions, reducers, selectors) замедляет разработку

**Почему не React Context?**
- Context вызывает перерендер всего дерева — плохо для скорости sidebar

**Zustand:**
```ts
// Весь стор в 20 строк
const useProductStore = create<ProductStore>((set) => ({
  productData: null,
  scoreResult: null,
  serpResults: [],
  isLoading: true,
  theme: 'dark',
  setProductData: (data) => set({ productData: data }),
  setTheme: (theme) => set({ theme }),
}))
```

---

### Framer Motion
**Почему не CSS-анимации?**
- ScoreRing требует анимации числового значения (0 → 78)
- Staggered reveal блоков оценки (появляются по очереди)
- Exit-анимации при переключении экранов
- Всё это делается в 3 строки с Framer Motion, а без него — 50 строк custom JS

```tsx
// Пример staggered reveal
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ delay: index * 0.1 }}
>
  <ScoreCard block={block} />
</motion.div>
```

---

### Шрифты: Syne + DM Sans
**Почему не Inter/Roboto/Space Grotesk?**
Это инструмент для продавцов маркетплейсов — нам нужен характер, а не корпоративная скука.

- **Syne** — display-шрифт с геометрической энергией. Для заголовков, оценок, акцентов. Выглядит как 2026 год.
- **DM Sans** — современный гуманистический гротеск. Для основного текста. Читается идеально на тёмном фоне.

Загружаем через `@import` в CSS — не через Google Fonts напрямую (CSP расширений блокирует внешние шрифты). Используем `@font-face` с локальными файлами в `public/fonts/`.

---

### Shadow DOM для изоляции
**Критично для content script.**
Sidebar монтируется в Shadow DOM — стили Ozon не ломают наш UI, наши стили не ломают страницу Ozon.

```ts
// content/injector.ts
const host = document.createElement('div')
host.id = 'pomogator-root'
const shadow = host.attachShadow({ mode: 'open' })
document.body.appendChild(host)
ReactDOM.createRoot(shadow).render(<App />)
```

---

## Что НЕ используем и почему

| Технология | Почему нет |
|-----------|-----------|
| Angular | Слишком тяжёлый для расширения |
| MobX | Zustand проще, достаточно |
| Styled Components | Конфликты с Shadow DOM |
| Redux Toolkit | Оверинжиниринг для MVP |
| jQuery | 2026 год |
| Webpack | Медленнее Vite, сложнее конфиг MV3 |
| CRXJS | Менее стабильный чем vite-plugin-web-extension |

---

## AI-сервисы (планируются в v2)

| Слот | Сервис | Что анализирует |
|------|--------|----------------|
| photo-quality | OpenAI Vision API / Google Vision | Резкость, белый фон, lifestyle |
| sentiment | YandexGPT / OpenAI | Тональность отзывов |
| seo-quality | OpenAI / Claude API | Качество SEO-структуры названия |
| text-quality | OpenAI / Claude API | Польза и структура описания |

Архитектура слотов позволяет подключить любой сервис без рефакторинга — только реализовать интерфейс `AIPlugin`.

---

## Manifest V3 — важные ограничения

- Service Worker **не имеет** доступа к DOM — только background-логика
- `fetch()` в content scripts работает, но с CORS-ограничениями Ozon
- `chrome.tabs` требует разрешения `tabs` — запрашиваем в manifest
- Inline scripts запрещены — весь JS через bundle
- `eval()` запрещён — не используем

---

## Команды разработки

```bash
npm install          # установка зависимостей
npm run dev          # dev-сборка с hot reload (load unpacked в Chrome)
npm run build        # production-сборка в /dist
npm run type-check   # проверка типов без сборки
npm run lint         # ESLint
```
