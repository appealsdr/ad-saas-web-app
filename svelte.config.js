import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// adapter-node produces a Node.js server — suitable for ECS Fargate deployment
		adapter: adapter({
			out: 'build'
		}),
		// Replaced by src/lib/server/csrf.ts (called from hooks.server.ts), which is identical except for the
		// OAuth machine endpoints that MCP clients call without an Origin header.
		csrf: { checkOrigin: false },
		alias: {
			$lib: 'src/lib',
			$components: 'src/lib/components',
			$stores: 'src/lib/stores',
			$types: 'src/lib/types'
		}
	}
};

export default config;
