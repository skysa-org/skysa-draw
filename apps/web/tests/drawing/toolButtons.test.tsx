import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToolBar } from '../../src/components/ui/ToolBar.js';
import { editorReducer, initialEditorState } from '../../src/drawing/editorState.js';
import { ToolButtons } from '../../src/drawing/panels/ToolButtons.js';
import { TOOLS } from '../../src/drawing/tools/index.js';
import { inToolOptions } from '../../src/drawing/tools/optionsRegion.js';
import type { Tool } from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';

/**
 * What the tool bar holds (docs/ARCHITECTURE.md §7, "The interface"): the
 * tools in their groups, a rule between each two, folded where the bar is
 * short of room (docs/decisions/0004-the-interface.md, "The tool bar"); then
 * the colors as one button and the layers. The colors are where the tool's
 * options are set, each press asks the frame's state for what it does, and a
 * color changed anywhere else shows in the bar at once, since it is the
 * state's and the bar is handed it.
 */

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const toolById = (id: Tool['id']) => TOOLS.find((each) => each.id === id) as Tool;
const brush = toolById('brush');

const renderButtons = (props: Partial<ComponentProps<typeof ToolButtons>> = {}) => {
	const dispatch = vi.fn();
	const onLayers = vi.fn();
	const utils = render(
		<ToolBar orientation="vertical" label="Tools">
			<ToolButtons
				tool={brush}
				layerKind={undefined}
				orientation="vertical"
				fill="#111827"
				stroke="none"
				colorsOpen={false}
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

const toolNames = () =>
	screen
		.getAllByRole('button')
		.map((each) => each.getAttribute('aria-label'))
		.filter((name) => TOOLS.some((each) => name === t(`tools.${each.id}`)));

/** The tools region, in order: a tool by its name, `▾` where it is a folded group, and `|` a rule. */
const barText = (container: HTMLElement) =>
	[...(container.querySelector('.tool-groups')?.children ?? [])]
		.map((each) =>
			each.getAttribute('role') === 'separator'
				? '|'
				: `${each.getAttribute('aria-label') ?? ''}${each.hasAttribute('aria-haspopup') ? '▾' : ''}`
		)
		.join(' ');

/**
 * A bar as a browser lays it out: every tool and rule 44 px along it, with no
 * gap, measured as a `ResizeObserver` reports; `measured(container, room)`
 * gives the tools `room` px and reports it.
 */
const laidOut = () => {
	const observed: ResizeObserverCallback[] = [];
	class FakeResizeObserver {
		constructor(callback: ResizeObserverCallback) {
			observed.push(callback);
		}
		observe = () => undefined;
		unobserve = () => undefined;
		disconnect = () => undefined;
	}
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(44);
	return (container: HTMLElement, room: number) => {
		const box = container.querySelector('.tool-groups');
		if (box === null) throw new Error('no tools');
		Object.defineProperty(box, 'clientHeight', { configurable: true, value: room });
		act(() => {
			observed.forEach((callback) => callback([], {} as ResizeObserver));
		});
	};
};

describe('the tools shown, by the active layer’s kind', () => {
	it('shows every tool with no layer, in the groups’ order', () => {
		renderButtons();
		expect(toolNames()).toEqual(TOOLS.map((each) => t(`tools.${each.id}`)));
	});

	it('leaves out on a vector layer the tools that only work pixels', () => {
		renderButtons({ layerKind: 'vector' });
		expect(toolNames()).not.toContain('Smudge');
		expect(toolNames()).not.toContain('Remove');
		expect(toolNames()).not.toContain('Red eye');
		expect(toolNames()).toContain('Magic wand');
		expect(toolNames()).toContain('Pen');
	});

	it('leaves out on a raster layer the tools that only work shapes', () => {
		renderButtons({ layerKind: 'raster' });
		expect(toolNames()).not.toContain('Node');
		expect(toolNames()).not.toContain('Pen');
		expect(toolNames()).not.toContain('Text');
		expect(toolNames()).toContain('Remove');
		expect(toolNames()).toContain('Red eye');
	});

	it('shows on a group only what acts there: the move tool, which moves it or picks inside it, and the view’s', () => {
		renderButtons({ tool: toolById('select'), layerKind: 'group' });
		expect(toolNames()).toEqual(['Select', 'Crop', 'Hand', 'Zoom']);
	});

	it('keeps the tool in hand, faded and pressed, where the layer has no use for it', () => {
		renderButtons({ tool: toolById('remove'), layerKind: 'vector' });
		const remove = button('Remove');
		expect(remove.getAttribute('aria-pressed')).toBe('true');
		expect(remove.classList.contains('is-unavailable')).toBe(true);
		expect(button('Brush').classList.contains('is-unavailable')).toBe(false);
		expect(toolNames()).not.toContain('Red eye');
	});
});

describe('the groups', () => {
	it('parts each group from the next with a rule across the bar, and none for a group not shown', () => {
		const { container } = renderButtons({ tool: toolById('select'), layerKind: 'vector' });
		expect(barText(container)).toBe(
			'Select | Marquee Lasso Magic wand | Crop Eyedropper | Brush Pencil Eraser Fill | Pen Text Node | Rectangle Ellipse Line | Hand Zoom'
		);
		const rules = screen.getAllByRole('separator');
		expect(rules).toHaveLength(6);
		expect(rules[0]?.getAttribute('aria-orientation')).toBe('horizontal');
	});

	it('draws its rules upright in a bar that runs across', () => {
		renderButtons({ orientation: 'horizontal', layerKind: 'vector' });
		expect(screen.getAllByRole('separator')[0]?.getAttribute('aria-orientation')).toBe(
			'vertical'
		);
	});

	it('folds nothing where the browser cannot measure the bar', () => {
		renderButtons({ layerKind: 'vector' });
		expect(document.querySelector('[aria-haspopup]')).toBeNull();
	});

	it('folds the largest group first where the bar is short, and unfolds it given the room', () => {
		const measured = laidOut();
		const { container } = renderButtons({ tool: toolById('select'), layerKind: 'vector' });
		// 18 tools and 6 rules, 44 px each: 1056 px; with painting folded, 924.
		measured(container, 1055);
		expect(barText(container)).toContain('| Brush▾ |');
		expect(barText(container)).not.toContain('Rectangle▾');
		expect(toolNames()).not.toContain('Pencil');

		measured(container, 923);
		expect(barText(container)).toContain('| Brush▾ |');
		expect(barText(container)).toContain('| Rectangle▾ |');

		measured(container, 1056);
		expect(barText(container)).not.toContain('▾');
	});

	it('shows folded the tool in hand, and the one last used after the hand moves on', () => {
		const measured = laidOut();
		const { container, rerender } = renderButtons({
			tool: toolById('eraser'),
			layerKind: 'vector',
		});
		measured(container, 100);
		expect(barText(container)).toContain('Eraser▾');
		expect(button('Eraser').getAttribute('aria-pressed')).toBe('true');
		rerender(
			<ToolBar orientation="vertical" label="Tools">
				<ToolButtons
					tool={toolById('marquee')}
					layerKind="vector"
					orientation="vertical"
					fill="#111827"
					stroke="none"
					colorsOpen={false}
					layersOpen={false}
					dispatch={vi.fn()}
					onLayers={vi.fn()}
				/>
			</ToolBar>
		);
		expect(barText(container)).toContain('Eraser▾');
		expect(button('Eraser').getAttribute('aria-pressed')).toBe('false');
	});

	it('picks a folded group’s tool with a press, and opens its menu with a right-click', async () => {
		const user = userEvent.setup();
		const measured = laidOut();
		const { container, dispatch } = renderButtons({
			tool: toolById('select'),
			layerKind: 'raster',
		});
		measured(container, 100);
		await user.click(button('Brush'));
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'setTool', toolId: 'brush' });

		fireEvent.contextMenu(button('Remove'));
		const menu = screen.getByRole('menu', { name: 'Retouching tools' });
		const items = within(menu).getAllByRole('menuitemradio');
		expect(items.map((item) => item.textContent)).toEqual(['RemoveJ', 'Red eyeJ', 'SmudgeS']);
		expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
			'false',
			'false',
			'false',
		]);
		await user.click(within(menu).getByRole('menuitemradio', { name: 'Red eye' }));
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'setTool', toolId: 'redEye' });
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('checks the tool in hand in its group’s menu', () => {
		const measured = laidOut();
		const { container } = renderButtons({ tool: toolById('smudge'), layerKind: 'raster' });
		measured(container, 100);
		fireEvent.contextMenu(button('Smudge'));
		const menu = screen.getByRole('menu', { name: 'Retouching tools' });
		expect(
			within(menu)
				.getAllByRole('menuitemradio')
				.map((item) => item.getAttribute('aria-checked'))
		).toEqual(['false', 'false', 'true']);
	});

	it('never folds a group of one, as the tool in hand alone in its group on a layer it does nothing on', () => {
		const measured = laidOut();
		const { container } = renderButtons({ tool: toolById('smudge'), layerKind: 'vector' });
		measured(container, 100);
		expect(button('Smudge').hasAttribute('aria-haspopup')).toBe(false);
		expect(button('Select').hasAttribute('aria-haspopup')).toBe(false);
	});
});

describe('the colors and the layers', () => {
	it('come after the tools: the colors as one button, then the layers, with no swap', () => {
		renderButtons();
		const names = screen.getAllByRole('button').map((each) => each.getAttribute('aria-label'));
		expect(names.slice(TOOLS.length)).toEqual(['Colors', 'Layers']);
		expect(screen.queryByRole('button', { name: 'Swap colors' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Reset colors' })).toBeNull();
		expect(button('Brush').getAttribute('aria-pressed')).toBe('true');
	});

	it('say what the two colors are', () => {
		renderButtons();
		expect(
			screen.getByRole('button', {
				name: 'Colors',
				description: 'Fill color: #111827 Stroke color: none',
			})
		).toBeDefined();
	});

	it('mark the colors as where the tool’s options are set, and neither the tools nor the layers', () => {
		renderButtons();
		expect(button('Colors').closest('[data-tool-options]')).not.toBeNull();
		expect(inToolOptions(button('Colors'))).toBe(true);
		expect(inToolOptions(button('Layers'))).toBe(false);
		expect(inToolOptions(button('Brush'))).toBe(false);
	});

	it('open and close the color panel through the state, and the layers through the frame', async () => {
		const user = userEvent.setup();
		const { dispatch, onLayers } = renderButtons();
		await user.click(button('Colors'));
		expect(dispatch).toHaveBeenLastCalledWith({ type: 'togglePanel', panel: 'color' });
		await user.click(button('Layers'));
		expect(onLayers).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('show the color panel open as the colors pressed', () => {
		renderButtons({ colorsOpen: true });
		expect(button('Colors').getAttribute('aria-pressed')).toBe('true');
	});

	it('show a color changed elsewhere at once: by the color panel or the eyedropper, and by X', async () => {
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
							layerKind="raster"
							orientation="vertical"
							fill={state.options.fill}
							stroke={state.options.stroke}
							colorsOpen={state.panel === 'color'}
							layersOpen={false}
							dispatch={dispatch}
							onLayers={vi.fn()}
						/>
					</ToolBar>
				</>
			);
		};
		render(<Frame />);
		const colors = () => button('Colors');
		const description = () =>
			screen.getByRole('button', { name: 'Colors' }).getAttribute('aria-describedby') ?? '';
		const said = () =>
			description()
				.split(' ')
				.map((id) => document.getElementById(id)?.textContent)
				.join(' ');

		await user.click(button('Panel picks'));
		expect(said()).toBe('Fill color: #e11d48 Stroke color: none');

		await user.click(button('Eyedropper reads'));
		expect(said()).toBe('Fill color: #e11d48 Stroke color: #2563eb');
		expect(colors().querySelector('.color-pair-mark-stroke')?.getAttribute('style')).toContain(
			'color: rgb(37, 99, 235)'
		);

		await user.click(button('Key X'));
		expect(said()).toBe('Fill color: #2563eb Stroke color: #e11d48');

		// And the pair's own press, through the same state: the panel opens and closes.
		await user.click(colors());
		expect(colors().getAttribute('aria-pressed')).toBe('true');
		await user.click(colors());
		expect(colors().getAttribute('aria-pressed')).toBe('false');
	});
});
