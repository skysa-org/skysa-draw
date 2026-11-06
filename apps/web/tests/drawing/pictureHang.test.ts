import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { encodePatience } from '../../src/drawing/pictures/index.js';
import type { PictureRequest } from '../../src/drawing/pictures/protocol.js';
import { surfaceFor } from '../../src/drawing/tools/raster/surface.js';
import type { ToolContext } from '../../src/drawing/tools/types.js';
import { fakeOf, installFakeCanvas, pictureAt, uninstallFakeCanvas } from './fakeCanvas.js';

/**
 * A raster layer's writes when the pictures worker stops answering
 * (`src/drawing/pictures/index.ts`, `src/drawing/tools/raster/surface.ts`):
 * the writes land in turn, so the encodings it holds must not hold every
 * stroke after them. Once they have waited past their patience, the worker
 * is dropped and they are encoded on the page's thread, in the order they
 * were asked for; a reply after that is not heard, and the next write goes
 * to a worker started afresh. Against a real document and its commands, the
 * compositing fake canvas (`fakeCanvas.ts`), and a fake worker: the first
 * one started says it listens and never answers, as one stuck would; any
 * after it answers each request at once.
 */

const FROM_WORKER = `data:image/png;base64,${btoa('from the worker')}`;

type Started = { posted: PictureRequest[]; terminated: number; target: EventTarget };

const started: Started[] = [];

/** `Worker`: says it listens; the first never answers, those after answer at once. */
class FakeWorker {
	constructor() {
		const target = new EventTarget();
		const answers = started.length > 0;
		const worker: Started = { posted: [], terminated: 0, target };
		started.push(worker);
		const say = (data: unknown): void => {
			queueMicrotask(() => target.dispatchEvent(new MessageEvent('message', { data })));
		};
		say({ ready: true });
		return Object.assign(target, {
			postMessage: (message: PictureRequest, transfer: readonly Transferable[]) => {
				worker.posted.push(message);
				// Transferred, as a real worker's are: the page's copy is left empty.
				transfer.forEach((bitmap) => {
					Object.assign(bitmap, { width: 0, height: 0 });
				});
				if (answers) say({ id: message.id, href: FROM_WORKER });
			},
			terminate: () => {
				worker.terminated += 1;
			},
		});
	}
}

/** `createImageBitmap` of a canvas: a copy of its pixels as they are now, on a canvas of its own. */
const snapshot = (source: HTMLCanvasElement): Promise<HTMLCanvasElement> => {
	const copy = document.createElement('canvas');
	copy.width = source.width;
	copy.height = source.height;
	fakeOf(copy).pixels().set(fakeOf(source).pixels());
	return Promise.resolve(
		Object.assign(copy, {
			close: () => {
				copy.width = 0;
				copy.height = 0;
			},
		})
	);
};

/** The canvas is 40 × 30; `layer-2` is an empty raster layer. */
const DRAWING = [
	'<?xml version="1.0" encoding="UTF-8"?>',
	`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="0f8fad5b-d9cb-469f-a165-70867728950e" viewBox="0 0 40 30" width="40" height="30">`,
	'  <g id="layer-2" draw:kind="raster" draw:name="Paint"/>',
	'</svg>',
	'',
].join('\n');

const open = () => {
	const opened = openDocument(DRAWING);
	if (opened === undefined) throw new Error('the drawing opens');
	const labels: string[] = [];
	const editor: EditorDocument = {
		...opened,
		get size() {
			return opened.size;
		},
		execute: (command) => {
			labels.push(command.label);
			opened.execute(command);
		},
	};
	const context = {
		document: editor,
		layer: editor.snapshot().layers.find((each) => each.id === 'layer-2'),
	} as ToolContext;
	const href = (): string | null | undefined =>
		Array.from(editor.layer('layer-2')?.children ?? [])
			.find((child) => child.localName === 'image')
			?.getAttribute('href');
	return { context, labels, href };
};

/** A painter of a 2 × 2 square of `color` at `x`, 0. */
const square =
	(color: string, x: number) =>
	(ctx: CanvasRenderingContext2D): boolean => {
		ctx.fillStyle = color;
		ctx.fillRect(x, 0, 2, 2);
		return true;
	};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	installFakeCanvas();
	vi.stubGlobal('Worker', FakeWorker);
	vi.stubGlobal('OffscreenCanvas', class {});
	vi.stubGlobal('createImageBitmap', snapshot);
});

afterEach(() => {
	vi.useRealTimers();
	uninstallFakeCanvas();
	started.length = 0;
});

describe('a raster layer’s writes, when the pictures worker stops answering', () => {
	it('land in order once it has been waited for, a late reply is not heard, and the next goes to a new worker', async () => {
		const { context, labels, href } = open();
		const surface = surfaceFor(context);
		if (surface === undefined) throw new Error('the layer has a surface');
		const one = surface.paint('one', square('#ff0000', 0));
		const two = surface.paint('two', square('#0000ff', 4));
		await vi.advanceTimersByTimeAsync(0);
		const [stuck] = started;
		expect(stuck?.posted.map((request) => request.kind)).toEqual(['encode', 'encode']);
		await vi.advanceTimersByTimeAsync(encodePatience(40 * 30) - 1);
		expect(labels).toEqual([]);
		// The encodings here wait on `toBlob`'s timer and a `FileReader`: let both run.
		await vi.waitFor(() => expect(labels).toEqual(['one', 'two']));
		await Promise.all([one, two]);
		expect(stuck?.terminated).toBe(1);
		// Encoded here, from the canvas as it is now: the snapshots went with the worker.
		expect(pictureAt(href(), 0, 0)).toEqual([255, 0, 0, 255]);
		expect(pictureAt(href(), 4, 0)).toEqual([0, 0, 255, 255]);
		const written = href();
		stuck?.target.dispatchEvent(
			new MessageEvent('message', { data: { id: 1, href: 'data:too-late' } })
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(labels).toEqual(['one', 'two']);
		expect(href()).toBe(written);
		const three = surface.paint('three', square('#00ff00', 8));
		await vi.waitFor(() => expect(labels).toHaveLength(3));
		await three;
		expect(started).toHaveLength(2);
		expect(started[1]?.posted.map((request) => request.kind)).toEqual(['encode']);
		expect(labels).toEqual(['one', 'two', 'three']);
		expect(href()).toBe(FROM_WORKER);
	});
});
