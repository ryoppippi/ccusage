import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: 'esm',
  clean: true,
  sourcemap: false,
  minify: false,
  treeshake: true,
  dts: true,
  publint: true,
  unused: true,
  nodeProtocol: true,
  define: {
    'import.meta.vitest': 'undefined'
  }
});
