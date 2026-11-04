import {
	emptyDrawing,
	readDrawingId,
	readDrawingTitle,
	ROOT,
	withDrawingId,
	withDrawingTitle,
} from '@skysa/draw-core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentSnapshot, EditorDocument } from '../../src/drawing/document/model.js';
import { Editor } from '../../src/drawing/Editor.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../../src/drawing/useOpenDrawing.js';
import { DatabaseProvider } from '../../src/store/database.js';
import type { DrawDatabase } from '../../src/store/db.js';
import { createDrawing, deleteDrawing, getDrawing, saveDrawing } from '../../src/store/drawings.js';
import { isLive } from '../../src/store/rowStates.js';
import { freshDatabase } from '../support/db.js';
import { stubWindowWidth, type Width } from './support.js';

/**
 * The frame (docs/ARCHITECTURE.md §7, "The interface"): the same pieces placed
 * by size class, the keys that reach them, and the drawing saved as it is
 * edited. The document is a fake here, with spies where the frame calls into
 * it and a hand to edit it with; what a real document does to the SVG is
 * `layersPanel.test.tsx`'s and the document's own tests' business.
 */

/** A drawing whose title says the opener cannot take it, as a file from elsewhere might be. */
const BROKEN = 'Broken';

const fake = vi.hoisted(() => {
	type Fake = EditorDocument & {
		/** Changes the text as a command would, telling the subscribers unless `quietly`. */
		edit: (text: string, quietly?: boolean) => void;
	};
	const undo = vi.fn();
	const redo = vi.fn();
	const opened: Fake[] = [];
	/** The kind of the one layer the next document opened has. */
	const settings = { kind: 'vector' as 'vector' | 'raster' };
	const open = vi.fn((text: string): EditorDocument | undefined => {
		if (text.includes(`<title>Broken</title>`)) return undefined;
		const listeners = new Set<() => void>();
		const state = { text, dirty: false, version: 0 };
		const snapshot = (): DocumentSnapshot => ({
			layers: [
				{
					id: 'layer-1',
					kind: settings.kind,
					name: undefined,
					hidden: false,
					locked: false,
					opacity: 1,
					blend: 'normal',
					depth: 0,
					parentId: undefined,
					loose: false,
				},
			],
			size: { width: 1600, height: 1000 },
			canUndo: true,
			canRedo: false,
			dirty: state.dirty,
			version: state.version,
		});
		// One object per version, as `useSyncExternalStore` needs of a snapshot.
		const snapshots = new Map<number, DocumentSnapshot>();
		const document: Fake = {
			root: window.document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
			prolog: '',
			size: { width: 1600, height: 1000 },
			snapshot: () => {
				const known = snapshots.get(state.version) ?? snapshot();
				snapshots.set(state.version, known);
				return known;
			},
			text: () => state.text,
			layer: () => undefined,
			execute: () => undefined,
			undo,
			redo,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			pending: () => undefined,
			settle: () => Promise.resolve(),
			edit: (next, quietly = false) => {
				state.text = next;
				state.dirty = true;
				state.version += 1;
				if (!quietly) listeners.forEach((listener) => listener());
			},
		};
		opened.push(document);
		return document;
	});
	return { undo, redo, opened, open, settings };
});

vi.mock('../../src/drawing/document/openDocument.js', () => ({ openDocument: fake.open }));

/** The export module's, mocked to what the frame asks of it: placing a picture, and the dialog. */
const exporting = vi.hoisted(() => ({ placePicture: vi.fn() }));

vi.mock('../../src/drawing/export/place.js', () => ({ placePicture: exporting.placePicture }));

vi.mock('../../src/drawing/export/ExportDialog.js', () => ({
	ExportDialog: ({
		open,
		title,
		onClose,
	}: Readonly<{ open: boolean; title: string; onClose: () => void }>) =>
		open ? (
			<div role="dialog" aria-label="Export">
				<p>{title}</p>
				<button type="button" onClick={onClose}>
					Close the export
				</button>
			</div>
		) : null,
}));

/** The document the editor opened last. */
const lastOpened = () => {
	const document = fake.opened.at(-1);
	if (document === undefined) throw new Error('nothing was opened');
	return document;
};

/** The editor as the route holds it: the id is the URL's, and `onReplaced` moves it. */
const Routed = ({
	first,
	onBack,
	onReplaced,
}: Readonly<{ first: string; onBack: () => void; onReplaced: (id: string) => void }>) => {
	const [id, setId] = useState(first);
	return (
		<Editor
			id={id}
			onBack={onBack}
			onReplaced={(next) => {
				onReplaced(next);
				setId(next);
			}}
			library={<p>The library</p>}
		/>
	);
};

const renderEditor = async (width: Width, title = 'Harbor', folderPath = ROOT) => {
	stubWindowWidth(width);
	const db = freshDatabase();
	const made = await createDrawing(db, {
		title,
		folderPath,
		text: emptyDrawing({ id: crypto.randomUUID(), title }),
	});
	const onBack = vi.fn();
	const onReplaced = vi.fn();
	const view = render(
		<DatabaseProvider database={db}>
			<Routed first={made.id} onBack={onBack} onReplaced={onReplaced} />
		</DatabaseProvider>
	);
	await screen.findByRole('heading', { name: title });
	// The title is in the bar as soon as the row is, and the document opens
	// from the row a moment later: until then the frame has no tools.
	if (title !== BROKEN) await screen.findByRole('toolbar', { name: 'Tools' });
	return { db, made, onBack, onReplaced, view };
};

/** Long enough for a pending save to have fired, and for anything it led to. */
const pastTheSave = () => new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 100));

/** Where `a` is in the page against `b`: before it, in reading order. */
const precedes = (a: Element, b: Element): boolean =>
	(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

const rowText = async (db: DrawDatabase, id: string) => (await getDrawing(db, id))?.text;
/** The rows a user can see: a delete leaves a tombstone until the push sends it. */
const liveRows = async (db: DrawDatabase) => (await db.drawings.toArray()).filter(isLive);

describe('the editor frame, by size class', () => {
	beforeEach(() => {
		fake.undo.mockClear();
		fake.redo.mockClear();
	});

	it('on compact: Back, the tools along the bottom under the options, the panels as sheets', async () => {
		const user = userEvent.setup();
		const { onBack } = await renderEditor('compact');
		const tools = screen.getByRole('toolbar', { name: 'Tools' });
		expect(tools.getAttribute('aria-orientation')).toBe('horizontal');
		const options = screen.getByRole('toolbar', { name: 'Tool options' });
		const canvas = screen.getByRole('region', { name: 'Canvas' });
		expect(precedes(canvas, options)).toBe(true);
		expect(precedes(options, tools)).toBe(true);
		expect(screen.queryByRole('button', { name: 'Drawings' })).toBeNull();
		expect(screen.queryByRole('complementary')).toBeNull();
		// No room in the bar for the zoom: it is under More.
		expect(screen.queryByRole('button', { name: '100%' })).toBeNull();
		await user.click(screen.getByRole('button', { name: 'More' }));
		expect(screen.getByRole('menuitem', { name: /Fit to window/ })).toBeDefined();
		await user.keyboard('{Escape}');

		await user.click(within(tools).getByRole('button', { name: 'Layers' }));
		const sheet = await screen.findByRole('dialog', { name: 'Layers' });
		expect(sheet.classList.contains('panel-sheet')).toBe(true);
		expect(within(sheet).getByRole('list', { name: 'Layers' })).toBeDefined();
		// Its properties are inside it, there being no properties panel.
		expect(within(sheet).getByRole('slider', { name: 'Opacity' })).toBeDefined();

		fireEvent.click(screen.getByRole('button', { name: 'Back to drawings' }));
		expect(onBack).toHaveBeenCalled();
	});

	it('on medium: the library and the panels in drawers, a rail, the options over the canvas', async () => {
		const user = userEvent.setup();
		await renderEditor('medium');
		const rail = screen.getByRole('toolbar', { name: 'Tools' });
		expect(rail.getAttribute('aria-orientation')).toBe('vertical');
		const options = screen.getByRole('toolbar', { name: 'Tool options' });
		expect(precedes(options, screen.getByRole('region', { name: 'Canvas' }))).toBe(true);
		expect(screen.queryByRole('complementary')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Back to drawings' })).toBeNull();

		await user.click(screen.getByRole('button', { name: 'Drawings' }));
		const library = await screen.findByRole('dialog', { name: 'Drawings' });
		expect(library.classList.contains('panel-drawer-start')).toBe(true);
		expect(within(library).getByText('The library')).toBeDefined();
		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await user.click(within(rail).getByRole('button', { name: 'Layers' }));
		const drawer = await screen.findByRole('dialog', { name: 'Layers' });
		expect(drawer.classList.contains('panel-drawer-end')).toBe(true);
	});

	it('on expanded: the rail, and the layers over the properties in a dock, open on a wide window', async () => {
		await renderEditor('expanded');
		expect(
			screen.getByRole('toolbar', { name: 'Tools' }).getAttribute('aria-orientation')
		).toBe('vertical');
		const dock = await screen.findByRole('complementary', { name: 'Layers and properties' });
		const layers = within(dock).getByRole('region', { name: 'Layers' });
		const properties = within(dock).getByRole('region', { name: 'Properties' });
		expect(precedes(layers, properties)).toBe(true);
		expect(
			within(layers)
				.getByRole('button', { name: /Layer 1/ })
				.getAttribute('aria-current')
		).toBe('true');
		expect(screen.getByRole('button', { name: '100%' })).toBeDefined();
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('on an expanded window under 1200 px: the dock closed until the layers button opens it', async () => {
		const user = userEvent.setup();
		await renderEditor(1000);
		const layersButton = within(screen.getByRole('toolbar', { name: 'Tools' })).getByRole(
			'button',
			{ name: 'Layers' }
		);
		expect(screen.queryByRole('complementary')).toBeNull();
		expect(layersButton.getAttribute('aria-pressed')).toBe('false');

		await user.click(layersButton);
		expect(await screen.findByRole('complementary')).toBeDefined();
		expect(layersButton.getAttribute('aria-pressed')).toBe('true');
		await user.click(layersButton);
		await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
	});
});

describe('the editor frame', () => {
	beforeEach(() => {
		fake.undo.mockClear();
		fake.redo.mockClear();
	});

	it("shows the drawing's title in the top bar", async () => {
		await renderEditor('compact', 'Harbor at dusk');
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Harbor at dusk');
	});

	it('presses a tool with its key', async () => {
		await renderEditor('expanded');
		const brush = screen.getByRole('button', { name: 'Brush' });
		const select = screen.getByRole('button', { name: 'Select' });
		expect(brush.getAttribute('aria-pressed')).toBe('false');
		expect(select.getAttribute('aria-pressed')).toBe('true');

		fireEvent.keyDown(window, { key: 'b' });
		await waitFor(() => expect(brush.getAttribute('aria-pressed')).toBe('true'));
		expect(select.getAttribute('aria-pressed')).toBe('false');

		fireEvent.keyDown(window, { key: 'p' });
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Pen' }).getAttribute('aria-pressed')).toBe(
				'true'
			)
		);
		expect(brush.getAttribute('aria-pressed')).toBe('false');
	});

	it('takes no key typed into a field', async () => {
		const user = userEvent.setup();
		await renderEditor('expanded');
		await user.type(screen.getByRole('textbox', { name: 'Name' }), 'b');
		expect(screen.getByRole('button', { name: 'Brush' }).getAttribute('aria-pressed')).toBe(
			'false'
		);
	});

	it('undoes with the primary key and Z, and from the top bar', async () => {
		const user = userEvent.setup();
		await renderEditor('compact');
		fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
		expect(fake.undo).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
		expect(fake.redo).toHaveBeenCalledTimes(1);

		await user.click(screen.getByRole('button', { name: 'Undo' }));
		expect(fake.undo).toHaveBeenCalledTimes(2);
		expect(screen.getByRole('button', { name: 'Redo' })).toHaveProperty('disabled', true);
	});

	it('makes a new layer with Insert, which a browser tab hears where it keeps Ctrl+Shift+N', async () => {
		await renderEditor('expanded');
		const execute = vi.spyOn(lastOpened(), 'execute');
		const event = new KeyboardEvent('keydown', { key: 'Insert', cancelable: true });
		act(() => {
			window.dispatchEvent(event);
		});
		expect(execute).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it('swaps the colors with X and puts them back with the color panel’s reset, as the pair in the tool bar shows', async () => {
		const user = userEvent.setup();
		await renderEditor('expanded');
		const fill = () => screen.getByRole('button', { name: /^Fill color: / });
		expect(fill().getAttribute('aria-label')).toBe('Fill color: #111827');
		// The default stroke is none, so after the swap the fill is.
		fireEvent.keyDown(window, { key: 'x' });
		await waitFor(() => expect(fill().getAttribute('aria-label')).toBe('Fill color: none'));
		expect(screen.getByRole('button', { name: 'Stroke color: #111827' })).toBeDefined();
		// The bar has no reset of its own: it is the color panel's, which a color opens.
		expect(screen.queryByRole('button', { name: 'Reset colors' })).toBeNull();
		await user.click(fill());
		await user.click(await screen.findByRole('button', { name: 'Reset colors' }));
		expect(fill().getAttribute('aria-label')).toBe('Fill color: #111827');
		expect(screen.getByRole('button', { name: 'Stroke color: none' })).toBeDefined();
	});

	it('opens the color panel on the color pressed in the tool bar, and goes back to it on closing', async () => {
		const user = userEvent.setup();
		await renderEditor('medium');
		const stroke = screen.getByRole('button', { name: 'Stroke color: none' });
		await user.click(stroke);
		const dialog = await screen.findByRole('dialog', { name: 'Color' });
		expect(stroke.getAttribute('aria-pressed')).toBe('true');
		await waitFor(() =>
			expect(document.activeElement).toBe(within(dialog).getByLabelText('Stroke'))
		);
		expect(within(dialog).getByRole('button', { name: 'Reset colors' }).title).toBe(
			'Reset colors (D)'
		);

		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(document.activeElement).toBe(stroke);
		expect(stroke.getAttribute('aria-pressed')).toBe('false');
	});

	it('shows both colors as one control on a compact window, with the swap, and opens the color sheet', async () => {
		const user = userEvent.setup();
		await renderEditor('compact');
		const both = screen.getByRole('button', { name: 'Colors' });
		expect(screen.queryByRole('button', { name: /^Fill color: / })).toBeNull();
		fireEvent.keyDown(window, { key: 'x' });
		await waitFor(() =>
			expect(both.querySelector('.color-pair-mark-fill')?.classList.contains('is-none')).toBe(
				true
			)
		);
		await user.click(screen.getByRole('button', { name: 'Swap colors' }));
		expect(both.querySelector('.color-pair-mark-fill')?.classList.contains('is-none')).toBe(
			false
		);
		await user.click(both);
		expect(await screen.findByRole('dialog', { name: 'Color' })).toBeDefined();
		expect(both.getAttribute('aria-pressed')).toBe('true');
	});

	it('puts the colors back with D, and leaves D with the primary key to the selection', async () => {
		await renderEditor('expanded');
		fireEvent.keyDown(window, { key: 'x' });
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Fill color: none' })).toBeDefined()
		);
		fireEvent.keyDown(window, { key: 'd', ctrlKey: true, metaKey: true });
		expect(screen.getByRole('button', { name: 'Fill color: none' })).toBeDefined();
		fireEvent.keyDown(window, { key: 'd' });
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Fill color: #111827' })).toBeDefined()
		);
		expect(screen.getByRole('button', { name: 'Stroke color: none' })).toBeDefined();
	});

	it('closes a sheet with Escape, and it stays closed', async () => {
		const user = userEvent.setup();
		await renderEditor('compact');
		await user.click(screen.getByRole('button', { name: 'Colors' }));
		expect(await screen.findByRole('dialog', { name: 'Color' })).toBeDefined();

		await user.keyboard('{Escape}');
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('shows a file it cannot open as an image, with a notice, and no tools', async () => {
		await renderEditor('expanded', BROKEN);
		expect(await screen.findByRole('img', { name: `Preview of “${BROKEN}”` })).toBeDefined();
		expect(screen.getByText(/cannot be edited here/)).toBeDefined();
		expect(screen.queryByRole('toolbar')).toBeNull();
	});
});

describe('the selection bar', () => {
	beforeEach(() => {
		fake.settings.kind = 'vector';
	});

	const selectAll = () => {
		fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
	};

	const bar = () => screen.queryByRole('group', { name: 'Selection' });

	const barButtons = () =>
		[...(bar()?.querySelectorAll('button') ?? [])].map((button) => button.textContent);

	it.each(['compact', 'medium', 'expanded'] as const)(
		'shows the area’s actions in the options while a tool that selects is in hand (%s)',
		async (width) => {
			fake.settings.kind = 'raster';
			await renderEditor(width);
			expect(bar()).toBeNull();
			selectAll();
			await waitFor(() => expect(bar()).not.toBeNull());
			const options = screen.getByRole('toolbar', { name: 'Tool options' });
			expect(options.contains(bar())).toBe(true);
			expect(barButtons()).toEqual([
				'Deselect',
				'Select inverse',
				'Feather…',
				'Layer via copy',
				'Layer via cut',
				'Fill…',
				'Clear',
				'Crop to selection',
			]);
			fireEvent.keyDown(window, { key: 'b' });
			await waitFor(() => expect(bar()).toBeNull());
			fireEvent.keyDown(window, { key: 'm' });
			await waitFor(() => expect(bar()).not.toBeNull());
			fireEvent.click(screen.getByRole('button', { name: 'Deselect' }));
			await waitFor(() => expect(bar()).toBeNull());
		}
	);

	it('feathers the area from the bar, starting the dialog at its feather', async () => {
		const user = userEvent.setup();
		fake.settings.kind = 'raster';
		await renderEditor('expanded');
		selectAll();
		await user.click(await screen.findByRole('button', { name: 'Feather…' }));
		const dialog = await screen.findByRole('dialog', { name: 'Feather selection' });
		expect(dialog.classList.contains('panel-drawer')).toBe(true);
		const field = within(dialog).getByRole('spinbutton', { name: 'Feather radius in pixels' });
		expect(field).toHaveProperty('value', '0');
		fireEvent.change(field, { target: { value: '12' } });
		await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await user.click(screen.getByRole('button', { name: 'Feather…' }));
		const again = await screen.findByRole('dialog', { name: 'Feather selection' });
		expect(
			within(again).getByRole('spinbutton', { name: 'Feather radius in pixels' })
		).toHaveProperty('value', '12');
		// The area dropped under it takes the dialog with it, for good.
		fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		selectAll();
		await screen.findByRole('button', { name: 'Feather…' });
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('shows the elements’ actions for shapes selected on a vector layer, and makes the layer via copy', async () => {
		await renderEditor('expanded');
		const document = lastOpened();
		const layer = window.document.createElementNS('http://www.w3.org/2000/svg', 'g');
		layer.setAttribute('id', 'layer-1');
		layer.appendChild(window.document.createElementNS('http://www.w3.org/2000/svg', 'rect'));
		document.root.appendChild(layer);
		vi.spyOn(document, 'layer').mockImplementation(
			(id) => document.root.querySelector<SVGGraphicsElement>(`[id="${id}"]`) ?? undefined
		);
		const execute = vi.spyOn(document, 'execute');
		selectAll();
		await waitFor(() =>
			expect(barButtons()).toEqual([
				'Deselect',
				'Select inverse',
				'Layer via copy',
				'Layer via cut',
				'Delete',
			])
		);
		fireEvent.click(screen.getByRole('button', { name: 'Layer via copy' }));
		expect(execute).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(bar()).toBeNull());
	});
});

describe('editing a text from the select tool', () => {
	/** A text of the drawing's one layer, at 50, 50, with `attributes`, and the document finding its layer. */
	const withText = (attributes: Readonly<Record<string, string>>) => {
		const document = lastOpened();
		const svg = 'http://www.w3.org/2000/svg';
		const layer = window.document.createElementNS(svg, 'g');
		layer.setAttribute('id', 'layer-1');
		const text = window.document.createElementNS(svg, 'text');
		Object.entries({ x: '50', y: '50', ...attributes }).forEach(([name, value]) =>
			text.setAttribute(name, value)
		);
		text.append('Hello');
		layer.appendChild(text);
		document.root.appendChild(layer);
		vi.spyOn(document, 'layer').mockImplementation(
			(id) => document.root.querySelector<SVGGraphicsElement>(`[id="${id}"]`) ?? undefined
		);
		return document;
	};

	/** A mouse's double press on the canvas at 50, 50. */
	const doublePress = () => {
		const canvas = screen.getByRole('region', { name: 'Canvas' });
		const press = (type: 'pointerdown' | 'pointerup') =>
			fireEvent(
				canvas,
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 1,
					pointerType: 'mouse',
					isPrimary: true,
					button: 0,
					buttons: type === 'pointerdown' ? 1 : 0,
					clientX: 50,
					clientY: 50,
				})
			);
		['pointerdown', 'pointerup', 'pointerdown', 'pointerup'].forEach((type) =>
			press(type as 'pointerdown' | 'pointerup')
		);
	};

	it('shows the text’s own size and fill in the options as its field opens, writes nothing for them, and keeps them after', async () => {
		await renderEditor('expanded');
		const document = withText({ 'font-size': '20', fill: '#00ff00' });
		const execute = vi.spyOn(document, 'execute');
		doublePress();
		const field = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Text' });
		const size = screen.getByRole('slider', { name: 'Font size' });
		await waitFor(() => expect(size.getAttribute('aria-valuetext')).toBe('20 px'));
		expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Fill (hex)' }).value).toBe(
			'#00ff00'
		);
		expect(field.style.fontSize).toBe('20px');
		fireEvent.keyDown(field, { key: 'Escape' });
		expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull();
		expect(execute).not.toHaveBeenCalled();
		// Kept for the next new text, as Photoshop keeps them.
		expect(size.getAttribute('aria-valuetext')).toBe('20 px');
	});

	it('switches to the text tool on a double press, opens the field on its words, and keeps it open through the font size', async () => {
		await renderEditor('expanded');
		const document = lastOpened();
		const svg = 'http://www.w3.org/2000/svg';
		const layer = window.document.createElementNS(svg, 'g');
		layer.setAttribute('id', 'layer-1');
		const text = window.document.createElementNS(svg, 'text');
		text.setAttribute('x', '50');
		text.setAttribute('y', '50');
		text.setAttribute('font-size', '20');
		text.append('Hello');
		layer.appendChild(text);
		document.root.appendChild(layer);
		vi.spyOn(document, 'layer').mockImplementation(
			(id) => document.root.querySelector<SVGGraphicsElement>(`[id="${id}"]`) ?? undefined
		);
		const canvas = screen.getByRole('region', { name: 'Canvas' });
		const press = (type: 'pointerdown' | 'pointerup') =>
			fireEvent(
				canvas,
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 1,
					pointerType: 'mouse',
					isPrimary: true,
					button: 0,
					buttons: type === 'pointerdown' ? 1 : 0,
					clientX: 50,
					clientY: 50,
				})
			);
		press('pointerdown');
		press('pointerup');
		expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull();
		press('pointerdown');
		press('pointerup');
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Text' }).getAttribute('aria-pressed')).toBe(
				'true'
			)
		);
		const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' });
		expect(field.value).toBe('Hello');
		expect(window.document.activeElement).toBe(field);
		expect(field.style.fontSize).toBe('20px');

		const size = screen.getByRole('slider', { name: 'Font size' });
		expect(size.closest('[data-tool-options]')).not.toBeNull();
		size.focus();
		fireEvent.change(size, { target: { value: '64' } });
		expect(screen.getByRole('textbox', { name: 'Text' })).toBe(field);
		expect(field.style.fontSize).toBe('64px');
		expect(window.document.activeElement).toBe(field);
	});
});

describe('the editor saving', () => {
	it('saves an edit into the row after a pause, and says so', async () => {
		const { db, made } = await renderEditor('expanded');
		const edited = withDrawingId(
			emptyDrawing({ id: made.id, title: 'Harbor' }),
			made.id
		).replace('</svg>', '<g id="layer-2"/></svg>');
		act(() => lastOpened().edit(edited));
		expect(await rowText(db, made.id)).not.toBe(edited);

		await waitFor(async () => expect(await rowText(db, made.id)).toBe(edited), {
			timeout: AUTOSAVE_DEBOUNCE_MS * 6,
		});
		expect(await screen.findByText('Saved')).toBeDefined();
	});

	it('saves what is pending as it closes, without waiting for the pause', async () => {
		const { db, made, view } = await renderEditor('expanded');
		const edited = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		act(() => lastOpened().edit(edited));
		view.unmount();
		await waitFor(async () => expect(await rowText(db, made.id)).toBe(edited), {
			timeout: AUTOSAVE_DEBOUNCE_MS - 100,
		});
	});

	it('reopens a drawing changed elsewhere while nothing here is unsaved', async () => {
		const { db, made } = await renderEditor('expanded');
		const before = fake.open.mock.calls.length;
		const elsewhere = made.text.replace('</svg>', '<g id="layer-9"/></svg>');
		await saveDrawing(db, made.id, elsewhere);

		await waitFor(() => expect(fake.open.mock.calls.length).toBe(before + 1));
		expect(fake.open).toHaveBeenLastCalledWith(elsewhere);
		expect(screen.queryByText(/changed elsewhere/)).toBeNull();
	});

	it('keeps unsaved edits under a change from elsewhere as a copy beside it, and opens the change', async () => {
		const { db, made } = await renderEditor('expanded');
		const mine = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		const theirs = made.text.replace('</svg>', '<g id="layer-9"/></svg>');
		// Edited, and not yet saved: the save would come after the pause.
		act(() => lastOpened().edit(mine, true));
		await saveDrawing(db, made.id, theirs);

		const notice = await screen.findByText(/your edits were kept in a copy/);
		await waitFor(() => expect(fake.open).toHaveBeenLastCalledWith(theirs));
		const rows = await liveRows(db);
		expect(rows).toHaveLength(2);
		const copy = rows.find((row) => row.id !== made.id);
		if (copy === undefined) throw new Error('no copy was kept');

		// The other change keeps the drawing, its path and its id.
		expect(await rowText(db, made.id)).toBe(theirs);
		expect((await getDrawing(db, made.id))?.path).toBe(made.path);
		// The edits are a drawing of their own: a new id, a conflict name and a
		// title that says what it is, the editor's text otherwise.
		expect(readDrawingId(copy.text)).toBe(copy.id);
		expect(copy.title).toMatch(/^Harbor \(conflict \d{4}-\d\d-\d\dT\d\d-\d\d\)$/);
		expect(copy.path).toMatch(/^harbor \(conflict \d{4}-\d\d-\d\dT\d\d-\d\d\)\.svg$/);
		expect(readDrawingTitle(copy.text)).toBe(copy.title);
		expect(copy.text).toBe(withDrawingId(withDrawingTitle(mine, copy.title), copy.id));
		expect(notice.textContent).toContain(`“${copy.title}”`);
		expect(await db.opQueue.where('drawingId').equals(copy.id).toArray()).toEqual([
			expect.objectContaining({ op: 'write', path: copy.path }),
		]);

		// And nothing of the edits is saved over the change after the pause.
		await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 100));
		expect(await rowText(db, made.id)).toBe(theirs);
	});

	it('puts an edit made while the copy is written into the copy, not the drawing', async () => {
		const { db, made } = await renderEditor('expanded');
		const mine = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		const later = made.text.replace('</svg>', '<g id="layer-2"/><g id="layer-3"/></svg>');
		const theirs = made.text.replace('</svg>', '<g id="layer-9"/></svg>');
		const document = lastOpened();
		act(() => document.edit(mine, true));
		// The copy is written from the text after the first settle; an edit
		// lands in the second, after the copy is in the store.
		const settle = vi
			.spyOn(document, 'settle')
			.mockImplementationOnce(() => Promise.resolve())
			.mockImplementationOnce(() => {
				document.edit(later);
				return Promise.resolve();
			});
		await saveDrawing(db, made.id, theirs);

		await waitFor(() => expect(fake.open).toHaveBeenLastCalledWith(theirs));
		expect(settle).toHaveBeenCalled();
		const copy = (await liveRows(db)).find((row) => row.id !== made.id);
		expect(copy?.text).toBe(
			withDrawingId(withDrawingTitle(later, copy?.title ?? ''), copy?.id ?? '')
		);
		await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 100));
		expect(await rowText(db, made.id)).toBe(theirs);
	});
});

describe('a link to a drawing that is not here', () => {
	it('says so once the store has answered, with the way back to the library', async () => {
		stubWindowWidth('expanded');
		const db = freshDatabase();
		const onBack = vi.fn();
		render(
			<DatabaseProvider database={db}>
				<Editor
					id="no-such-drawing"
					onBack={onBack}
					onReplaced={vi.fn()}
					library={<p>The library</p>}
				/>
			</DatabaseProvider>
		);
		expect(await screen.findByText(/This drawing is not on this device/)).toBeDefined();
		expect(screen.queryByRole('toolbar')).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Back to drawings' }));
		expect(onBack).toHaveBeenCalled();
	});

	it('is not said while the store is still being asked', async () => {
		stubWindowWidth('expanded');
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Harbor' });
		render(
			<DatabaseProvider database={db}>
				<Editor
					id={made.id}
					onBack={vi.fn()}
					onReplaced={vi.fn()}
					library={<p>The library</p>}
				/>
			</DatabaseProvider>
		);
		expect(screen.queryByText(/This drawing is not on this device/)).toBeNull();
		await screen.findByRole('toolbar', { name: 'Tools' });
		expect(screen.queryByText(/This drawing is not on this device/)).toBeNull();
	});

	it('says so when the drawing open is deleted elsewhere with nothing here unsaved, and keeps nothing', async () => {
		const { db, made, onReplaced } = await renderEditor('expanded');
		await db.drawings.delete([made.connectionId, made.id]);
		expect(await screen.findByText(/This drawing is not on this device/)).toBeDefined();
		await pastTheSave();
		expect((await liveRows(db)).length).toBe(0);
		expect(onReplaced).not.toHaveBeenCalled();
	});

	it('keeps nothing of edits already saved when the drawing is deleted elsewhere: they went with it', async () => {
		const { db, made, onReplaced } = await renderEditor('expanded');
		const mine = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		act(() => lastOpened().edit(mine));
		await waitFor(async () => expect(await rowText(db, made.id)).toBe(mine), {
			timeout: AUTOSAVE_DEBOUNCE_MS * 6,
		});
		await deleteDrawing(db, made.id);

		expect(await screen.findByText(/This drawing is not on this device/)).toBeDefined();
		expect((await liveRows(db)).length).toBe(0);
		expect(onReplaced).not.toHaveBeenCalled();
	});
});

describe('the drawing open deleted under unsaved edits', () => {
	it('elsewhere: keeps the edits as a new drawing in its place, and moves to it', async () => {
		const { db, made, onReplaced } = await renderEditor('expanded', 'Harbor', 'Work');
		const mine = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		// Edited, and not yet saved: the save would come after the pause.
		act(() => lastOpened().edit(mine, true));
		// Another tab's delete, as it would make it.
		await deleteDrawing(db, made.id);

		const notice = await screen.findByText(/This drawing was deleted elsewhere/);
		const rows = await liveRows(db);
		expect(rows).toHaveLength(1);
		const [kept] = rows;
		if (kept === undefined) throw new Error('nothing was kept');
		expect(onReplaced).toHaveBeenCalledExactlyOnceWith(kept.id);

		// A drawing of its own, where the deleted one was: a new id, since the
		// old one now means deleted; the same folder, connection and title, and
		// a name by the folder's usual rule, which nothing else holds now.
		expect(kept.id).not.toBe(made.id);
		expect((await getDrawing(db, made.id))?.deletedLocally).toBe(1);
		expect(readDrawingId(kept.text)).toBe(kept.id);
		expect(kept.text).toBe(withDrawingId(mine, kept.id));
		expect(kept.title).toBe('Harbor');
		expect(kept.path).toBe('Work/harbor.svg');
		expect(kept.connectionId).toBe(made.connectionId);
		expect(await db.opQueue.where('drawingId').equals(kept.id).toArray()).toEqual([
			expect.objectContaining({ op: 'write', path: kept.path }),
		]);
		expect(notice.textContent).toContain('“Harbor”');

		// The editor is on it, and nothing more is kept, however long it waits.
		await waitFor(() => expect(fake.open).toHaveBeenLastCalledWith(kept.text));
		expect(screen.queryByText(/This drawing is not on this device/)).toBeNull();
		await pastTheSave();
		expect((await liveRows(db)).length).toBe(1);
		expect(onReplaced).toHaveBeenCalledTimes(1);
	});

	it('elsewhere: waits for raster work still pending, which makes a clean document dirty', async () => {
		const { db, made, onReplaced } = await renderEditor('expanded');
		const stroke = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		const document = lastOpened();
		// The stroke's command lands when its encoding settles, after the delete.
		vi.spyOn(document, 'settle').mockImplementationOnce(() => {
			document.edit(stroke, true);
			return Promise.resolve();
		});
		await deleteDrawing(db, made.id);

		await waitFor(() => expect(onReplaced).toHaveBeenCalledTimes(1));
		const [kept] = await liveRows(db);
		expect(kept?.text).toBe(withDrawingId(stroke, kept?.id ?? ''));
	});

	it('elsewhere, while a copy is kept for a change: moves to the copy, the only one left', async () => {
		const { db, made, onReplaced } = await renderEditor('expanded');
		const mine = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		const theirs = made.text.replace('</svg>', '<g id="layer-9"/></svg>');
		const document = lastOpened();
		act(() => document.edit(mine, true));
		// The delete lands while the copy is being written.
		vi.spyOn(document, 'settle').mockImplementationOnce(async () => {
			await deleteDrawing(db, made.id);
			await waitFor(() =>
				expect(screen.queryByRole('toolbar', { name: 'Tools' })).toBeNull()
			);
		});
		await saveDrawing(db, made.id, theirs);

		expect(await screen.findByText(/This drawing was deleted elsewhere/)).toBeDefined();
		const rows = await liveRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.title).toMatch(/^Harbor \(conflict /);
		expect(onReplaced).toHaveBeenCalledExactlyOnceWith(rows[0]?.id);
	});

	it('by the user, through More: the edits go with it, and nothing is left behind', async () => {
		const user = userEvent.setup();
		const { db, made, onBack, onReplaced } = await renderEditor('expanded');
		const mine = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		// Edited, with the save waiting on the pause.
		act(() => lastOpened().edit(mine));

		await user.click(screen.getByRole('button', { name: 'More' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
		await user.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
		);

		await waitFor(() => expect(onBack).toHaveBeenCalled());
		// The editor stays here, as it might for a moment before the route
		// moves: the row's going is the user's, and says not found.
		expect(await screen.findByText(/This drawing is not on this device/)).toBeDefined();
		await pastTheSave();
		expect((await liveRows(db)).length).toBe(0);
		expect(await db.opQueue.toArray()).toEqual([
			expect.objectContaining({ op: 'delete', drawingId: made.id }),
		]);
		expect(onReplaced).not.toHaveBeenCalled();
	});
});

describe('placing a picture and exporting', () => {
	const PICTURE = new File(['png'], 'boat.png', { type: 'image/png' });
	const placed = {
		id: 'layer-2',
		label: 'exporting.place',
		apply: () => undefined,
		revert: () => undefined,
		bytes: 10,
	};

	beforeEach(() => {
		exporting.placePicture.mockReset();
		exporting.placePicture.mockResolvedValue(placed);
	});

	it('places a picture chosen from More above the active layer, as one step', async () => {
		const user = userEvent.setup();
		await renderEditor('expanded');
		const execute = vi.spyOn(lastOpened(), 'execute');
		await user.click(screen.getByRole('button', { name: 'More' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Place picture…' }));
		fireEvent.change(screen.getByLabelText('Picture to place'), {
			target: { files: [PICTURE] },
		});
		await waitFor(() => expect(execute).toHaveBeenCalledWith(placed));
		expect(exporting.placePicture).toHaveBeenCalledWith(lastOpened(), PICTURE, 'layer-1');
	});

	it('places a picture pasted, but not one pasted into a field', async () => {
		await renderEditor('expanded');
		const paste = (target: EventTarget) => {
			const event = new Event('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: { files: [PICTURE] } });
			target.dispatchEvent(event);
			return event;
		};
		const field = window.document.createElement('input');
		window.document.body.appendChild(field);
		paste(field);
		expect(exporting.placePicture).not.toHaveBeenCalled();
		expect(paste(window.document.body).defaultPrevented).toBe(true);
		await waitFor(() => expect(exporting.placePicture).toHaveBeenCalledTimes(1));
		field.remove();
	});

	it('places a picture dropped on the canvas, and says so of a file that is not one', async () => {
		await renderEditor('expanded');
		const canvas = screen.getByRole('region', { name: 'Canvas' }).parentElement;
		if (canvas === null) throw new Error('the canvas is in a frame');
		fireEvent.drop(canvas, { dataTransfer: { files: [PICTURE], types: ['Files'] } });
		await waitFor(() => expect(exporting.placePicture).toHaveBeenCalledTimes(1));
		const text = new File(['words'], 'notes.txt', { type: 'text/plain' });
		fireEvent.drop(canvas, { dataTransfer: { files: [text], types: ['Files'] } });
		expect(
			await screen.findByText(
				'This file cannot be placed. A picture in PNG, JPEG, GIF, WebP or SVG can.'
			)
		).toBeDefined();
		expect(exporting.placePicture).toHaveBeenCalledTimes(1);
	});

	it('says so when the picture could not be read', async () => {
		exporting.placePicture.mockResolvedValue(undefined);
		await renderEditor('expanded');
		const canvas = screen.getByRole('region', { name: 'Canvas' }).parentElement;
		if (canvas === null) throw new Error('the canvas is in a frame');
		fireEvent.drop(canvas, { dataTransfer: { files: [PICTURE], types: ['Files'] } });
		expect(
			await screen.findByText(
				'This file cannot be placed. A picture in PNG, JPEG, GIF, WebP or SVG can.'
			)
		).toBeDefined();
	});

	it('opens the export dialog from More, with the drawing’s title', async () => {
		const user = userEvent.setup();
		await renderEditor('compact');
		await user.click(screen.getByRole('button', { name: 'More' }));
		await user.click(await screen.findByRole('menuitem', { name: 'Export…' }));
		const dialog = await screen.findByRole('dialog', { name: 'Export' });
		expect(within(dialog).getByText('Harbor')).toBeDefined();
		await user.click(within(dialog).getByRole('button', { name: 'Close the export' }));
		await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export' })).toBeNull());
	});
});
