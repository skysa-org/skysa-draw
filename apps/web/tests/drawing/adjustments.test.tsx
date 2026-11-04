import { DRAWING_NAMESPACE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
	type Adjustment,
	adjustmentsOf,
	newAdjustment,
	setAdjustments,
} from '../../src/drawing/document/adjustments.js';
import { duplicateLayer } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { useDocumentSnapshot } from '../../src/drawing/document/useDocument.js';
import { PropertiesPanel } from '../../src/drawing/panels/PropertiesPanel.js';

/**
 * Adjustments (docs/decisions/0003-layers.md): SVG's own filter primitives
 * in a `<filter id="adjust-…">` the layer names, each carrying the app's
 * `draw:adjust` and its parameters, so the panel reads back what was set. A
 * change is one step to undo, a drag of a slider only a preview until it is
 * let go, and a filter from another tool is left alone.
 */

const DRAWING_ID = '11111111-2222-4333-8444-555555555555';

const open = (text = emptyDrawing({ id: DRAWING_ID })): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('a drawing opens');
	return document;
};

const layer = (document: EditorDocument, id = 'layer-1'): Element => {
	const found = document.layer(id);
	if (found === undefined) throw new Error(`${id} is there`);
	return found;
};

const set = (document: EditorDocument, list: readonly Adjustment[], id = 'layer-1') => {
	document.execute(setAdjustments(document.root, id, list, 'layers.adjustments.change'));
};

describe('adjustments in the file', () => {
	it('writes a filter of SVG primitives, each with its parameters, and reads them back', () => {
		const document = open();
		set(document, [
			{ kind: 'brightness', values: { amount: 20 } },
			{ kind: 'contrast', values: { amount: -10 } },
			{ kind: 'hue', values: { angle: 30 } },
			{ kind: 'shadow', values: { dx: 2, dy: 3, blur: 4, opacity: 50 } },
		]);
		const text = document.text();
		expect(text).toContain(
			'<filter id="adjust-layer-1" color-interpolation-filters="sRGB" x="-50%" y="-50%" width="200%" height="200%">'
		);
		expect(text).toContain(
			'<feComponentTransfer draw:adjust="brightness" draw:amount="20"><feFuncR type="linear" slope="1.2" intercept="0"/>'
		);
		expect(text).toContain('<feFuncG type="linear" slope="0.9" intercept="0.05"/>');
		expect(text).toContain(
			'<feColorMatrix draw:adjust="hue" draw:angle="30" type="hueRotate" values="30"/>'
		);
		expect(text).toContain(
			'<feDropShadow draw:adjust="shadow" draw:dx="2" draw:dy="3" draw:blur="4" draw:opacity="50" dx="2" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.5"/>'
		);
		expect(text).toContain(
			'<g id="layer-1" draw:kind="vector" filter="url(#adjust-layer-1)"/>'
		);

		// Through the sanitizer and back: the same adjustments.
		const again = open(text);
		expect(again.snapshot().layers[0]?.adjustments).toEqual({
			own: true,
			filterId: 'adjust-layer-1',
			list: [
				{ kind: 'brightness', values: { amount: 20 } },
				{ kind: 'contrast', values: { amount: -10 } },
				{ kind: 'hue', values: { angle: 30 } },
				{ kind: 'shadow', values: { dx: 2, dy: 3, blur: 4, opacity: 50 } },
			],
		});
	});

	it('writes the rest of the kinds as the CSS filter functions define them', () => {
		const document = open();
		set(document, [
			{ kind: 'saturation', values: { amount: 50 } },
			{ kind: 'blur', values: { radius: 2.5 } },
			{ kind: 'invert', values: { amount: 100 } },
			{ kind: 'grayscale', values: { amount: 25 } },
		]);
		const text = document.text();
		expect(text).toContain('type="saturate" values="1.5"');
		expect(text).toContain(
			'<feGaussianBlur draw:adjust="blur" draw:radius="2.5" stdDeviation="2.5"/>'
		);
		expect(text).toContain('<feFuncB type="table" tableValues="1 0"/>');
		expect(text).toContain(
			'draw:adjust="grayscale" draw:amount="25" type="saturate" values="0.75"'
		);
	});

	it('is one step to undo, back to the very bytes, and an empty list takes it all away', () => {
		const document = open();
		const original = document.text();
		set(document, [newAdjustment('blur')]);
		const blurred = document.text();
		set(document, [newAdjustment('blur'), newAdjustment('invert')]);
		expect(document.root.querySelectorAll('filter')).toHaveLength(1);
		set(document, []);
		expect(document.text()).not.toContain('filter');
		document.undo();
		document.undo();
		expect(document.text()).toBe(blurred);
		document.undo();
		expect(document.text()).toBe(original);
		expect(document.snapshot().dirty).toBe(false);
	});

	it('gives a duplicate that shares the filter one of its own when either changes', () => {
		const document = open();
		set(document, [newAdjustment('blur')]);
		document.execute(duplicateLayer(document.root, 'layer-1'));
		set(document, [newAdjustment('invert')], 'layer-2');
		expect(layer(document, 'layer-1').getAttribute('filter')).toBe('url(#adjust-layer-1)');
		expect(layer(document, 'layer-2').getAttribute('filter')).toBe('url(#adjust-layer-2)');
		expect(adjustmentsOf(document.root, layer(document))).toMatchObject({
			list: [{ kind: 'blur' }],
		});
	});

	it("leaves another tool's filter alone", () => {
		const text = `<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" viewBox="0 0 10 10"><defs><filter id="soft"><feGaussianBlur stdDeviation="1"/></filter></defs><g id="layer-1" filter="url(#soft)"/><g id="layer-2" style="filter:blur(2px)"/></svg>`;
		const document = open(text);
		expect(document.snapshot().layers.map((each) => each.adjustments)).toEqual([
			{ own: false },
			{ own: false },
		]);
		const command = setAdjustments(document.root, 'layer-1', [newAdjustment('blur')], 'x');
		document.execute(command);
		expect(command.bytes).toBe(0);
		expect(document.snapshot().dirty).toBe(false);
	});
});

/** The properties as the dock shows them, for the drawing's one layer. */
const Harness = ({ document }: Readonly<{ document: EditorDocument }>) => {
	const snapshot = useDocumentSnapshot(document);
	if (snapshot === undefined) return null;
	return <PropertiesPanel document={document} snapshot={snapshot} activeLayerId="layer-1" />;
};

const section = () => screen.getByRole('region', { name: 'Adjustments' });

describe('the adjustments panel', () => {
	it('adds an adjustment from its menu, as one step to undo', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		await user.click(within(section()).getByRole('button', { name: 'Add adjustment' }));
		await user.click(screen.getByRole('menuitem', { name: 'Drop shadow' }));
		await waitFor(() =>
			expect(screen.getByRole('slider', { name: 'Shadow offset across' })).toBeDefined()
		);
		expect(document.text()).toContain('draw:adjust="shadow"');
		document.undo();
		await waitFor(() =>
			expect(screen.queryByRole('slider', { name: 'Shadow blur' })).toBeNull()
		);
	});

	it('shows a drag live and makes it one change when it is let go', async () => {
		const document = open();
		set(document, [newAdjustment('brightness')]);
		render(<Harness document={document} />);
		const slider = screen.getByRole('slider', { name: 'Brightness' });
		const before = document.text();

		fireEvent.input(slider, { target: { value: '30' } });
		// Shown in the drawing, and not yet a change.
		expect(
			document.root
				.querySelector('feComponentTransfer')
				?.getAttributeNS(DRAWING_NAMESPACE, 'amount')
		).toBe('30');
		expect(document.text()).toBe(before);
		expect(slider.getAttribute('aria-valuetext')).toBe('30%');
		fireEvent.input(slider, { target: { value: '40' } });

		fireEvent.change(slider, { target: { value: '40' } });
		await waitFor(() => expect(document.text()).toContain('draw:amount="40"'));
		expect(document.text()).toContain('slope="1.4"');
		document.undo();
		expect(document.text()).toBe(before);
	});

	it('removes and reorders adjustments', async () => {
		const user = userEvent.setup();
		const document = open();
		set(document, [newAdjustment('blur'), newAdjustment('invert')]);
		render(<Harness document={document} />);
		await user.click(screen.getByRole('button', { name: 'Move Invert up' }));
		await waitFor(() =>
			expect(adjustmentsOf(document.root, layer(document))).toMatchObject({
				list: [{ kind: 'invert' }, { kind: 'blur' }],
			})
		);
		await user.click(screen.getByRole('button', { name: 'Remove Blur' }));
		await waitFor(() =>
			expect(adjustmentsOf(document.root, layer(document))).toMatchObject({
				list: [{ kind: 'invert' }],
			})
		);
	});

	it('names a filter from another tool, and offers nothing to change it with', () => {
		const document = open(
			`<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 10 10"><defs><filter id="soft"><feGaussianBlur stdDeviation="1"/></filter></defs><g id="layer-1" filter="url(#soft)"/></svg>`
		);
		render(<Harness document={document} />);
		expect(within(section()).getByText('Filter from another tool')).toBeDefined();
		expect(within(section()).queryByRole('button', { name: 'Add adjustment' })).toBeNull();
	});

	it('makes the layer opacity one change at the release, too', async () => {
		const document = open();
		render(<Harness document={document} />);
		const slider = screen.getByRole('slider', { name: 'Opacity' });
		fireEvent.input(slider, { target: { value: '0.3' } });
		expect(layer(document).getAttribute('opacity')).toBe('0.3');
		expect(document.snapshot().canUndo).toBe(false);
		fireEvent.input(slider, { target: { value: '0.6' } });
		fireEvent.change(slider, { target: { value: '0.6' } });
		await waitFor(() => expect(document.text()).toContain('opacity="0.6"'));
		document.undo();
		expect(document.snapshot().dirty).toBe(false);
	});
});
