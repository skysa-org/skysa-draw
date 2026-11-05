import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ColorPanel } from '../../src/drawing/panels/ColorPanel.js';
import { DEFAULT_TOOL_OPTIONS } from '../../src/drawing/tools/types.js';

/**
 * The color panel (docs/ARCHITECTURE.md §7, "The interface"), which the tool
 * bar's colors open and close: the fill and the stroke, each a stacked group
 * with its name over its row and the colors used lately under it, as Fill…'s
 * groups are; and in the header the swap and the reset, which the tool bar
 * has no control for, each with the key that does what it does.
 */

const renderPanel = (recent: readonly string[] = []) => {
	const onColor = vi.fn();
	const onSwap = vi.fn();
	const onReset = vi.fn();
	render(
		<ColorPanel
			options={{ ...DEFAULT_TOOL_OPTIONS, fill: '#e11d48', stroke: 'none' }}
			recent={recent}
			onColor={onColor}
			onSwap={onSwap}
			onReset={onReset}
		/>
	);
	return { onColor, onSwap, onReset };
};

const button = (name: string) => screen.getByRole('button', { name });

describe('ColorPanel', () => {
	it('has the swap and the reset, each with its key in its tooltip', () => {
		renderPanel();
		expect(button('Swap colors').title).toBe('Swap colors (X)');
		expect(button('Reset colors').title).toBe('Reset colors (D)');
	});

	it('draws the reset as the colors it puts back, not the colors there now', () => {
		renderPanel();
		const mark = button('Reset colors').querySelector('.color-pair-mark');
		expect(mark?.getAttribute('aria-hidden')).toBe('true');
		expect(mark?.querySelector('.color-pair-mark-fill')?.getAttribute('style')).toContain(
			'color: rgb(17, 24, 39)'
		);
		expect(mark?.querySelector('.color-pair-mark-stroke')?.classList.contains('is-none')).toBe(
			true
		);
	});

	it('asks for the swap and the reset', async () => {
		const user = userEvent.setup();
		const { onSwap, onReset } = renderPanel();
		await user.click(button('Swap colors'));
		expect(onSwap).toHaveBeenCalledTimes(1);
		await user.click(button('Reset colors'));
		expect(onReset).toHaveBeenCalledTimes(1);
	});

	it('stacks each color as a group, its name over its row, in a column of groups as Fill…’s are', () => {
		renderPanel();
		const fields = [...document.querySelectorAll('.field-groups > .color-field')];
		expect(fields.map((field) => field.querySelector('label')?.textContent)).toEqual([
			'Fill',
			'Stroke',
		]);
		fields.forEach((field) => {
			expect(field.classList.contains('color-field-stacked')).toBe(true);
			expect(field.firstElementChild?.className).toBe('field-legend');
			expect(field.children[1]?.className).toBe('color-field-row');
		});
	});

	it('shows each color as it is, the stroke as none, with a None of its own', () => {
		renderPanel();
		expect(screen.getByLabelText<HTMLInputElement>('Fill').value).toBe('#e11d48');
		expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Stroke (hex)' }).value).toBe(
			''
		);
		const nones = screen.getAllByRole('button', { name: 'None' });
		expect(nones.map((none) => none.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
	});

	it('gives a color picked back as the fill’s or the stroke’s, by the field it was picked in', () => {
		const { onColor } = renderPanel();
		fireEvent.change(screen.getByLabelText('Stroke'), { target: { value: '#2563eb' } });
		expect(onColor).toHaveBeenLastCalledWith('stroke', '#2563eb');
		fireEvent.change(screen.getByLabelText('Fill'), { target: { value: '#00ff00' } });
		expect(onColor).toHaveBeenLastCalledWith('fill', '#00ff00');
	});

	it('offers the colors used lately under each color’s row, a press giving that color', async () => {
		const user = userEvent.setup();
		const { onColor } = renderPanel(['#2563eb', '#16a34a']);
		const rows = screen.getAllByRole('group', { name: 'Recent colors' });
		expect(rows).toHaveLength(2);
		rows.forEach((row) => {
			expect(row.previousElementSibling?.className).toBe('color-field-row');
		});
		const [, strokeRow] = rows;
		if (strokeRow === undefined) throw new Error('no recent colors under the stroke');
		await user.click(within(strokeRow).getByRole('button', { name: 'Use #16a34a' }));
		expect(onColor).toHaveBeenLastCalledWith('stroke', '#16a34a');
	});
});
