import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Slider } from '../../src/components/ui/Slider.js';

/**
 * A number in a range (docs/ARCHITECTURE.md §7, "The interface"): the native
 * range input, named by its label alone, saying its value as the read-out
 * beside it does, and that read-out no live region of its own.
 */

const percent = (value: number) => `${Math.round(value * 100)}%`;

describe('Slider', () => {
	it('is a slider named by its label alone, with its value read out beside it', () => {
		render(<Slider label="Size" value={8} min={1} max={200} onChange={vi.fn()} />);
		const slider = screen.getByRole<HTMLInputElement>('slider', { name: 'Size' });
		expect(slider.value).toBe('8');
		expect(slider.min).toBe('1');
		expect(slider.max).toBe('200');
		expect(slider.hasAttribute('aria-valuetext')).toBe(false);
		expect(screen.getByText('8').tagName).toBe('OUTPUT');
	});

	it('says a formatted value as the read-out shows it, and the read-out is not a second status', () => {
		render(
			<Slider
				label="Opacity"
				value={0.5}
				min={0}
				max={1}
				step={0.01}
				format={percent}
				onChange={vi.fn()}
			/>
		);
		const slider = screen.getByRole('slider', { name: 'Opacity' });
		expect(slider.getAttribute('aria-valuetext')).toBe('50%');
		expect(screen.getByText('50%').getAttribute('aria-hidden')).toBe('true');
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('gives back the number it is moved to', () => {
		const onChange = vi.fn();
		render(<Slider label="Size" value={8} min={1} max={200} onChange={onChange} />);
		fireEvent.change(screen.getByRole('slider', { name: 'Size' }), { target: { value: '24' } });
		expect(onChange).toHaveBeenCalledWith(24);
	});

	it('can be disabled, and can hide its label from the eye', () => {
		const { container } = render(
			<Slider
				label="Size"
				value={8}
				min={1}
				max={200}
				onChange={vi.fn()}
				disabled
				hideLabel
			/>
		);
		expect(screen.getByRole('slider', { name: 'Size' })).toHaveProperty('disabled', true);
		expect(container.firstElementChild?.className).toBe('slider is-disabled');
		expect(screen.getByText('Size').className).toBe('visually-hidden');
	});
});
