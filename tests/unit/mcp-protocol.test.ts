import { describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/lib/server/mcp/tools', () => ({
	TOOLS: [
		{ name: 'list_stores', description: 'd', permission: 'stores.list', inputSchema: { type: 'object', properties: { limit: {} }, additionalProperties: false }, run: m.run },
		{ name: 'get_case', description: 'd', permission: 'cases.read', inputSchema: { type: 'object', properties: { caseId: {} }, additionalProperties: false }, run: m.run }
	]
}));

import { handleRpc, visibleTools, MAX_RESULT_CHARS } from '../../src/lib/server/mcp/protocol';
import { ApiError } from '../../src/lib/server/integrations/errors';

const principal = (permissions: string[]) => ({ permissions }) as never;
const call = (name: string, args: unknown, perms = ['stores.list']) =>
	handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args as never } }, principal(perms), {}) as Promise<any>;

describe('mcp protocol', () => {
	it('negotiates the protocol version and ignores notifications', async () => {
		const ok: any = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, principal([]), {});
		expect(ok.result.protocolVersion).toBe('2025-03-26');
		const newer: any = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, principal([]), {});
		expect(newer.result.protocolVersion).toBe('2025-06-18');
		expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, principal([]), {})).toBeNull();
	});
	it('lists only the tools the connection is permitted to use', async () => {
		expect(visibleTools(principal(['stores.list'])).map((t) => t.name)).toEqual(['list_stores']);
		const r: any = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, principal(['cases.read']), {});
		expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual(['get_case']);
	});
	it('denies a tool without its permission and never runs it', async () => {
		m.run.mockClear();
		const r = await call('get_case', { caseId: 'x' });
		expect(r.result.isError).toBe(true);
		expect(r.result.content[0].text).toContain('PERMISSION_DENIED');
		expect(m.run).not.toHaveBeenCalled();
	});
	it('rejects unknown tools, unknown arguments and non-object arguments', async () => {
		expect((await call('nope', {})).error.code).toBe(-32602);
		expect((await call('list_stores', { accountId: 'other' })).result.content[0].text).toContain('Unknown argument');
		expect((await call('list_stores', [])).error.code).toBe(-32602);
	});
	it('returns tool data, and turns ApiError into a readable error result', async () => {
		m.run.mockResolvedValueOnce({ data: [1] });
		expect((await call('list_stores', {})).result).toMatchObject({ isError: false });
		m.run.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Store not found.'));
		const r = await call('list_stores', {});
		expect(r.result.isError).toBe(true);
		expect(r.result.content[0].text).toContain('NOT_FOUND');
	});
	it('does not swallow unexpected errors (the route maps them to -32603)', async () => {
		m.run.mockRejectedValueOnce(new Error('db down'));
		await expect(call('list_stores', {})).rejects.toThrow('db down');
	});
	it('caps oversized results', async () => {
		m.run.mockResolvedValueOnce({ big: 'x'.repeat(MAX_RESULT_CHARS * 2) });
		const r = await call('list_stores', {});
		expect(r.result.content[0].text.length).toBeLessThan(MAX_RESULT_CHARS + 100);
		expect(r.result.content[0].text).toContain('truncated');
	});
	it('rejects unknown methods', async () => {
		expect(((await handleRpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, principal([]), {})) as any).error.code).toBe(-32601);
	});
});
