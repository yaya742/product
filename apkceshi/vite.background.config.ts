import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist/runners',
    emptyOutDir: false,
    lib: {
      entry: 'src/runtime/campusBackgroundRunner.ts',
      name: 'ZaichangCampusRunner',
      formats: ['iife'],
      fileName: () => 'campus-sync.js',
    },
  },
});
