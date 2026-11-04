import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ColorField } from '../../src/components/ui/ColorField.js';
import { isNone, isValidHex, toHex } from '../../src/components/ui/colour.js';

/**
 * A colour (docs/ARCHITECTURE.md §7, "The interface"): the native picker
 * named by the field's label, the hex beside it, None where a colour may be
 * absent, and the colours used lately. What goes back is `#rrggbb` or `none`.
 */

describe('toHex', () => {
	it.each([
		['#ABC', '#aabbcc'],
		['#A1b2C3', '#a1b2c3'],
		['  #fff ', '#ffffff'],
		['rgb(255, 0, 0)', '#ff0000'],
		['rgb(0 128 255)', '#0080ff'],
		['rgba(16, 32, 48, 1)', '#102030'],
		['rgb(0 0 0 / 100%)', '#000000'],
		['rgb(300, 0, 0)', '#ff0000'],
		['RebeccaPurple', '#663399'],
		['red', '#ff0000'],
		['grey', '#808080'],
	])('writes %s as %s', (colour, hex) => {
		expect(toHex(colour)).toBe(hex);
	});

	it.each([
		'rgba(0, 0, 0, 0.5)',
		'rgb(0 0 0 / 50%)',
		'transparent',
		'none',
		'currentColor',
		'#abcd',
		'#aabbccdd',
		'#ggg',
		'url(#gradient)',
		'hsl(0 100% 50%)',
		'',
	])('has no #rrggbb for %j', (colour) => {
		expect(toHex(colour)).toBeUndefined();
	});
});

describe('isValidHex and isNone', () => {
	it('takes #rgb and #rrggbb, in either case, and nothing else', () => {
		expect(['#abc', '#AABBCC', ' #123456 '].every(isValidHex)).toBe(true);
		expect(['abc', '#abcd', '#gggggg', 'red', ''].some(isValidHex)).toBe(false);
	});

	it('knows none however it is written', () => {
		expect(isNone('none')).toBe(true);
		expect(isNone(' NONE ')).toBe(true);
		expect(isNone('red')).toBe(false);
	});
});

const renderField = (props: Partial<Parameters<typeof ColorField>[0]> = {}) => {
	const onChange = vi.fn();
	const utils = render(<ColorField label="Fill" value="red" onChange={onChange} {...props} />);
	return {
		...utils,
		onChange,
		picker: screen.getByLabelText<HTMLInputElement>('Fill'),
		hex: screen.getByRole<HTMLInputElement>('textbox', { name: 'Fill (hex)' }),
	};
};

describe('ColorField', () => {
	it('is the native picker, named by the label, and the hex beside it', () => {
		const { picker, hex } = renderField();
		expect(picker.type).toBe('color');
		expect(picker.value).toBe('#ff0000');
		expect(hex.value).toBe('#ff0000');
		expect(screen.getByText('Fill').className).toBe('field-label');
	});

	it('hides the label from the eye, not from the picker, when asked', () => {
		const { picker } = renderField({ hideLabel: true });
		expect(screen.getByText('Fill').className).toBe('visually-hidden');
		expect(picker.type).toBe('color');
	});

	it('gives back what the picker picks, as #rrggbb', () => {
		const { picker, onChange } = renderField();
		fireEvent.change(picker, { target: { value: '#123456' } });
		expect(onChange).toHaveBeenCalledWith('#123456');
	});

	it('commits a typed hex on Enter and on leaving the field, with or without its #', async () => {
		const user = userEvent.setup();
		const { hex, onChange } = renderField();

		await user.clear(hex);
		await user.type(hex, '#00F{Enter}');
		expect(onChange).toHaveBeenLastCalledWith('#0000ff');

		await user.clear(hex);
		await user.type(hex, '00ff00');
		await user.tab();
		expect(onChange).toHaveBeenLastCalledWith('#00ff00');
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it('goes back to the colour it had from anything that is not a hex, and gives nothing back', async () => {
		const user = userEvent.setup();
		const { hex, onChange } = renderField();
		await user.clear(hex);
		await user.type(hex, 'zz{Enter}');
		expect(hex.value).toBe('#ff0000');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('gives nothing back for the colour it already has', async () => {
		const user = userEvent.setup();
		const { hex, onChange } = renderField();
		await user.clear(hex);
		await user.type(hex, '#f00{Enter}');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('drops a draft on Escape, taking the key only when there is one', async () => {
		const user = userEvent.setup();
		const { hex, onChange } = renderField();
		await user.clear(hex);
		await user.type(hex, '#123');
		expect(fireEvent.keyDown(hex, { key: 'Escape' })).toBe(false);
		expect(hex.value).toBe('#ff0000');
		expect(onChange).not.toHaveBeenCalled();

		// No draft now: Escape is the sheet's the field is in.
		expect(fireEvent.keyDown(hex, { key: 'Escape' })).toBe(true);
	});

	it('shows a value it cannot write as hex as it is, and the picker at black', () => {
		const { picker, hex } = renderField({ value: 'url(#gradient)' });
		expect(hex.value).toBe('url(#gradient)');
		expect(picker.value).toBe('#000000');
	});

	it('offers None only where a colour may be absent', () => {
		renderField();
		expect(screen.queryByRole('button', { name: 'None' })).toBeNull();
	});

	it('turns to none and back to the colour it had, through the None toggle', async () => {
		const user = userEvent.setup();
		const { rerender, onChange, picker, hex } = renderField({ allowNone: true });
		const toggle = screen.getByRole('button', { name: 'None' });
		expect(toggle.getAttribute('aria-pressed')).toBe('false');

		await user.click(toggle);
		expect(onChange).toHaveBeenLastCalledWith('none');

		rerender(<ColorField label="Fill" value="none" onChange={onChange} allowNone />);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		expect(hex.value).toBe('');
		expect(hex.placeholder).toBe('None');
		expect(picker.value).toBe('#ff0000');
		expect(picker.parentElement?.className).toContain('is-none');

		await user.click(toggle);
		expect(onChange).toHaveBeenLastCalledWith('#ff0000');
	});

	it('picks a colour out of none from the picker', () => {
		const { picker, onChange } = renderField({ value: 'none', allowNone: true });
		expect(picker.value).toBe('#000000');
		fireEvent.change(picker, { target: { value: '#336699' } });
		expect(onChange).toHaveBeenCalledWith('#336699');
	});

	it('shows the colours used lately, the current one pressed, each choosing itself', async () => {
		const user = userEvent.setup();
		const { onChange } = renderField({ recent: ['#ff0000', 'blue', '#0f0'] });
		const row = screen.getByRole('group', { name: 'Recent colours' });
		const swatches = within(row).getAllByRole('button');
		expect(swatches.map((swatch) => swatch.getAttribute('aria-label'))).toEqual([
			'Use #ff0000',
			'Use #0000ff',
			'Use #00ff00',
		]);
		expect(swatches.map((swatch) => swatch.getAttribute('aria-pressed'))).toEqual([
			'true',
			'false',
			'false',
		]);
		expect(swatches[1]?.style.color).toBe('rgb(0, 0, 255)');

		await user.click(within(row).getByRole('button', { name: 'Use #0000ff' }));
		expect(onChange).toHaveBeenCalledWith('#0000ff');
	});

	it('has no row of recent colours when there are none', () => {
		renderField({ recent: [] });
		expect(screen.queryByRole('group', { name: 'Recent colours' })).toBeNull();
	});
});
