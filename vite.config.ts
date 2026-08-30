import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// クライアントだけのビルド。オンライン対戦は server/ が要るので、
// 動作確認には npm run build && npm start を使う（dev は画面の見た目確認まで）
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
  build: { outDir: 'dist' },
});
