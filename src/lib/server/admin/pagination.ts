export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export function parsePage(v: string | null | undefined): number {
	const n = Number.parseInt(v ?? '1', 10);
	return Number.isFinite(n) && n >= 1 && n <= 100_000 ? n : 1;
}

export function parsePageSize(v: string | null | undefined): number {
	const n = Number.parseInt(v ?? '', 10);
	if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
	return Math.min(n, MAX_PAGE_SIZE);
}

/** Escape LIKE/ILIKE metacharacters so user input is matched literally. */
export function likeContains(input: string): string {
	return `%${input.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
