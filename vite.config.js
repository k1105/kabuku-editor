import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  // `.env` lives at the project root (one level above `src`) — without this
  // override Vite would look inside src/ where we don't want secrets to live.
  envDir: '..',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
