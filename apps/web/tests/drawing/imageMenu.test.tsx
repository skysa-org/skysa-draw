import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MenuItem } from '../../src/components/ui/Menu.js';
import type { CanvasJob } from '../../src/drawing/document/canvasOps.js';
import * as canvasOps from '../../src/drawing/document/canvasOps.js';
import type { Command, EditorDocument } from '../../src/drawing/document/model.js';
import { imageMenuItems, useImageMenu } from '../../src/drawing/panels/imageMenu.js';
import type { LayerExtent } from '../../src/drawing/tools/common/align.js';
import { layerExtentIn } from '../../src/drawing/viewport/layerExtent.js';

/**
 * The Image operations under More (docs/decisions/0004-the-interface.md):
 * the items in Photoshop's order, the dialogs they open in the frame's place
 * for them, and what each asks of `canvasOps.ts`, whose own tests say what
 * that does to the drawing. A fixed turn or flip is executed at once as the
 * command it makes; a dialog's Apply makes and executes one, or runs the job
 * that measures first; a job that changed nothing says why.
 */

const ops = vi.hoisted(() => {
	const command = (label: string) => ({
		label,
		apply: () => undefined,
		revert: () => undefined,
		bytes: 1,
	});
	return { command };
});

vi.mock('../../src/drawing/document/canvasOps.js', () => ({
	turnCanvas: vi.fn((_root: unknown, _opened: unknown, turn: string) => ops.command(turn)),
	rotateCanvas: vi.fn(() => ops.command('rotate')),
	resizeCanvas: vi.fn(() => ops.command('canvasSize')),
	resizeImage: vi.fn(() => Promise.resolve('done')),
	trimCanvas: vi.fn(() => Promise.resolve('done')),
	revealAll: vi.fn(() => Promise.resolve('done')),
}));

const EXTENT: LayerExtent = () => Promise.resolve(undefined);

vi.mock('../../src/drawing/viewport/layerExtent.js', () => ({
	layerExtentIn: vi.fn(() => EXTENT),
}));

/** A drawing of 1600 × 1000, as the frame has it: only what the items read and what they execute. */
const drawing = (): EditorDocument & { execute: ReturnType<typeof vi.fn> } => {
	const root = window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	root.setAttribute('viewBox', '0 0 1600 1000');
	return {
		root,
		prolog: '',
		size: { width: 1600, height: 1000 },
		snapshot: () => {
			throw new Error('not read here');
		},
		text: () => '',
		layer: () => undefined,
		execute: vi.fn<(command: Command) => void>(),
		undo: () => undefined,
		redo: () => undefined,
		subscribe: () => () => undefined,
		pending: () => undefined,
		settle: () => Promise.resolve(),
	};
};

/** The items as buttons, a submenu's after its own, and the dialogs, as the frame places them. */
const Harness = ({
	document,
	busy = false,
	notify,
}: Readonly<{ document: EditorDocument; busy?: boolean; notify: (message: string) => void }>) => {
	const image = useImageMenu({ document, placement: 'drawer', busy, notify });
	const flat = image.items.flatMap((item) => [item, ...(item.submenu ?? [])]);
	return (
		<>
			<nav aria-label="Image">
				{flat.map((item) => (
					<button
						key={item.id}
						type="button"
						disabled={item.disabled}
						onClick={item.onSelect}
					>
						{item.label}
					</button>
				))}
			</nav>
			{image.dialogs}
		</>
	);
};

const setup = (busy = false) => {
	const document = drawing();
	const notify = vi.fn<(message: string) => void>();
	const view = render(<Harness document={document} busy={busy} notify={notify} />);
	const item = (name: string) =>
		within(screen.getByRole('navigation', { name: 'Image' })).getByRole('button', { name });
	return { document, notify, view, item };
};

const NO_ACTIONS = { ask: () => undefined, turn: () => undefined, revealAll: () => undefined };

const shape = (items: readonly MenuItem[]) =>
	items.map((item) => [item.label, item.disabled === true, item.separatorBefore === true]);

describe('the Image operations', () => {
	beforeEach(() => {
		vi.mocked(canvasOps.turnCanvas).mockClear();
		vi.mocked(canvasOps.rotateCanvas).mockClear();
		vi.mocked(canvasOps.resizeCanvas).mockClear();
		vi.mocked(canvasOps.resizeImage).mockReset().mockResolvedValue('done');
		vi.mocked(canvasOps.trimCanvas).mockReset().mockResolvedValue('done');
		vi.mocked(canvasOps.revealAll).mockReset().mockResolvedValue('done');
		vi.mocked(layerExtentIn).mockClear();
	});

	it('lists Photoshop’s Image items in its order, and Image rotation’s turns, then its flips', () => {
		const items = imageMenuItems(NO_ACTIONS, false);
		expect(shape(items)).toEqual([
			['Image size…', false, false],
			['Canvas size…', false, false],
			['Image rotation', false, false],
			['Trim…', false, false],
			['Reveal all', false, false],
		]);
		expect(shape(items[2]?.submenu ?? [])).toEqual([
			['180°', false, false],
			['90° clockwise', false, false],
			['90° counterclockwise', false, false],
			['Arbitrary…', false, false],
			['Flip canvas horizontal', false, true],
			['Flip canvas vertical', false, false],
		]);
		expect(imageMenuItems(NO_ACTIONS, true).every((item) => item.disabled === true)).toBe(true);
	});

	it.each([
		['180°', 'rotate180'],
		['90° clockwise', 'rotate90cw'],
		['90° counterclockwise', 'rotate90ccw'],
		['Flip canvas horizontal', 'flipHorizontal'],
		['Flip canvas vertical', 'flipVertical'],
	] as const)('turns or flips the canvas at once with %s, as one command', (name, turn) => {
		const { document, item, notify } = setup();
		fireEvent.click(item(name));
		expect(canvasOps.turnCanvas).toHaveBeenCalledWith(document.root, document.size, turn);
		expect(document.execute).toHaveBeenCalledWith(expect.objectContaining({ label: turn }));
		expect(notify).not.toHaveBeenCalled();
	});

	it('rotates by the angle Arbitrary… asks, clockwise positive, and not by none', async () => {
		const user = userEvent.setup();
		const { document, item } = setup();
		await user.click(item('Arbitrary…'));
		const dialog = await screen.findByRole('dialog', { name: 'Rotate canvas' });
		await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		expect(canvasOps.rotateCanvas).not.toHaveBeenCalled();

		await user.click(item('Arbitrary…'));
		const again = await screen.findByRole('dialog', { name: 'Rotate canvas' });
		fireEvent.change(within(again).getByRole('spinbutton', { name: 'Angle' }), {
			target: { value: '30' },
		});
		await user.click(within(again).getByRole('radio', { name: 'Counterclockwise' }));
		await user.click(within(again).getByRole('button', { name: 'Apply' }));
		expect(canvasOps.rotateCanvas).toHaveBeenCalledWith(document.root, document.size, -30);
		expect(document.execute).toHaveBeenCalledWith(expect.objectContaining({ label: 'rotate' }));
	});

	it('sets the canvas’s size from the anchor Canvas size… asks, and not to the size it has', async () => {
		const user = userEvent.setup();
		const { document, item } = setup();
		await user.click(item('Canvas size…'));
		const dialog = await screen.findByRole('dialog', { name: 'Canvas size' });
		expect(within(dialog).getByText('Current size: 1,600 × 1,000 px')).toBeDefined();
		await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
		expect(canvasOps.resizeCanvas).not.toHaveBeenCalled();

		await user.click(item('Canvas size…'));
		const again = await screen.findByRole('dialog', { name: 'Canvas size' });
		fireEvent.change(within(again).getByRole('spinbutton', { name: 'Width' }), {
			target: { value: '2000' },
		});
		await user.click(within(again).getByRole('radio', { name: 'Top' }));
		await user.click(within(again).getByRole('button', { name: 'Apply' }));
		expect(canvasOps.resizeCanvas).toHaveBeenCalledWith(
			document.root,
			document.size,
			{ width: 2000, height: 1000 },
			'top'
		);
		expect(document.execute).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'canvasSize' })
		);
	});

	it('resizes the image as Image size… asks, and says when it is that size already', async () => {
		const user = userEvent.setup();
		const { document, item, notify } = setup();
		vi.mocked(canvasOps.resizeImage).mockResolvedValue('nothing');
		await user.click(item('Image size…'));
		const dialog = await screen.findByRole('dialog', { name: 'Image size' });
		fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Width' }), {
			target: { value: '800' },
		});
		await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
		expect(canvasOps.resizeImage).toHaveBeenCalledWith(document, {
			width: 800,
			height: 500,
			resample: true,
		});
		await waitFor(() => expect(notify).toHaveBeenCalledWith('The image is already that size.'));
	});

	it('trims as Trim… asks, measured by the layers’ extent, and says when there is nothing to trim', async () => {
		const user = userEvent.setup();
		const { document, item, notify } = setup();
		vi.mocked(canvasOps.trimCanvas).mockResolvedValue('nothing');
		await user.click(item('Trim…'));
		const dialog = await screen.findByRole('dialog', { name: 'Trim' });
		await user.click(within(dialog).getByRole('button', { name: 'Right' }));
		await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
		expect(layerExtentIn).toHaveBeenCalledWith(document);
		expect(canvasOps.trimCanvas).toHaveBeenCalledWith(
			document,
			'transparent',
			{ top: true, bottom: true, left: true, right: false },
			EXTENT
		);
		await waitFor(() => expect(notify).toHaveBeenCalledWith('There is nothing to trim.'));
	});

	it.each([
		['done', undefined],
		['nothing', 'Everything is already on the canvas.'],
		['changed', 'The drawing changed before this could finish, so it is as it was. Try again.'],
		[
			'unrenderable',
			'This browser could not read the picture of a layer, so the drawing is as it was.',
		],
	] as const)(
		'reveals all at once, measured by the layers’ extent, and says what came of %s',
		async (outcome: CanvasJob, said: string | undefined) => {
			const { document, item, notify } = setup();
			vi.mocked(canvasOps.revealAll).mockResolvedValue(outcome);
			fireEvent.click(item('Reveal all'));
			expect(canvasOps.revealAll).toHaveBeenCalledWith(document, EXTENT);
			await waitFor(() => expect(item('Reveal all')).toHaveProperty('disabled', false));
			if (said === undefined) expect(notify).not.toHaveBeenCalled();
			else expect(notify).toHaveBeenCalledWith(said);
		}
	);

	it('says so when a job fails outright', async () => {
		const { item, notify } = setup();
		vi.mocked(canvasOps.revealAll).mockRejectedValue(new Error('broken'));
		fireEvent.click(item('Reveal all'));
		await waitFor(() =>
			expect(notify).toHaveBeenCalledWith(
				'That could not be done, so the drawing is as it was.'
			)
		);
	});

	it('disables every item while a job is under way, and while the frame says so', async () => {
		const pending: { resolve?: (outcome: CanvasJob) => void } = {};
		vi.mocked(canvasOps.revealAll).mockReturnValue(
			new Promise((resolve) => {
				pending.resolve = resolve;
			})
		);
		const { item, view, document, notify } = setup();
		fireEvent.click(item('Reveal all'));
		for (const name of ['Image size…', 'Canvas size…', 'Image rotation', 'Trim…', 'Reveal all'])
			expect(item(name)).toHaveProperty('disabled', true);
		await act(async () => {
			pending.resolve?.('done');
			await Promise.resolve();
		});
		await waitFor(() => expect(item('Trim…')).toHaveProperty('disabled', false));

		view.rerender(<Harness document={document} busy notify={notify} />);
		expect(item('Image size…')).toHaveProperty('disabled', true);
		expect(item('Image rotation')).toHaveProperty('disabled', true);
	});

	it('closes a dialog asked of one drawing when another is opened', async () => {
		const user = userEvent.setup();
		const { item, view, notify } = setup();
		await user.click(item('Image size…'));
		await screen.findByRole('dialog', { name: 'Image size' });
		view.rerender(<Harness document={drawing()} notify={notify} />);
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});
});
