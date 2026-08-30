import { defineConfig } from 'vite';

// サーバーを1ファイルに束ねる。engine を server からも import するので、
// tsc ではなく vite でビルドして型と実体の入口を1つに保つ
export default defineConfig({
  build: {
    outDir: 'dist-server',
    ssr: 'server/index.ts',
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  },
});
