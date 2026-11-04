import { BLEND_MODES } from '@skysa/draw-core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { blendKey } from '../../src/drawing/panels/blendKey.js';
import { FillDialog } from '../../src/drawing/panels/FillDialog.js';
import type { FillSpec } from '../../src/drawing/tools/raster/areaFill.js';
import { DEFAULT_TOOL_OPTIONS, type ToolOptions } from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';

/**
 * Fill… (docs/decisions/0004-the-interface.md, "The context menu"): the
 * contents, each color with its swatch and Color… with a field of its own,
 * then the blending, as Photoshop's Edit > Fill asks them; Apply or Enter
 * fills, Cancel and Escape leave the layer. What was last applied is where
 * the next opening starts, for the page's life, so these tests run in their
 * order: the first sees the dialog as it first opens, and each after it
 * chooses what it reads.
 */

const open = (
	setup: Readonly<{
		options?: Partial<ToolOptions>;
		placement?: 'sheet' | 'drawer';
		recent?: readonly string[];
	}> = {}
) => {
	const onApply = vi.fn<(spec: FillSpec) => void>();
	const onClose = vi.fn();
	const view = render(
		<FillDialog
			placement={setup.placement ?? 'drawer'}
			open
			options={{ ...DEFAULT_TOOL_OPTIONS, ...setup.options }}
			recent={setup.recent}
			onApply={onApply}
			onClose={onClose}
		/>
	);
	const dialog = screen.getByRole('dialog', { name: 'Fill' });
	const radio = (name: string) => within(dialog).getByRole('radio', { name });
	const mode = within(dialog).getByRole('combobox', { name: 'Mode' });
	const slider = within(dialog).getByRole('slider', { name: 'Opacity' });
	const percent = within(dialog).getByRole('spinbutton', { name: 'Opacity in percent' });
	const preserve = within(dialog).getByRole('checkbox', { name: 'Preserve transparency' });
	const apply = within(dialog).getByRole('button', { name: 'Apply' });
	return { onApply, onClose, dialog, radio, mode, slider, percent, preserve, apply, view };
};

/** The swatch beside a choice: its color, as the style says it. */
const swatchOf = (radio: HTMLElement): string | undefined =>
	radio.parentElement?.querySelector<HTMLElement>('.fill-swatch')?.style.color;

describe('the fill dialog', () => {
	it('first opens at the fill color, in normal, at full opacity, with the focus on it', async () => {
		const { dialog, radio, mode, slider, percent, preserve } = open();
		expect(dialog.classList.contains('panel-drawer')).toBe(true);
		expect(radio('Fill color')).toHaveProperty('checked', true);
		expect(mode).toHaveProperty('value', 'normal');
		expect(slider).toHaveProperty('value', '100');
		expect(slider.getAttribute('aria-valuetext')).toBe('100%');
		expect(percent).toHaveProperty('value', '100');
		expect(preserve).toHaveProperty('checked', false);
		await waitFor(() => expect(document.activeElement).toBe(radio('Fill color')));
	});

	it('opens as a sheet on compact', () => {
		expect(open({ placement: 'sheet' }).dialog.classList.contains('panel-sheet')).toBe(true);
	});

	it('names each choice from the catalog, with the swatch of the color each pours', () => {
		const { dialog, radio } = open({ options: { fill: '#ff0000', stroke: '#0000ff' } });
		expect(
			within(within(dialog).getByRole('group', { name: 'Contents' }))
				.getAllByRole('radio')
				.map((each) => each.parentElement?.textContent)
		).toEqual(['Fill color', 'Stroke color', 'Color…', 'Content-Aware']);
		expect(swatchOf(radio('Fill color'))).toBe('rgb(255, 0, 0)');
		expect(swatchOf(radio('Stroke color'))).toBe('rgb(0, 0, 255)');
		expect(swatchOf(radio('Content-Aware'))).toBe('');
		expect(within(dialog).getByRole('group', { name: 'Blending' })).toBeDefined();
	});

	it('shows the fill color for a stroke of none, which is what it falls back to', () => {
		const { radio } = open({ options: { fill: '#ff0000', stroke: 'none' } });
		expect(swatchOf(radio('Stroke color'))).toBe('rgb(255, 0, 0)');
	});

	it('offers the layers’ blend modes, in their words', () => {
		const { mode } = open();
		expect(Array.from((mode as HTMLSelectElement).options).map((each) => each.value)).toEqual([
			...BLEND_MODES,
		]);
		expect(
			Array.from((mode as HTMLSelectElement).options).map((each) => each.textContent)
		).toEqual(BLEND_MODES.map((each) => t(blendKey(each))));
	});

	it('opens a color field under Color…, starting at the fill color, and fills with what it picks', async () => {
		const user = userEvent.setup();
		const { dialog, radio, apply, onApply, onClose } = open({
			options: { fill: '#ff0000' },
			recent: ['#123456'],
		});
		expect(within(dialog).queryByLabelText('Fill with this color')).toBeNull();
		await user.click(radio('Color…'));
		const picker = within(dialog).getByLabelText<HTMLInputElement>('Fill with this color');
		expect(picker.value).toBe('#ff0000');
		expect(within(dialog).getByRole('button', { name: 'Use #123456' })).toBeDefined();
		fireEvent.change(picker, { target: { value: '#00ff00' } });
		expect(swatchOf(radio('Color…'))).toBe('rgb(0, 255, 0)');
		await user.click(apply);
		expect(onApply).toHaveBeenCalledWith({
			contents: 'color',
			color: '#00ff00',
			mode: 'normal',
			opacity: 1,
			preserveTransparency: false,
		});
		expect(onClose).toHaveBeenCalled();
	});

	it('keeps the slider and the number one value, within 0 to 100, and applies it as a fraction', async () => {
		const user = userEvent.setup();
		const { radio, slider, percent, mode, preserve, apply, onApply } = open();
		await user.click(radio('Content-Aware'));
		fireEvent.change(slider, { target: { value: '30' } });
		expect(percent).toHaveProperty('value', '30');
		fireEvent.change(percent, { target: { value: '12.5' } });
		expect(slider).toHaveProperty('value', '12.5');
		fireEvent.change(percent, { target: { value: '900' } });
		expect(percent).toHaveProperty('value', '100');
		fireEvent.change(percent, { target: { value: '-3' } });
		expect(percent).toHaveProperty('value', '0');
		fireEvent.change(percent, { target: { value: '40' } });
		await user.selectOptions(mode, 'multiply');
		await user.click(preserve);
		await user.click(apply);
		expect(onApply).toHaveBeenCalledWith({
			contents: 'contentAware',
			mode: 'multiply',
			opacity: 0.4,
			preserveTransparency: true,
		});
	});

	it('applies on Enter from a choice, the checkbox or the mode, and not from a button', () => {
		const { radio, preserve, mode, onApply, onClose, dialog } = open();
		fireEvent.click(radio('Stroke color'));
		fireEvent.keyDown(radio('Stroke color'), { key: 'Enter' });
		expect(onApply).toHaveBeenCalledTimes(1);
		expect(onApply.mock.calls[0]?.[0].contents).toBe('stroke');
		fireEvent.keyDown(preserve, { key: 'Enter' });
		fireEvent.keyDown(mode, { key: 'Enter' });
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
	});

	it('opens again at what was last applied, which a Cancel does not change', async () => {
		const user = userEvent.setup();
		const first = open();
		await user.click(first.radio('Content-Aware'));
		await user.selectOptions(first.mode, 'screen');
		fireEvent.change(first.percent, { target: { value: '65' } });
		if (first.preserve instanceof HTMLInputElement && first.preserve.checked) {
			await user.click(first.preserve);
		}
		await user.click(first.apply);
		first.view.unmount();

		const second = open();
		expect(second.radio('Content-Aware')).toHaveProperty('checked', true);
		expect(second.mode).toHaveProperty('value', 'screen');
		expect(second.percent).toHaveProperty('value', '65');
		expect(second.preserve).toHaveProperty('checked', false);
		await waitFor(() => expect(document.activeElement).toBe(second.radio('Content-Aware')));
		await user.click(second.radio('Fill color'));
		await user.click(within(second.dialog).getByRole('button', { name: 'Cancel' }));
		second.view.unmount();

		const third = open();
		expect(third.radio('Content-Aware')).toHaveProperty('checked', true);
		expect(third.mode).toHaveProperty('value', 'screen');
	});
});
