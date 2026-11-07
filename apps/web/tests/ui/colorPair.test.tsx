import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ColorPair } from '../../src/components/ui/ColorPair.js';
import { ToolBar } from '../../src/components/ui/ToolBar.js';
import { ToolButton } from '../../src/components/ui/ToolButton.js';

/**
 * The two colors in the tool bar (docs/ARCHITECTURE.md §7, "The interface"):
 * one tool button named for the pair, described by what each color is in a
 * whole sentence, expanded while the color panel it opens beside it is open,
 * which a press opens and closes. The swap and the reset are the color panel's
 * (`colorPanel.test.tsx`), and X's and D's, not here.
 */

/** The color panel, as the pair is told of it: closed, and open. */
const CLOSED = { id: 'color-panel', open: false } as const;
const OPEN = { id: 'color-panel', open: true } as const;

const renderPair = (props: Partial<Parameters<typeof ColorPair>[0]> = {}) => {
	const onToggle = vi.fn();
	const utils = render(
		<ColorPair fill="#111827" stroke="none" panel={CLOSED} onToggle={onToggle} {...props} />
	);
	return { ...utils, onToggle };
};

const colors = () => screen.getByRole('button', { name: 'Colors' });

/** What a screen reader says after the button's name: each color's sentence, in order. */
const description = (control: HTMLElement) =>
	(control.getAttribute('aria-describedby') ?? '')
		.split(' ')
		.map((id) => document.getElementById(id)?.textContent);

describe('ColorPair', () => {
	it('is one tool button, named for the pair, and nothing else to press', () => {
		renderPair();
		expect(screen.getAllByRole('button')).toEqual([colors()]);
		expect(colors().classList.contains('tool-button')).toBe(true);
		expect(colors().classList.contains('icon-button')).toBe(true);
		expect(colors().title).toBe('Colors');
		expect(screen.queryByRole('button', { name: 'Swap colors' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Reset colors' })).toBeNull();
	});

	it('is described by each color in a whole sentence, its value as #rrggbb where it has one', () => {
		renderPair({ fill: 'red', stroke: 'url(#gradient)' });
		expect(description(colors())).toEqual([
			'Fill color: #ff0000',
			'Stroke color: url(#gradient)',
		]);
	});

	it('says none as none, for the fill and for the stroke', () => {
		const { rerender, onToggle } = renderPair({ fill: '#111827', stroke: 'none' });
		expect(description(colors())).toEqual(['Fill color: #111827', 'Stroke color: none']);
		rerender(<ColorPair fill="none" stroke="#e11d48" panel={CLOSED} onToggle={onToggle} />);
		expect(description(colors())).toEqual(['Fill color: none', 'Stroke color: #e11d48']);
	});

	it('draws both colors as its face, the fill in front, none struck through, hidden from a screen reader', () => {
		renderPair({ fill: '#e11d48', stroke: 'none' });
		const mark = colors().querySelector('.tool-button-icon > .color-pair-mark');
		expect(mark?.getAttribute('aria-hidden')).toBe('true');
		const fill = mark?.querySelector('.color-pair-mark-fill');
		const stroke = mark?.querySelector('.color-pair-mark-stroke');
		expect(fill?.getAttribute('style')).toContain('color: rgb(225, 29, 72)');
		expect(fill?.classList.contains('is-none')).toBe(false);
		expect(stroke?.classList.contains('is-none')).toBe(true);
		expect(stroke?.getAttribute('style')).toBeNull();
		// The fill is drawn last, so it is in front.
		expect(mark?.lastElementChild).toBe(fill);
	});

	it('says it opens a dialog, and whether the color panel is open and which it is, never pressed', () => {
		const { rerender, onToggle } = renderPair();
		expect(colors().getAttribute('aria-haspopup')).toBe('dialog');
		expect(colors().getAttribute('aria-expanded')).toBe('false');
		expect(colors().hasAttribute('aria-controls')).toBe(false);
		rerender(<ColorPair fill="#111827" stroke="none" panel={OPEN} onToggle={onToggle} />);
		expect(colors().getAttribute('aria-expanded')).toBe('true');
		expect(colors().getAttribute('aria-controls')).toBe('color-panel');
		expect(colors().hasAttribute('aria-pressed')).toBe(false);
	});

	it('asks for the color panel to open or close on a press, with the keyboard too', async () => {
		const user = userEvent.setup();
		const { onToggle } = renderPair();
		await user.click(colors());
		expect(onToggle).toHaveBeenCalledTimes(1);
		colors().focus();
		await user.keyboard('{Enter}');
		await user.keyboard(' ');
		expect(onToggle).toHaveBeenCalledTimes(3);
	});

	it('shows colors changed elsewhere the moment it is given them', () => {
		const { rerender, onToggle } = renderPair();
		rerender(<ColorPair fill="none" stroke="#111827" panel={CLOSED} onToggle={onToggle} />);
		const mark = colors().querySelector('.color-pair-mark');
		expect(mark?.querySelector('.color-pair-mark-fill')?.classList.contains('is-none')).toBe(
			true
		);
		expect(mark?.querySelector('.color-pair-mark-stroke')?.getAttribute('style')).toContain(
			'color: rgb(17, 24, 39)'
		);
		expect(description(colors())).toEqual(['Fill color: none', 'Stroke color: #111827']);
	});

	it.each(['vertical', 'horizontal'] as const)(
		'is one stop in the %s bar’s arrow-key order, after the tools and before what follows',
		async (orientation) => {
			const user = userEvent.setup();
			const next = orientation === 'vertical' ? '{ArrowDown}' : '{ArrowRight}';
			render(
				<ToolBar orientation={orientation} label="Tools">
					<ToolButton icon={null} label="Brush" onClick={vi.fn()} />
					<ColorPair fill="#111827" stroke="none" panel={CLOSED} onToggle={vi.fn()} />
					<ToolButton icon={null} label="Layers" onClick={vi.fn()} />
				</ToolBar>
			);
			await user.tab();
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Brush' }));
			await user.keyboard(next);
			expect(document.activeElement).toBe(colors());
			await user.keyboard(next);
			expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Layers' }));
		}
	);
});
