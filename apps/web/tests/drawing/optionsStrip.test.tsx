import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SIZE_MAX, SIZE_MIN } from '../../src/drawing/editorState.js';
import { OptionsStrip } from '../../src/drawing/panels/OptionsStrip.js';
import { DEFAULT_TOOL_OPTIONS, type Tool } from '../../src/drawing/tools/types.js';

/**
 * The strip of options for the tool in hand (docs/ARCHITECTURE.md §7, "The
 * interface"): each option the tool names, as the control its kind takes.
 * Tools of the test's own, so the strip is tested without the tools themselves.
 */

/** A tool with one option of each kind. */
const brushLike: Tool = {
	id: 'brush',
	options: ['size', 'opacity', 'pressure', 'fill'],
	behaviours: {},
};

const rectangleLike: Tool = { id: 'rectangle', options: ['fill', 'stroke'], behaviours: {} };

describe('the options strip', () => {
	it('is a toolbar named for a screen reader, with a slider per numeric option under its catalog label', () => {
		render(<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />);
		const bar = screen.getByRole('toolbar', { name: 'Tool options' });
		expect(bar.getAttribute('aria-orientation')).toBe('horizontal');
		expect(screen.getByRole('slider', { name: 'Size' })).toBeDefined();
		expect(screen.getByRole('slider', { name: 'Opacity' })).toBeDefined();
	});

	it('shows the options in the order the tool names them', () => {
		render(<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />);
		const controls = [
			screen.getByRole('slider', { name: 'Size' }),
			screen.getByRole('slider', { name: 'Opacity' }),
			screen.getByRole('button', { name: 'Pressure' }),
			screen.getByLabelText('Fill'),
		];
		const inPageOrder = [...controls].sort((a, b) =>
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
		);
		expect(inPageOrder).toEqual(controls);
	});

	it('reads a value out as what it is: a size in px, a fraction as a percentage', () => {
		render(
			<OptionsStrip
				tool={brushLike}
				options={{ ...DEFAULT_TOOL_OPTIONS, size: 12, opacity: 0.5 }}
				onChange={vi.fn()}
			/>
		);
		const outputs = [...screen.getByRole('toolbar').querySelectorAll('output')].map(
			(output) => output.textContent
		);
		expect(outputs).toEqual(['12 px', '50%']);
	});

	it('runs the size over the range the [ and ] keys keep to', () => {
		render(<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />);
		const size = screen.getByRole('slider', { name: 'Size' });
		expect(size.getAttribute('min')).toBe(String(SIZE_MIN));
		expect(size.getAttribute('max')).toBe(String(SIZE_MAX));
	});

	it('emits the key and the number a slider is moved to', () => {
		const onChange = vi.fn();
		render(
			<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={onChange} />
		);
		fireEvent.change(screen.getByRole('slider', { name: 'Size' }), { target: { value: '24' } });
		expect(onChange).toHaveBeenCalledWith('size', 24);
		fireEvent.change(screen.getByRole('slider', { name: 'Opacity' }), {
			target: { value: '0.25' },
		});
		expect(onChange).toHaveBeenCalledWith('opacity', 0.25);
	});

	it('emits a boolean when a toggle is pressed', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={onChange} />
		);
		const pressure = screen.getByRole('button', { name: 'Pressure' });
		expect(pressure.getAttribute('aria-pressed')).toBe('true');
		await user.click(pressure);
		expect(onChange).toHaveBeenCalledWith('pressure', false);
	});

	it('shows a colour field per colour option, which emits the colour as #rrggbb', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<OptionsStrip tool={rectangleLike} options={DEFAULT_TOOL_OPTIONS} onChange={onChange} />
		);
		fireEvent.change(screen.getByLabelText('Fill'), { target: { value: '#ff0000' } });
		expect(onChange).toHaveBeenCalledWith('fill', '#ff0000');
		await user.type(screen.getByRole('textbox', { name: 'Stroke (hex)' }), '#00FF00{Enter}');
		expect(onChange).toHaveBeenCalledWith('stroke', '#00ff00');
	});

	it("lets a shape's fill and stroke be none, but not a brush's fill, which is the paint", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const { unmount } = render(
			<OptionsStrip tool={rectangleLike} options={DEFAULT_TOOL_OPTIONS} onChange={onChange} />
		);
		// Fill first, then stroke, as the tool names them; the stroke is none already.
		const [fillNone, strokeNone] = screen.getAllByRole('button', { name: 'None' });
		expect(strokeNone?.getAttribute('aria-pressed')).toBe('true');
		await user.click(fillNone as HTMLElement);
		expect(onChange).toHaveBeenCalledWith('fill', 'none');
		unmount();

		render(<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />);
		expect(screen.getByLabelText('Fill')).toBeDefined();
		expect(screen.queryByRole('button', { name: 'None' })).toBeNull();
	});

	it('is there, empty, for a tool with no options, so the layout does not jump', () => {
		render(
			<OptionsStrip
				tool={{ id: 'hand', options: [], behaviours: {} }}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={vi.fn()}
			/>
		);
		const bar = screen.getByRole('toolbar', { name: 'Tool options' });
		expect(bar.querySelectorAll('input, button')).toHaveLength(0);
	});
});
