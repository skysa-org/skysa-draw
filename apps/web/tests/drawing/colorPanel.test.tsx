import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ColorPanel } from '../../src/drawing/panels/ColorPanel.js';
import { DEFAULT_TOOL_OPTIONS } from '../../src/drawing/tools/types.js';

/**
 * The color panel's own controls (docs/ARCHITECTURE.md §7, "The interface"):
 * the swap the tool bar also has, and the reset, which is the panel's alone,
 * so the bar keeps its targets for what is pressed often. Each shows the key
 * that does what it does, as a tool shows its own.
 */

const renderPanel = () => {
	const onSwap = vi.fn();
	const onReset = vi.fn();
	render(
		<ColorPanel
			options={{ ...DEFAULT_TOOL_OPTIONS, fill: '#e11d48', stroke: '#2563eb' }}
			recent={[]}
			onColor={vi.fn()}
			onSwap={onSwap}
			onReset={onReset}
		/>
	);
	return { onSwap, onReset };
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
});
