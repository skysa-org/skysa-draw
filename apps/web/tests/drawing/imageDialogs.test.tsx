import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Anchor } from '../../src/drawing/document/canvasOps.js';
import { anchorAfter, ANCHORS } from '../../src/drawing/panels/AnchorGrid.js';
import {
	CanvasSizeDialog,
	type CanvasSizeRequest,
} from '../../src/drawing/panels/CanvasSizeDialog.js';
import {
	ImageSizeDialog,
	type ImageSizeRequest,
} from '../../src/drawing/panels/ImageSizeDialog.js';
import { RotateDialog } from '../../src/drawing/panels/RotateDialog.js';
import { TrimDialog, type TrimRequest } from '../../src/drawing/panels/TrimDialog.js';
import { t } from '../../src/i18n/t.js';

/**
 * The Image operations' dialogs (docs/decisions/0004-the-interface.md), as
 * Photoshop's Image menu asks them: Image size's width and height linked by
 * Constrain proportions, and Resample; Canvas size's width and height,
 * Relative and the anchor; Arbitrary…'s angle and its way; Trim's basis and
 * its sides. Apply or Enter asks for what the fields say, Cancel and Escape
 * leave the drawing. What each was last applied with is where its next
 * opening starts, for the page's life, so the tests of a dialog run in
 * their order: the first sees it as it first opens, and each after it
 * chooses what it reads.
 */

const CANVAS = { width: 1600, height: 1000 } as const;

const field = (dialog: HTMLElement, name: string) =>
	within(dialog).getByRole('spinbutton', { name });

const toggle = (dialog: HTMLElement, name: string) => within(dialog).getByRole('button', { name });

const pressed = (button: HTMLElement) => button.getAttribute('aria-pressed') === 'true';

const type = (input: HTMLElement, value: string) => {
	fireEvent.change(input, { target: { value } });
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Image size…', () => {
	const open = (placement: 'sheet' | 'drawer' = 'drawer') => {
		const onApply = vi.fn<(request: ImageSizeRequest) => void>();
		const onClose = vi.fn();
		const view = render(
			<ImageSizeDialog
				placement={placement}
				open
				canvas={CANVAS}
				onApply={onApply}
				onClose={onClose}
			/>
		);
		const dialog = screen.getByRole('dialog', { name: 'Image size' });
		return {
			onApply,
			onClose,
			view,
			dialog,
			width: field(dialog, 'Width'),
			height: field(dialog, 'Height'),
			constrain: toggle(dialog, 'Constrain proportions'),
			resample: toggle(dialog, 'Resample'),
			apply: within(dialog).getByRole('button', { name: 'Apply' }),
		};
	};

	it('first opens at the canvas’s size, linked and resampled, with the focus on the width, selected', async () => {
		const select = vi.spyOn(HTMLInputElement.prototype, 'select');
		const { dialog, width, height, constrain, resample } = open();
		expect(dialog.classList.contains('panel-drawer')).toBe(true);
		expect(within(dialog).getByText('Current size: 1,600 × 1,000 px')).toBeDefined();
		expect(width).toHaveProperty('value', '1600');
		expect(height).toHaveProperty('value', '1000');
		// The unit is said after the name, as the field's description.
		expect(within(dialog).getByRole('spinbutton', { name: 'Width', description: 'px' })).toBe(
			width
		);
		expect(pressed(constrain)).toBe(true);
		expect(pressed(resample)).toBe(true);
		await waitFor(() => expect(document.activeElement).toBe(width));
		expect(select.mock.contexts).toContain(width);
	});

	it('opens as a sheet on compact', () => {
		expect(open('sheet').dialog.classList.contains('panel-sheet')).toBe(true);
	});

	it('keeps the canvas’s proportions while linked, to the nearest pixel, and not once unlinked', async () => {
		const user = userEvent.setup();
		const { width, height, constrain } = open();
		type(width, '800');
		expect(height).toHaveProperty('value', '500');
		type(height, '333');
		expect(width).toHaveProperty('value', '533');
		// A field emptied to type another leaves the other as it was.
		type(width, '');
		expect(width).toHaveProperty('value', '');
		expect(height).toHaveProperty('value', '333');

		type(width, '800');
		await user.click(constrain);
		expect(pressed(constrain)).toBe(false);
		type(width, '1000');
		expect(height).toHaveProperty('value', '500');
		// Linked again, the height follows the width.
		await user.click(constrain);
		expect(height).toHaveProperty('value', '625');
	});

	it('takes no side under 1 px or over 300,000, and says which', async () => {
		const user = userEvent.setup();
		const { width, height, constrain, apply, onApply } = open();
		await user.click(constrain);
		for (const bad of ['', '0', '0.5', '300001', '-4']) {
			type(width, bad);
			expect(width.getAttribute('aria-invalid')).toBe('true');
			expect(height.getAttribute('aria-invalid')).toBeNull();
			expect(apply).toHaveProperty('disabled', true);
		}
		fireEvent.keyDown(height, { key: 'Enter' });
		expect(onApply).not.toHaveBeenCalled();
		type(width, '300000');
		expect(width.getAttribute('aria-invalid')).toBeNull();
		expect(apply).toHaveProperty('disabled', false);
	});

	it('asks for the size on Apply, or on Enter from a field, and closes', async () => {
		const user = userEvent.setup();
		const first = open();
		expect(pressed(first.constrain)).toBe(true);
		type(first.width, '3200');
		await user.click(first.apply);
		expect(first.onApply).toHaveBeenCalledWith({ width: 3200, height: 2000, resample: true });
		expect(first.onClose).toHaveBeenCalled();
		first.view.unmount();

		const second = open();
		type(second.height, '500');
		fireEvent.keyDown(second.height, { key: 'Enter' });
		expect(second.onApply).toHaveBeenCalledWith({ width: 800, height: 500, resample: true });
	});

	it('leaves Enter on a toggle to the toggle, and asks for nothing on Cancel or Escape', async () => {
		const user = userEvent.setup();
		const { width, resample, dialog, onApply, onClose } = open();
		await waitFor(() => expect(document.activeElement).toBe(width));
		act(() => resample.focus());
		await user.keyboard('{Enter}');
		expect(pressed(resample)).toBe(false);
		expect(onApply).not.toHaveBeenCalled();
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(1);
		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onApply).not.toHaveBeenCalled();
	});

	it('opens with the link and Resample as last applied, a Cancel forgetting nothing', async () => {
		const user = userEvent.setup();
		const first = open();
		// Canceled in the test before: still on.
		expect(pressed(first.resample)).toBe(true);
		await user.click(first.resample);
		await user.click(first.constrain);
		await user.click(first.apply);
		expect(first.onApply).toHaveBeenCalledWith({ width: 1600, height: 1000, resample: false });
		first.view.unmount();

		const second = open();
		expect(pressed(second.resample)).toBe(false);
		expect(pressed(second.constrain)).toBe(false);
		// The sizes are the canvas's each time.
		expect(second.width).toHaveProperty('value', '1600');
	});
});

describe('Canvas size…', () => {
	const open = () => {
		const onApply = vi.fn<(request: CanvasSizeRequest) => void>();
		const onClose = vi.fn();
		const view = render(
			<CanvasSizeDialog
				placement="drawer"
				open
				canvas={CANVAS}
				onApply={onApply}
				onClose={onClose}
			/>
		);
		const dialog = screen.getByRole('dialog', { name: 'Canvas size' });
		const anchors = within(dialog).getByRole('radiogroup', { name: 'Anchor' });
		return {
			onApply,
			onClose,
			view,
			dialog,
			anchors,
			width: field(dialog, 'Width'),
			height: field(dialog, 'Height'),
			relative: toggle(dialog, 'Relative'),
			apply: within(dialog).getByRole('button', { name: 'Apply' }),
			anchor: (name: string) => within(anchors).getByRole('radio', { name }),
		};
	};

	/** The anchor chosen, by its name. */
	const chosen = (anchors: HTMLElement) =>
		within(anchors)
			.getAllByRole('radio')
			.filter((radio) => radio.getAttribute('aria-checked') === 'true')
			.map((radio) => radio.getAttribute('aria-label'));

	it('first opens at the canvas’s size, not relative, from the center, with the focus on the width', async () => {
		const { dialog, width, height, relative, anchors } = open();
		expect(within(dialog).getByText('Current size: 1,600 × 1,000 px')).toBeDefined();
		expect(width).toHaveProperty('value', '1600');
		expect(height).toHaveProperty('value', '1000');
		expect(pressed(relative)).toBe(false);
		expect(chosen(anchors)).toEqual(['Center']);
		await waitFor(() => expect(document.activeElement).toBe(width));
		// No color for the new area: it is transparent.
		expect(within(dialog).queryByRole('combobox')).toBeNull();
		expect(within(dialog).queryByText(/color/i)).toBeNull();
	});

	it('names the nine squares in Photoshop’s order, one stop for Tab at the anchor', () => {
		const { anchors } = open();
		const radios = within(anchors).getAllByRole('radio');
		expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual(
			ANCHORS.map((each) => t(`image.canvasDialog.anchors.${each}`))
		);
		expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, -1, -1, 0, -1, -1, -1, -1]);
	});

	it('draws the anchor filled and an arrow away from it in each square around it, as Photoshop does', () => {
		const { anchor } = open();
		const angleOf = (name: string) =>
			anchor(name).querySelector('path')?.getAttribute('transform') ?? undefined;
		expect(anchor('Center').querySelector('rect')).not.toBeNull();
		expect(angleOf('Right')).toBe('rotate(0 12 12)');
		expect(angleOf('Bottom')).toBe('rotate(90 12 12)');
		expect(angleOf('Left')).toBe('rotate(180 12 12)');
		expect(angleOf('Top')).toBe('rotate(-90 12 12)');
		expect(angleOf('Bottom right')).toBe('rotate(45 12 12)');
		expect(angleOf('Top left')).toBe('rotate(-135 12 12)');

		fireEvent.click(anchor('Top left'));
		expect(anchor('Top left').querySelector('rect')).not.toBeNull();
		expect(angleOf('Top')).toBe('rotate(0 12 12)');
		expect(angleOf('Left')).toBe('rotate(90 12 12)');
		expect(angleOf('Center')).toBe('rotate(45 12 12)');
		// Two squares off: nothing.
		expect(anchor('Top right').querySelector('svg')).toBeNull();
		expect(anchor('Bottom right').querySelector('svg')).toBeNull();
	});

	it('moves the anchor with the arrows as on the canvas, stopping at the edges, and Home and End', () => {
		const { anchors, anchor } = open();
		const key = (key: string) => {
			const at = document.activeElement ?? anchors;
			fireEvent.keyDown(at, { key });
		};
		act(() => anchor('Center').focus());
		key('ArrowLeft');
		expect(chosen(anchors)).toEqual(['Left']);
		expect(document.activeElement).toBe(anchor('Left'));
		key('ArrowUp');
		expect(chosen(anchors)).toEqual(['Top left']);
		key('ArrowUp');
		key('ArrowLeft');
		expect(chosen(anchors)).toEqual(['Top left']);
		key('ArrowRight');
		key('ArrowDown');
		expect(chosen(anchors)).toEqual(['Center']);
		key('End');
		expect(chosen(anchors)).toEqual(['Bottom right']);
		expect(document.activeElement).toBe(anchor('Bottom right'));
		expect(anchor('Bottom right').tabIndex).toBe(0);
		key('Home');
		expect(chosen(anchors)).toEqual(['Top left']);
	});

	it.each([
		['center', 'ArrowDown', 'bottom'],
		['bottom', 'ArrowDown', 'bottom'],
		['topRight', 'ArrowRight', 'topRight'],
		['topRight', 'ArrowLeft', 'top'],
		['left', 'Tab', undefined],
	] as const)('moves %s by %s to %s', (from: Anchor, key: string, to: Anchor | undefined) => {
		expect(anchorAfter(from, key)).toBe(to);
	});

	it('asks for the size from the anchor on Apply, and on Enter from the anchor', async () => {
		const user = userEvent.setup();
		const first = open();
		type(first.width, '1800');
		type(first.height, '1200');
		await user.click(first.apply);
		expect(first.onApply).toHaveBeenCalledWith({
			size: { width: 1800, height: 1200 },
			anchor: 'center',
		});
		expect(first.onClose).toHaveBeenCalled();
		first.view.unmount();

		const second = open();
		type(second.width, '2000');
		fireEvent.click(second.anchor('Bottom left'));
		fireEvent.keyDown(second.anchor('Bottom left'), { key: 'Enter' });
		expect(second.onApply).toHaveBeenCalledWith({
			size: { width: 2000, height: 1000 },
			anchor: 'bottomLeft',
		});
	});

	it('says how much to add or take away while Relative, starting at 0, and asks for the size that makes', async () => {
		const user = userEvent.setup();
		const { dialog, width, height, relative, apply, anchor, onApply } = open();
		// The anchor last applied.
		expect(anchor('Bottom left').getAttribute('aria-checked')).toBe('true');
		await user.click(relative);
		expect(width).toHaveProperty('value', '0');
		expect(height).toHaveProperty('value', '0');
		type(width, '200');
		type(height, '-100');
		expect(within(dialog).getByText('New size: 1,800 × 900 px')).toBeDefined();
		// Turned off, the fields say the size it makes; on again, how much again.
		await user.click(relative);
		expect(width).toHaveProperty('value', '1800');
		expect(height).toHaveProperty('value', '900');
		await user.click(relative);
		expect(width).toHaveProperty('value', '200');

		// Taking away the whole canvas leaves nothing to have.
		type(width, '-1600');
		expect(width.getAttribute('aria-invalid')).toBe('true');
		expect(apply).toHaveProperty('disabled', true);
		type(width, '-600');
		await user.click(apply);
		expect(onApply).toHaveBeenCalledWith({
			size: { width: 1000, height: 900 },
			anchor: 'bottomLeft',
		});
	});

	it('opens relative where it was last applied relative, at no change', () => {
		const { width, height, relative, dialog } = open();
		expect(pressed(relative)).toBe(true);
		expect(width).toHaveProperty('value', '0');
		expect(height).toHaveProperty('value', '0');
		expect(within(dialog).getByText('New size: 1,600 × 1,000 px')).toBeDefined();
	});
});

describe('Image rotation’s Arbitrary…', () => {
	const open = () => {
		const onApply = vi.fn<(degrees: number) => void>();
		const onClose = vi.fn();
		const view = render(
			<RotateDialog placement="drawer" open onApply={onApply} onClose={onClose} />
		);
		const dialog = screen.getByRole('dialog', { name: 'Rotate canvas' });
		return {
			onApply,
			onClose,
			view,
			dialog,
			angle: field(dialog, 'Angle'),
			way: (name: string) => within(dialog).getByRole('radio', { name }),
			apply: within(dialog).getByRole('button', { name: 'Apply' }),
		};
	};

	it('first opens at no turn, clockwise, with the focus on the angle', async () => {
		const { dialog, angle, way } = open();
		expect(angle).toHaveProperty('value', '0');
		expect(within(dialog).getByRole('spinbutton', { name: 'Angle', description: '°' })).toBe(
			angle
		);
		expect(within(dialog).getByRole('group', { name: 'Direction' })).toBeDefined();
		expect(way('Clockwise')).toHaveProperty('checked', true);
		expect(way('Counterclockwise')).toHaveProperty('checked', false);
		await waitFor(() => expect(document.activeElement).toBe(angle));
	});

	it('asks for the turn, clockwise positive, and keeps it to less than a whole turn', async () => {
		const user = userEvent.setup();
		const first = open();
		type(first.angle, '360');
		expect(first.apply).toHaveProperty('disabled', true);
		type(first.angle, '45');
		await user.click(first.apply);
		expect(first.onApply).toHaveBeenCalledWith(45);
		first.view.unmount();

		const second = open();
		expect(second.angle).toHaveProperty('value', '45');
		await user.click(second.way('Counterclockwise'));
		type(second.angle, '12.5');
		fireEvent.keyDown(second.way('Counterclockwise'), { key: 'Enter' });
		expect(second.onApply).toHaveBeenCalledWith(-12.5);
		second.view.unmount();

		const third = open();
		expect(third.way('Counterclockwise')).toHaveProperty('checked', true);
		expect(third.angle).toHaveProperty('value', '12.5');
		await user.keyboard('{Escape}');
		expect(third.onClose).toHaveBeenCalled();
		expect(third.onApply).not.toHaveBeenCalled();
	});
});

describe('Trim…', () => {
	const open = () => {
		const onApply = vi.fn<(request: TrimRequest) => void>();
		const onClose = vi.fn();
		const view = render(
			<TrimDialog placement="drawer" open onApply={onApply} onClose={onClose} />
		);
		const dialog = screen.getByRole('dialog', { name: 'Trim' });
		const sides = within(dialog).getByRole('group', { name: 'Trim away' });
		return {
			onApply,
			onClose,
			view,
			dialog,
			basis: (name: string) =>
				within(within(dialog).getByRole('group', { name: 'Based on' })).getByRole('radio', {
					name,
				}),
			side: (name: string) => within(sides).getByRole('button', { name }),
			sides,
			apply: within(dialog).getByRole('button', { name: 'Apply' }),
		};
	};

	it('first opens at transparent pixels, from every side, with the focus on the basis', async () => {
		const { basis, sides } = open();
		expect(basis('Transparent pixels')).toHaveProperty('checked', true);
		expect(basis('Top left pixel color')).toHaveProperty('checked', false);
		expect(basis('Bottom right pixel color')).toHaveProperty('checked', false);
		const toggles = within(sides).getAllByRole('button');
		expect(toggles.map((each) => each.textContent)).toEqual(['Top', 'Bottom', 'Left', 'Right']);
		expect(toggles.every(pressed)).toBe(true);
		await waitFor(() => expect(document.activeElement).toBe(basis('Transparent pixels')));
	});

	it('asks for the basis and the sides chosen, and for nothing with no side', async () => {
		const user = userEvent.setup();
		const first = open();
		await user.click(first.basis('Top left pixel color'));
		await user.click(first.side('Left'));
		await user.click(first.apply);
		expect(first.onApply).toHaveBeenCalledWith({
			basis: 'topLeft',
			sides: { top: true, bottom: true, left: false, right: true },
		});
		first.view.unmount();

		const second = open();
		expect(second.basis('Top left pixel color')).toHaveProperty('checked', true);
		expect(pressed(second.side('Left'))).toBe(false);
		await user.click(second.side('Top'));
		await user.click(second.side('Bottom'));
		await user.click(second.side('Right'));
		expect(second.apply).toHaveProperty('disabled', true);
		fireEvent.keyDown(second.basis('Transparent pixels'), { key: 'Enter' });
		expect(second.onApply).not.toHaveBeenCalled();
		await user.click(second.side('Bottom'));
		fireEvent.keyDown(second.basis('Bottom right pixel color'), { key: 'Enter' });
		expect(second.onApply).toHaveBeenCalledWith({
			basis: 'topLeft',
			sides: { top: false, bottom: true, left: false, right: false },
		});
	});
});
