/** Legacy local-disk uploads (store_documents.storage_path, from before S3). */
import { createReadStream, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { env } from '$env/dynamic/private';
import { contentDisposition, resolveContentType, safeDisposition, type Disposition } from './content_headers';

/** Stream a stored file, or null when it is missing or its path points outside the uploads folder. */
export function diskFileResponse(
	storagePath: string,
	file: { fileName: string; contentType: string | null },
	requested: Disposition = 'attachment'
): Response | null {
	const raw = env.UPLOADS_DIR?.trim() || './uploads';
	const root = normalize(isAbsolute(raw) ? raw : join(process.cwd(), raw));
	const path = normalize(join(root, storagePath));
	if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
	let size: number;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return null;
		size = stat.size;
	} catch {
		return null;
	}
	const type = resolveContentType(file.contentType, file.fileName);
	return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
		headers: {
			'content-type': type,
			'content-length': String(size),
			'content-disposition': contentDisposition(safeDisposition(requested, type), file.fileName),
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff'
		}
	});
}
