import { defineConfig } from 'tsdown';
import baseConfig from '@ccusage/config/tsdown';

export default defineConfig({
  ...baseConfig,
  dts: false,
  exports:false,
  sourcemap: false,
})
