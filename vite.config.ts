import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 5173,
		// Allow ngrok / tunnels to reach the dev server. Safe for dev — Vite
		// uses this to gate the Host header; localhost is already allowed.
		// Use ".ngrok-free.app" + ".ngrok.app" to cover both free and paid plans;
		// add more entries here if you use Cloudflare Tunnel, Tailscale Funnel, etc.
		allowedHosts: [
			'.ngrok-free.dev',   // current free tier
			'.ngrok-free.app',   // older free tier
			'.ngrok.app',        // paid plans
			'.ngrok.io'          // legacy
		]
	}
});
