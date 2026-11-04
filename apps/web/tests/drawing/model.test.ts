import { DRAWING_NAMESPACE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { addLayer, moveLayer, renameLayer } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { useDocumentSnapshot } from '../../src/drawing/document/useDocument.js';
import { drawingFixture } from '../fixtures/drawing/fixtures.js';

/**
 * The editor's document (docs/ARCHITECTURE.md §7, "The editor"): what opens,
 * what a file from elsewhere has for layers (§3, "Layers"), and the rule that
 * the text is the opened string until a command runs, and again once every
 * command is undone, so a drawing opened and closed is the same bytes.
 */

const ID = '11111111-2222-4333-8444-555555555555';

const opened = (text: string): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('the drawing opens');
	return document;
};

const svg = (body: string, attributes = ''): string =>
	`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" ${attributes}>${body}</svg>`;

describe('a new drawing, opened', () => {
	it('is the same text, with one vector layer, at the default size, and not dirty', () => {
		const text = emptyDrawing({ id: ID });
		const document = opened(text);
		expect(document.text()).toBe(text);
		expect(document.prolog).toBe('<?xml version="1.0" encoding="UTF-8"?>\n');
		expect(document.size).toEqual({ width: 1600, height: 1000 });
		const snapshot = document.snapshot();
		expect(snapshot.layers).toEqual([
			{
				id: 'layer-1',
				kind: 'vector',
				name: undefined,
				hidden: false,
				locked: false,
				opacity: 1,
				blend: 'normal',
				depth: 0,
				parentId: undefined,
				loose: false,
			},
		]);
		expect(snapshot.size).toEqual({ width: 1600, height: 1000 });
		expect(snapshot).toMatchObject({
			canUndo: false,
			canRedo: false,
			dirty: false,
			version: 0,
		});
		expect(document.layer('layer-1')?.localName).toBe('g');
	});

	it('is written out after a command, prolog first, and dirty', () => {
		const text = emptyDrawing({ id: ID, title: 'Harbor' });
		const document = opened(text);
		const command = addLayer(document.root, 'vector');
		document.execute(command);

		const written = document.text();
		expect(written).not.toBe(text);
		expect(written.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg ')).toBe(true);
		expect(written.endsWith('</svg>\n')).toBe(true);
		expect(written).toContain('<title>Harbor</title>');
		expect(written).toContain('<g id="layer-2" draw:kind="vector"/>');
		expect(document.snapshot()).toMatchObject({ dirty: true, canUndo: true, version: 1 });
		expect(document.snapshot().layers.map((layer) => layer.id)).toEqual(['layer-1', 'layer-2']);
	});

	it('is the opened string again once every command is undone, and the written one on redo', () => {
		const text = emptyDrawing({ id: ID });
		const document = opened(text);
		document.execute(addLayer(document.root, 'raster'));
		document.execute(renameLayer('layer-2', 'Photo'));
		const written = document.text();

		document.undo();
		document.undo();
		expect(document.text()).toBe(text);
		expect(document.snapshot()).toMatchObject({ dirty: false, canUndo: false, canRedo: true });

		document.redo();
		document.redo();
		expect(document.text()).toBe(written);
		expect(document.snapshot()).toMatchObject({ dirty: true, canRedo: false, version: 6 });
		expect(document.snapshot().layers[1]).toMatchObject({ kind: 'raster', name: 'Photo' });
	});

	it('does not record a command that found nothing to do', () => {
		const text = emptyDrawing({ id: ID });
		const document = opened(text);
		const listener = vi.fn();
		document.subscribe(listener);
		document.execute(moveLayer('layer-1', 'up'));
		expect(listener).not.toHaveBeenCalled();
		expect(document.snapshot()).toMatchObject({ dirty: false, canUndo: false, version: 0 });
		expect(document.text()).toBe(text);
	});

	it('tells its listeners of every change, until they stop listening', () => {
		const document = opened(emptyDrawing({ id: ID }));
		const listener = vi.fn();
		const stop = document.subscribe(listener);
		document.execute(addLayer(document.root, 'vector'));
		document.undo();
		document.redo();
		expect(listener).toHaveBeenCalledTimes(3);
		stop();
		document.undo();
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it('gives the same snapshot until something changes', () => {
		const document = opened(emptyDrawing({ id: ID }));
		const first = document.snapshot();
		expect(document.snapshot()).toBe(first);
		document.execute(addLayer(document.root, 'vector'));
		const second = document.snapshot();
		expect(second).not.toBe(first);
		expect(document.snapshot()).toBe(second);
	});
});

describe('a drawing from elsewhere', () => {
	it('has Inkscape’s layers, by their labels, with what SVG says of them', () => {
		const document = opened(drawingFixture('inkscape.svg'));
		expect(document.size).toEqual({ width: 210, height: 297 });
		expect(document.snapshot().layers).toEqual([
			expect.objectContaining({ id: 'layer1', name: 'Sky', kind: 'vector', hidden: false }),
			expect.objectContaining({
				id: 'layer2',
				name: 'Boats',
				kind: 'vector',
				opacity: 0.8,
				blend: 'multiply',
			}),
			expect.objectContaining({ id: 'layer3', name: 'Photo', kind: 'raster', hidden: true }),
		]);
	});

	it('keeps Inkscape’s prolog and an unprefixed root through an edit, and opens again', () => {
		const text = drawingFixture('inkscape.svg');
		const document = opened(text);
		document.execute(renameLayer('layer1', 'Clouds'));
		const written = document.text();
		expect(
			written.startsWith(
				'<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!-- Created with Inkscape (http://www.inkscape.org/) -->\n\n<svg '
			)
		).toBe(true);
		expect(written.endsWith('</svg>\n')).toBe(true);
		expect(written).toContain('sodipodi:namedview');
		expect(written).toContain('inkscape:label="Sky"');
		const again = opened(written);
		expect(again.snapshot().layers.map((layer) => layer.name)).toEqual([
			'Clouds',
			'Boats',
			'Photo',
		]);
		expect(again.text()).toBe(written);
	});

	it('has a graphics element loose at the root as a vector layer of its own', () => {
		const document = opened(
			svg(
				'<title>Logo</title><defs/><rect width="1" height="1"/><path id="Layer_1" d="M0 0"/>'
			)
		);
		expect(document.snapshot().layers).toEqual([
			expect.objectContaining({ id: 'layer-1', kind: 'vector', loose: true, depth: 0 }),
			expect.objectContaining({ id: 'Layer_1', kind: 'vector', loose: true, depth: 0 }),
		]);
	});

	it('has a group whose only drawing child is one image as a raster layer', () => {
		const document = opened(
			svg(
				'<g id="a"><title>Photo</title><image href="p.png" width="1" height="1"/></g>' +
					'<g id="b"><image href="p.png" width="1" height="1"/><rect width="1" height="1"/></g>'
			)
		);
		expect(document.snapshot().layers.map((layer) => [layer.id, layer.kind])).toEqual([
			['a', 'raster'],
			['b', 'vector'],
		]);
	});

	it('lists a group’s layers after it, one deeper, and no nested <g> that is not a group', () => {
		const document = opened(
			svg(
				'<g id="folder" draw:kind="group"><g id="inside"/><path id="line" d="M0 0"/></g>' +
					'<g id="plain"><g id="shape"/></g>'
			)
		);
		expect(
			document
				.snapshot()
				.layers.map(({ id, kind, depth, parentId }) => ({ id, kind, depth, parentId }))
		).toEqual([
			{ id: 'folder', kind: 'group', depth: 0, parentId: undefined },
			{ id: 'inside', kind: 'vector', depth: 1, parentId: 'folder' },
			{ id: 'line', kind: 'vector', depth: 1, parentId: 'folder' },
			{ id: 'plain', kind: 'vector', depth: 0, parentId: undefined },
		]);
	});

	it('gives a layer with no id, or one an earlier layer has, a layer-n id, in the DOM only', () => {
		const text = svg('<g id="layer-1"/><g/><g id="dup"/><g id="dup"/><path d="M0 0"/>');
		const document = opened(text);
		expect(document.snapshot().layers.map((layer) => layer.id)).toEqual([
			'layer-1',
			'layer-2',
			'dup',
			'layer-3',
			'layer-4',
		]);
		expect(document.text()).toBe(text);
	});

	it('is sanitized before anything sees it, while its text stays as it was', () => {
		const text = svg('<script>alert(1)</script><g id="a" onclick="alert(2)"/>');
		const document = opened(text);
		expect(document.root.getElementsByTagNameNS(SVG_NAMESPACE, 'script')).toHaveLength(0);
		expect(document.layer('a')?.hasAttribute('onclick')).toBe(false);
		expect(document.text()).toBe(text);
		document.execute(renameLayer('a', 'Named'));
		expect(document.text()).not.toContain('alert');
	});

	it('reads its size from the root, or takes the default', () => {
		expect(opened(svg('<g/>', 'width="300" height="200"')).size).toEqual({
			width: 300,
			height: 200,
		});
		expect(opened(svg('<g/>', 'width="10cm"')).size).toEqual({ width: 1600, height: 1000 });
	});
});

describe('text that will not open', () => {
	it.each([
		['not well-formed', `<svg xmlns="${SVG_NAMESPACE}"><g></svg>`],
		['not an SVG', '<html xmlns="http://www.w3.org/1999/xhtml"/>'],
		['an svg in no namespace', '<svg><g/></svg>'],
		[
			'a root with a prefix the sanitizer will not work on in place',
			`<s:svg xmlns:s="${SVG_NAMESPACE}"><s:g/></s:svg>`,
		],
	])('is undefined: %s', (_label, text) => {
		expect(openDocument(text)).toBeUndefined();
	});
});

describe('pending work', () => {
	it('settles once every piece of it has, including work started meanwhile', async () => {
		const document = opened(emptyDrawing({ id: ID }));
		const order: string[] = [];
		const late = Promise.withResolvers<void>();
		const first = Promise.withResolvers<void>();
		document.pending(
			first.promise.then(() => {
				order.push('first');
				document.pending(late.promise.then(() => order.push('late')));
			})
		);
		const settled = document.settle().then(() => order.push('settled'));

		first.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(['first']);
		late.resolve();
		await settled;
		expect(order).toEqual(['first', 'late', 'settled']);
	});

	it('settles when a piece of it fails, and at once when there is none', async () => {
		const document = opened(emptyDrawing({ id: ID }));
		await expect(document.settle()).resolves.toBeUndefined();
		const failing = Promise.reject(new Error('the encoding failed'));
		failing.catch(() => undefined);
		document.pending(failing);
		await expect(document.settle()).resolves.toBeUndefined();
	});
});

describe('useDocumentSnapshot', () => {
	it('re-renders with the new snapshot on every change, and is undefined with no document', () => {
		const document = opened(emptyDrawing({ id: ID }));
		const initialProps: { current: EditorDocument | undefined } = { current: document };
		const { result, rerender } = renderHook(
			({ current }: { current: EditorDocument | undefined }) => useDocumentSnapshot(current),
			{ initialProps }
		);
		expect(result.current?.version).toBe(0);
		act(() => {
			document.execute(addLayer(document.root, 'group'));
		});
		expect(result.current?.version).toBe(1);
		expect(result.current?.layers.at(-1)?.kind).toBe('group');
		rerender({ current: undefined });
		expect(result.current).toBeUndefined();
	});
});
