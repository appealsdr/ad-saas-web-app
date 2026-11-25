// Test stub for `$app/stores` — SSR rendering only reads the current values.
import { readable } from 'svelte/store';
export const page = readable({ url: new URL('http://localhost/'), params: {}, data: {} });
export const navigating = readable(null);
