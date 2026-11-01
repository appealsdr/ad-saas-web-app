import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			$lib: r('./src/lib'),
			$components: r('./src/lib/components'),
			'$env/dynamic/private': r('./tests/setup/env-shim.ts'),
			'$env/dynamic/public': r('./tests/setup/env-shim.ts'),
			'$app/environment': r('./tests/setup/app-environment-shim.ts')
		}
	},
	test: {
		include: ['tests/**/*.test.ts'],
		globalSetup: ['tests/setup/global.ts'],
		testTimeout: 30_000,
		hookTimeout: 60_000,
		// DB-backed tests share one throwaway database; run files serially.
		fileParallelism: false,
		pool: 'forks'
	}
});
