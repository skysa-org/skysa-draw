import { BLEND_MODES, emptyDrawing } from '@skysa/draw-core';
import {
	act,
	createEvent,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useReducer, useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { editLayer } from '../../src/drawing/document/commands.js';
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
import type { ToolId } from '../../src/drawing/tools/types.js';
import { NO_SELECTION } from '../../src/drawing/viewport/context.js';
import {
	createViewportSelection,
	type ViewportSelection,
} from '../../src/drawing/viewport/selectionState.js';
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
	selection: given,
	tool = initialEditorState.toolId,
}: Readonly<{
	document: EditorDocument;
	onActivate?: (id: string) => void;
	onSelect?: (selection: LayerSelection) => void;
	onNotify?: (message: string) => void;
	/** The selection the viewport would share, where a test sets it as the canvas would. */
	selection?: ViewportSelection;
	/** The tool in hand to begin with. */
	tool?: ToolId;
}>) => {
	const snapshot = useDocumentSnapshot(document);
	const [state, dispatch] = useReducer(editorReducer, { ...initialEditorState, toolId: tool });
	const [own] = useState(createViewportSelection);
	const selection = given ?? own;
	if (snapshot === undefined) return null;
	const active = activeLayerIn(snapshot.layers, state.activeLayerId);
	return (
		<>
			{/* The tool in hand, as the frame's state has it. */}
			<span data-testid="tool" data-tool={state.toolId} />
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
				expandedLayerIds={state.expandedLayerIds}
				onExpandLayers={(ids) => dispatch({ type: 'setExpandedLayers', ids })}
				selectedElements={selection.elements}
				onSelectElements={(id, elements) => {
					dispatch({ type: 'selectInLayer', id });
					selection.elements.set(elements.length === 0 ? NO_SELECTION : elements);
				}}
				withProperties
				onNotify={onNotify}
			/>
		</>
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

/** An item of one of the panel's menus, chosen. */
const chooseIn = async (user: ReturnType<typeof userEvent.setup>, menu: string, name: string) => {
	await user.click(screen.getByRole('button', { name: menu }));
	await user.click(await screen.findByRole('menuitem', { name }));
};

/** The items of the layer actions menu, opened from its button and closed again: those that apply. */
const offered = async (user: ReturnType<typeof userEvent.setup>) => {
	await user.click(screen.getByRole('button', { name: 'Layer actions' }));
	const menu = await screen.findByRole('menu', { name: 'Layer actions' });
	const items = within(menu)
		.getAllByRole('menuitem')
		.map((each) => each.textContent);
	await user.keyboard('{Escape}');
	return items;
};

/** Something new from the panel's New menu, a vector layer unless it says. */
const add = async (user: ReturnType<typeof userEvent.setup>, name = 'Vector layer') => {
	await chooseIn(user, 'New', name);
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

		await add(user, 'Raster layer');

		await waitFor(() => expect(rows()).toEqual(['Layer 2', 'Layer 1']));
		expect(document.text()).toContain('draw:kind="raster"');
	});

	it('adds an empty group above the active one, its folder with no caret, and activates it', async () => {
		const user = userEvent.setup();
		const document = open();
		const onActivate = vi.fn();
		render(<Harness document={document} onActivate={onActivate} />);

		await add(user, 'Group');

		await waitFor(() => expect(rows()).toEqual(['Group 2', 'Layer 1']));
		expect(onActivate).toHaveBeenCalledWith('layer-2');
		expect(document.text()).toMatch(/<g id="layer-2" draw:kind="group"\/>/);
		expect(list().querySelector('.layer-disclosure')).toBeNull();
		expect(list().querySelectorAll('.layer-row[data-group] .layer-folder')).toHaveLength(1);
	});

	it('has no buttons to move a layer up or down: a drag does, or the actions menu', () => {
		render(<Harness document={open()} />);
		expect(screen.queryByRole('button', { name: 'Move up' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Move down' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'New layer' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'New raster layer' })).toBeNull();
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
		expect(await offered(user)).not.toContain('Move up');
		expect(await offered(user)).toContain('Move down');

		await chooseIn(user, 'Layer actions', 'Move down');
		await waitFor(() => expect(rows()).toEqual(['Layer 1', 'Layer 2']));
		const text = document.text();
		expect(text.indexOf('id="layer-2"')).toBeLessThan(text.indexOf('id="layer-1"'));
		expect(await offered(user)).not.toContain('Move down');

		await chooseIn(user, 'Layer actions', 'Move up');
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

	it('groups the active layer and ungroups it again', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		expect(await offered(user)).not.toContain('Ungroup');

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
		expect(await offered(user)).not.toContain('Merge down');

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

		await chooseIn(user, 'Layer actions', 'Move down');

		await waitFor(() => expect(names()).toEqual(['Layer 1', 'Layer 3', 'Layer 2']));
		expect(chosen()).toEqual(['Layer 3', 'Layer 2']);
		expect(await offered(user)).not.toContain('Move down');
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

	it('keeps merge down, rasterize and clip to one layer: not offered while several are chosen', async () => {
		const user = userEvent.setup();
		render(<Harness document={stacked()} />);
		expect(await offered(user)).toEqual([
			'Group layers',
			'Move down',
			'Merge down',
			'Rasterize layer',
			'Clip to layer below',
		]);

		click('Layer 1', { ctrlKey: true });

		expect(await offered(user)).toEqual(['Group layers', 'Move up', 'Move down']);
	});
});

describe('the layer actions menu, applying only where it can', () => {
	it('lists only what applies to the layers chosen, with a rule between the kinds', async () => {
		const user = userEvent.setup();
		render(<Harness document={open()} />);
		// One vector layer: nothing to ungroup, move, merge into or clip to.
		expect(await offered(user)).toEqual(['Group layers', 'Rasterize layer']);
		await user.click(screen.getByRole('button', { name: 'Layer actions' }));
		const menu = await screen.findByRole('menu', { name: 'Layer actions' });
		// A rule begins the second kind, none above the first.
		expect([...menu.children].map((each) => each.getAttribute('role'))).toEqual([
			'menuitem',
			'separator',
			'menuitem',
		]);
	});

	it('is disabled where nothing applies, with no layer at all', async () => {
		const user = userEvent.setup();
		const document = open();
		render(<Harness document={document} />);
		await user.click(screen.getByRole('button', { name: 'Delete layer' }));
		await waitFor(() => expect(within(list()).queryAllByRole('listitem')).toHaveLength(0));
		expect(screen.getByRole('button', { name: 'Layer actions' })).toHaveProperty(
			'disabled',
			true
		);
	});
});

describe('the layer actions menu over a row', () => {
	const rowOf = (name: string) => {
		const found = row(name).closest('li');
		if (found === null) throw new Error(`a row for ${name}`);
		return found;
	};

	const shownItems = () =>
		within(screen.getByRole('menu', { name: 'Layer actions' }))
			.getAllByRole('menuitem')
			.map((each) => each.textContent);

	it('opens on a right-click, at the pointer, with what the head’s menu has, and acts', async () => {
		const user = userEvent.setup();
		const document = stacked();
		render(<Harness document={document} />);
		click('Layer 1');
		const event = createEvent.contextMenu(rowOf('Layer 1'), { clientX: 120, clientY: 300 });
		fireEvent(rowOf('Layer 1'), event);

		expect(event.defaultPrevented).toBe(true);
		const menu = await screen.findByRole('menu', { name: 'Layer actions' });
		expect(menu.style.top).not.toBe('');
		expect(shownItems()).toEqual(['Group layers', 'Move up', 'Rasterize layer']);

		await user.click(within(menu).getByRole('menuitem', { name: 'Move up' }));
		// Past Group 2 whole, not into it.
		await waitFor(() => expect(names()).toEqual(['Layer 4', 'Layer 1', 'Group 2', 'Layer 3']));
		expect(depthOf('Layer 1')).toBe('0');
		expect(screen.queryByRole('menu', { name: 'Layer actions' })).toBeNull();
	});

	it('chooses a row not among the chosen alone first, and keeps a choice the row is in', async () => {
		render(<Harness document={stacked()} />);
		click('Layer 4');
		click('Layer 1', { ctrlKey: true });

		fireEvent.contextMenu(rowOf('Layer 1'), { clientX: 100, clientY: 100 });
		expect(chosen()).toEqual(['Layer 4', 'Layer 1']);
		await screen.findByRole('menu', { name: 'Layer actions' });
		expect(shownItems()).toEqual(['Group layers', 'Move up', 'Move down']);
		fireEvent.keyDown(screen.getByRole('menu', { name: 'Layer actions' }), { key: 'Escape' });

		fireEvent.contextMenu(rowOf('Group 2'), { clientX: 100, clientY: 100 });
		expect(chosen()).toEqual(['Group 2']);
		expect(activeName()).toBe('Group 2');
		await waitFor(() => expect(shownItems()).toContain('Ungroup'));
	});

	it('opens on Shift F10 under the row, and gives the focus back to it on Escape', async () => {
		const user = userEvent.setup();
		render(<Harness document={stacked()} />);
		row('Layer 4').focus();

		await user.keyboard('{Shift>}{F10}{/Shift}');

		const menu = await screen.findByRole('menu', { name: 'Layer actions' });
		await waitFor(() => expect(menu.contains(window.document.activeElement)).toBe(true));
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('menu', { name: 'Layer actions' })).toBeNull();
		expect(window.document.activeElement).toBe(row('Layer 4'));
	});

	it('leaves the browser its own menu in the rename field, and opens none from the grip', () => {
		render(<Harness document={stacked()} />);
		fireEvent.doubleClick(row('Layer 4'));
		// The row's button is the field while it is renamed.
		const field = list().querySelector('[data-layer-id="layer-4"] input');
		if (field === null) throw new Error('a rename field');
		const inField = createEvent.contextMenu(field);
		fireEvent(field, inField);
		expect(inField.defaultPrevented).toBe(false);
		fireEvent.keyDown(field, { key: 'Escape' });

		const grip = rowOf('Layer 1').querySelector('.layer-grip');
		if (grip === null) throw new Error('a grip');
		const onGrip = createEvent.contextMenu(grip);
		fireEvent(grip, onGrip);
		expect(onGrip.defaultPrevented).toBe(true);
		expect(screen.queryByRole('menu', { name: 'Layer actions' })).toBeNull();
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

	describe('past an expanded vector layer', () => {
		/** Layer 3 on top; Layer 2, a vector layer of two items, expanded; Layer 1 at the bottom. */
		const expandedIn = (middle: boolean) => {
			const items = '<rect width="1" height="1"/><circle r="1"/>';
			const document = open(
				emptyDrawing({ id: DRAWING_ID }).replace(
					/<g id="layer-1"[^>]*\/>/,
					middle
						? `<g id="layer-1" draw:kind="vector"/><g id="layer-2" draw:kind="vector">${items}</g><g id="layer-3" draw:kind="vector"/>`
						: `<g id="layer-1" draw:kind="vector">${items}</g><g id="layer-2" draw:kind="vector"/><g id="layer-3" draw:kind="vector"/>`
				)
			);
			render(<Harness document={document} />);
			const control = list().querySelector('.layer-disclosure');
			if (!(control instanceof HTMLElement)) throw new Error('a disclosure');
			fireEvent.click(control);
			layOut();
			return document;
		};

		it('drops over the items under their layer, the line under the last of them', async () => {
			expandedIn(true);
			expect(names()).toEqual(['Layer 3', 'Layer 2', 'Ellipse', 'Rectangle', 'Layer 1']);
			const from = row('Layer 3');

			// Over either item, the gap under Layer 2, drawn over Layer 1.
			drag(from, [[100, yOf(2, 0.2)]]);
			expect(line()).toEqual(['Layer 1', 'before']);
			expect(lit()).toEqual([]);
			fire(from, pointer('pointermove', 100, yOf(3, 0.9)));
			expect(line()).toEqual(['Layer 1', 'before']);
			lift(from);

			await waitFor(() =>
				expect(names()).toEqual(['Layer 2', 'Ellipse', 'Rectangle', 'Layer 3', 'Layer 1'])
			);
		});

		it('drops above the layer from the top of its own row; its bottom is the gap its items are', async () => {
			expandedIn(true);
			const from = row('Layer 1');

			// Under Layer 2, from the bottom of its row or over its items, is where Layer 1 is.
			drag(from, [[100, yOf(1, 0.7)]]);
			expect(line()).toBeUndefined();
			fire(from, pointer('pointermove', 100, yOf(3, 0.5)));
			expect(line()).toBeUndefined();
			fire(from, pointer('pointermove', 100, yOf(1, 0.3)));
			expect(line()).toEqual(['Layer 2', 'before']);
			lift(from);

			await waitFor(() =>
				expect(names()).toEqual(['Layer 3', 'Layer 1', 'Layer 2', 'Ellipse', 'Rectangle'])
			);
		});

		it('draws the line under the last item where the bottom layer is expanded, and drops at the bottom', async () => {
			expandedIn(false);
			expect(names()).toEqual(['Layer 3', 'Layer 2', 'Layer 1', 'Ellipse', 'Rectangle']);
			const from = row('Layer 3');

			drag(from, [[100, yOf(3)]]);
			expect(line()).toEqual(['Rectangle', 'after']);
			expect(list().querySelectorAll('.layer-drop-line')).toHaveLength(1);
			fire(from, pointer('pointermove', 100, yOf(6)));
			expect(line()).toEqual(['Rectangle', 'after']);
			lift(from);

			await waitFor(() =>
				expect(names()).toEqual(['Layer 2', 'Layer 1', 'Ellipse', 'Rectangle', 'Layer 3'])
			);
		});

		it('moves the expanded layer with Alt and an arrow past its neighbors, its items with it', async () => {
			expandedIn(true);
			fireEvent.keyDown(row('Layer 2'), { key: 'ArrowDown', altKey: true });
			await waitFor(() =>
				expect(names()).toEqual(['Layer 3', 'Layer 1', 'Layer 2', 'Ellipse', 'Rectangle'])
			);
		});
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

	it('has the folder be the disclosure, where a layer has its preview, and moves no row over for it', () => {
		const { unmount } = render(<Harness document={open()} />);
		expect(list().querySelector('.layer-disclosure')).toBeNull();
		expect(list().querySelector('.layer-pick .layer-preview')).not.toBeNull();
		unmount();

		render(<Harness document={nested()} />);
		const groups = [...list().querySelectorAll('.layer-row[data-group]')];
		expect(groups).toHaveLength(2);
		// The folder is before the group's own button, in place of the kind inside it.
		expect(
			groups.every((each) => each.querySelector(':scope > .layer-disclosure') !== null)
		).toBe(true);
		expect(
			groups.every(
				(each) =>
					each.querySelector('.layer-pick .layer-kind-icon') === null &&
					each.querySelector('.layer-preview') === null
			)
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

	it('gives an empty group its folder with no caret and no button, as there is nothing to show or hide', () => {
		render(<Harness document={stacked('')} />);
		expect(list().querySelector('.layer-disclosure')).toBeNull();
		const folder = list().querySelector('.layer-row[data-group] > .layer-folder');
		expect(folder?.querySelectorAll('path')).toHaveLength(1);
		expect(folder?.closest('button')).toBeNull();
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

describe('the previews, and a vector layer’s items', () => {
	const INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';

	/** Layer 3 on top, a vector layer holding `inside`; Layer 2, a vector layer of one rectangle; Layer 1, raster, at the bottom. */
	const itemized = (inside = '<rect width="4" height="4"/><circle r="2"/>') =>
		open(
			emptyDrawing({ id: DRAWING_ID })
				.replace('xmlns:draw=', `xmlns:inkscape="${INKSCAPE}" xmlns:draw=`)
				.replace(
					/<g id="layer-1"[^>]*\/>/,
					`<g id="layer-1" draw:kind="raster"/><g id="layer-2" draw:kind="vector"><rect width="1" height="1"/></g><g id="layer-3" draw:kind="vector">${inside}</g>`
				)
		);

	/** A layer's row, by its name. */
	const rowOf = (name: string) => {
		const found = [...list().querySelectorAll('.layer-row:not(.layer-item)')].find(
			(each) => each.querySelector('.layer-name')?.textContent === name
		);
		if (!(found instanceof HTMLElement)) throw new Error(`a row for ${name}`);
		return found;
	};

	/** The disclosure on a layer's row, if it has one. */
	const disclosureOf = (name: string) => rowOf(name).querySelector(':scope > .layer-disclosure');

	const toggle = (name: string) => {
		const control = disclosureOf(name);
		if (!(control instanceof HTMLElement)) throw new Error(`a disclosure on ${name}`);
		fireEvent.click(control);
	};

	/** The items' rows' names, top first. */
	const itemNames = () => names('.layer-item');

	/** The item's own button, by its name, whatever is said after it. */
	const item = (name: string, nth = 0) => {
		const found = within(list())
			.getAllByRole('button', { name: new RegExp(`^${name}( |$)`) })
			.filter((button) => button.closest('.layer-item') !== null)[nth];
		if (found === undefined) throw new Error(`an item called ${name}`);
		return found;
	};

	const chosenLayers = () => names(':not(.layer-item)[data-selected]');
	const selectedItems = () => names('.layer-item[data-selected]');
	const tool = () => screen.getByTestId('tool').getAttribute('data-tool');

	/** The layer's elements, in paint order. */
	const elementsOf = (document: EditorDocument, id: string) => [
		...(document.layer(id)?.children ?? []),
	];

	it('shows a preview where a layer’s kind was, a vector layer’s with its mark, and keeps a group’s folder', () => {
		const document = itemized();
		render(<Harness document={document} />);

		const raster = rowOf('Layer 1');
		expect(raster.querySelector('.layer-pick .layer-preview')).not.toBeNull();
		expect(raster.querySelector('.layer-preview-mark')).toBeNull();
		const vector = rowOf('Layer 2');
		expect(
			vector.querySelector('.layer-pick .layer-preview .layer-preview-mark')
		).not.toBeNull();
		expect(vector.querySelector('.layer-kind-icon')).toBeNull();
		// The picture says nothing the name does not.
		expect(pick('Layer 2').textContent).toBe('Layer 2');
	});

	it('gives a vector layer of one item no caret: its preview is in the layer’s button, and nothing expands', () => {
		render(<Harness document={itemized()} />);
		expect(disclosureOf('Layer 2')).toBeNull();
		expect(rowOf('Layer 2').querySelector('.layer-preview-caret')).toBeNull();
		fireEvent.keyDown(row('Layer 2'), { key: 'ArrowRight' });
		expect(itemNames()).toEqual([]);
	});

	it('makes a vector layer of two items expandable by its preview, collapsed to begin with, with a caret that turns', () => {
		const document = itemized();
		const before = document.text();
		render(<Harness document={document} />);
		const control = disclosureOf('Layer 3');
		expect(control?.getAttribute('aria-expanded')).toBe('false');
		expect(control?.getAttribute('aria-label')).toBe('Expand layer');
		// The preview is the disclosure, before the layer's button, with the caret and the mark on it.
		expect(control?.querySelector('.layer-preview .layer-preview-caret')).not.toBeNull();
		expect(control?.querySelector('.layer-preview .layer-preview-mark')).not.toBeNull();
		expect(rowOf('Layer 3').querySelector('.layer-pick .layer-preview')).toBeNull();
		expect(itemNames()).toEqual([]);
		const caret = () => control?.querySelector('.layer-preview-caret path')?.getAttribute('d');
		const shut = caret();

		toggle('Layer 3');

		expect(control?.getAttribute('aria-expanded')).toBe('true');
		expect(control?.getAttribute('aria-label')).toBe('Collapse layer');
		expect(caret()).not.toBe(shut);
		expect(names()).toEqual(['Layer 3', 'Ellipse', 'Rectangle', 'Layer 2', 'Layer 1']);
		toggle('Layer 3');
		expect(itemNames()).toEqual([]);
		expect(document.text()).toBe(before);
		expect(document.snapshot().dirty).toBe(false);
	});

	it('lists the items top first, a level deeper than their layer, each with its preview, named in the user’s words', () => {
		const document = itemized(
			[
				'<rect width="1" height="1"/>',
				'<circle r="1"/>',
				'<ellipse rx="1" ry="2"/>',
				'<line x2="1"/>',
				'<polyline points="0,0 1,1"/>',
				'<polygon points="0,0 1,1 1,0"/>',
				'<path d="M0 0L1 1"/>',
				'<text>  Harbor\n   at  dusk </text>',
				'<text>The quick brown fox jumps over the lazy dog</text>',
				'<text> </text>',
				'<g><rect width="1" height="1"/></g>',
				'<image width="1" height="1"/>',
				'<use href="#nowhere"/>',
				'<rect inkscape:label="Sky" width="1" height="1"/>',
				'<path d="M0 0L2 2"><title>Coastline</title></path>',
			].join('')
		);
		render(<Harness document={document} />);
		toggle('Layer 3');

		expect(itemNames()).toEqual([
			'Coastline',
			'Sky',
			'Clone',
			'Image',
			'Group',
			'Text',
			'The quick brown fox jump…',
			'Harbor at dusk',
			'Path',
			'Polygon',
			'Polyline',
			'Line',
			'Ellipse',
			'Ellipse',
			'Rectangle',
		]);
		const items = [...list().querySelectorAll<HTMLElement>('.layer-item')];
		expect(
			items.every((each) => each.style.paddingInlineStart === 'calc(1 * var(--space-l))')
		).toBe(true);
		expect(rowOf('Layer 3').style.paddingInlineStart).toBe('calc(0 * var(--space-l))');
		// Where an eye is on a layer's row, an empty place, so the previews line up.
		expect(
			items.every((each) => each.querySelector(':scope > .layer-item-slot') !== null)
		).toBe(true);
		expect(
			items.every((each) => each.querySelector('.layer-pick .layer-preview') !== null)
		).toBe(true);
		// No item can be dragged, and none has an eye or a lock of its own.
		expect(items.every((each) => each.querySelectorAll('button').length === 1)).toBe(true);
	});

	it('indents the items of a vector layer inside a group a level deeper than the layer', () => {
		const document = open(
			emptyDrawing({ id: DRAWING_ID }).replace(
				/<g id="layer-1"[^>]*\/>/,
				'<g id="layer-1" draw:kind="group"><g id="layer-2" draw:kind="vector"><rect width="1" height="1"/><rect width="2" height="2"/></g></g>'
			)
		);
		render(<Harness document={document} />);
		toggle('Layer 2');
		const items = [...list().querySelectorAll<HTMLElement>('.layer-item')];
		expect(items.map((each) => each.style.paddingInlineStart)).toEqual([
			'calc(2 * var(--space-l))',
			'calc(2 * var(--space-l))',
		]);
	});

	it('selects an item from its row: its layer active and chosen alone, the move tool taken up, the item alone selected', () => {
		const document = itemized();
		const selection = createViewportSelection();
		render(<Harness document={document} selection={selection} tool="brush" />);
		toggle('Layer 3');
		click('Layer 1');
		click('Layer 2', { ctrlKey: true });
		expect(chosenLayers()).toEqual(['Layer 2', 'Layer 1']);
		const [rect, circle] = elementsOf(document, 'layer-3');

		fireEvent.click(item('Ellipse'));

		expect(activeName()).toBe('Layer 3');
		expect(chosenLayers()).toEqual(['Layer 3']);
		expect(tool()).toBe('select');
		expect(selection.elements.get()).toEqual([circle]);
		expect(selectedItems()).toEqual(['Ellipse']);
		expect(item('Ellipse').textContent).toBe('Ellipse Selected');

		// Shift adds, in paint order, and takes out again; Ctrl or ⌘ as well.
		fireEvent.click(item('Rectangle'), { shiftKey: true });
		expect(selection.elements.get()).toEqual([rect, circle]);
		expect(selectedItems()).toEqual(['Ellipse', 'Rectangle']);
		fireEvent.click(item('Ellipse'), { shiftKey: true });
		expect(selection.elements.get()).toEqual([rect]);
		fireEvent.click(item('Ellipse'), { ctrlKey: true, metaKey: true });
		expect(selection.elements.get()).toEqual([rect, circle]);
		fireEvent.click(item('Rectangle'), { ctrlKey: true, metaKey: true });
		expect(selectedItems()).toEqual(['Ellipse']);
		// A plain press selects the one alone again.
		fireEvent.click(item('Rectangle'));
		expect(selection.elements.get()).toEqual([rect]);
		expect(document.snapshot().dirty).toBe(false);
	});

	it('keeps a tool that selects in hand, and adds within the item’s layer alone', () => {
		const document = open(
			emptyDrawing({ id: DRAWING_ID }).replace(
				/<g id="layer-1"[^>]*\/>/,
				'<g id="layer-1" draw:kind="vector"><rect width="1" height="1"/><circle r="1"/></g><g id="layer-2" draw:kind="vector"><rect width="1" height="1"/><line x2="1"/></g>'
			)
		);
		const selection = createViewportSelection();
		render(<Harness document={document} selection={selection} tool="marquee" />);
		toggle('Layer 2');
		toggle('Layer 1');
		const [line] = elementsOf(document, 'layer-2').slice(1);

		fireEvent.click(item('Line'));
		// Shift on another layer's item selects it alone: a selection is one layer's.
		fireEvent.click(item('Ellipse'), { shiftKey: true });

		expect(tool()).toBe('marquee');
		expect(activeName()).toBe('Layer 1');
		expect(selection.elements.get()).toEqual([elementsOf(document, 'layer-1')[1]]);
		expect(selection.elements.get()).not.toContain(line);
	});

	it('shows an item selected however it was selected, as on the canvas, and lets it go as it is let go', () => {
		const document = itemized();
		const selection = createViewportSelection();
		render(<Harness document={document} selection={selection} />);
		toggle('Layer 3');
		const [rect, circle] = elementsOf(document, 'layer-3');

		act(() => selection.elements.set([rect, circle].flatMap((each) => each ?? [])));
		expect(selectedItems()).toEqual(['Ellipse', 'Rectangle']);
		expect(item('Rectangle').textContent).toBe('Rectangle Selected');

		act(() => selection.elements.set(NO_SELECTION));
		expect(selectedItems()).toEqual([]);
		expect(item('Rectangle').textContent).toBe('Rectangle');
	});

	it('walks the items with the arrows, opens and shuts a vector layer across, and keeps the arrows from the canvas', () => {
		const document = itemized();
		const selection = createViewportSelection();
		render(<Harness document={document} selection={selection} />);
		const [rect, circle] = elementsOf(document, 'layer-3');

		fireEvent.keyDown(row('Layer 3'), { key: 'ArrowRight' });
		expect(itemNames()).toEqual(['Ellipse', 'Rectangle']);
		fireEvent.keyDown(row('Layer 3'), { key: 'ArrowRight' });
		expect(window.document.activeElement).toBe(item('Ellipse'));
		expect(selection.elements.get()).toEqual([circle]);

		const down = createEvent.keyDown(item('Ellipse'), { key: 'ArrowDown' });
		fireEvent(item('Ellipse'), down);
		expect(down.defaultPrevented).toBe(true);
		expect(window.document.activeElement).toBe(item('Rectangle'));
		expect(selection.elements.get()).toEqual([rect]);

		// Past the last item, the next layer's row.
		fireEvent.keyDown(item('Rectangle'), { key: 'ArrowDown' });
		expect(activeName()).toBe('Layer 2');
		expect(window.document.activeElement).toBe(row('Layer 2'));
		fireEvent.keyDown(row('Layer 2'), { key: 'ArrowUp' });
		expect(window.document.activeElement).toBe(item('Rectangle'));
		expect(activeName()).toBe('Layer 3');

		// Left from an item goes to its layer's row; on the layer's, it shuts the layer.
		fireEvent.keyDown(item('Rectangle'), { key: 'ArrowLeft' });
		expect(window.document.activeElement).toBe(row('Layer 3'));
		expect(chosenLayers()).toEqual(['Layer 3']);
		fireEvent.keyDown(row('Layer 3'), { key: 'ArrowLeft' });
		expect(itemNames()).toEqual([]);

		// Shift with an arrow on an item does nothing here, and nothing on the canvas.
		fireEvent.keyDown(row('Layer 3'), { key: 'ArrowRight' });
		const nudge = createEvent.keyDown(item('Ellipse'), { key: 'ArrowUp', shiftKey: true });
		fireEvent(item('Ellipse'), nudge);
		expect(nudge.defaultPrevented).toBe(true);
		expect(selection.elements.get()).toEqual([rect]);
	});

	it('opens the layer’s actions menu over an item, choosing its layer alone first', async () => {
		render(<Harness document={itemized()} />);
		toggle('Layer 3');
		click('Layer 1');

		fireEvent.contextMenu(item('Ellipse'), { clientX: 10, clientY: 20 });

		expect(await screen.findByRole('menu', { name: 'Layer actions' })).toBeDefined();
		expect(chosenLayers()).toEqual(['Layer 3']);
	});

	it('keeps a layer expanded through an edit and an undo that put its markup back, and loses the caret at one item', () => {
		const document = itemized();
		render(<Harness document={document} />);
		toggle('Layer 3');

		act(() =>
			document.execute(
				editLayer('layer-3', 'tools.select', (layer) => {
					layer.appendChild(
						layer.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path')
					);
				})
			)
		);
		expect(itemNames()).toEqual(['Path', 'Ellipse', 'Rectangle']);
		act(() => document.undo());
		expect(disclosureOf('Layer 3')?.getAttribute('aria-expanded')).toBe('true');
		expect(itemNames()).toEqual(['Ellipse', 'Rectangle']);

		act(() =>
			document.execute(
				editLayer('layer-3', 'tools.select', (layer) => {
					layer.lastElementChild?.remove();
				})
			)
		);
		expect(disclosureOf('Layer 3')).toBeNull();
		expect(itemNames()).toEqual([]);
		expect(rowOf('Layer 3').querySelector('.layer-pick .layer-preview-mark')).not.toBeNull();
	});

	it('starts every vector layer collapsed, so a layer of 300 strokes is one row', () => {
		const strokes = Array.from({ length: 300 }, (_, at) => `<path d="M0 ${at}L1 ${at}"/>`);
		render(<Harness document={itemized(strokes.join(''))} />);
		expect(names()).toEqual(['Layer 3', 'Layer 2', 'Layer 1']);
		toggle('Layer 3');
		expect(itemNames()).toHaveLength(300);
	});
});
