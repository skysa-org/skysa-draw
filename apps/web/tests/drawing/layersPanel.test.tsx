import { BLEND_MODES, emptyDrawing } from '@skysa/draw-core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { useDocumentSnapshot } from '../../src/drawing/document/useDocument.js';
import {
	activeLayerIn,
	editorReducer,
	initialEditorState,
	selectedLayersIn,
} from '../../src/drawing/editorState.js';
import type { LayerSelection } from '../../src/drawing/layerSelection.js';
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

/**
 * The panel as the frame holds it (`Editor.tsx`): the snapshot from the
 * document, the frame's own reducer, and the active layer and the choice
 * resolved against the document.
 */
const Harness = ({
	document,
	onActivate = () => undefined,
	onSelect = () => undefined,
	onNotify = () => undefined,
}: Readonly<{
	document: EditorDocument;
	onActivate?: (id: string) => void;
	onSelect?: (selection: LayerSelection) => void;
	onNotify?: (message: string) => void;
}>) => {
	const snapshot = useDocumentSnapshot(document);
	const [state, dispatch] = useReducer(editorReducer, initialEditorState);
	if (snapshot === undefined) return null;
	const active = activeLayerIn(snapshot.layers, state.activeLayerId);
	return (
		<LayersPanel
			document={document}
			snapshot={snapshot}
			activeLayerId={active}
			selectedLayerIds={selectedLayersIn(snapshot.layers, state.selectedLayerIds, active)}
			layerAnchor={state.layerAnchor}
			onActivate={(id) => {
				dispatch({ type: 'setActiveLayer', id });
				onActivate(id);
			}}
			onSelectLayers={(selection) => {
				dispatch({ type: 'selectLayers', selection });
				onSelect(selection);
			}}
			collapsedGroupIds={state.collapsedGroupIds}
			onCollapseGroups={(ids) => dispatch({ type: 'setCollapsedGroups', ids })}
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
		render(<Harness document={document} />);

		await user.click(screen.getByRole('button', { name: 'Duplicate layer' }));

		await waitFor(() => expect(rows()).toHaveLength(2));
		expect(document.text()).toContain('id="layer-2"');
		expect(pick('Layer 2').getAttribute('aria-current')).toBe('true');
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
		expect(pick('Layer 1').getAttribute('aria-current')).toBe('true');

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
		expect(rows()).toEqual(['Layer 3', 'Group 1', 'Layer 2']);
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

		await choose(user, 'Group layers');
		await waitFor(() => expect(rows()).toEqual(['Group 2', 'Layer 1']));
		expect(pick('Group 2').getAttribute('aria-current')).toBe('true');
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

/** Layer 4 on top, the group Group 2 holding Layer 3, and Layer 1 at the bottom. */
const stacked = (inside = '<g id="layer-3" draw:kind="vector"/>', group = '') =>
	open(
		emptyDrawing({ id: DRAWING_ID }).replace(
			/<g id="layer-1"[^>]*\/>/,
			`<g id="layer-1" draw:kind="vector"/><g id="layer-2" draw:kind="group"${group}>${inside}</g><g id="layer-4" draw:kind="vector"/>`
		)
	);

/** The names of the rows, top first, of those that match `which` only where it is given. */
const names = (which = '') =>
	[...list().querySelectorAll(`.layer-row${which}`)].map(
		(row) => row.querySelector('.layer-name')?.textContent
	);

/** The rows chosen, and the active one among them. */
const chosen = () => names('[data-selected]');
const activeName = () => names('[data-active]')[0];

/** A row's depth, as the panel draws it. */
const depthOf = (name: string) =>
	[...list().querySelectorAll('.layer-row')]
		.find((row) => row.querySelector('.layer-name')?.textContent === name)
		?.getAttribute('data-depth');

/** The layer's own button, whatever is said after its name. */
const row = (name: string) => pick(new RegExp(`^${name}( |$)`));

const click = (name: string, keys: Readonly<{ ctrlKey?: boolean; shiftKey?: boolean }> = {}) => {
	fireEvent.click(row(name), keys);
};

describe('choosing layers', () => {
	it('chooses one with a click, adds and takes out with Ctrl, and never leaves none', () => {
		render(<Harness document={stacked()} />);
		expect(chosen()).toEqual(['Layer 4']);

		click('Layer 1');
		expect(chosen()).toEqual(['Layer 1']);
		click('Layer 4', { ctrlKey: true });
		expect(chosen()).toEqual(['Layer 4', 'Layer 1']);
		expect(activeName()).toBe('Layer 4');

		click('Layer 4', { ctrlKey: true });
		expect(chosen()).toEqual(['Layer 1']);
		expect(activeName()).toBe('Layer 1');
		click('Layer 1', { ctrlKey: true });
		expect(chosen()).toEqual(['Layer 1']);
	});

	it('chooses a range with Shift from the last layer clicked, and adds one with both keys', () => {
		const onSelect = vi.fn();
		render(<Harness document={stacked()} onSelect={onSelect} />);

		click('Layer 4');
		click('Layer 3', { shiftKey: true });
		expect(chosen()).toEqual(['Layer 4', 'Group 2', 'Layer 3']);
		expect(activeName()).toBe('Layer 3');
		expect(onSelect).toHaveBeenLastCalledWith({
			active: 'layer-3',
			selected: ['layer-4', 'layer-2', 'layer-3'],
			anchor: 'layer-4',
		});

		click('Layer 1');
		click('Layer 4', { ctrlKey: true });
		click('Group 2', { ctrlKey: true, shiftKey: true });
		expect(chosen()).toEqual(['Layer 4', 'Group 2', 'Layer 1']);
	});

	it('says which layers are chosen to a screen reader, while more than one is, and which is active', () => {
		render(<Harness document={stacked()} />);
		expect(pick('Layer 4').getAttribute('aria-current')).toBe('true');

		click('Layer 1', { ctrlKey: true });

		expect(pick('Layer 4 Selected').getAttribute('aria-current')).toBeNull();
		expect(pick('Layer 1 Selected').getAttribute('aria-current')).toBe('true');
		expect(pick('Group 2')).toBeDefined();
	});
});

describe('keys on a row', () => {
	it('grows and shrinks the range with Shift and an arrow, the focus going with it', () => {
		render(<Harness document={stacked()} />);
		click('Layer 4');

		fireEvent.keyDown(row('Layer 4'), { key: 'ArrowDown', shiftKey: true });
		expect(chosen()).toEqual(['Layer 4', 'Group 2']);
		expect(window.document.activeElement).toBe(row('Group 2'));

		fireEvent.keyDown(row('Group 2'), { key: 'ArrowDown', shiftKey: true });
		expect(chosen()).toEqual(['Layer 4', 'Group 2', 'Layer 3']);
		fireEvent.keyDown(row('Layer 3'), { key: 'ArrowUp', shiftKey: true });
		expect(chosen()).toEqual(['Layer 4', 'Group 2']);
		expect(activeName()).toBe('Group 2');
	});

	it('chooses every layer with Ctrl A, which the frame does not also take', () => {
		render(<Harness document={stacked()} />);

		const unclaimed = fireEvent.keyDown(row('Layer 4'), { key: 'a', ctrlKey: true });

		expect(unclaimed).toBe(false);
		expect(chosen()).toEqual(['Layer 4', 'Group 2', 'Layer 3', 'Layer 1']);
		expect(activeName()).toBe('Layer 4');
	});

	it('deletes every layer chosen with Delete, which one undo brings back', async () => {
		const document = stacked();
		render(<Harness document={document} />);
		click('Layer 1', { ctrlKey: true });

		fireEvent.keyDown(row('Layer 4'), { key: 'Delete' });

		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 3']));
		act(() => document.undo());
		await waitFor(() => expect(names()).toEqual(['Layer 4', 'Group 2', 'Layer 3', 'Layer 1']));
	});

	it('moves the chosen into a group, through it and out of it with Alt and an arrow, the focus staying', async () => {
		const document = stacked();
		render(<Harness document={document} />);
		click('Layer 4');

		fireEvent.keyDown(row('Layer 4'), { key: 'ArrowDown', altKey: true });
		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 4', 'Layer 3', 'Layer 1']));
		expect(depthOf('Layer 4')).toBe('1');
		await waitFor(() => expect(window.document.activeElement).toBe(row('Layer 4')));

		fireEvent.keyDown(row('Layer 4'), { key: 'ArrowDown', altKey: true });
		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 3', 'Layer 4', 'Layer 1']));
		expect(depthOf('Layer 4')).toBe('1');

		fireEvent.keyDown(row('Layer 4'), { key: 'ArrowDown', altKey: true });
		await waitFor(() => expect(depthOf('Layer 4')).toBe('0'));
		expect(names()).toEqual(['Group 2', 'Layer 3', 'Layer 4', 'Layer 1']);
		await waitFor(() => expect(window.document.activeElement).toBe(row('Layer 4')));
		expect(chosen()).toEqual(['Layer 4']);

		fireEvent.keyDown(row('Layer 4'), { key: 'ArrowUp', altKey: true });
		await waitFor(() => expect(depthOf('Layer 4')).toBe('1'));
	});
});

describe('the actions on the layers chosen', () => {
	/** Three layers, Layer 3 on top. */
	const three = async (user: ReturnType<typeof userEvent.setup>) => {
		const document = open();
		render(<Harness document={document} />);
		await add(user);
		await add(user);
		await waitFor(() => expect(names()).toEqual(['Layer 3', 'Layer 2', 'Layer 1']));
		return document;
	};

	it('moves the chosen down and up together', async () => {
		const user = userEvent.setup();
		const document = await three(user);
		click('Layer 3');
		click('Layer 2', { shiftKey: true });

		await user.click(screen.getByRole('button', { name: 'Move down' }));

		await waitFor(() => expect(names()).toEqual(['Layer 1', 'Layer 3', 'Layer 2']));
		expect(chosen()).toEqual(['Layer 3', 'Layer 2']);
		expect(screen.getByRole('button', { name: 'Move down' })).toHaveProperty('disabled', true);
		act(() => document.undo());
		await waitFor(() => expect(names()).toEqual(['Layer 3', 'Layer 2', 'Layer 1']));
	});

	it('deletes the chosen, the button saying how many', async () => {
		const user = userEvent.setup();
		await three(user);
		click('Layer 3');
		click('Layer 1', { ctrlKey: true });

		await user.click(screen.getByRole('button', { name: 'Delete 2 layers' }));

		await waitFor(() => expect(names()).toEqual(['Layer 2']));
	});

	it('duplicates the chosen, each above its original, and chooses the copies', async () => {
		const user = userEvent.setup();
		await three(user);
		click('Layer 3');
		click('Layer 2', { shiftKey: true });

		await user.click(screen.getByRole('button', { name: 'Duplicate 2 layers' }));

		await waitFor(() =>
			expect(names()).toEqual(['Layer 5', 'Layer 3', 'Layer 4', 'Layer 2', 'Layer 1'])
		);
		expect(chosen()).toEqual(['Layer 5', 'Layer 4']);
		// The copy of the active layer, Layer 2, is active.
		expect(activeName()).toBe('Layer 4');
	});
});

describe('the layer actions menu, with layers chosen', () => {
	const choose = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
		await user.click(screen.getByRole('button', { name: 'Layer actions' }));
		await user.click(await screen.findByRole('menuitem', { name }));
	};

	const disabled = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
		await user.click(screen.getByRole('button', { name: 'Layer actions' }));
		const found = await screen.findByRole('menuitem', { name });
		await user.keyboard('{Escape}');
		return found.getAttribute('aria-disabled') === 'true';
	};

	it('groups the chosen into one new group where the topmost was, and makes it active alone', async () => {
		const user = userEvent.setup();
		const document = stacked();
		render(<Harness document={document} />);
		click('Layer 1', { ctrlKey: true });

		await choose(user, 'Group layers');

		await waitFor(() =>
			expect(names()).toEqual(['Group 5', 'Layer 4', 'Layer 1', 'Group 2', 'Layer 3'])
		);
		expect(depthOf('Layer 1')).toBe('1');
		expect(chosen()).toEqual(['Group 5']);
		expect(activeName()).toBe('Group 5');
	});

	it('ungroups every group chosen at once, and chooses what they held', async () => {
		const user = userEvent.setup();
		const document = open(
			emptyDrawing({ id: DRAWING_ID }).replace(
				/<g id="layer-1"[^>]*\/>/,
				'<g id="layer-1" draw:kind="vector"/><g id="layer-2" draw:kind="group"><g id="layer-3" draw:kind="vector"/></g><g id="layer-4" draw:kind="group"><g id="layer-5" draw:kind="vector"/></g>'
			)
		);
		render(<Harness document={document} />);
		click('Group 4');
		click('Group 2', { ctrlKey: true });

		await choose(user, 'Ungroup');

		await waitFor(() => expect(names()).toEqual(['Layer 5', 'Layer 3', 'Layer 1']));
		expect(chosen()).toEqual(['Layer 5', 'Layer 3']);
		expect(activeName()).toBe('Layer 5');
		act(() => document.undo());
		await waitFor(() => expect(names()).toHaveLength(5));
	});

	it('leaves a styled group among those chosen as it is, and says so', async () => {
		const user = userEvent.setup();
		const onNotify = vi.fn();
		const document = open(
			emptyDrawing({ id: DRAWING_ID }).replace(
				/<g id="layer-1"[^>]*\/>/,
				'<g id="layer-1" draw:kind="group" opacity="0.5"><g id="layer-2" draw:kind="vector"/></g><g id="layer-3" draw:kind="group"><g id="layer-4" draw:kind="vector"/></g>'
			)
		);
		render(<Harness document={document} onNotify={onNotify} />);
		click('Group 3');
		click('Group 1', { ctrlKey: true });

		await choose(user, 'Ungroup');

		await waitFor(() => expect(names()).toEqual(['Layer 4', 'Group 1', 'Layer 2']));
		expect(onNotify).toHaveBeenCalledWith(
			'1 group was left as it is: it has an opacity, a blend mode, an effect or a style of its own, which its layers would lose.'
		);
	});

	it('keeps merge down, rasterize and clip to one layer: disabled while several are chosen', async () => {
		const user = userEvent.setup();
		render(<Harness document={stacked()} />);
		expect(await disabled(user, 'Merge down')).toBe(false);

		click('Layer 1', { ctrlKey: true });

		expect(await disabled(user, 'Merge down')).toBe(true);
		expect(await disabled(user, 'Rasterize layer')).toBe(true);
		expect(await disabled(user, 'Clip to layer below')).toBe(true);
		expect(await disabled(user, 'Group layers')).toBe(false);
	});
});

describe('dragging layers', () => {
	const ROW_PX = 44;

	// jsdom has no pointer capture; the browser has, and the drag asks for it.
	const captured = vi.fn();
	beforeAll(() => {
		Object.defineProperty(Element.prototype, 'setPointerCapture', {
			value: captured,
			configurable: true,
			writable: true,
		});
	});
	afterAll(() => {
		Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
	});

	const box = (left: number, top: number, width: number, height: number): DOMRect => ({
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	});

	/** Each row 44 px tall from the top of the page down, as a browser lays the list out and jsdom does not. */
	const layOut = () => {
		within(list())
			.getAllByRole('listitem')
			.forEach((each, at) => {
				Object.defineProperty(each, 'getBoundingClientRect', {
					configurable: true,
					value: () => box(0, at * ROW_PX, 300, ROW_PX),
				});
			});
	};

	/** The middle of row `at`'s height, or `share` of the way down it. */
	const yOf = (at: number, share = 0.5) => at * ROW_PX + share * ROW_PX;

	const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			pointerType: 'mouse',
			isPrimary: true,
			button: type === 'pointermove' ? -1 : 0,
			buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
			clientX: x,
			clientY: y,
			...init,
		});

	const fire = (target: Element, event: Event) => {
		act(() => {
			target.dispatchEvent(event);
		});
	};

	/**
	 * A press on `target`, a move past the few pixels a click may wander, and
	 * a move to each point: every event to the element pressed, as the
	 * pointer is captured.
	 */
	const drag = (
		target: Element,
		points: readonly (readonly [number, number])[],
		init: PointerEventInit = {}
	) => {
		const [first] = points;
		const [x, y] = first ?? [100, 0];
		fire(target, pointer('pointerdown', x, y - 10, init));
		for (const [px, py] of points) fire(target, pointer('pointermove', px, py, init));
	};

	const lift = (target: Element, init: PointerEventInit = {}) =>
		fire(target, pointer('pointerup', 0, 0, init));

	/** The line a drop would go on, as the row it is drawn on and which edge. */
	const line = () => {
		const drawn = list().querySelector('.layer-drop-line');
		return drawn === null
			? undefined
			: [
					drawn.closest('.layer-row')?.querySelector('.layer-name')?.textContent,
					drawn.getAttribute('data-at'),
				];
	};

	const lit = () => names('[data-drop="into"]');

	it('drags a layer to under another with a mouse, and the click after it chooses nothing', async () => {
		const document = stacked();
		render(<Harness document={document} />);
		layOut();
		const from = row('Layer 4');

		// Just under itself is where it is: nothing to show.
		drag(from, [[100, yOf(0, 0.7)]]);
		expect(list().getAttribute('data-dragging')).toBe('');
		expect(names('[data-dragged]')).toEqual(['Layer 4']);
		expect(line()).toBeUndefined();
		expect(captured).toHaveBeenCalledWith(1);

		fire(from, pointer('pointermove', 100, yOf(3, 0.8)));
		expect(line()).toEqual(['Layer 1', 'after']);
		lift(from);
		fireEvent.click(from);

		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 3', 'Layer 1', 'Layer 4']));
		expect(list().getAttribute('data-dragging')).toBeNull();
		expect(chosen()).toEqual(['Layer 4']);
		act(() => document.undo());
		await waitFor(() => expect(names()).toEqual(['Layer 4', 'Group 2', 'Layer 3', 'Layer 1']));
	});

	it('drags into a group from the middle of its row, which is lit, to its top', async () => {
		render(<Harness document={stacked()} />);
		layOut();
		const from = row('Layer 1');

		drag(from, [[100, yOf(1)]]);
		expect(lit()).toEqual(['Group 2']);
		expect(line()).toBeUndefined();
		lift(from);

		await waitFor(() => expect(names()).toEqual(['Layer 4', 'Group 2', 'Layer 1', 'Layer 3']));
		expect(depthOf('Layer 1')).toBe('1');
	});

	it('drags out of a group at its foot only as far out as the pointer is to the left', async () => {
		render(<Harness document={stacked()} />);
		layOut();
		const from = row('Layer 3');

		// Under Layer 3, the last in its group, at its own depth: where it is.
		drag(from, [[200, yOf(2, 0.8)]]);
		expect(line()).toBeUndefined();
		// Left of the group's indent: out of it, under the group.
		fire(from, pointer('pointermove', 4, yOf(2, 0.8)));
		expect(line()).toEqual(['Layer 1', 'before']);
		lift(from);

		await waitFor(() => expect(depthOf('Layer 3')).toBe('0'));
		expect(names()).toEqual(['Layer 4', 'Group 2', 'Layer 3', 'Layer 1']);
	});

	it('drags the layers chosen together, and they stay chosen', async () => {
		const document = stacked();
		render(<Harness document={document} />);
		click('Layer 1', { ctrlKey: true });
		layOut();
		const from = row('Layer 4');

		drag(from, [[100, yOf(1)]]);
		expect(names('[data-dragged]')).toEqual(['Layer 4', 'Layer 1']);
		lift(from);

		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 4', 'Layer 1', 'Layer 3']));
		expect(chosen()).toEqual(['Layer 4', 'Layer 1']);
		// Layer 1, Ctrl-clicked last, is active still.
		expect(activeName()).toBe('Layer 1');
	});

	it('drags a row not chosen alone, choosing it as the drag begins', async () => {
		render(<Harness document={stacked()} />);
		click('Layer 1', { ctrlKey: true });
		layOut();
		const from = row('Layer 3');

		drag(from, [[100, yOf(0, 0.2)]]);
		expect(chosen()).toEqual(['Layer 3']);
		expect(names('[data-dragged]')).toEqual(['Layer 3']);
		lift(from);

		await waitFor(() => expect(names()).toEqual(['Layer 3', 'Layer 4', 'Group 2', 'Layer 1']));
	});

	it('shows nothing and drops nothing where the layers cannot go: a group into itself', () => {
		const document = stacked();
		render(<Harness document={document} />);
		layOut();
		const before = document.text();
		const from = row('Group 2');

		drag(from, [
			[100, yOf(1)],
			[100, yOf(2)],
		]);
		expect(lit()).toEqual([]);
		expect(line()).toBeUndefined();
		lift(from);

		expect(document.text()).toBe(before);
	});

	it('is a click, not a drag, where the press moves no more than a few pixels', () => {
		render(<Harness document={stacked()} />);
		layOut();
		const from = row('Layer 1');

		fire(from, pointer('pointerdown', 100, yOf(3)));
		fire(from, pointer('pointermove', 102, yOf(3) + 2));
		expect(list().getAttribute('data-dragging')).toBeNull();
		lift(from);
		fireEvent.click(from);

		expect(chosen()).toEqual(['Layer 1']);
	});

	it('puts the drag down with Escape, or where the browser cancels the pointer', () => {
		const document = stacked();
		render(<Harness document={document} />);
		layOut();
		const before = document.text();
		const from = row('Layer 4');

		drag(from, [[100, yOf(3, 0.8)]]);
		expect(line()).toEqual(['Layer 1', 'after']);
		const unclaimed = fireEvent.keyDown(from, { key: 'Escape' });
		expect(unclaimed).toBe(false);
		expect(line()).toBeUndefined();
		expect(list().getAttribute('data-dragging')).toBeNull();
		lift(from);

		drag(from, [[100, yOf(3, 0.8)]]);
		fire(from, pointer('pointercancel', 0, 0));
		expect(list().getAttribute('data-dragging')).toBeNull();
		lift(from);

		expect(document.text()).toBe(before);
	});

	it('leaves a finger on the layer to scroll the list, and drags by the grip', async () => {
		render(<Harness document={stacked()} />);
		layOut();
		const touch = { pointerType: 'touch' };

		const layer = row('Layer 4');
		drag(layer, [[100, yOf(3, 0.8)]], touch);
		expect(list().getAttribute('data-dragging')).toBeNull();
		lift(layer, touch);

		const grip = layer.closest('.layer-row')?.querySelector('.layer-grip');
		if (!(grip instanceof Element)) throw new Error('a grip on the row');
		expect(grip.getAttribute('aria-hidden')).toBe('true');
		drag(grip, [[100, yOf(3, 0.8)]], touch);
		expect(line()).toEqual(['Layer 1', 'after']);
		lift(grip, touch);

		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 3', 'Layer 1', 'Layer 4']));
	});

	it('scrolls the panel while the pointer is held near its bottom edge', async () => {
		render(<Harness document={stacked()} />);
		layOut();
		const body = list().closest('.panel-body');
		if (!(body instanceof HTMLElement)) throw new Error('the panel body');
		const scrolled = vi.fn();
		Object.defineProperty(body, 'getBoundingClientRect', {
			configurable: true,
			value: () => box(0, 0, 300, 120),
		});
		Object.defineProperty(body, 'scrollBy', { configurable: true, value: scrolled });
		const from = row('Layer 4');

		drag(from, [[100, 118]]);

		await waitFor(() => expect(scrolled).toHaveBeenCalled());
		expect(scrolled.mock.calls.every(([, step]) => typeof step === 'number' && step > 0)).toBe(
			true
		);
		lift(from);
	});
});

describe('collapsing groups', () => {
	/** Layer 6 on top; Group 2 holding Layer 5 and Group 3, which holds Layer 4; Layer 1 at the bottom. */
	const nested = () =>
		open(
			emptyDrawing({ id: DRAWING_ID }).replace(
				/<g id="layer-1"[^>]*\/>/,
				'<g id="layer-1" draw:kind="vector"/><g id="layer-2" draw:kind="group"><g id="layer-3" draw:kind="group"><g id="layer-4" draw:kind="vector"/></g><g id="layer-5" draw:kind="vector"/></g><g id="layer-6" draw:kind="vector"/>'
			)
		);

	/** The disclosure on a group's row. */
	const disclosure = (name: string) => {
		const found = [...list().querySelectorAll('.layer-row')]
			.find((each) => each.querySelector('.layer-name')?.textContent === name)
			?.querySelector('.layer-disclosure');
		if (!(found instanceof HTMLElement)) throw new Error(`a disclosure on ${name}`);
		return found;
	};

	it('hides every row under a group, nested groups too, and changes nothing in the drawing', () => {
		const document = nested();
		const before = document.text();
		render(<Harness document={document} />);
		expect(names()).toEqual(['Layer 6', 'Group 2', 'Layer 5', 'Group 3', 'Layer 4', 'Layer 1']);
		expect(disclosure('Group 2').getAttribute('aria-expanded')).toBe('true');

		fireEvent.click(disclosure('Group 2'));

		expect(names()).toEqual(['Layer 6', 'Group 2', 'Layer 1']);
		expect(disclosure('Group 2').getAttribute('aria-expanded')).toBe('false');
		expect(disclosure('Group 2').getAttribute('aria-label')).toBe('Expand group');
		expect(document.text()).toBe(before);
		expect(document.snapshot().dirty).toBe(false);
		expect(document.snapshot().canUndo).toBe(false);
	});

	it('keeps a nested group as it was when its group opens again, and Alt does every group inside', () => {
		render(<Harness document={nested()} />);
		fireEvent.click(disclosure('Group 3'));
		fireEvent.click(disclosure('Group 2'));
		fireEvent.click(disclosure('Group 2'));
		expect(names()).toEqual(['Layer 6', 'Group 2', 'Layer 5', 'Group 3', 'Layer 1']);

		fireEvent.click(disclosure('Group 2'), { altKey: true });
		expect(names()).toEqual(['Layer 6', 'Group 2', 'Layer 1']);
		fireEvent.click(disclosure('Group 2'), { altKey: true });
		expect(names()).toEqual(['Layer 6', 'Group 2', 'Layer 5', 'Group 3', 'Layer 4', 'Layer 1']);
	});

	it('has the folder be the disclosure, where a layer has its kind, and moves no row over for it', () => {
		const { unmount } = render(<Harness document={open()} />);
		expect(list().querySelector('.layer-disclosure')).toBeNull();
		expect(list().querySelector('.layer-pick .layer-kind-icon')).not.toBeNull();
		unmount();

		render(<Harness document={nested()} />);
		const groups = [...list().querySelectorAll('.layer-row[data-group]')];
		expect(groups).toHaveLength(2);
		// The folder is before the group's own button, in place of the kind inside it.
		expect(
			groups.every((each) => each.querySelector(':scope > .layer-disclosure') !== null)
		).toBe(true);
		expect(
			groups.every((each) => each.querySelector('.layer-pick .layer-kind-icon') === null)
		).toBe(true);
		expect(
			list().querySelectorAll('.layer-row:not([data-group]) .layer-disclosure')
		).toHaveLength(0);
		// Its caret turns: down while open, across once shut.
		const caret = () => disclosure('Group 3').querySelectorAll('path')[1]?.getAttribute('d');
		const opened = caret();
		fireEvent.click(disclosure('Group 3'));
		expect(caret()).not.toBe(opened);
	});

	it('gives an empty group its folder too, though there is nothing in it to show or hide', () => {
		render(<Harness document={stacked('')} />);
		expect(list().querySelectorAll('.layer-disclosure')).toHaveLength(1);
	});

	it('opens and shuts a group with the arrows across, as a tree view, and walks the rows shown', () => {
		render(<Harness document={nested()} />);
		click('Group 2');

		fireEvent.keyDown(row('Group 2'), { key: 'ArrowLeft' });
		expect(names()).toEqual(['Layer 6', 'Group 2', 'Layer 1']);
		fireEvent.keyDown(row('Group 2'), { key: 'ArrowDown' });
		expect(activeName()).toBe('Layer 1');
		expect(window.document.activeElement).toBe(row('Layer 1'));

		fireEvent.keyDown(row('Layer 1'), { key: 'ArrowUp' });
		fireEvent.keyDown(row('Group 2'), { key: 'ArrowRight' });
		expect(names()).toHaveLength(6);
		fireEvent.keyDown(row('Group 2'), { key: 'ArrowRight' });
		expect(activeName()).toBe('Layer 5');
		expect(window.document.activeElement).toBe(row('Layer 5'));

		fireEvent.keyDown(row('Layer 5'), { key: 'ArrowLeft' });
		expect(chosen()).toEqual(['Group 2']);
		expect(window.document.activeElement).toBe(row('Group 2'));
	});

	it('keeps the choice, the active layer inside too, and gives the focus of a row it hides to the group', async () => {
		const onSelect = vi.fn();
		const onActivate = vi.fn();
		render(<Harness document={nested()} onSelect={onSelect} onActivate={onActivate} />);
		click('Layer 4');
		row('Layer 4').focus();
		onSelect.mockClear();

		fireEvent.click(disclosure('Group 2'));

		expect(onSelect).not.toHaveBeenCalled();
		expect(onActivate).not.toHaveBeenCalled();
		expect(names()).toEqual(['Layer 6', 'Group 2', 'Layer 1']);
		await waitFor(() => expect(window.document.activeElement).toBe(row('Group 2')));
		// The properties under the list are still the active layer's.
		expect(
			screen
				.getAllByRole('textbox', { name: 'Name' })
				.some((field) => field.getAttribute('placeholder') === 'Layer 4')
		).toBe(true);
	});

	it('chooses every row shown with Ctrl A, and an active layer inside a collapsed group with them', () => {
		const onSelect = vi.fn();
		render(<Harness document={nested()} onSelect={onSelect} />);
		click('Layer 4');
		fireEvent.click(disclosure('Group 2'));

		fireEvent.keyDown(row('Layer 6'), { key: 'a', ctrlKey: true });

		expect(onSelect).toHaveBeenLastCalledWith({
			active: 'layer-4',
			selected: ['layer-6', 'layer-2', 'layer-4', 'layer-1'],
			anchor: 'layer-4',
		});
		expect(chosen()).toEqual(['Layer 6', 'Group 2', 'Layer 1']);
	});

	it('keeps a layer chosen inside a collapsed group through Ctrl, and lets it go with a plain click', () => {
		const onSelect = vi.fn();
		render(<Harness document={nested()} onSelect={onSelect} />);
		click('Layer 4');
		fireEvent.click(disclosure('Group 2'));

		click('Layer 1', { ctrlKey: true });
		expect(onSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ active: 'layer-1', selected: ['layer-4', 'layer-1'] })
		);

		click('Layer 6');
		expect(onSelect).toHaveBeenLastCalledWith(
			expect.objectContaining({ active: 'layer-6', selected: ['layer-6'] })
		);
	});

	it('passes over a collapsed group whole with Alt and an arrow', async () => {
		render(<Harness document={stacked()} />);
		fireEvent.click(disclosure('Group 2'));

		fireEvent.keyDown(row('Layer 4'), { key: 'ArrowDown', altKey: true });

		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 4', 'Layer 1']));
		expect(depthOf('Layer 4')).toBe('0');
	});

	it('starts a group made by Group expanded, even under an id a group collapsed before had', async () => {
		const user = userEvent.setup();
		render(<Harness document={stacked()} />);
		fireEvent.click(disclosure('Group 2'));
		click('Group 2');
		fireEvent.keyDown(row('Group 2'), { key: 'Delete' });
		await waitFor(() => expect(names()).toEqual(['Layer 4', 'Layer 1']));
		click('Layer 4');

		await user.click(screen.getByRole('button', { name: 'Layer actions' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Group layers' }));

		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 4', 'Layer 1']));
		expect(disclosure('Group 2').getAttribute('aria-expanded')).toBe('true');
	});
});

describe('dropping on a collapsed group', () => {
	beforeAll(() => {
		Object.defineProperty(Element.prototype, 'setPointerCapture', {
			value: () => undefined,
			configurable: true,
			writable: true,
		});
	});
	afterAll(() => {
		Reflect.deleteProperty(Element.prototype, 'setPointerCapture');
	});

	const layOut = () => {
		within(list())
			.getAllByRole('listitem')
			.forEach((each, at) => {
				Object.defineProperty(each, 'getBoundingClientRect', {
					configurable: true,
					value: () => ({
						left: 0,
						right: 300,
						top: at * 44,
						bottom: at * 44 + 44,
						x: 0,
						y: at * 44,
						width: 300,
						height: 44,
						toJSON: () => ({}),
					}),
				});
			});
	};

	const dragTo = (from: Element, y: number) => {
		const events = [
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'mouse',
				button: 0,
				buttons: 1,
				clientX: 100,
				clientY: 0,
			}),
			new PointerEvent('pointermove', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'mouse',
				button: -1,
				buttons: 1,
				clientX: 100,
				clientY: y,
			}),
			new PointerEvent('pointerup', {
				bubbles: true,
				pointerId: 1,
				pointerType: 'mouse',
				button: 0,
				buttons: 0,
				clientX: 100,
				clientY: y,
			}),
		];
		for (const event of events) act(() => void from.dispatchEvent(event));
	};

	const shut = () => {
		const control = list().querySelector('.layer-disclosure');
		if (!(control instanceof HTMLElement)) throw new Error('a disclosure');
		fireEvent.click(control);
		return control;
	};

	it('puts the layers into it at its top from the middle of its row, and leaves it collapsed', async () => {
		const document = stacked();
		render(<Harness document={document} />);
		const control = shut();
		layOut();

		dragTo(row('Layer 1'), 44 + 22);

		await waitFor(() => expect(names()).toEqual(['Layer 4', 'Group 2']));
		expect(control.getAttribute('aria-expanded')).toBe('false');
		expect(document.text()).toMatch(/<g id="layer-3" draw:kind="vector"\/>\s*<g id="layer-1"/);
	});

	it('places beside it, not among its layers, from under its row', async () => {
		render(<Harness document={stacked()} />);
		shut();
		layOut();

		dragTo(row('Layer 4'), 44 + 40);

		await waitFor(() => expect(names()).toEqual(['Group 2', 'Layer 4', 'Layer 1']));
		expect(depthOf('Layer 4')).toBe('0');
	});
});
