import baseConfig from '@ccusage/config/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig({
	...baseConfig,
	dts: false,
	exports: false,
	sourcemap: false,
});
