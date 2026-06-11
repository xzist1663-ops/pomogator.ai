# ARCHITECTURE.md
> Полная архитектура проекта Pomogator.ai

---

## Тип проекта

Chrome Extension (Manifest V3) + React-приложение внутри sidebar.

---

## Структура файлов и папок

```
pomogator/
│
├── docs/                          # Контекст для AI-ассистента
│   ├── PROJECT_OVERVIEW.md
│   ├── ARCHITECTURE.md
│   ├── TECH_STACK.md
│   └── CURRENT_STATUS.md
│
├── public/                        # Статика Chrome Extension
│   ├── manifest.json              # Манифест расширения (MV3)
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
│
├── src/
│   ├── background/
│   │   └── index.ts               # Service Worker — управление вкладками, поиск позиции
│   │
│   ├── content/
│   │   ├── index.tsx              # Точка входа content script — монтирует sidebar
│   │   ├── parser/
│   │   │   ├── index.ts           # Оркестратор парсинга
│   │   │   ├── photos.ts          # Парсер блока фото и медиа
│   │   │   ├── attributes.ts      # Парсер характеристик
│   │   │   ├── reviews.ts         # Парсер отзывов и рейтинга
│   │   │   ├── title.ts           # Парсер названия и извлечение ключей
│   │   │   ├── delivery.ts        # Парсер доставки
│   │   │   ├── description.ts     # Парсер описания
│   │   │   ├── rich.ts            # Парсер rich-контента
│   │   │   └── price.ts           # Парсер цены и акций
│   │   └── injector.ts            # Инжектор sidebar в DOM страницы
│   │
│   ├── sidebar/                   # React-приложение сайдбара
│   │   ├── App.tsx                # Корневой компонент, роутинг между экранами
│   │   ├── main.tsx               # Точка входа React
│   │   │
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   ├── Sidebar.tsx        # Обёртка сайдбара (drag, resize, close)
│   │   │   │   ├── ThemeToggle.tsx    # Переключатель тёмная/светлая тема
│   │   │   │   └── Logo.tsx           # Логотип Pomogator.ai
│   │   │   │
│   │   │   ├── hero/
│   │   │   │   ├── HeroSection.tsx    # Hero с заголовком и анимацией
│   │   │   │   └── ProductPreview.tsx # Превью товара (фото, название, бренд)
│   │   │   │
│   │   │   ├── score/
│   │   │   │   ├── ScoreRing.tsx      # Круговой индикатор общей оценки
│   │   │   │   ├── ScoreCard.tsx      # Карточка одного блока оценки
│   │   │   │   ├── ScoreBreakdown.tsx # Раскладка всех 9 блоков
│   │   │   │   ├── CriterionRow.tsx   # Строка одного критерия внутри блока
│   │   │   │   └── AISlot.tsx         # Заглушка для будущих AI-критериев
│   │   │   │
│   │   │   ├── serp/
│   │   │   │   ├── SerpBlock.tsx      # Блок "Место в выдаче"
│   │   │   │   └── KeywordTag.tsx     # Тег ключевого слова с позицией
│   │   │   │
│   │   │   └── cta/
│   │   │       ├── WantSameSection.tsx  # Секция "Хочу так же"
│   │   │       ├── ConfettiButton.tsx   # Кнопка с конфетти
│   │   │       └── Footer.tsx           # Футер с инфо о проекте
│   │   │
│   │   ├── hooks/
│   │   │   ├── useProductData.ts    # Получение данных от content script
│   │   │   ├── useScoring.ts        # Расчёт баллов по всем блокам
│   │   │   ├── useSerpSearch.ts     # Запрос позиции через background
│   │   │   └── useTheme.ts          # Управление темой
│   │   │
│   │   ├── scoring/
│   │   │   ├── index.ts             # Главная функция расчёта оценки
│   │   │   ├── photos.ts            # Логика оценки фото
│   │   │   ├── attributes.ts        # Логика оценки характеристик
│   │   │   ├── reviews.ts           # Логика оценки отзывов
│   │   │   ├── title.ts             # Логика оценки названия
│   │   │   ├── delivery.ts          # Логика оценки доставки
│   │   │   ├── description.ts       # Логика оценки описания
│   │   │   ├── rich.ts              # Логика оценки rich-контента
│   │   │   ├── price.ts             # Логика оценки цены
│   │   │   └── weights.ts           # Константы весов (pts per criterion)
│   │   │
│   │   ├── store/
│   │   │   └── productStore.ts      # Zustand store — данные товара и оценки
│   │   │
│   │   ├── styles/
│   │   │   ├── globals.css          # CSS переменные тем (dark/light)
│   │   │   └── animations.css       # Keyframe анимации
│   │   │
│   │   └── types/
│   │       ├── product.ts           # Типы данных товара
│   │       ├── scoring.ts           # Типы оценки и критериев
│   │       └── messages.ts          # Типы сообщений между скриптами
│   │
│   └── shared/
│       ├── constants.ts             # Общие константы (URL паттерны, веса)
│       └── utils/
│           ├── keywords.ts          # Извлечение ключевых слов из текста
│           └── dom.ts               # Утилиты для безопасного чтения DOM
│
├── .env                             # Переменные окружения (API ключи AI в будущем)
├── vite.config.ts                   # Конфиг сборки (vite-plugin-web-extension)
├── tsconfig.json
├── tailwind.config.ts
└── package.json
```

---

## Компоненты — подробное описание

### `manifest.json`
Манифест Chrome Extension MV3.
- `content_scripts` — активируется на `*://www.ozon.ru/product/*`
- `background.service_worker` — для открытия фоновых вкладок поиска
- Разрешения: `tabs`, `scripting`, `storage`, `cookies` (для региона в v2)
- `web_accessible_resources` — sidebar bundle

### `background/index.ts`
Service Worker. Слушает сообщения от sidebar.
- `SEARCH_SERP` — открывает вкладку поиска, ждёт парсинга, возвращает позицию
- `GET_REGION` — в v2: читает региональный cookie
- Управляет жизненным циклом вкладок (открыть → дождаться → закрыть)

### `content/parser/index.ts`
Оркестратор. Запускает все парсеры последовательно, собирает `ProductData`.
```ts
interface ProductData {
  title: string
  photos: PhotoData
  attributes: AttributeData
  reviews: ReviewData
  delivery: DeliveryData
  description: DescriptionData
  rich: RichData
  price: PriceData
  keywords: string[]   // топ-3 для SERP
  articleId: string    // артикул для поиска позиции
}
```

### `content/parser/photos.ts`
Считает миниатюры в галерее, проверяет наличие плеера, 3D-кнопки.
Инфографику определяет по alt-тексту (`alt.includes('инфографика') || alt.length > 30`).

### `content/parser/title.ts`
Читает `h1`, считает длину, проверяет наличие бренда.
Вызывает `shared/utils/keywords.ts` для извлечения топ-3 ключей.

### `content/parser/delivery.ts`
Парсит блок доставки: срок в днях/датах, иконки способов, бейдж экспресса.
**"Завтра" = 1 день = максимальный балл.**

### `sidebar/components/score/ScoreRing.tsx`
SVG-кольцо с анимацией заполнения при появлении.
Цвет: зелёный (80–100), жёлтый (50–79), красный (0–49).

### `sidebar/components/score/AISlot.tsx`
Заглушка для AI-критериев.
```tsx
// Показывает:
// - В MVP: "⚡ Скоро — AI-анализ качества фото"
// - После подключения: реальная оценка
interface AISlotProps {
  label: string
  pts: number
  pluginId: 'photo-quality' | 'sentiment' | 'seo-quality' | 'text-quality'
  isConnected?: boolean
}
```

### `sidebar/components/serp/SerpBlock.tsx`
Показывает позиции по топ-3 ключам.
Состояния: загрузка → найден (позиция N) → не найден в топ-36 → ошибка.

### `sidebar/components/cta/WantSameSection.tsx`
CTA-блок "Хочу так же". Анимированные карточки с советами.
`ConfettiButton` — при клике запускает конфетти через `canvas-confetti`.

### `sidebar/scoring/weights.ts`
Единственное место где хранятся все баллы. Менять оценку — только здесь.
```ts
export const WEIGHTS = {
  photos: { total: 22, count: 6, video: 5, threeDee: 3, infographic: 2 },
  attributes: { total: 18, count: 10, required: 5, relevance: 3 },
  // ...
}
```

### `sidebar/store/productStore.ts`
Zustand. Хранит: `productData`, `scoreResult`, `serpResults`, `isLoading`, `theme`.

---

## Поток данных

```
Страница Ozon
    ↓ DOM
content/parser/index.ts  →  ProductData
    ↓ postMessage
sidebar/hooks/useProductData.ts
    ↓
sidebar/scoring/index.ts  →  ScoreResult
    ↓
productStore (Zustand)
    ↓
React компоненты → UI

Параллельно:
sidebar/hooks/useSerpSearch.ts
    ↓ chrome.runtime.sendMessage
background/index.ts
    ↓ открывает вкладку ozon.ru/search/?text=КЛЮЧ
    ↓ парсит позицию
    ↓ закрывает вкладку
    → SerpResult → productStore
```

---

## Цветовая палитра

### Тёмная тема (основная)
```css
--bg-primary:    #0A0E17;   /* почти чёрный, основной фон */
--bg-elevated:   #111827;   /* карточки, сайдбар */
--bg-card:       #1A2235;   /* блоки оценки */
--border:        #1E2D45;   /* разделители */
--text-primary:  #F0F4FF;   /* основной текст */
--text-secondary:#8899BB;   /* вспомогательный */
--accent:        #00E5FF;   /* неоновый циан — основной акцент */
--accent-2:      #7C3AED;   /* фиолетовый — второй акцент */
--success:       #10B981;   /* зелёный — хорошая оценка */
--warning:       #F59E0B;   /* жёлтый — средняя */
--danger:        #EF4444;   /* красный — плохая */
--ai-slot:       #F59E0B33; /* фон AI-заглушки */
```

### Светлая тема
```css
--bg-primary:    #F8FAFF;
--bg-elevated:   #FFFFFF;
--bg-card:       #F1F5FD;
--border:        #E2E8F0;
--text-primary:  #0F172A;
--text-secondary:#64748B;
--accent:        #0EA5E9;
--accent-2:      #7C3AED;
--success:       #059669;
--warning:       #D97706;
--danger:        #DC2626;
```

---

## Масштабируемость

Добавить новый блок оценки = 4 шага:
1. Создать `src/content/parser/newblock.ts`
2. Создать `src/sidebar/scoring/newblock.ts`
3. Добавить веса в `weights.ts`
4. Создать компонент `ScoreCard` с новым блоком

Подключить AI-сервис = 2 шага:
1. Реализовать `AISlot` с `pluginId` нужного слота
2. Добавить вызов API в соответствующий scoring-файл
