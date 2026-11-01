// Stand-in for SvelteKit's `$env/dynamic/private` under vitest.
export const env = new Proxy({} as Record<string, string | undefined>, {
	get: (_t, k: string) => process.env[k],
	has: (_t, k: string) => k in process.env,
	ownKeys: () => Reflect.ownKeys(process.env),
	getOwnPropertyDescriptor: (_t, k: string) => (k in process.env ? { enumerable: true, configurable: true, value: process.env[k] } : undefined)
});
