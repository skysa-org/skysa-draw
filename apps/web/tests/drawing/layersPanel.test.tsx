import { BLEND_MODES, emptyDrawing } from '@skysa/draw-core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { useDocumentSnapshot } from '../../src/drawing/document/useDocument.js';
import { activeLayerIn } from '../../src/drawing/editorState.js';
import { blendKey } from '../../src/drawing/panels/blendKey.js';
import { LayersPanel } from '../../src/drawing/panels/LayersPanel.js';
import { t } from '../../src/i18n/t.js';

/**
 * The layers panel over a real document (docs/ARCHITECTURE.md §3, "Layers"):
 * what each control writes into the SVG, read back from `document.text()`.
 * A new drawing has one vector layer, `layer-1`, to draw on.
 */

const DRAWING_ID = '11111111-2222-4333-8444-555555555555';

const open = (text = emptyDrawing({ id: DRAWING_ID })): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('a drawing opens');
	return document;
};

/** The panel as the frame holds it: the snapshot from the document, the active layer resolved against it. */
const Harness = ({
	document,
	onActivate = () => undefined,
	onNotify = () => undefined,
}: Readonly<{
	document: EditorDocument;
	onActivate?: (id: string) => void;
	onNotify?: (message: string) => void;
}>) => {
	const snapshot = useDocumentSnapshot(document);
	const [chosen, setChosen] = useState<string | undefined>(undefined);
	if (snapshot === undefined) return null;
	return (
		<LayersPanel
			document={document}
			snapshot={snapshot}
			activeLayerId={activeLayerIn(snapshot.layers, chosen)}
			onActivate={(id) => {
				setChosen(id);
				onActivate(id);
			}}
			withProperties
			onNotify={onNotify}
		/>
	);
};

const list = () => screen.getByRole('list', { name: 'Layers' });

/** The rows' names, top first, as the panel shows them. */
const rows = () =>
	within(list())
		.getAllByRole('listitem')
		.map((row) => row.textContent);

/** The button that is the layer itself, in its row. */
const pick = (name: string | RegExp) => within(list()).getByRole('button', { name });

const add = async (user: ReturnType<typeof userEvent.setup>, name = 'New layer') => {
	await user.click(screen.getByRole('button', { name }));
};

describe('the layers panel', () => {
	it("shows a new drawing's one layer, active", () => {
		render(<Harness document={open()} />);
		expect(rows()).toEqual(['Layer 1']);
		expect(pick('Layer 1').getAttribute('aria-current')).toBe('true');
	});

	it('adds a vector layer above the active one, and activates it', async () => {
		const user = userEvent.setup();
		const document = open();
		const onActivate = vi.fn();
		render(<Harness document={document} onActivate={onActivate} />);

		await add(user);

		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
		expect(onActivate).toHaveBeenCalledWith('layer-2');
		expect(pick('Layer 2').getAttribute('aria-current')).toBe('true');
		expect(document.text()).toContain('id="layer-2"');
		expect(document.text().match(/draw:kind="vector"/g)).toHaveLength(2);
	});

	it('adds a raster layer above the active one', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);

		await add(user, 'New raster layer');

		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
		expect(document.text()).toContain('draw:kind="raster"');
	});

	it('duplicates the active layer above it, and activates the copy', async () => {
		const user = userEvent.setup();
		const document = open();
		const onActivate = vi.fn();
		render(<Harness document={document} onActivate={onActivate} />);

		await user.click(screen.getByRole('button', { name: 'Duplicate layer' }));

		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(onActivate).toHaveBeenCalledWith('layer-2');
		expect(document.text()).toContain('id="layer-2"');
	});

	it('renames a layer from its row, into draw:name, and gives the focus back to the row', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);

		await user.dblClick(pick('Layer 1'));
		const field = within(list()).getByRole('textbox', { name: 'Name' });
		expect(window.document.activeElement).toBe(field);
		await user.type(field, 'Sky{Enter}');

		expect(document.text()).toContain('draw:name="Sky"');
		await waitFor(() => expect(rows()).toEqual(['Sky']));
		expect(window.document.activeElement).toBe(pick('Sky'));
	});

	it('renames with F2, and Escape leaves the name as it was', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);

		fireEvent.keyDown(pick('Layer 1'), { key: 'F2' });
		const field = await within(list()).findByRole('textbox', { name: 'Name' });
		await user.type(field, 'Sea{Escape}');

		expect(document.text()).not.toContain('draw:name');
		expect(rows()).toEqual(['Layer 1']);
	});

	it('renames from the field under the list too', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		const properties = screen
			.getAllByRole('textbox', { name: 'Name' })
			.find((field) => !list().contains(field));
		if (properties === undefined) throw new Error('a name field under the list');

		await user.type(properties, 'Ground{Enter}');

		expect(document.text()).toContain('draw:name="Ground"');
		await waitFor(() => expect(rows()).toEqual(['Ground']));
	});

	it('hides and shows a layer with display="none"', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);

		await user.click(screen.getByRole('button', { name: 'Hide layer' }));
		expect(document.text()).toContain('display="none"');

		await user.click(await screen.findByRole('button', { name: 'Show layer' }));
		expect(document.text()).not.toContain('display="none"');
	});

	it('locks a layer with draw:locked', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);

		await user.click(screen.getByRole('button', { name: 'Lock layer' }));
		expect(document.text()).toContain('draw:locked="true"');
		expect(await screen.findByRole('button', { name: 'Unlock layer' })).toBeDefined();
	});

	it('writes opacity as the opacity attribute, and the blend mode into style', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);

		fireEvent.change(screen.getByRole('slider', { name: 'Opacity' }), {
			target: { value: '0.5' },
		});
		expect(document.text()).toContain('opacity="0.5"');

		await user.selectOptions(screen.getByRole('combobox', { name: 'Blend mode' }), 'multiply');
		expect(document.text()).toMatch(/mix-blend-mode:\s*multiply/);
	});

	it('deletes the active layer, which undo brings back', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);

		await user.click(screen.getByRole('button', { name: 'Delete layer' }));

		await waitFor(() => expect(within(list()).queryAllByRole('listitem')).toHaveLength(0));
		expect(document.text()).not.toContain('layer-1');
		expect(screen.getByRole('button', { name: 'Duplicate layer' })).toHaveProperty(
			'disabled',
			true
		);

		act(() => document.undo());
		await waitFor(() => expect(rows()).toEqual(['Layer 1']));
	});

	it('moves the active layer down and up, which reorders the document', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		await add(user);
		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
		// The top layer is active: it can only go down.
		expect(screen.getByRole('button', { name: 'Move up' })).toHaveProperty('disabled', true);

		await user.click(screen.getByRole('button', { name: 'Move down' }));
		await waitFor(() => expect(rows()).toEqual(['Layer 1', 'Layer 2']));
		const text = document.text();
		expect(text.indexOf('id="layer-2"')).toBeLessThan(text.indexOf('id="layer-1"'));
		expect(screen.getByRole('button', { name: 'Move down' })).toHaveProperty('disabled', true);

		await user.click(screen.getByRole('button', { name: 'Move up' }));
		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
	});

	it('activates a row on click, and walks the rows as shown with the arrow keys', async () => {
		const user = userEvent.setup();
		const document = open();
		const onActivate = vi.fn();
		render(<Harness document={document} onActivate={onActivate} />);
		await add(user);
		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));

		await user.click(pick('Layer 1'));
		expect(onActivate).toHaveBeenLastCalledWith('layer-1');

		fireEvent.keyDown(pick('Layer 1'), { key: 'ArrowUp' });
		expect(onActivate).toHaveBeenLastCalledWith('layer-2');
		expect(window.document.activeElement).toBe(pick('Layer 2'));

		fireEvent.keyDown(pick('Layer 2'), { key: 'ArrowDown' });
		expect(onActivate).toHaveBeenLastCalledWith('layer-1');
	});

	it('deletes the focused row with Delete', async () => {
		const document = open();
		render(<Harness document={document} />);

		fireEvent.keyDown(pick('Layer 1'), { key: 'Delete' });

		await waitFor(() => expect(within(list()).queryAllByRole('listitem')).toHaveLength(0));
	});

	it('shows a group above the layers it holds, as a folder', () => {
		const text = emptyDrawing({ id: DRAWING_ID }).replace(
			/<g id="layer-1"[^>]*\/>/,
			'<g id="layer-1" draw:kind="group"><g id="layer-2" draw:kind="vector"/></g><g id="layer-3" draw:kind="vector"/>'
		);
		render(<Harness document={open(text)} />);
		expect(rows()).toEqual(['Layer 3', 'Layer 1', 'Layer 2']);
	});
});

describe('the layer actions menu', () => {
	const choose = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
		await user.click(screen.getByRole('button', { name: 'Layer actions' }));
		await user.click(await screen.findByRole('menuitem', { name }));
	};

	const item = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
		await user.click(screen.getByRole('button', { name: 'Layer actions' }));
		const found = await screen.findByRole('menuitem', { name });
		await user.keyboard('{Escape}');
		return found;
	};

	it('groups the active layer and ungroups it again', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		expect((await item(user, 'Ungroup')).getAttribute('aria-disabled')).toBe('true');

		await choose(user, 'Group layer');
		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
		expect(pick('Layer 2').getAttribute('aria-current')).toBe('true');
		expect(document.text()).toMatch(/<g id="layer-2" draw:kind="group"><g id="layer-1"/);

		await choose(user, 'Ungroup');
		await waitFor(() => expect(rows()).toEqual(['Layer 1']));
		expect(pick('Layer 1').getAttribute('aria-current')).toBe('true');
	});

	it('merges the active layer down, which is not offered at the bottom', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		expect((await item(user, 'Merge down')).getAttribute('aria-disabled')).toBe('true');

		await add(user);
		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
		await choose(user, 'Merge down');
		await waitFor(() => expect(rows()).toEqual(['Layer 1']));
		document.undo();
		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
	});

	it('clips the active layer to the one below, marks it, and releases it', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		await add(user);
		await choose(user, 'Clip to layer below');
		await waitFor(() =>
			expect(pick(/Layer 2/).textContent).toBe('↳Layer 2Clipped to the layer below')
		);
		expect(document.text()).toContain('mask="url(#clip-layer-2)"');

		await choose(user, 'Release clip');
		await waitFor(() => expect(pick(/Layer 2/).textContent).toBe('Layer 2'));
		expect(document.text()).not.toContain('<mask');
	});

	it('says why a merge of a hidden layer, or a rasterize the browser cannot draw, did nothing', async () => {
		const user = userEvent.setup();
		const document = open();
		const onNotify = vi.fn();
		render(<Harness document={document} onNotify={onNotify} />);
		await add(user);
		await user.click(screen.getAllByRole('button', { name: 'Hide layer' })[0] as HTMLElement);
		await choose(user, 'Merge down');
		expect(onNotify).toHaveBeenLastCalledWith(
			'Hidden layers cannot be merged. Show both layers first.'
		);

		// jsdom draws nothing on a canvas.
		await choose(user, 'Rasterize layer');
		await waitFor(() =>
			expect(onNotify).toHaveBeenLastCalledWith(
				'This browser could not draw the layer as pixels, so nothing was changed.'
			)
		);
		expect(rows()).toEqual(['Layer 2', 'Layer 1']);
	});
});

describe('blendKey', () => {
	it.each(BLEND_MODES)('names a message the catalog has for %s', (mode) => {
		const key = blendKey(mode);
		expect(key.startsWith('layers.blendModes.')).toBe(true);
		// `t` answers a key it has no message for with the key itself.
		expect(t(key)).not.toBe(key);
	});
});
