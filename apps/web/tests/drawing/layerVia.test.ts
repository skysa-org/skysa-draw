import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { layerById, layersOf } from '../../src/drawing/document/layers.js';
import { layerViaElements } from '../../src/drawing/document/layerVia.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Region,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import { elementsOf } from '../../src/drawing/tools/vector/hit.js';
import {
	layerViaSelection,
	selectedBox,
	selectOtherElements,
} from '../../src/drawing/tools/vector/region.js';
import { createToolContext, NO_SELECTION } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';
import { t } from '../../src/i18n/t.js';

/**
 * Layer via copy and layer via cut on a vector layer
 * (docs/decisions/0004-the-interface.md, "The context menu"): the selected
 * elements in a new layer above theirs, in the same place, as one step that
 * undoes to the file's own bytes; and select inverse among a layer's
 * elements. Real documents, as the editor opens them.
 */

const GRADIENT = 'url(#sky)';

const DRAWING = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="d1" viewBox="0 0 100 80">
  <title>Harbor</title>
  <g id="layer-1" draw:kind="vector" draw:name="Boats" opacity="0.5" transform="translate(5 5)" style="mix-blend-mode:multiply">
    <defs><linearGradient id="sky"><stop offset="0"/></linearGradient></defs>
    <rect id="hull" width="10" height="10" fill="${GRADIENT}"/>
    <circle id="sun" cx="40" cy="20" r="3"/>
    <path d="M0 0 L5 5"/>
  </g>
  <g id="layer-2" draw:kind="vector">
    <use href="#hull"/>
  </g>
</svg>
`;

/** The same, as another tool wrote it: no kind, no app namespace, and Inkscape's name. */
const FOREIGN = `<svg xmlns="${SVG_NAMESPACE}" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 10 10">
  <g id="a" inkscape:label="Pictures">
    <rect width="1" height="1"/>
    <image href="data:image/png;base64,iVBORw0KGgo=" width="2" height="2"/>
  </g>
</svg>`;

const opened = (text = DRAWING): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('the test drawing opens');
	return document;
};

const layer = (document: EditorDocument, id: string): Element => {
	const found = layerById(document.root, id);
	if (found === undefined) throw new Error(`no ${id}`);
	return found;
};

/** What each layer draws: the local names of its elements, bottom to top. */
const drawn = (document: EditorDocument, id: string): readonly string[] =>
	elementsOf(layer(document, id)).map((element) => element.localName);

afterEach(() => {
	window.document.body.replaceChildren();
});

describe('layer via copy, on a vector layer', () => {
	it('puts the selected elements in a new layer just above, with the old one’s look, as one step', () => {
		const document = opened();
		const made = layerViaElements(document.root, 'layer-1', [0, 2], 'copy');
		document.execute(made);
		expect(made.id).toBe('layer-3');
		expect(layersOf(document.root).map((each) => each.id)).toEqual([
			'layer-1',
			'layer-3',
			'layer-2',
		]);
		expect(drawn(document, 'layer-1')).toEqual(['rect', 'circle', 'path']);
		expect(drawn(document, 'layer-3')).toEqual(['rect', 'path']);
		const copy = layer(document, 'layer-3');
		expect(copy.getAttribute('transform')).toBe('translate(5 5)');
		expect(copy.getAttribute('opacity')).toBe('0.5');
		expect(copy.getAttribute('style')).toBe('mix-blend-mode:multiply');
		// Its own name is its number, as a new layer's is.
		expect(copy.getAttributeNS(DRAWING_NAMESPACE, 'name')).toBeNull();
		expect(layersOf(document.root)[1]?.name).toBeUndefined();
		// What is copied has ids of its own, its gradient with it.
		const rect = copy.querySelector('rect');
		expect(rect?.getAttribute('id')).toBe('hull-copy');
		expect(rect?.getAttribute('fill')).toBe('url(#sky-copy)');
		expect(copy.querySelector('linearGradient')?.getAttribute('id')).toBe('sky-copy');
		expect(document.snapshot().canUndo).toBe(true);
	});

	it('undoes to the file’s own bytes, and redoes to the same', () => {
		const document = opened();
		document.execute(layerViaElements(document.root, 'layer-1', [1], 'copy'));
		const done = document.text();
		expect(done).not.toBe(DRAWING);
		expect(done).toContain('<circle id="sun-copy" cx="40" cy="20" r="3"/>\n  </g>');
		document.undo();
		expect(document.text()).toBe(DRAWING);
		document.redo();
		expect(document.text()).toBe(done);
	});

	it('says the new layer is vector, so a copy left holding one picture is not read as raster', () => {
		const document = opened(FOREIGN);
		document.execute(layerViaElements(document.root, 'a', [1], 'copy'));
		const [, copy] = layersOf(document.root);
		expect(copy?.kind).toBe('vector');
		expect(copy?.name).toBeUndefined();
		expect(layersOf(document.root)[0]?.name).toBe('Pictures');
		document.undo();
		expect(document.text()).toBe(FOREIGN);
	});
});

describe('layer via cut, on a vector layer', () => {
	it('moves the selected elements up into the new layer, ids and all, as one step', () => {
		const document = opened();
		const made = layerViaElements(document.root, 'layer-1', [0], 'cut');
		document.execute(made);
		expect(drawn(document, 'layer-1')).toEqual(['circle', 'path']);
		expect(drawn(document, made.id)).toEqual(['rect']);
		const rect = layer(document, made.id).querySelector('rect');
		// Moved, not copied: the other layer's `<use>` still finds it.
		expect(rect?.getAttribute('id')).toBe('hull');
		expect(rect?.getAttribute('fill')).toBe('url(#sky-copy)');
		expect(document.root.querySelectorAll('[id="hull"]')).toHaveLength(1);
		// What stays keeps its gradient, and the old layer its name.
		expect(layer(document, 'layer-1').querySelector('linearGradient')?.id).toBe('sky');
		expect(layersOf(document.root)[0]?.name).toBe('Boats');
	});

	it('undoes to the file’s own bytes in one step, and redoes to the same', () => {
		const document = opened();
		document.execute(layerViaElements(document.root, 'layer-1', [0, 1], 'cut'));
		const done = document.text();
		document.undo();
		expect(document.text()).toBe(DRAWING);
		expect(document.snapshot().canUndo).toBe(false);
		document.redo();
		expect(document.text()).toBe(done);
		document.undo();
		expect(document.text()).toBe(DRAWING);
	});

	it('names itself for the undo history', () => {
		const document = opened();
		expect(layerViaElements(document.root, 'layer-1', [0], 'cut').label).toBe(
			'selection.history.layerViaCut'
		);
		expect(t('selection.history.layerViaCopy')).toBe('Layer via copy');
	});

	it('costs nothing, and is not recorded, where the layer is gone', () => {
		const document = opened();
		const command = layerViaElements(document.root, 'layer-9', [0], 'cut');
		document.execute(command);
		expect(command.bytes).toBe(0);
		expect(document.text()).toBe(DRAWING);
	});
});

/** A context over a real document, as the viewport gives one, on `layerId`. */
const contextFor = (document: EditorDocument, layerId: string) => {
	window.document.body.appendChild(document.root);
	const overlay = window.document.createElementNS(SVG_NAMESPACE, 'svg');
	const selection = observable<readonly Element[]>(NO_SELECTION);
	const notify = vi.fn<(message: string) => void>();
	const context: ToolContext = createToolContext({
		document,
		layer: document.snapshot().layers.find((each) => each.id === layerId),
		options: DEFAULT_TOOL_OPTIONS,
		overlay,
		canvas: window.document.createElement('canvas'),
		pixelRatio: () => 1,
		view: observable(IDENTITY_VIEW),
		selection,
		region: observable<Region | undefined>(undefined),
		host: window.document.createElement('div'),
		fit: () => undefined,
		actualSize: () => undefined,
		setColor: () => undefined,
		notify,
	});
	return { context, selection, overlay, notify };
};

describe('the selection’s actions on a vector layer', () => {
	it('select inverse selects the layer’s other elements, and shows them', () => {
		const document = opened();
		const { context, selection, overlay } = contextFor(document, 'layer-1');
		const [rect, circle, path] = elementsOf(layer(document, 'layer-1'));
		context.selection.set([circle as Element]);
		expect(selectOtherElements(context, false)).toBe(true);
		expect(selection.get()).toEqual([rect, path]);
		expect(overlay.querySelectorAll('[data-draw-region-outline] rect')).toHaveLength(2);
		selectOtherElements(context, true);
		expect(selection.get()).toEqual([circle]);
		expect(overlay.querySelector('[data-draw-selection]')).not.toBeNull();
	});

	it('finds the box around what is selected, out in the drawing’s units', () => {
		const document = opened();
		const { context } = contextFor(document, 'layer-1');
		expect(selectedBox(context)).toBeUndefined();
		const [rect] = elementsOf(layer(document, 'layer-1'));
		context.selection.set([rect as Element]);
		// jsdom measures nothing, so the box is the layer's translation alone.
		expect(selectedBox(context)).toMatchObject({ x: 5, y: 5 });
	});

	it('layer via cut moves the selection to a new layer, lets go of it, and says the layer', () => {
		const document = opened();
		const { context, selection } = contextFor(document, 'layer-1');
		const [, circle] = elementsOf(layer(document, 'layer-1'));
		context.selection.set([circle as Element]);
		expect(layerViaSelection(context, 'cut')).toBe('layer-3');
		expect(selection.get()).toEqual([]);
		expect(drawn(document, 'layer-1')).toEqual(['rect', 'path']);
		expect(drawn(document, 'layer-3')).toEqual(['circle']);
	});

	it('says why it does nothing on a locked layer, and makes nothing with nothing selected', () => {
		const locked = opened(
			DRAWING.replace('draw:name="Boats"', 'draw:name="Boats" draw:locked="true"')
		);
		const { context, notify } = contextFor(locked, 'layer-1');
		expect(layerViaSelection(context, 'copy')).toBeUndefined();
		const [rect] = elementsOf(layer(locked, 'layer-1'));
		context.selection.set([rect as Element]);
		expect(layerViaSelection(context, 'copy')).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(t('layers.locked', { name: 'Boats' }));
		expect(layersOf(locked.root)).toHaveLength(2);
	});
});
