import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ToolBar } from '../../src/components/ui/ToolBar.js';
import { editorReducer, initialEditorState } from '../../src/drawing/editorState.js';
import type * as Keys from '../../src/drawing/keys.js';
import { ToolButtons } from '../../src/drawing/panels/ToolButtons.js';
import { TOOLS } from '../../src/drawing/tools/index.js';
import { inToolOptions } from '../../src/drawing/tools/optionsRegion.js';
import type { Tool } from '../../src/drawing/tools/types.js';

/**
 * What the tool bar holds (docs/ARCHITECTURE.md §7, "The interface"): the
 * tools, then the two colors and the layers. The colors are where the tool's
 * options are set, each press asks the frame's state for what it does, and a
 * color changed anywhere else shows in the bar at once, since it is the
 * state's and the bar is handed it.
 */

// The key the swap shows is `keys.ts`'s; what the map says is `keys.test.ts`'s.
vi.mock('../../src/drawing/keys.js', async (importOriginal) => ({
	...(await importOriginal<typeof Keys>()),
	shortcutFor: (action: string) =>
		(({ swapColors: 'X', resetColors: 'D' }) as Readonly<Record<string, string>>)[action],
}));

const brush = TOOLS.find((each) => each.id === 'brush') as Tool;

const renderButtons = (props: Partial<ComponentProps<typeof ToolButtons>> = {}) => {
	const dispatch = vi.fn();
	const onLayers = vi.fn();
	const utils = render(
		<ToolBar orientation="vertical" label="Tools">
			<ToolButtons
				tool={brush}
				fill="#111827"
				stroke="none"
				editing={undefined}
				compact={false}
				layersOpen={false}
				dispatch={dispatch}
				onLayers={onLayers}
				{...props}
			/>
		</ToolBar>
	);
	return { ...utils, dispatch, onLayers };
};

const button = (name: string) => screen.getByRole('button', { name });

const PAIR = ['Fill color: #111827', 'Stroke color: none', 'Swap colors'];

describe('ToolButtons', () => {
	it('holds the tools, then the colors, then the layers', () => {
		renderButtons();
		const names = screen.getAllByRole('button').map((each) => each.getAttribute('aria-label'));
		expect(names.slice(0, TOOLS.length)).toHaveLength(TOOLS.length);
		expect(names.slice(TOOLS.length)).toEqual([...PAIR, 'Layers']);
		expect(button('Brush').getAttribute('aria-pressed')).toBe('true');
	});

	it('marks the colors as where the tool’s options are set, and neither the tools nor the layers', () => {
		renderButtons();
		PAIR.forEach((name) => {
			expect(button(name).closest('[data-tool-options]')).not.toBeNull();
			expect(inToolOptions(button(name))).toBe(true);
		});
		expect(inToolOptions(button('Layers'))).toBe(false);
		expect(inToolOptions(button('Brush'))).toBe(false);
	});

	it('asks the state for the color panel on a color, and the swap', async () => {
		const user = userEvent.setup();
		const { dispatch, onLayers } = renderButtons();
		await user.click(button('Fill color: #111827'));
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'editColor', which: 'fill' });
		await user.click(button('Stroke color: none'));
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'editColor', which: 'stroke' });
		await user.click(button('Swap colors'));
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'swapColors' });
		await user.click(button('Layers'));
		expect(onLayers).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledTimes(3);
	});

	it('shows the key the map has for the swap, and leaves the reset to the color panel', () => {
		renderButtons();
		expect(button('Swap colors').title).toBe('Swap colors (X)');
		expect(screen.queryByRole('button', { name: 'Reset colors' })).toBeNull();
	});

	it('shows which color the color panel is open on', () => {
		renderButtons({ editing: 'stroke' });
		expect(button('Stroke color: none').getAttribute('aria-pressed')).toBe('true');
		expect(button('Fill color: #111827').getAttribute('aria-pressed')).toBe('false');
	});

	it('is the compact pair where the bar is short of room: both colors in one, and the swap', async () => {
		const user = userEvent.setup();
		const { dispatch } = renderButtons({ compact: true });
		const names = screen.getAllByRole('button').map((each) => each.getAttribute('aria-label'));
		expect(names.slice(TOOLS.length)).toEqual(['Colors', 'Swap colors', 'Layers']);
		expect(inToolOptions(button('Colors'))).toBe(true);
		await user.click(button('Colors'));
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'editColor', which: 'fill' });
	});

	it('shows a color changed elsewhere at once: by the color panel or the eyedropper, and by X', async () => {
		const user = userEvent.setup();
		// The frame, as far as the colors go: its state, and the bar it hands them to.
		const Frame = () => {
			const [state, dispatch] = useReducer(editorReducer, initialEditorState);
			return (
				<>
					<button
						type="button"
						onClick={() =>
							dispatch({ type: 'setColor', which: 'fill', value: '#e11d48' })
						}
					>
						Panel picks
					</button>
					<button
						type="button"
						onClick={() =>
							dispatch({
								type: 'setColor',
								which: 'stroke',
								value: 'rgb(37, 99, 235)',
							})
						}
					>
						Eyedropper reads
					</button>
					<button type="button" onClick={() => dispatch({ type: 'swapColors' })}>
						Key X
					</button>
					<ToolBar orientation="vertical" label="Tools">
						<ToolButtons
							tool={brush}
							fill={state.options.fill}
							stroke={state.options.stroke}
							editing={undefined}
							compact={false}
							layersOpen={false}
							dispatch={dispatch}
							onLayers={vi.fn()}
						/>
					</ToolBar>
				</>
			);
		};
		render(<Frame />);
		expect(button('Fill color: #111827')).toBeDefined();

		await user.click(button('Panel picks'));
		expect(button('Fill color: #e11d48')).toBeDefined();

		await user.click(button('Eyedropper reads'));
		const stroke = button('Stroke color: #2563eb');
		expect(stroke.querySelector('.color-pair-square')?.getAttribute('style')).toContain(
			'color: rgb(37, 99, 235)'
		);

		await user.click(button('Key X'));
		expect(button('Fill color: #2563eb')).toBeDefined();
		expect(button('Stroke color: #e11d48')).toBeDefined();

		// And the pair's own swap, through the same state.
		await user.click(button('Swap colors'));
		expect(button('Fill color: #e11d48')).toBeDefined();
	});
});
