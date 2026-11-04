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
import { createDrawing, deleteDrawing, saveDrawing } from '../../src/store/drawings.js';
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
	const open = vi.fn((text: string): EditorDocument | undefined => {
		if (text.includes(`<title>Broken</title>`)) return undefined;
		const listeners = new Set<() => void>();
		const state = { text, dirty: false, version: 0 };
		const snapshot = (): DocumentSnapshot => ({
			layers: [
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
	return { undo, redo, opened, open };
});

vi.mock('../../src/drawing/document/openDocument.js', () => ({ openDocument: fake.open }));

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

const renderEditor = async (width: Width, title = 'Harbour', folderPath = ROOT) => {
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

const rowText = async (db: DrawDatabase, id: string) => (await db.drawings.get(id))?.text;

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
		await renderEditor('compact', 'Harbour at dusk');
		expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Harbour at dusk');
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

	it('swaps the colours with X, as the swatch on the colour button shows', async () => {
		await renderEditor('compact');
		const swatch = () =>
			screen.getByRole('button', { name: 'Colour' }).querySelector('.swatch');
		expect(swatch()?.classList.contains('swatch-none')).toBe(false);
		// The default stroke is none, so after the swap the fill is.
		fireEvent.keyDown(window, { key: 'x' });
		await waitFor(() => expect(swatch()?.classList.contains('swatch-none')).toBe(true));
	});

	it('closes a sheet with Escape, and it stays closed', async () => {
		const user = userEvent.setup();
		await renderEditor('compact');
		await user.click(screen.getByRole('button', { name: 'Colour' }));
		expect(await screen.findByRole('dialog', { name: 'Colour' })).toBeDefined();

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

describe('the editor saving', () => {
	it('saves an edit into the row after a pause, and says so', async () => {
		const { db, made } = await renderEditor('expanded');
		const edited = withDrawingId(
			emptyDrawing({ id: made.id, title: 'Harbour' }),
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
		const rows = await db.drawings.toArray();
		expect(rows).toHaveLength(2);
		const copy = rows.find((row) => row.id !== made.id);
		if (copy === undefined) throw new Error('no copy was kept');

		// The other change keeps the drawing, its path and its id.
		expect(await rowText(db, made.id)).toBe(theirs);
		expect((await db.drawings.get(made.id))?.path).toBe(made.path);
		// The edits are a drawing of their own: a new id, a conflict name and a
		// title that says what it is, the editor's text otherwise.
		expect(readDrawingId(copy.text)).toBe(copy.id);
		expect(copy.title).toMatch(/^Harbour \(conflict \d{4}-\d\d-\d\dT\d\d-\d\d\)$/);
		expect(copy.path).toMatch(/^harbour \(conflict \d{4}-\d\d-\d\dT\d\d-\d\d\)\.svg$/);
		expect(readDrawingTitle(copy.text)).toBe(copy.title);
		expect(copy.text).toBe(withDrawingId(withDrawingTitle(mine, copy.title), copy.id));
		expect(notice.textContent).toContain(`“${copy.title}”`);
		expect(await db.opQueue.where('drawingId').equals(copy.id).toArray()).toEqual([
			expect.objectContaining({ op: 'create', path: copy.path }),
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
		const copy = (await db.drawings.toArray()).find((row) => row.id !== made.id);
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
		const made = await createDrawing(db, { title: 'Harbour' });
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
		await db.drawings.delete(made.id);
		expect(await screen.findByText(/This drawing is not on this device/)).toBeDefined();
		await pastTheSave();
		expect(await db.drawings.count()).toBe(0);
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
		expect(await db.drawings.count()).toBe(0);
		expect(onReplaced).not.toHaveBeenCalled();
	});
});

describe('the drawing open deleted under unsaved edits', () => {
	it('elsewhere: keeps the edits as a new drawing in its place, and moves to it', async () => {
		const { db, made, onReplaced } = await renderEditor('expanded', 'Harbour', 'Work');
		const mine = made.text.replace('</svg>', '<g id="layer-2"/></svg>');
		// Edited, and not yet saved: the save would come after the pause.
		act(() => lastOpened().edit(mine, true));
		// Another tab's delete, as it would make it.
		await deleteDrawing(db, made.id);

		const notice = await screen.findByText(/This drawing was deleted elsewhere/);
		const rows = await db.drawings.toArray();
		expect(rows).toHaveLength(1);
		const [kept] = rows;
		if (kept === undefined) throw new Error('nothing was kept');
		expect(onReplaced).toHaveBeenCalledExactlyOnceWith(kept.id);

		// A drawing of its own, where the deleted one was: a new id, since the
		// old one now means deleted; the same folder, connection and title, and
		// a name by the folder's usual rule, which nothing else holds now.
		expect(kept.id).not.toBe(made.id);
		expect(await db.drawings.get(made.id)).toBeUndefined();
		expect(readDrawingId(kept.text)).toBe(kept.id);
		expect(kept.text).toBe(withDrawingId(mine, kept.id));
		expect(kept.title).toBe('Harbour');
		expect(kept.path).toBe('Work/harbour.svg');
		expect(kept.connectionId).toBe(made.connectionId);
		expect(await db.opQueue.where('drawingId').equals(kept.id).toArray()).toEqual([
			expect.objectContaining({ op: 'create', path: kept.path }),
		]);
		expect(notice.textContent).toContain('“Harbour”');

		// The editor is on it, and nothing more is kept, however long it waits.
		await waitFor(() => expect(fake.open).toHaveBeenLastCalledWith(kept.text));
		expect(screen.queryByText(/This drawing is not on this device/)).toBeNull();
		await pastTheSave();
		expect(await db.drawings.count()).toBe(1);
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
		const [kept] = await db.drawings.toArray();
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
		const rows = await db.drawings.toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.title).toMatch(/^Harbour \(conflict /);
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
		expect(await db.drawings.count()).toBe(0);
		expect(await db.opQueue.toArray()).toEqual([]);
		expect(onReplaced).not.toHaveBeenCalled();
	});
});
