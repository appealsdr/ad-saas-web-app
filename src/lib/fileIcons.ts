/**
 * Map a file (by extension, falling back to MIME) to one of the icons in
 * /static/icons/files/. Returns `unknown` when nothing matches.
 */
const EXT_TO_ICON: Record<string, string> = {
	pdf: 'pdf',
	doc: 'word',
	docx: 'word',
	xls: 'excel',
	xlsx: 'excel',
	csv: 'csv',
	txt: 'txt',
	log: 'txt',
	rtf: 'rtf',
	ppt: 'ppt',
	pptx: 'ppt',
	key: 'keynote',
	keynote: 'keynote',
	jpg: 'image',
	jpeg: 'image',
	png: 'image',
	gif: 'image',
	bmp: 'image',
	webp: 'image',
	heic: 'image',
	svg: 'image',
	tif: 'image',
	tiff: 'image',
	html: 'html',
	htm: 'html',
	xml: 'xml',
	psd: 'psd',
	eps: 'eps',
	swf: 'flash',
	exe: 'exe',
	vsd: 'visio',
	visio: 'visio'
};

function extFromMime(mime: string): string {
	const m = mime.toLowerCase();
	if (m === 'application/pdf') return 'pdf';
	if (m.startsWith('image/')) return 'jpg';
	if (m.startsWith('text/')) return 'txt';
	if (m.includes('word')) return 'doc';
	if (m.includes('sheet') || m.includes('excel')) return 'xls';
	if (m.includes('presentation') || m.includes('powerpoint')) return 'ppt';
	return '';
}

export function fileTypeIconName(
	nameOrExt: string | null | undefined,
	mime?: string | null
): string {
	let ext = '';
	if (nameOrExt) {
		const n = nameOrExt.toLowerCase().trim();
		ext = n.includes('.') ? (n.split('.').pop() ?? '') : n;
	}
	if (!ext && mime) ext = extFromMime(mime);
	return EXT_TO_ICON[ext] ?? 'unknown';
}

/** Full URL to the matching file-type icon. */
export function fileTypeIconUrl(nameOrExt: string | null | undefined, mime?: string | null): string {
	return `/icons/files/${fileTypeIconName(nameOrExt, mime)}.png`;
}
