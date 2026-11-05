import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModifyDialog } from '../../src/drawing/panels/ModifyDialog.js';
import { rectPath } from '../../src/drawing/tools/raster/area.js';
import * as areaOps from '../../src/drawing/tools/raster/areaOps.js';
import { MODIFY_LIMITS } from '../../src/drawing/tools/raster/areaOps.js';
import type { Region } from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';

/**
 * Modify… (docs/decisions/0004-the-interface.md, "The context menu"): the
 * four ways of Photoshop's Select > Modify, each with its line, then the
 * radius as a slider and a number that are one value, named and kept to its
 * range by the way chosen; Apply or Enter sets what `modifyArea` makes of the
 * area, Cancel and Escape leave it. What it applies is compared with what
 * `modifyArea` makes of the same inputs, not with an outline worked out here:
 * the outline is `areaOps.test.ts`'s business. What was last applied is where
 * the next opening starts, for the page's life, so these tests run in their
 * order: the first sees the dialog as it first opens, and each after it
 * chooses what it reads.
 */

// The real one, watched, so a test sees what it was asked; one test makes it leave nothing.
vi.mock('../../src/drawing/tools/raster/areaOps.js', async (importOriginal) => {
	const real = await importOriginal<typeof areaOps>();
	return { ...real, modifyArea: vi.fn(real.modifyArea) };
});

const CANVAS = { x: 0, y: 0, width: 400, height: 300 } as const;

const AREA: Region = {
	path: rectPath({ x: 40, y: 30, width: 120, height: 80 }) ?? '',
	inverted: false,
	feather: 0,
};

const open = (setup: Readonly<{ region?: Region; placement?: 'sheet' | 'drawer' }> = {}) => {
	const onApply = vi.fn<(region: Region | undefined) => void>();
	const onClose = vi.fn();
	const view = render(
		<ModifyDialog
			placement={setup.placement ?? 'drawer'}
			open
			region={setup.region ?? AREA}
			canvas={CANVAS}
			onApply={onApply}
			onClose={onClose}
		/>
	);
	const dialog = screen.getByRole('dialog', { name: 'Modify selection' });
	const way = (name: string) => within(dialog).getByRole('radio', { name });
	const slider = () => within(dialog).getByRole('slider');
	const field = () => within(dialog).getByRole('spinbutton');
	const apply = within(dialog).getByRole('button', { name: 'Apply' });
	return { onApply, onClose, dialog, way, slider, field, apply, view };
};

describe('the modify dialog', () => {
	beforeEach(() => {
		vi.mocked(areaOps.modifyArea).mockClear();
	});

	it('first opens at Expand by the least it takes, with the focus on it', async () => {
		const { dialog, way, slider, field } = open();
		expect(dialog.classList.contains('panel-drawer')).toBe(true);
		expect(way('Expand')).toHaveProperty('checked', true);
		expect(slider()).toHaveProperty('value', String(MODIFY_LIMITS.expand.min));
		expect(slider().getAttribute('aria-valuetext')).toBe('1 px');
		expect(within(dialog).getByRole('slider', { name: 'Expand by' })).toBe(slider());
		expect(within(dialog).getByRole('spinbutton', { name: 'Expand by, in pixels' })).toBe(
			field()
		);
		expect(field()).toHaveProperty('value', String(MODIFY_LIMITS.expand.min));
		await waitFor(() => expect(document.activeElement).toBe(way('Expand')));
	});

	it('opens as a sheet on compact', () => {
		expect(open({ placement: 'sheet' }).dialog.classList.contains('panel-sheet')).toBe(true);
	});

	it('names each way from the catalog, in order, with its line as its description', () => {
		const { dialog } = open();
		const group = within(dialog).getByRole('group', { name: 'How to modify the selection' });
		const ways = ['expand', 'contract', 'smooth', 'border'] as const;
		expect(
			within(group)
				.getAllByRole('radio')
				.map((each) => each.getAttribute('value'))
		).toEqual([...ways]);
		for (const each of ways) {
			expect(
				within(group).getByRole('radio', {
					name: t(`selection.modify.${each}.name`),
					description: t(`selection.modify.${each}.hint`),
				})
			).toBeDefined();
		}
	});

	it('names the radius and keeps it to the range of the way chosen, Photoshop’s', async () => {
		const user = userEvent.setup();
		const { dialog, way, slider, field } = open();
		expect(slider().getAttribute('max')).toBe(String(MODIFY_LIMITS.expand.max));
		fireEvent.change(field(), { target: { value: '300' } });
		await user.click(way('Border'));
		expect(within(dialog).getByRole('slider', { name: 'Width' })).toBe(slider());
		expect(within(dialog).getByRole('spinbutton', { name: 'Border width in pixels' })).toBe(
			field()
		);
		expect(slider().getAttribute('max')).toBe(String(MODIFY_LIMITS.border.max));
		expect(field()).toHaveProperty('value', String(MODIFY_LIMITS.border.max));
		// Shown at the end of Border's range, and not forgotten for the way before.
		await user.click(way('Expand'));
		expect(field()).toHaveProperty('value', '300');
		await user.click(way('Contract'));
		expect(within(dialog).getByRole('slider', { name: 'Contract by' })).toBe(slider());
		await user.click(way('Smooth'));
		expect(within(dialog).getByRole('slider', { name: 'Sample radius' })).toBe(slider());
		expect(slider().getAttribute('max')).toBe(String(MODIFY_LIMITS.smooth.max));
	});

	it('keeps the slider and the number one value, a whole unit within the least and the most', () => {
		const { slider, field } = open();
		fireEvent.change(slider(), { target: { value: '30' } });
		expect(field()).toHaveProperty('value', '30');
		fireEvent.change(field(), { target: { value: '12.5' } });
		expect(slider()).toHaveProperty('value', '13');
		expect(field()).toHaveProperty('value', '13');
		fireEvent.change(field(), { target: { value: '900' } });
		expect(field()).toHaveProperty('value', String(MODIFY_LIMITS.expand.max));
		fireEvent.change(field(), { target: { value: '0' } });
		expect(field()).toHaveProperty('value', String(MODIFY_LIMITS.expand.min));
	});

	it('applies what Modify makes of the area on the canvas, and closes', async () => {
		const user = userEvent.setup();
		const inverse: Region = { ...AREA, inverted: true, feather: 6 };
		const { way, field, apply, onApply, onClose } = open({ region: inverse });
		await user.click(way('Contract'));
		fireEvent.change(field(), { target: { value: '20' } });
		await user.click(apply);
		expect(areaOps.modifyArea).toHaveBeenCalledExactlyOnceWith(inverse, 'contract', 20, CANVAS);
		expect(onApply).toHaveBeenCalledExactlyOnceWith(
			areaOps.modifyArea(inverse, 'contract', 20, CANVAS)
		);
		expect(onClose).toHaveBeenCalled();
	});

	it('applies none where nothing of the area is left', async () => {
		const user = userEvent.setup();
		vi.mocked(areaOps.modifyArea).mockReturnValueOnce(undefined);
		const { apply, onApply } = open();
		await user.click(apply);
		expect(onApply).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it('applies on Enter from a way, the slider or the number, and not from a button', () => {
		const { dialog, way, slider, field, onApply, onClose } = open();
		fireEvent.click(way('Smooth'));
		fireEvent.keyDown(way('Smooth'), { key: 'Enter' });
		expect(onApply).toHaveBeenCalledTimes(1);
		expect(areaOps.modifyArea).toHaveBeenLastCalledWith(AREA, 'smooth', 20, CANVAS);
		fireEvent.keyDown(slider(), { key: 'Enter' });
		fireEvent.keyDown(field(), { key: 'Enter' });
		expect(onApply).toHaveBeenCalledTimes(3);
		fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Cancel' }), {
			key: 'Enter',
		});
		expect(onApply).toHaveBeenCalledTimes(3);
		expect(onClose).toHaveBeenCalledTimes(3);
	});

	it('changes nothing on Cancel or Escape', async () => {
		const user = userEvent.setup();
		const { dialog, onApply, onClose } = open();
		await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onApply).not.toHaveBeenCalled();
		expect(areaOps.modifyArea).not.toHaveBeenCalled();
	});

	it('opens again at what was last applied, which a Cancel does not change', async () => {
		const user = userEvent.setup();
		const first = open();
		await user.click(first.way('Border'));
		fireEvent.change(first.field(), { target: { value: '40' } });
		await user.click(first.apply);
		first.view.unmount();

		const second = open();
		expect(second.way('Border')).toHaveProperty('checked', true);
		expect(second.field()).toHaveProperty('value', '40');
		await waitFor(() => expect(document.activeElement).toBe(second.way('Border')));
		await user.click(second.way('Expand'));
		fireEvent.change(second.field(), { target: { value: '90' } });
		await user.click(within(second.dialog).getByRole('button', { name: 'Cancel' }));
		second.view.unmount();

		const third = open();
		expect(third.way('Border')).toHaveProperty('checked', true);
		expect(third.field()).toHaveProperty('value', '40');
	});
});
