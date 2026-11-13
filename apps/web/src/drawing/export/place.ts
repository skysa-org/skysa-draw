import {
	DEFAULT_DRAWING_SIZE,
	type DrawingSize,
	imageInfo,
	isDrawingText,
	type PictureInfo,
	readDrawingSize,
} from '@skysa/draw-core';
import { extensionAt, extensionOf, mediaOf } from '@skysa/storage';

import { addLayer, compound, renameLayer, replaceRasterImage } from '../document/commands.js';
import type { Command, EditorDocument } from '../document/model.js';
import { type Box, canvasBox } from './box.js';

/**
 * A picture placed in a drawing from a file, a paste or a drop
 * (docs/ARCHITECTURE.md §3, "Layers"): a new raster layer holding one
 * `<image>` whose `href` is the file's own bytes, inline as a `data:` URL, of
 * the type they are. Nothing is decoded or re-encoded: a picture placed keeps
 * its bytes and its type until a pixel of it changes.
 *
 * What it is, and how large, is read from the bytes rather than from what the
 * file says it is (`imageInfo` reads a header without decoding), so a JPEG
 * named `.png` is placed as the JPEG it is, and a file that only says it is a
 * picture is not placed at all.
 *
 * An SVG is placed the same way, as `data:image/svg+xml`: an SVG an `<image>`
 * shows is drawn as a picture, with no script run, no handler fired and
 * nothing loaded from outside it, so its bytes are kept as they came, as any
 * other picture's are, and are as inert in the drawing as in an `<img>`.
 */

/** The pictures placed as they are, by what their bytes say they are. BMP is read, and not placed. */
const PLACED: Readonly<Partial<Record<PictureInfo['format'], string>>> = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
};

const SVG_TYPE = 'image/svg+xml';

type Picture = Readonly<{ type: string; size: DrawingSize }>;

/** What the file says it is: its type, or for a file with none, what its name's extension names. */
const declaredType = (blob: Blob): string => {
	if (blob.type !== '' || !(blob instanceof File)) return blob.type;
	return mediaOf(extensionOf(blob.name))?.type ?? '';
};

const textOf = (bytes: Uint8Array): string | undefined => {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
};

/**
 * The picture the bytes are, by their header; or an SVG, for a file that says
 * it is one and whose text is one, at the size its root gives, or a size of
 * the app's own where it gives none in user units. `undefined` for anything
 * else.
 */
const pictureOf = (bytes: Uint8Array, declared: string): Picture | undefined => {
	const info = imageInfo(bytes);
	if (info !== undefined) {
		const type = PLACED[info.format];
		return type === undefined
			? undefined
			: { type, size: { width: info.width, height: info.height } };
	}
	if (declared !== SVG_TYPE) return undefined;
	const text = textOf(bytes);
	if (text === undefined || !isDrawingText(text)) return undefined;
	return { type: SVG_TYPE, size: readDrawingSize(text) ?? DEFAULT_DRAWING_SIZE };
};

/** Bytes as `btoa` takes them, a run at a time: one call over a large file would pass too many arguments. */
const CHUNK = 0x8000;

const base64Of = (bytes: Uint8Array): string =>
	btoa(
		Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, index) =>
			String.fromCharCode(...bytes.subarray(index * CHUNK, (index + 1) * CHUNK))
		).join('')
	);

/** User units to a thousandth: enough for any screen, and an attribute a person can read. */
const tidy = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * A picture of `size` inside the canvas: made smaller to fit where it is
 * larger, never larger, and centered, one pixel a user unit where it fits.
 */
const fitted = (size: DrawingSize, box: Box): Box => {
	const scale = Math.min(1, box.width / size.width, box.height / size.height);
	const width = size.width * scale;
	const height = size.height * scale;
	return {
		x: tidy(box.x + (box.width - width) / 2),
		y: tidy(box.y + (box.height - height) / 2),
		width: tidy(width),
		height: tidy(height),
	};
};

/**
 * The layer's name: a file's name without its extension, where the kit's
 * `extensionAt` says it starts (never at a leading dot). A blob pasted has none.
 */
const stemOf = (blob: Blob): string | undefined => {
	if (!(blob instanceof File)) return undefined;
	const name = blob.name.trim();
	const stem = name.slice(0, extensionAt(name)).trim();
	return stem === '' ? undefined : stem;
};

/**
 * The command that places `file` as a new raster layer above the layer
 * `above`, or on top of everything, fitted to the canvas and named after the
 * file: one step of the history, which undo takes away whole. `id` is the
 * new layer's, for the caller to make it the active one. `undefined` for a
 * file that is not a PNG, JPEG, GIF, WebP or SVG, or that cannot be read.
 *
 * Nothing is executed: the caller does that, at once, since the layer's id is
 * the one free when this was made.
 */
export const placePicture = async (
	document: EditorDocument,
	file: Blob,
	above: string | undefined
): Promise<(Command & Readonly<{ id: string }>) | undefined> => {
	const bytes = await file.arrayBuffer().then(
		(buffer) => new Uint8Array(buffer),
		() => undefined
	);
	if (bytes === undefined) return undefined;
	const picture = pictureOf(bytes, declaredType(file));
	if (picture === undefined) return undefined;
	const href = `data:${picture.type};base64,${base64Of(bytes)}`;
	const layer = addLayer(document.root, 'raster', above === undefined ? undefined : { above });
	const name = stemOf(file);
	const step = compound('exporting.place', [
		layer,
		replaceRasterImage(layer.id, 'exporting.place', {
			href,
			...fitted(picture.size, canvasBox(document)),
		}),
		...(name === undefined ? [] : [renameLayer(layer.id, name)]),
	]);
	// Not spread: `bytes` is a getter, worth nothing until the command has run.
	return {
		id: layer.id,
		label: step.label,
		apply: step.apply,
		revert: step.revert,
		get bytes() {
			return step.bytes;
		},
	};
};
