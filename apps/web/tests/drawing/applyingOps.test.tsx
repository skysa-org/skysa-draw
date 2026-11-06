import { emptyDrawing } from '@skysa/draw-core';
import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from '@testing-library/react';
import type { DragEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type Apply, ApplyingProvider } from '../../src/components/ui/Applying.js';
import { addLayer } from '../../src/drawing/document/commands.js';
import type { EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { usePlacePicture } from '../../src/drawing/document/usePlacePicture.js';
import { placePicture } from '../../src/drawing/export/place.js';
import { layerMenuItems } from '../../src/drawing/panels/layerMenu.js';
import { ModifyDialog } from '../../src/drawing/panels/ModifyDialog.js';
import { rectPath } from '../../src/drawing/tools/raster/area.js';
import { fillAreaWith } from '../../src/drawing/tools/raster/areaFill.js';
import { modifyArea } from '../../src/drawing/tools/raster/areaOps.js';
import { clearArea, fillArea, layerViaArea } from '../../src/drawing/tools/raster/index.js';
import type { ToolContext } from '../../src/drawing/tools/types.js';
import {
	type SelectionCommandDeps,
	useSelectionCommands,
} from '../../src/drawing/viewport/selectionCommands.js';
import { createViewportSelection } from '../../src/drawing/viewport/selectionState.js';

/**
 * The work on a whole layer that is done under the frame's indicator
 * (`components/ui/Applying.tsx`), each in its own words: what the
 * selection's actions write into a raster layer's pixels, the layers panel's
 * merge, a picture placed, and Modify…. Each still does what it did, once the
 * indicator is in place; what is quick, and Content-Aware with its own line,
 * is done plainly.
 */

vi.mock('../../src/drawing/tools/raster/index.js', async (original) => ({
	...(await original<Record<string, unknown>>()),
	clearArea: vi.fn(() => true),
	fillArea: vi.fn(() => true),
	layerViaArea: vi.fn(() => Promise.resolve('layer-9')),
}));

vi.mock('../../src/drawing/tools/raster/areaFill.js', async (original) => ({
	...(await original<Record<string, unknown>>()),
	fillAreaWith: vi.fn(() => true),
}));

vi.mock('../../src/drawing/export/place.js', async (original) => ({
	...(await original<Record<string, unknown>>()),
	placePicture: vi.fn(),
}));

const DRAWING_ID = '11111111-2222-4333-8444-555555555555';

const open = (): EditorDocument => {
	const document = openDocument(emptyDrawing({ id: DRAWING_ID }));
	if (document === undefined) throw new Error('a drawing opens');
	return document;
};

const cover = () => window.document.querySelector('.applying');

/** The words on the indicator's card, there from the start though seen only after 300 ms. */
const shown = () => cover()?.querySelector('.applying-card')?.textContent;

const RASTER: LayerInfo = {
	id: 'layer-1',
	kind: 'raster',
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: 0,
	parentId: undefined,
	loose: false,
};

const AREA = { path: 'M0 0H100V100H0Z', inverted: false, feather: 0 };

/** The selection's actions as the viewport makes them, inside the frame's indicator, with an area on a raster layer. */
const commandsOn = (document: EditorDocument) => {
	const selection = createViewportSelection();
	selection.region.set(AREA);
	const context = { layer: RASTER } as unknown as ToolContext;
	const activate = vi.fn<(id: string) => void>();
	const deps: SelectionCommandDeps = {
		document,
		layer: RASTER,
		canvas: { x: 0, y: 0, width: 800, height: 600 },
		toolId: 'marquee',
		selection,
		busy: () => false,
		context: () => context,
		overlay: () => null,
		notify: () => undefined,
		activate,
		transform: { start: () => false, apply: () => false, cancel: () => false },
	};
	const { result } = renderHook(() => useSelectionCommands(deps), {
		wrapper: ApplyingProvider,
	});
	return { commands: () => result.current, context, selection, activate };
};

/** `act`, in React's turn, and what it gave back. */
const now = <T,>(work: () => T): T => {
	const given: { value?: T } = {};
	act(() => {
		given.value = work();
	});
	return given.value as T;
};

describe('the selection’s pixel work under the frame’s indicator', () => {
	beforeEach(() => {
		vi.mocked(clearArea).mockClear();
		vi.mocked(fillArea).mockClear();
		vi.mocked(fillAreaWith).mockClear();
		vi.mocked(layerViaArea).mockClear();
	});

	it.each([
		['fill', fillArea, 'Filling the selection…'],
		['clear', clearArea, 'Clearing the selection…'],
		['delete', clearArea, 'Clearing the selection…'],
	] as const)(
		'does %s under it, the action done as soon as asked',
		async (action, work, words) => {
			const document = open();
			const { commands, context } = commandsOn(document);
			expect(now(() => commands().run(action))).toBe(true);
			expect(shown()).toBe(words);
			// Begun once the indicator is in place.
			expect(work).not.toHaveBeenCalled();
			await waitFor(() => expect(work).toHaveBeenCalledWith(context));
			await waitFor(() => expect(cover()).toBeNull());
		}
	);

	it('stays until what the work wrote is written, its encoding included', async () => {
		const document = open();
		const written: { resolve?: () => void } = {};
		const settle = vi.spyOn(document, 'settle').mockReturnValue(
			new Promise<void>((resolve) => {
				written.resolve = resolve;
			})
		);
		const { commands } = commandsOn(document);
		now(() => commands().run('fill'));
		await waitFor(() => expect(settle).toHaveBeenCalled());
		await waitFor(() =>
			expect(window.document.querySelector('[role="status"]')?.textContent).toBe(
				'Filling the selection…'
			)
		);
		act(() => written.resolve?.());
		await waitFor(() => expect(cover()).toBeNull());
	});

	it('fills with the stroke color, and as Fill… asks, under it; Content-Aware, with its own line, plainly', async () => {
		const document = open();
		const { commands, context } = commandsOn(document);
		now(() => commands().run('fillWithStroke'));
		expect(shown()).toBe('Filling the selection…');
		await waitFor(() =>
			expect(fillAreaWith).toHaveBeenCalledWith(
				context,
				expect.objectContaining({ contents: 'stroke' })
			)
		);
		await waitFor(() => expect(cover()).toBeNull());

		const spec = {
			contents: 'color',
			color: '#336699',
			mode: 'multiply',
			opacity: 0.5,
			preserveTransparency: true,
		} as const;
		vi.mocked(fillAreaWith).mockClear();
		expect(now(() => commands().fillWith(spec))).toBe(true);
		expect(fillAreaWith).not.toHaveBeenCalled();
		expect(shown()).toBe('Filling the selection…');
		await waitFor(() => expect(fillAreaWith).toHaveBeenCalledWith(context, spec));
		await waitFor(() => expect(cover()).toBeNull());

		vi.mocked(fillAreaWith).mockClear();
		const aware = { ...spec, contents: 'contentAware' } as const;
		expect(now(() => commands().fillWith(aware))).toBe(true);
		expect(fillAreaWith).toHaveBeenCalledWith(context, aware);
		expect(cover()).toBeNull();
	});

	it.each([
		['copy', 'Copying the selection to a new layer…'],
		['cut', 'Cutting the selection to a new layer…'],
	] as const)(
		'makes a layer via %s under it, makes it active and drops the area',
		async (how, words) => {
			const document = open();
			const { commands, context, selection, activate } = commandsOn(document);
			now(() => commands().run(how === 'copy' ? 'layerViaCopy' : 'layerViaCut'));
			expect(layerViaArea).not.toHaveBeenCalled();
			expect(shown()).toBe(words);
			await waitFor(() => expect(activate).toHaveBeenCalledWith('layer-9'));
			expect(layerViaArea).toHaveBeenCalledWith(context, how);
			expect(selection.region.get()).toBeUndefined();
			await waitFor(() => expect(cover()).toBeNull());
		}
	);

	it('keeps the area where no layer was made', async () => {
		vi.mocked(layerViaArea).mockReturnValueOnce(Promise.resolve(undefined));
		const document = open();
		const { commands, selection, activate } = commandsOn(document);
		now(() => commands().run('layerViaCopy'));
		await waitFor(() => expect(cover()).toBeNull());
		expect(layerViaArea).toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
		expect(selection.region.get()).toEqual(AREA);
	});
});

describe('the layer menu’s work under the frame’s indicator', () => {
	/** The menu for a drawing of two vector layers, the top one active, with `apply` watched. */
	const menu = () => {
		const document = open();
		const made = addLayer(document.root, 'vector');
		document.execute(made);
		const snapshot = document.snapshot();
		const active = snapshot.layers.find((layer) => layer.id === made.id);
		const applied = vi.fn<(words: string | undefined) => void>();
		const apply: Apply = (work, words) => {
			applied(words);
			return new Promise((resolve) => resolve(work()));
		};
		const onActivate = vi.fn<(id: string) => void>();
		const onNotify = vi.fn<(message: string) => void>();
		const items = layerMenuItems({
			document,
			snapshot,
			active,
			chosen: [made.id],
			order: snapshot.layers.map((layer) => layer.id),
			onActivate,
			onSelectLayers: () => undefined,
			onShowGroups: () => undefined,
			onNotify,
			apply,
		});
		const choose = (id: string) => {
			const item = items.find((each) => each.id === id);
			if (item === undefined) throw new Error(`${id} is offered`);
			item.onSelect();
		};
		return { document, applied, onActivate, onNotify, choose };
	};

	it('merges down under it, and the layer below is active after', async () => {
		const { document, applied, onActivate, choose } = menu();
		choose('merge');
		expect(applied).toHaveBeenCalledExactlyOnceWith('Merging the layers…');
		await waitFor(() => expect(onActivate).toHaveBeenCalledWith('layer-1'));
		expect(document.snapshot().layers.map((layer) => layer.id)).toEqual(['layer-1']);
	});

	it.each(['group', 'down', 'clip', 'rasterize'])('does %s plainly', (id) => {
		const { applied, choose } = menu();
		choose(id);
		expect(applied).not.toHaveBeenCalled();
	});
});

describe('a picture placed under the frame’s indicator', () => {
	beforeEach(() => {
		vi.mocked(placePicture).mockReset();
	});

	const CANNOT_PLACE =
		'This file cannot be placed. A picture in PNG, JPEG, GIF, WebP or SVG can.';

	/** The frame's way of placing a picture above `layer-1`, inside the indicator. */
	const placingOn = (document: EditorDocument) => {
		const onPlaced = vi.fn<(id: string) => void>();
		const onNotify = vi.fn<(message: string) => void>();
		const { result } = renderHook(
			() => usePlacePicture(document, 'layer-1', onPlaced, onNotify),
			{ wrapper: ApplyingProvider }
		);
		return { placing: () => result.current, onPlaced, onNotify };
	};

	/** A drop on the canvas of `files`, as the browser gives it, and its `preventDefault`, watched. */
	const dropOf = (files: readonly File[]) => {
		const prevented = vi.fn();
		const event = {
			dataTransfer: { files, types: ['Files'] },
			preventDefault: prevented,
		} as unknown as DragEvent<HTMLElement>;
		return { event, prevented };
	};

	it('reads the picture once the indicator is in place, in its words, and goes once the layer is there', async () => {
		const document = open();
		const pending = vi.spyOn(document, 'pending');
		const execute = vi.spyOn(document, 'execute');
		const read: { resolve?: (command: ReturnType<typeof addLayer>) => void } = {};
		vi.mocked(placePicture).mockReturnValueOnce(
			new Promise((resolve) => {
				read.resolve = resolve;
			})
		);
		const { placing, onPlaced } = placingOn(document);
		const file = new File(['bytes'], 'big.jpg', { type: 'image/jpeg' });
		act(() => placing().place(file));
		// The document's pending work from the start, so a save waits for it.
		expect(pending).toHaveBeenCalledTimes(1);
		expect(shown()).toBe('Placing the picture…');
		expect(placePicture).not.toHaveBeenCalled();
		await waitFor(() => expect(placePicture).toHaveBeenCalledWith(document, file, 'layer-1'));
		await waitFor(() =>
			expect(screen.getByRole('status').textContent).toBe('Placing the picture…')
		);

		const command = addLayer(document.root, 'raster');
		act(() => read.resolve?.(command));
		await waitFor(() => expect(cover()).toBeNull());
		expect(execute).toHaveBeenCalledWith(command);
		expect(onPlaced).toHaveBeenCalledWith(command.id);
	});

	it('places a picture dropped on the canvas under it, and says at once that a file of another kind is none', async () => {
		vi.mocked(placePicture).mockResolvedValueOnce(undefined);
		const document = open();
		const { placing, onNotify } = placingOn(document);
		const picture = new File(['bytes'], 'big.png', { type: 'image/png' });
		const drop = dropOf([picture]);
		act(() => placing().onDrop(drop.event));
		expect(drop.prevented).toHaveBeenCalled();
		expect(shown()).toBe('Placing the picture…');
		await waitFor(() =>
			expect(placePicture).toHaveBeenCalledWith(document, picture, 'layer-1')
		);
		// One the browser would not read is said so, as it was.
		await waitFor(() => expect(onNotify).toHaveBeenCalledWith(CANNOT_PLACE));
		await waitFor(() => expect(cover()).toBeNull());

		onNotify.mockClear();
		act(() =>
			placing().onDrop(
				dropOf([new File(['words'], 'notes.txt', { type: 'text/plain' })]).event
			)
		);
		expect(onNotify).toHaveBeenCalledExactlyOnceWith(CANNOT_PLACE);
		expect(cover()).toBeNull();
	});
});

describe('Modify… under the frame’s indicator', () => {
	const CANVAS = { x: 0, y: 0, width: 400, height: 300 } as const;
	const SQUARE = {
		path: rectPath({ x: 40, y: 30, width: 120, height: 80 }) ?? '',
		inverted: false,
		feather: 0,
	};

	const modifying = () => {
		const onApply = vi.fn();
		const onClose = vi.fn();
		render(
			<ApplyingProvider>
				<ModifyDialog
					placement="drawer"
					open
					region={SQUARE}
					canvas={CANVAS}
					onApply={onApply}
					onClose={onClose}
				/>
			</ApplyingProvider>
		);
		const dialog = screen.getByRole('dialog', { name: 'Modify selection' });
		const field = () => within(dialog).getByRole('spinbutton');
		const applyButton = within(dialog).getByRole('button', { name: 'Apply' });
		return { dialog, field, applyButton, onApply, onClose };
	};

	it('closes at once, and makes and sets the area under it, in its words', async () => {
		const { field, applyButton, onApply, onClose } = modifying();
		fireEvent.change(field(), { target: { value: '20' } });
		fireEvent.click(applyButton);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onApply).not.toHaveBeenCalled();
		expect(shown()).toBe('Modifying the selection…');
		await waitFor(() =>
			expect(onApply).toHaveBeenCalledExactlyOnceWith(
				modifyArea(SQUARE, 'expand', 20, CANVAS)
			)
		);
		await waitFor(() => expect(cover()).toBeNull());
	});

	it('feathers plainly, setting the area’s own feather at once', () => {
		const { dialog, field, applyButton, onApply } = modifying();
		fireEvent.click(within(dialog).getByRole('radio', { name: 'Feather' }));
		fireEvent.change(field(), { target: { value: '5' } });
		fireEvent.click(applyButton);
		expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...SQUARE, feather: 5 });
		expect(cover()).toBeNull();
	});
});
