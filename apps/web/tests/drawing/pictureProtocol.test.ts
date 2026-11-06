import { describe, expect, it } from 'vitest';

import {
	base64TypeOf,
	decodesInWorker,
	isPictureRequest,
	pictureBytes,
	shrunkSize,
} from '../../src/drawing/pictures/protocol.js';

/**
 * How the page and the pictures worker read a picture
 * (`src/drawing/pictures/protocol.ts`): a `data:` URL of base64, its media
 * type and its bytes, read without a fetch; anything else refused, for the
 * page to decode on its own thread.
 */

const bytesOf = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

describe('a data: URL of base64', () => {
	it('gives its media type, lowercased and without its parameters', () => {
		expect(base64TypeOf('data:image/png;base64,AAAA')).toBe('image/png');
		expect(base64TypeOf('DATA:Image/JPEG;BASE64,AAAA')).toBe('image/jpeg');
		expect(base64TypeOf('data:image/png;name=photo.png;base64,AAAA')).toBe('image/png');
		expect(base64TypeOf('data:;base64,AAAA')).toBe('');
	});

	it('gives nothing for a URL that is not one', () => {
		expect(base64TypeOf('data:image/svg+xml,%3Csvg%2F%3E')).toBeUndefined();
		expect(base64TypeOf('data:image/png;base64')).toBeUndefined();
		expect(base64TypeOf('data:image/png;base64x,AAAA')).toBeUndefined();
		expect(base64TypeOf('blob:https://example.test/1')).toBeUndefined();
		expect(base64TypeOf('https://example.test/data:image/png;base64,AAAA')).toBeUndefined();
		expect(base64TypeOf('')).toBeUndefined();
	});

	it('reads into its bytes, whitespace and all, and its type with them', () => {
		const text = 'PNG\u0000ÿ\u0080 bytes';
		const picture = pictureBytes(`data:image/png;base64,${btoa(text)}`);
		expect(picture?.type).toBe('image/png');
		expect([...(picture?.bytes ?? [])]).toEqual(bytesOf(text));
		const wrapped = btoa(text).replace(/(.{4})/g, '$1\n');
		expect([...(pictureBytes(`data:image/png;base64,${wrapped}`)?.bytes ?? [])]).toEqual(
			bytesOf(text)
		);
	});

	it('reads nothing where the data is not base64, or the URL not one', () => {
		expect(pictureBytes('data:image/png;base64,not*base64!')).toBeUndefined();
		expect(pictureBytes('data:image/png;base64,AA%3D%3D')).toBeUndefined();
		expect(pictureBytes('data:image/png,PNG')).toBeUndefined();
		expect(pictureBytes('https://example.test/photo.png')).toBeUndefined();
	});
});

describe('a picture the worker decodes', () => {
	it('is any picture in a data: URL of base64 but an SVG', () => {
		expect(decodesInWorker('data:image/png;base64,AAAA')).toBe(true);
		expect(decodesInWorker('data:image/webp;base64,AAAA')).toBe(true);
		expect(decodesInWorker('data:;base64,AAAA')).toBe(true);
		expect(decodesInWorker('data:image/svg+xml;base64,AAAA')).toBe(false);
		expect(decodesInWorker('data:IMAGE/SVG+XML;charset=utf-8;base64,AAAA')).toBe(false);
		expect(decodesInWorker('data:image/svg+xml,%3Csvg%2F%3E')).toBe(false);
		expect(decodesInWorker('https://example.test/photo.png')).toBe(false);
	});
});

describe('a request', () => {
	it('is told from anything else that reaches the worker', () => {
		expect(isPictureRequest({ id: 1, kind: 'shrink', href: 'data:,', most: 4 })).toBe(true);
		expect(isPictureRequest({ id: 2, kind: 'encode', bitmap: {} })).toBe(true);
		expect(isPictureRequest({ ready: true })).toBe(false);
		expect(isPictureRequest({ id: 3, href: 'data:,' })).toBe(false);
		expect(isPictureRequest({ id: 4, kind: 'fill' })).toBe(false);
		expect(isPictureRequest(null)).toBe(false);
		expect(isPictureRequest('shrink')).toBe(false);
	});
});

describe('a stand-in’s size', () => {
	it('is held to the most on its longer side, at its own aspect, a pixel at least', () => {
		expect(shrunkSize(4000, 3000, 256)).toEqual({ width: 256, height: 192 });
		expect(shrunkSize(3000, 4000, 256)).toEqual({ width: 192, height: 256 });
		expect(shrunkSize(10_000, 3, 256)).toEqual({ width: 256, height: 1 });
	});
});
