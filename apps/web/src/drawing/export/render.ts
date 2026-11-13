import { withDrawingViewport } from '@skysa/draw-core';

import type { EditorDocument } from '../document/model.js';
import { type Box, canvasBox } from './box.js';

/**
 * A drawing rendered to pixels (docs/ARCHITECTURE.md §7, "Export"): its SVG
 * text as a `blob:` URL in an `<img>`, decoded and drawn onto a canvas with
 * `drawImage`. An SVG shown as an image runs no script and loads nothing from
 * outside itself, so the text needs no sanitizing for this, whoever wrote it,
 * and the `<img>` never enters the page. The same render serves export, and
 * whatever else turns vectors into pixels (rasterize, merge down).
 */

/** What a drawing exports to: three renders, and the file itself. */
export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'svg';

const TYPES = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	svg: 'image/svg+xml',
} as const satisfies Record<ExportFormat, string>;

/**
 * An export's longer side in pixels, at most: the most a canvas has on a side
 * in Chrome, Firefox and Safari on a desktop, and, squared, Chrome's limit on
 * a canvas's area. A scale that asks for more is given this, and the dialog
 * says so. iOS draws no canvas over 16.7 MP (4,096 square); an export larger
 * than that fails there and says so, rather than every device being held to
 * the phone's limit.
 */
export const EXPORT_MAX_SIDE = 16_384;

/** What the lossy encoders are asked for: high enough that a drawing's edges stay clean. */
const QUALITY = 0.92;

/** What a JPEG, which has no alpha, has behind the drawing unless the user chose otherwise. */
export const DEFAULT_BACKGROUND = '#ffffff';

export type ExportSize = Readonly<{ width: number; height: number; capped: boolean }>;

/**
 * The pixels an export of a canvas `box` big has at `scale`: `scale` pixels a
 * user unit, the longer side kept to `EXPORT_MAX_SIDE` (`capped` says it
 * was), never less than one either way.
 */
export const exportSize = (
	box: Readonly<{ width: number; height: number }>,
	scale: number
): ExportSize => {
	const width = box.width * scale;
	const height = box.height * scale;
	const fit = Math.min(1, EXPORT_MAX_SIDE / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * fit)),
		height: Math.max(1, Math.round(height * fit)),
		capped: fit < 1,
	};
};

/**
 * The text with its root's `viewBox` set to `box` and its `width` and
 * `height` to the pixels wanted, everything else as it was. The size is the
 * `<img>`'s natural size, so every browser renders the vectors at the size
 * they are drawn at rather than scaling a smaller bitmap up, and a file with
 * no size of its own, which Firefox will not draw on a canvas at all, has
 * one. Text whose root this cannot read is rendered as it is. Core reads and
 * rewrites the root (`withDrawingViewport`), as it does for every other change
 * to it, so a root is read, or refused, in time to its length, however many
 * attributes it has.
 */
const forRender = (text: string, box: Box, pixelWidth: number, pixelHeight: number): string =>
	withDrawingViewport(text, box, { width: pixelWidth, height: pixelHeight }) ?? text;

/**
 * The seam for what an SVG in an `<img>` cannot reach. An image renders
 * nothing from outside itself: an `<image>` whose `href` is relative, as an
 * attachment kept beside the drawing will be (§3, "Layers"; §10), or on
 * another host, comes out blank from a `blob:` document. Such a picture has
 * to be inlined as a `data:` URL before the render, and before a lone SVG is
 * handed over, since nothing travels beside it. Every picture is inline today,
 * so the text is given back as it is.
 */
const inlineReferences = (text: string): string => text;

/** The picture at `url`, decoded, never in the page; rejects where it will not decode. */
const decoded = async (url: string): Promise<HTMLImageElement> => {
	const img = document.createElement('img');
	img.setAttribute('src', url);
	await img.decode();
	return img;
};

/** The render, on `background` where one is given, painted before the drawing goes on it. */
const paint = async (
	svgText: string,
	box: Box,
	pixelWidth: number,
	pixelHeight: number,
	background: string | undefined
): Promise<HTMLCanvasElement | undefined> => {
	const canvas = document.createElement('canvas');
	canvas.width = pixelWidth;
	canvas.height = pixelHeight;
	// Without a 2D context, jsdom or a browser that would not make one this
	// large, there is nothing to draw on.
	const ctx = canvas.getContext('2d');
	if (ctx === null) return undefined;
	const svg = new Blob([forRender(svgText, box, pixelWidth, pixelHeight)], {
		type: TYPES.svg,
	});
	const url = URL.createObjectURL(svg);
	try {
		const img = await decoded(url);
		if (background !== undefined) {
			ctx.fillStyle = background;
			ctx.fillRect(0, 0, pixelWidth, pixelHeight);
		}
		ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);
		return canvas;
	} catch {
		// It would not decode, or the browser has no `decode`: no render.
		return undefined;
	} finally {
		URL.revokeObjectURL(url);
	}
};

/**
 * The SVG text, a whole `<svg>` document, drawn onto a new canvas of
 * `pixelWidth` by `pixelHeight` with `box` as its `viewBox`: what of the
 * drawing is shown, in its user units. `undefined`, never a rejection, where
 * the browser cannot: no 2D context (jsdom), or a picture that will not
 * decode.
 */
export const renderSvg = (
	svgText: string,
	box: Readonly<{ x: number; y: number; width: number; height: number }>,
	pixelWidth: number,
	pixelHeight: number
): Promise<HTMLCanvasElement | undefined> =>
	paint(svgText, box, pixelWidth, pixelHeight, undefined);

/** The canvas encoded; `null` where the browser gave nothing, or would not read it back. */
const blobOf = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
	new Promise((resolve) => {
		try {
			canvas.toBlob(resolve, type, quality);
		} catch {
			// A canvas something from another origin was drawn on cannot be read.
			resolve(null);
		}
	});

const dataUrlOf = (blob: Blob): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener(
			'load',
			() => {
				if (typeof reader.result === 'string') resolve(reader.result);
				else reject(new Error('the encoded picture could not be read back'));
			},
			{ once: true }
		);
		reader.addEventListener(
			'error',
			() => reject(new Error('the encoded picture could not be read back')),
			{ once: true }
		);
		reader.readAsDataURL(blob);
	});

/**
 * The canvas as a `data:image/png;base64,…` URL: through `toBlob` and a
 * `FileReader`, which keep the encoding off the main thread, or through
 * `toDataURL` where `toBlob` gave nothing. Rejects for a canvas that cannot be
 * read back.
 */
export const canvasToPng = async (canvas: HTMLCanvasElement): Promise<string> => {
	const blob = await blobOf(canvas, TYPES.png);
	return blob === null ? canvas.toDataURL(TYPES.png) : dataUrlOf(blob);
};

/**
 * The drawing as a file of `format`: for SVG the drawing's own text; for the
 * others, the text rendered at `scale` pixels a user unit (`exportSize`) and
 * encoded, a JPEG on `background`, white unless one is given, since it cannot
 * be see-through, and PNG and WebP on one only where it is given. The text is
 * the one a save would write: a stroke still being encoded is waited for.
 * `undefined` where the browser could not render or encode it. A browser that
 * cannot encode WebP gives a PNG, and the blob's type says so.
 */
export const exportBlob = async (
	document: EditorDocument,
	format: ExportFormat,
	scale: number,
	background?: string
): Promise<Blob | undefined> => {
	await document.settle();
	const text = inlineReferences(document.text());
	if (format === 'svg') return new Blob([text], { type: TYPES.svg });
	if (!(scale > 0) || !Number.isFinite(scale)) return undefined;
	const box = canvasBox(document);
	const size = exportSize(box, scale);
	const behind = background ?? (format === 'jpeg' ? DEFAULT_BACKGROUND : undefined);
	const canvas = await paint(text, box, size.width, size.height, behind);
	if (canvas === undefined) return undefined;
	const blob = await blobOf(canvas, TYPES[format], format === 'png' ? undefined : QUALITY);
	return blob ?? undefined;
};
