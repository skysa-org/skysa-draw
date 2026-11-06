import { pictureBytes, type PictureReply, type PictureRequest, shrunkSize } from './protocol.js';

/**
 * The pictures worker's work (`./pictures.worker.ts` listens; `./index.ts`
 * asks): a picture decoded, shrunk and encoded for the layers panel, and a
 * layer's pixels encoded as PNG, each a `data:` URL, all of it off the page's
 * thread. A picture comes as its `data:` URL and is read from its own bytes,
 * since a worker under the page's policy may not fetch one; the pixels come
 * as a bitmap and are drawn as they are, so the PNG decodes to the very
 * bytes the page's own `toBlob` would have written. Nothing here throws: a
 * failure is a reply that says so, with the pixels given back where they are
 * still whole, for the page to encode them itself.
 */

/** A reply, and what posting it transfers. */
export type PictureAnswer = Readonly<{ reply: PictureReply; transfer: readonly Transferable[] }>;

type ReadsSync = new () => Readonly<{ readAsDataURL: (blob: Blob) => string }>;

/** A blob as a `data:` URL, read at once by a worker's `FileReaderSync`, which the page's lib does not declare. */
const dataUrlOf = (blob: Blob): string => {
	const Reader = (globalThis as Partial<Readonly<{ FileReaderSync: ReadsSync }>>).FileReaderSync;
	if (Reader === undefined) throw new Error('there is no FileReaderSync here');
	return new Reader().readAsDataURL(blob);
};

/** `source` drawn on a canvas of its own size and encoded as a PNG `data:` URL. */
const pngOf = async (source: ImageBitmap): Promise<string> => {
	const canvas = new OffscreenCanvas(source.width, source.height);
	const ctx = canvas.getContext('2d');
	if (ctx === null) throw new Error('there is no 2D canvas in this worker');
	ctx.drawImage(source, 0, 0);
	return dataUrlOf(await canvas.convertToBlob({ type: 'image/png' }));
};

/**
 * The picture's stand-in, as the page's own shrink makes it
 * (`../panels/previewPictures.ts`): decoded whole to learn its size, the
 * `href` itself where that is no larger than `most`, and otherwise resized by
 * `createImageBitmap` at its best smoothing and encoded as PNG, which keeps
 * what is transparent.
 */
const shrink = async (href: string, most: number): Promise<string> => {
	const picture = pictureBytes(href);
	if (picture === undefined) throw new Error('the picture is not a base64 data: URL');
	const whole = await createImageBitmap(new Blob([picture.bytes], { type: picture.type }));
	try {
		if (Math.max(whole.width, whole.height) <= most) return href;
		const size = shrunkSize(whole.width, whole.height, most);
		const small = await createImageBitmap(whole, {
			resizeWidth: size.width,
			resizeHeight: size.height,
			resizeQuality: 'high',
		});
		try {
			return await pngOf(small);
		} finally {
			small.close();
		}
	} finally {
		whole.close();
	}
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** What went wrong, with the pixels given back where the request brought some that are still whole. */
const failed = (request: PictureRequest, error: unknown): PictureAnswer => {
	const bitmap =
		request.kind === 'encode' && request.bitmap.width > 0 ? request.bitmap : undefined;
	return bitmap === undefined
		? { reply: { id: request.id, error: messageOf(error) }, transfer: [] }
		: { reply: { id: request.id, error: messageOf(error), bitmap }, transfer: [bitmap] };
};

/** The reply to a request; never rejects. The pixels of one to encode are let go of once encoded. */
export const answerPicture = async (request: PictureRequest): Promise<PictureAnswer> => {
	try {
		if (request.kind === 'shrink') {
			const href = await shrink(request.href, request.most);
			return { reply: { id: request.id, href }, transfer: [] };
		}
		const href = await pngOf(request.bitmap);
		request.bitmap.close();
		return { reply: { id: request.id, href }, transfer: [] };
	} catch (error) {
		return failed(request, error);
	}
};
