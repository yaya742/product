import { build } from 'esbuild';
await build({
  entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts', 'plugin-runner': 'src/main/plugins/runner.ts' },
  bundle: true,
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  loader: { '.md': 'text' },
  sourcemap: true,
});
