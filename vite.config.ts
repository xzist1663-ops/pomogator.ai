import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import webExtension from 'vite-plugin-web-extension'
 
export default defineConfig({
  plugins: [
    react(),
    webExtension({
      manifest: './public/manifest.json',
      additionalInputs: [
        'src/popup/index.html',
        // seller.tsx не нужен здесь — он уже в content_scripts манифеста,
        // плагин подхватит его автоматически
      ],
    }),
  ],
})
 