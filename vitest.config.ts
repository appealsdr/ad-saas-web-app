import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	// Compiles .svelte files so shared components can be SSR-rendered in unit tests.
	plugins: [svelte({ hot: false })],
	resolve: {
		alias: {
			$lib: r('./src/lib'),
			$components: r('./src/lib/components'),
			'$env/dynamic/private': r('./tests/setup/env-shim.ts'),
			'$env/dynamic/public': r('./tests/setup/env-shim.ts'),
			'$app/environment': r('./tests/setup/app-environment-shim.ts'),
			'$app/forms': r('./tests/setup/app-forms-shim.ts'),
			'$app/navigation': r('./tests/setup/app-navigation-shim.ts')
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
