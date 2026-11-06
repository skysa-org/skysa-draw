/**
 * What the page and the pictures worker say to each other (`./index.ts` asks,
 * `./pictures.worker.ts` answers), and how both read a picture
 * (docs/ARCHITECTURE.md §7, "The editor"). A request is one of two: a
 * stand-in to make from a picture's `href`, for the layers panel's previews;
 * or a layer's pixels, an `ImageBitmap` transferred, to encode as PNG. The
 * reply, known by the request's id, is a `data:` URL, or why there is none,
 * with the pixels given back where the worker still has them.
 */

/** A stand-in of `href` at `most` pixels on its longer side, or `href` itself where it is no larger. */
type ShrinkRequest = Readonly<{ id: number; kind: 'shrink'; href: string; most: number }>;

/** The pixels of `bitmap` as a PNG `data:` URL; the bitmap is the worker's from then on. */
type EncodeRequest = Readonly<{ id: number; kind: 'encode'; bitmap: ImageBitmap }>;

export type PictureRequest = ShrinkRequest | EncodeRequest;

export type PictureReply =
	| Readonly<{ id: number; href: string }>
	| Readonly<{ id: number; error: string; bitmap?: ImageBitmap }>;

/** What the worker posts once it listens: the page posts it nothing it would want back before then. */
export type PictureHello = Readonly<{ ready: true }>;

/** Whether a message is a request, so whatever else reaches the worker is let be. */
export const isPictureRequest = (message: unknown): message is PictureRequest =>
	typeof message === 'object' &&
	message !== null &&
	'id' in message &&
	'kind' in message &&
	(message.kind === 'shrink' || message.kind === 'encode');

/**
 * The media type of a `data:` URL whose data is base64, lowercased and
 * without its parameters, empty where it names none; nothing for any other
 * `href`. Only the part before the first comma is read.
 */
export const base64TypeOf = (href: string): string | undefined => {
	const comma = href.indexOf(',');
	if (comma < 0 || !/^data:/i.test(href)) return undefined;
	const [type = '', ...parameters] = href.slice('data:'.length, comma).split(';');
	return parameters.at(-1)?.trim().toLowerCase() === 'base64'
		? type.trim().toLowerCase()
		: undefined;
};

/**
 * Whether the worker can decode the picture: a base64 `data:` URL, which it
 * reads without a fetch the page's policy would refuse, of anything but SVG,
 * which a worker has no decoder for.
 */
export const decodesInWorker = (href: string): boolean => {
	const type = base64TypeOf(href);
	return type !== undefined && type !== 'image/svg+xml';
};

/** A picture's bytes and the media type its `data:` URL gave them. */
type PictureBytes = Readonly<{ type: string; bytes: Uint8Array<ArrayBuffer> }>;

type FromBase64 = Readonly<{ fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }>;

/** Base64 as bytes: by `Uint8Array.fromBase64` where the engine has it, newer than this app's lib, and by `atob` where not. */
const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> =>
	(Uint8Array as FromBase64).fromBase64?.(text) ??
	Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** The picture in a base64 `data:` URL; nothing for any other `href`, or for data that is not base64. */
export const pictureBytes = (href: string): PictureBytes | undefined => {
	const type = base64TypeOf(href);
	if (type === undefined) return undefined;
	try {
		return { type, bytes: decodeBase64(href.slice(href.indexOf(',') + 1)) };
	} catch {
		return undefined;
	}
};

/** A size held to `most` on its longer side, at its own aspect, a pixel at least either way. */
export const shrunkSize = (
	width: number,
	height: number,
	most: number
): Readonly<{ width: number; height: number }> => {
	const scale = most / Math.max(width, height);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
};
