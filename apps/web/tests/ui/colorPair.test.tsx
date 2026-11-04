import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ColorPair } from '../../src/components/ui/ColorPair.js';
import { ToolBar } from '../../src/components/ui/ToolBar.js';
import { ToolButton } from '../../src/components/ui/ToolButton.js';

/**
 * The two colors at the foot of the tool bar (docs/ARCHITECTURE.md §7, "The
 * interface"): each control named with what it does or holds, a target of
 * its own, pressed for the color the color panel is open on, in the bar's
 * arrow-key order, and showing the colors it is given the moment it is given
 * them. The reset is the color panel's (`colorPanel.test.tsx`), not here.
 */

const renderPair = (props: Partial<Parameters<typeof ColorPair>[0]> = {}) => {
	const onEdit = vi.fn();
	const onSwap = vi.fn();
	const utils = render(
		<ColorPair
			fill="#111827"
			stroke="none"
			editing={undefined}
			swapShortcut="X"
			onEdit={onEdit}
			onSwap={onSwap}
			{...props}
		/>
	);
	return { ...utils, onEdit, onSwap };
};

const button = (name: string) => screen.getByRole('button', { name });

/** The square a color's control draws, which is the control's only child. */
const squareOf = (control: HTMLElement) => control.querySelector('.color-pair-square');

describe('ColorPair', () => {
	it('names each control in a whole sentence, the colors with their values and none as none, and has no reset', () => {
		renderPair();
		expect(screen.getByRole('group', { name: 'Colors' })).toBeDefined();
		expect(button('Fill color: #111827').title).toBe('Fill color: #111827');
		expect(button('Stroke color: none')).toBeDefined();
		expect(button('Swap colors').title).toBe('Swap colors (X)');
		expect(screen.queryByRole('button', { name: 'Reset colors' })).toBeNull();
	});

	it('names a color by its #rrggbb where it has one, and as written where it does not', () => {
		renderPair({ fill: 'red', stroke: 'url(#gradient)' });
		expect(button('Fill color: #ff0000')).toBeDefined();
		expect(button('Stroke color: url(#gradient)')).toBeDefined();
	});

	it('leaves the key out of a tooltip that has none', () => {
		renderPair({ swapShortcut: undefined });
		expect(button('Swap colors').title).toBe('Swap colors');
	});

	it('draws each color as its square, none struck through, hidden from a screen reader', () => {
		renderPair({ fill: '#e11d48', stroke: 'none' });
		const fill = squareOf(button('Fill color: #e11d48'));
		const stroke = squareOf(button('Stroke color: none'));
		expect(fill?.getAttribute('style')).toContain('color: rgb(225, 29, 72)');
		expect(fill?.classList.contains('is-none')).toBe(false);
		expect(stroke?.classList.contains('is-none')).toBe(true);
		expect(stroke?.getAttribute('style')).toBeNull();
		expect(fill?.getAttribute('aria-hidden')).toBe('true');
	});

	it('makes every control a target of its own, an icon button, which ui.css keeps a target either way', () => {
		renderPair();
		const controls = screen.getAllByRole('button');
		expect(controls).toHaveLength(3);
		controls.forEach((control) => {
			expect(control.classList.contains('icon-button')).toBe(true);
			expect(control.getAttribute('type')).toBe('button');
		});
	});

	it('asks for the color panel on the color pressed, and the swap', async () => {
		const user = userEvent.setup();
		const { onEdit, onSwap } = renderPair();
		await user.click(button('Stroke color: none'));
		expect(onEdit).toHaveBeenLastCalledWith('stroke');
		await user.click(button('Fill color: #111827'));
		expect(onEdit).toHaveBeenLastCalledWith('fill');
		await user.click(button('Swap colors'));
		expect(onSwap).toHaveBeenCalledTimes(1);
		expect(onEdit).toHaveBeenCalledTimes(2);
	});

	it('is pressed for the color the color panel is open on, and for no other', () => {
		const { rerender, onEdit, onSwap } = renderPair();
		const pressed = () =>
			['Fill color: #111827', 'Stroke color: none'].map((name) =>
				button(name).getAttribute('aria-pressed')
			);
		expect(pressed()).toEqual(['false', 'false']);
		const pair = (editing: 'fill' | 'stroke' | undefined) => (
			<ColorPair
				fill="#111827"
				stroke="none"
				editing={editing}
				onEdit={onEdit}
				onSwap={onSwap}
			/>
		);
		rerender(pair('stroke'));
		expect(pressed()).toEqual(['false', 'true']);
		rerender(pair('fill'));
		expect(pressed()).toEqual(['true', 'false']);
		expect(button('Swap colors').getAttribute('aria-pressed')).toBeNull();
	});

	it('shows colors changed elsewhere the moment it is given them', () => {
		const { rerender, onEdit, onSwap } = renderPair();
		rerender(
			<ColorPair
				fill="none"
				stroke="#111827"
				editing={undefined}
				onEdit={onEdit}
				onSwap={onSwap}
			/>
		);
		expect(squareOf(button('Fill color: none'))?.classList.contains('is-none')).toBe(true);
		expect(squareOf(button('Stroke color: #111827'))?.getAttribute('style')).toContain(
			'color: rgb(17, 24, 39)'
		);
		expect(screen.queryByRole('button', { name: 'Fill color: #111827' })).toBeNull();
	});

	it.each(['vertical', 'horizontal'] as const)(
		'is in the %s bar’s arrow-key order, after the tools and before what follows',
		async (orientation) => {
			const user = userEvent.setup();
			const next = orientation === 'vertical' ? '{ArrowDown}' : '{ArrowRight}';
			render(
				<ToolBar orientation={orientation} label="Tools">
					<ToolButton icon={null} label="Brush" onClick={vi.fn()} />
					<ColorPair
						fill="#111827"
						stroke="none"
						editing={undefined}
						onEdit={vi.fn()}
						onSwap={vi.fn()}
					/>
					<ToolButton icon={null} label="Layers" onClick={vi.fn()} />
				</ToolBar>
			);
			await user.tab();
			expect(document.activeElement).toBe(button('Brush'));
			for (const name of [
				'Fill color: #111827',
				'Stroke color: none',
				'Swap colors',
				'Layers',
			]) {
				await user.keyboard(next);
				expect(document.activeElement).toBe(button(name));
			}
		}
	);

	describe('compact', () => {
		it('is one control for both colors, said after its name, and the swap; the reset is not here', () => {
			renderPair({ compact: true, fill: '#e11d48', stroke: 'none' });
			const both = button('Colors');
			const description = (both.getAttribute('aria-describedby') ?? '')
				.split(' ')
				.map((id) => document.getElementById(id)?.textContent);
			expect(description).toEqual(['Fill color: #e11d48', 'Stroke color: none']);
			expect(button('Swap colors').title).toBe('Swap colors (X)');
			expect(screen.queryByRole('button', { name: 'Reset colors' })).toBeNull();
			expect(screen.getAllByRole('button')).toHaveLength(2);
		});

		it('draws both colors, and opens the color panel on the fill, pressed while it is open', async () => {
			const user = userEvent.setup();
			const { onEdit, onSwap, rerender } = renderPair({ compact: true });
			const both = button('Colors');
			expect(both.querySelector('.color-pair-mark-fill')?.getAttribute('style')).toContain(
				'color: rgb(17, 24, 39)'
			);
			expect(
				both.querySelector('.color-pair-mark-stroke')?.classList.contains('is-none')
			).toBe(true);
			expect(both.getAttribute('aria-pressed')).toBe('false');
			await user.click(both);
			expect(onEdit).toHaveBeenCalledWith('fill');
			rerender(
				<ColorPair
					compact
					fill="#111827"
					stroke="none"
					editing="stroke"
					onEdit={onEdit}
					onSwap={onSwap}
				/>
			);
			expect(button('Colors').getAttribute('aria-pressed')).toBe('true');
			await user.click(button('Swap colors'));
			expect(onSwap).toHaveBeenCalledTimes(1);
		});
	});
});
