import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { MenuItem } from '../../src/components/ui/Menu.js';
import { PanelHost } from '../../src/components/ui/PanelHost.js';
import { SIZE_MAX, SIZE_MIN } from '../../src/drawing/editorState.js';
import { ColorPanel } from '../../src/drawing/panels/ColorPanel.js';
import { OptionsStrip } from '../../src/drawing/panels/OptionsStrip.js';
import type { Arrangement } from '../../src/drawing/tools/common/align.js';
import { toolById, TOOLS } from '../../src/drawing/tools/index.js';
import { inToolOptions } from '../../src/drawing/tools/optionsRegion.js';
import { type AlignTo, DEFAULT_TOOL_OPTIONS, type Tool } from '../../src/drawing/tools/types.js';

/**
 * The strip of options for the tool in hand (docs/ARCHITECTURE.md §7, "The
 * interface"): each option the tool names, as the control its kind takes.
 * Tools of the test's own, so the strip is tested without the tools themselves.
 */

/** A tool with one option of each kind. */
const brushLike: Tool = {
	id: 'brush',
	options: ['size', 'opacity', 'pressure', 'fill'],
	behaviors: {},
};

const rectangleLike: Tool = { id: 'rectangle', options: ['fill', 'stroke'], behaviors: {} };

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

	it('shows the move tool’s Auto-select as a toggle, off until it is pressed', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const moveLike: Tool = { id: 'select', options: ['autoSelect'], behaviors: {} };
		render(<OptionsStrip tool={moveLike} options={DEFAULT_TOOL_OPTIONS} onChange={onChange} />);
		const toggle = screen.getByRole('button', { name: 'Auto-select' });
		// Its name in words, as Photoshop's options bar has it: no icon says what it does.
		expect(toggle.textContent).toBe('Auto-select');
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		await user.click(toggle);
		expect(onChange).toHaveBeenCalledWith('autoSelect', true);
	});

	it('shows a color field per color option, which emits the color as #rrggbb', async () => {
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
				tool={{ id: 'hand', options: [], behaviors: {} }}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={vi.fn()}
			/>
		);
		const bar = screen.getByRole('toolbar', { name: 'Tool options' });
		expect(bar.querySelectorAll('input, button')).toHaveLength(0);
	});

	it('shows the selection’s actions after the tool’s own, as buttons with their keys, a rule between groups', async () => {
		const user = userEvent.setup();
		const deselect = vi.fn();
		const actions: readonly MenuItem[] = [
			{ id: 'deselect', label: 'Deselect', shortcut: 'Ctrl+D', onSelect: deselect },
			{
				id: 'layerViaCopy',
				label: 'Layer via copy',
				onSelect: vi.fn(),
				separatorBefore: true,
			},
			{ id: 'fill', label: 'Fill', onSelect: vi.fn(), disabled: true },
		];
		render(
			<OptionsStrip
				tool={{ id: 'marquee', options: ['constrain'], behaviors: {} }}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={vi.fn()}
				actions={actions}
			/>
		);
		const bar = screen.getByRole('group', { name: 'Selection' });
		const constrain = screen.getByRole('button', { name: 'Constrain' });
		expect(constrain.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
			0
		);
		const buttons = [...bar.querySelectorAll('button')];
		expect(buttons.map((button) => button.textContent)).toEqual([
			'Deselect',
			'Layer via copy',
			'Fill',
		]);
		expect(buttons[0]?.getAttribute('title')).toBe('Deselect (Ctrl+D)');
		expect(buttons[2]).toHaveProperty('disabled', true);
		expect(bar.querySelectorAll('[role="separator"]')).toHaveLength(1);
		await user.click(screen.getByRole('button', { name: 'Deselect' }));
		expect(deselect).toHaveBeenCalledTimes(1);
	});

	it('shows only the selection’s Apply and Cancel while Transform selection is on, none of the tool’s options', () => {
		const actions: readonly MenuItem[] = [
			{ id: 'applyTransform', label: 'Apply', onSelect: vi.fn() },
			{ id: 'cancelTransform', label: 'Cancel', onSelect: vi.fn() },
		];
		const marqueeLike: Tool = {
			id: 'marquee',
			options: ['areaMode', 'constrain'],
			behaviors: {},
		};
		render(
			<OptionsStrip
				tool={marqueeLike}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={vi.fn()}
				actions={actions}
				transforming
			/>
		);
		const strip = screen.getByRole('toolbar', { name: 'Tool options' });
		expect(screen.queryByRole('group', { name: 'Selection mode' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Constrain' })).toBeNull();
		expect([...strip.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
			'Apply',
			'Cancel',
		]);
	});

	it('shows the selection tools’ mode first, as a group of four buttons named in words, the one in force pressed', () => {
		const marqueeLike: Tool = {
			id: 'marquee',
			options: ['areaMode', 'constrain'],
			behaviors: {},
		};
		render(
			<OptionsStrip
				tool={marqueeLike}
				options={{ ...DEFAULT_TOOL_OPTIONS, areaMode: 'subtract' }}
				onChange={vi.fn()}
			/>
		);
		const group = screen.getByRole('group', { name: 'Selection mode' });
		const buttons = [...group.querySelectorAll('button')];
		expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
			'New selection',
			'Add to selection',
			'Subtract from selection',
			'Intersect with selection',
		]);
		expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
			'false',
			'false',
			'true',
			'false',
		]);
		buttons.forEach((button) => {
			expect(button.querySelector('svg')).not.toBeNull();
		});
		const constrain = screen.getByRole('button', { name: 'Constrain' });
		expect(
			group.compareDocumentPosition(constrain) & Node.DOCUMENT_POSITION_FOLLOWING
		).not.toBe(0);
	});

	it('emits the mode pressed', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<OptionsStrip
				tool={{ id: 'lasso', options: ['areaMode'], behaviors: {} }}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={onChange}
			/>
		);
		expect(
			screen.getByRole('button', { name: 'New selection' }).getAttribute('aria-pressed')
		).toBe('true');
		await user.click(screen.getByRole('button', { name: 'Intersect with selection' }));
		expect(onChange).toHaveBeenCalledWith('areaMode', 'intersect');
	});

	it.each([
		[
			false,
			[
				'New selection',
				'Add to selection (Shift)',
				'Subtract from selection (Alt)',
				'Intersect with selection (Shift+Alt)',
			],
		],
		[
			true,
			[
				'New selection',
				'Add to selection (⇧)',
				'Subtract from selection (⌥)',
				'Intersect with selection (⌥⇧)',
			],
		],
	] as const)(
		'puts in each mode’s tooltip the keys that make it for one drag (a Mac: %s)',
		(mac, titles) => {
			render(
				<OptionsStrip
					tool={{ id: 'wand', options: ['areaMode'], behaviors: {} }}
					options={DEFAULT_TOOL_OPTIONS}
					onChange={vi.fn()}
					mac={mac}
				/>
			);
			const group = screen.getByRole('group', { name: 'Selection mode' });
			expect([...group.querySelectorAll('button')].map((button) => button.title)).toEqual(
				titles
			);
		}
	);

	it('shows no selection bar with no actions', () => {
		render(<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />);
		expect(screen.queryByRole('group', { name: 'Selection' })).toBeNull();
	});
});

describe('the move tool’s Auto-select mode and Snap', () => {
	/** The move tool as the registry has it, with its options in its order. */
	const move = toolById('select') as Tool;

	it('names Auto-select, what it picks, and Snap, in that order, for the move tool', () => {
		expect(move.options).toEqual(['autoSelect', 'autoSelectMode', 'snap']);
		render(<OptionsStrip tool={move} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />);
		const controls = [
			screen.getByRole('button', { name: 'Auto-select' }),
			screen.getByRole('combobox', { name: 'Auto-select picks' }),
			screen.getByRole('button', { name: 'Snap' }),
		];
		const inPageOrder = [...controls].sort((a, b) =>
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
		);
		expect(inPageOrder).toEqual(controls);
	});

	it('shows what Auto-select picks as a menu of Layer and Group, its name for a screen reader alone', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(<OptionsStrip tool={move} options={DEFAULT_TOOL_OPTIONS} onChange={onChange} />);
		const mode = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Auto-select picks' });
		expect(mode.value).toBe('layer');
		expect([...mode.options].map((option) => option.textContent)).toEqual(['Layer', 'Group']);
		// Auto-select's name is beside it already, as in Photoshop's options bar.
		expect(mode.labels[0]?.querySelector('.visually-hidden')?.textContent).toBe(
			'Auto-select picks'
		);
		await user.selectOptions(mode, 'Group');
		expect(onChange).toHaveBeenCalledExactlyOnceWith('autoSelectMode', 'group');
	});

	it('shows the mode in force, whether Auto-select is on or off, since Ctrl or ⌘ picks in it', () => {
		render(
			<OptionsStrip
				tool={move}
				options={{ ...DEFAULT_TOOL_OPTIONS, autoSelectMode: 'group' }}
				onChange={vi.fn()}
			/>
		);
		const mode = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Auto-select picks' });
		expect(mode.value).toBe('group');
		expect(mode.disabled).toBe(false);
	});

	it('shows Snap as a toggle, on by default, with its key in its tooltip as each platform writes it', async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		const { unmount } = render(
			<OptionsStrip
				tool={move}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={onChange}
				mac={false}
			/>
		);
		const snap = screen.getByRole('button', { name: 'Snap' });
		expect(snap.textContent).toBe('Snap');
		expect(snap.getAttribute('aria-pressed')).toBe('true');
		expect(snap.title).toBe('Snap (Ctrl+Shift+;)');
		// A toggle no key turns on and off has no tooltip: its name is shown.
		expect(screen.getByRole('button', { name: 'Auto-select' }).hasAttribute('title')).toBe(
			false
		);
		await user.click(snap);
		expect(onChange).toHaveBeenCalledExactlyOnceWith('snap', false);
		unmount();
		render(<OptionsStrip tool={move} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} mac />);
		expect(screen.getByRole('button', { name: 'Snap' }).title).toBe('Snap (⇧⌘;)');
	});

	it('is no other tool’s', () => {
		const others = TOOLS.filter((tool) => tool.id !== 'select');
		others.forEach((tool) => {
			expect(tool.options).not.toContain('autoSelectMode');
			expect(tool.options).not.toContain('snap');
		});
		render(<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />);
		expect(screen.queryByRole('combobox')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Snap' })).toBeNull();
	});

	it('comes before the alignment, which follows Snap, ruled off from it', () => {
		render(
			<OptionsStrip
				tool={move}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={vi.fn()}
				align={{ count: 1, onArrange: vi.fn() }}
			/>
		);
		const snap = screen.getByRole('button', { name: 'Snap' });
		const rule = snap.nextElementSibling;
		expect(rule?.getAttribute('role')).toBe('separator');
		expect(rule?.nextElementSibling).toBe(screen.getByRole('group', { name: 'Align' }));
	});
});

describe('the move tool’s alignment', () => {
	const moveLike: Tool = { id: 'select', options: ['autoSelect'], behaviors: {} };

	const SIX = [
		'Align left edges',
		'Align horizontal centers',
		'Align right edges',
		'Align top edges',
		'Align vertical centers',
		'Align bottom edges',
	];

	const DISTRIBUTIONS = [
		'Distribute top edges',
		'Distribute vertical centers',
		'Distribute bottom edges',
		'Distribute left edges',
		'Distribute horizontal centers',
		'Distribute right edges',
		'Distribute vertical spacing',
		'Distribute horizontal spacing',
	];

	const TO = ['Align to selection', 'Align to canvas'];

	/** The strip with the move tool in hand, `count` layers to move, aligned to `alignTo`. */
	const strip = (
		count: number,
		alignTo: AlignTo = 'selection',
		more: Partial<Parameters<typeof OptionsStrip>[0]> = {}
	) => {
		const onArrange = vi.fn<(arrangement: Arrangement) => void>();
		const onChange = vi.fn();
		render(
			<OptionsStrip
				tool={moveLike}
				options={{ ...DEFAULT_TOOL_OPTIONS, alignTo }}
				onChange={onChange}
				align={{ count, onArrange }}
				{...more}
			/>
		);
		return { onArrange, onChange };
	};

	const group = () => screen.queryByRole('group', { name: 'Align' });

	/** The menu after the six, opened: each item's name, and the radios' checks. */
	const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click(screen.getByRole('button', { name: 'More alignment' }));
		const menu = screen.getByRole('menu', { name: 'More alignment' });
		const items = [...menu.querySelectorAll('[role^="menuitem"]')];
		return {
			menu,
			names: items.map((item) => item.textContent),
			checked: items
				.filter((item) => item.getAttribute('role') === 'menuitemradio')
				.map((item) => item.getAttribute('aria-checked')),
			rules: menu.querySelectorAll('[role="separator"]').length,
		};
	};

	it('comes after Auto-select, ruled off from it, as a group of the six named in words, each by its icon, then its menu', () => {
		strip(1);
		const bar = group();
		expect(bar).not.toBeNull();
		const buttons = [...(bar?.querySelectorAll('button') ?? [])];
		expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
			...SIX,
			'More alignment',
		]);
		expect(buttons.map((button) => button.title)).toEqual([...SIX, 'More alignment']);
		buttons.forEach((button) => {
			expect(button.querySelector('svg')).not.toBeNull();
		});
		expect(buttons.at(-1)?.getAttribute('aria-haspopup')).toBe('menu');
		const autoSelect = screen.getByRole('button', { name: 'Auto-select' });
		const rule = screen
			.getByRole('toolbar', { name: 'Tool options' })
			.querySelector(':scope > [role="separator"]');
		expect(rule).not.toBeNull();
		expect(autoSelect.compareDocumentPosition(rule as Element)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING
		);
		expect((rule as Element).nextElementSibling).toBe(bar);
	});

	it('comes before the selection bar, which is the selection’s and not the tool’s', () => {
		strip(1, 'selection', {
			actions: [{ id: 'deselect', label: 'Deselect', onSelect: vi.fn() }],
		});
		const selectionBar = screen.getByRole('group', { name: 'Selection' });
		expect(group()?.compareDocumentPosition(selectionBar)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING
		);
	});

	it('is not there for another tool, without the frame’s say, or while Transform selection is on', () => {
		const onArrange = vi.fn();
		const { unmount } = render(
			<OptionsStrip
				tool={brushLike}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={vi.fn()}
				align={{ count: 2, onArrange }}
			/>
		);
		expect(group()).toBeNull();
		unmount();
		const without = render(
			<OptionsStrip tool={moveLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />
		);
		expect(group()).toBeNull();
		expect(screen.queryByRole('button', { name: 'More alignment' })).toBeNull();
		without.unmount();
		strip(2, 'selection', {
			transforming: true,
			actions: [{ id: 'applyTransform', label: 'Apply', onSelect: vi.fn() }],
		});
		expect(group()).toBeNull();
		expect(screen.queryByRole('button', { name: 'Auto-select' })).toBeNull();
		expect(
			screen
				.getByRole('toolbar', { name: 'Tool options' })
				.querySelector('[role="separator"]')
		).toBeNull();
	});

	it('disables the six with no layer to move, and keeps in the menu the choice of what to align to', async () => {
		const user = userEvent.setup();
		strip(0);
		SIX.forEach((name) => {
			expect(screen.getByRole('button', { name })).toHaveProperty('disabled', true);
		});
		expect(screen.getByRole('button', { name: 'More alignment' })).toHaveProperty(
			'disabled',
			false
		);
		const { names, checked, rules } = await openMenu(user);
		expect(names).toEqual(TO);
		expect(checked).toEqual(['true', 'false']);
		expect(rules).toBe(0);
	});

	it.each([
		[1, 'selection', false],
		[1, 'canvas', false],
		[2, 'selection', false],
		[2, 'canvas', true],
		[3, 'selection', true],
		[3, 'canvas', true],
	] as const)(
		'with %i layers aligned to the %s, lists the distributions only where they apply (%s)',
		async (count, alignTo, distributes) => {
			const user = userEvent.setup();
			strip(count, alignTo);
			SIX.forEach((name) => {
				expect(screen.getByRole('button', { name })).toHaveProperty('disabled', false);
			});
			const { names, checked, rules } = await openMenu(user);
			expect(names).toEqual(distributes ? [...DISTRIBUTIONS, ...TO] : TO);
			expect(checked).toEqual(
				alignTo === 'selection' ? ['true', 'false'] : ['false', 'true']
			);
			// By edge across, by edge down, the spacing, then what to align to.
			expect(rules).toBe(distributes ? 3 : 0);
		}
	);

	it('draws each distribution by its icon, and the choice of what to align to by none', async () => {
		const user = userEvent.setup();
		strip(3);
		const { menu } = await openMenu(user);
		const icons = [...menu.querySelectorAll('[role^="menuitem"]')].map(
			(item) => item.querySelector('.menu-item-icon svg') !== null
		);
		expect(icons).toEqual([...DISTRIBUTIONS.map(() => true), false, false]);
	});

	it('arranges by the button or the item pressed', async () => {
		const user = userEvent.setup();
		const { onArrange, onChange } = strip(3);
		await user.click(screen.getByRole('button', { name: 'Align vertical centers' }));
		expect(onArrange).toHaveBeenLastCalledWith({ kind: 'align', edge: 'centerY' });
		await user.click(screen.getByRole('button', { name: 'Align left edges' }));
		expect(onArrange).toHaveBeenLastCalledWith({ kind: 'align', edge: 'left' });
		await openMenu(user);
		await user.click(screen.getByRole('menuitem', { name: 'Distribute horizontal spacing' }));
		expect(onArrange).toHaveBeenLastCalledWith({ kind: 'distribute', how: 'spaceX' });
		await openMenu(user);
		await user.click(screen.getByRole('menuitem', { name: 'Distribute top edges' }));
		expect(onArrange).toHaveBeenLastCalledWith({ kind: 'distribute', how: 'top' });
		expect(onArrange).toHaveBeenCalledTimes(4);
		expect(onChange).not.toHaveBeenCalled();
	});

	it('arranges nothing from a button disabled', async () => {
		const user = userEvent.setup();
		const { onArrange } = strip(0);
		await user.click(screen.getByRole('button', { name: 'Align top edges' }));
		expect(onArrange).not.toHaveBeenCalled();
	});

	it('sets what to align to from the menu’s radios, and changes nothing choosing the one in force', async () => {
		const user = userEvent.setup();
		const { onChange, onArrange } = strip(2, 'selection');
		await openMenu(user);
		await user.click(screen.getByRole('menuitemradio', { name: 'Align to canvas' }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith('alignTo', 'canvas');
		// Choosing closes the menu, as any item does.
		expect(screen.queryByRole('menu')).toBeNull();
		await openMenu(user);
		await user.click(screen.getByRole('menuitemradio', { name: 'Align to selection' }));
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onArrange).not.toHaveBeenCalled();
	});

	it('is where the tool’s options are set, its menu’s button too', () => {
		strip(1);
		expect(inToolOptions(screen.getByRole('button', { name: 'Align left edges' }))).toBe(true);
		expect(inToolOptions(screen.getByRole('button', { name: 'More alignment' }))).toBe(true);
	});
});

describe('where the tool’s options are set', () => {
	it('is the options strip, every control in it, and the color panel', () => {
		const { unmount } = render(
			<OptionsStrip tool={brushLike} options={DEFAULT_TOOL_OPTIONS} onChange={vi.fn()} />
		);
		expect(inToolOptions(screen.getByRole('toolbar', { name: 'Tool options' }))).toBe(true);
		expect(inToolOptions(screen.getByRole('slider', { name: 'Size' }))).toBe(true);
		expect(inToolOptions(screen.getByRole('button', { name: 'Pressure' }))).toBe(true);
		unmount();
		const modes = render(
			<OptionsStrip
				tool={{ id: 'marquee', options: ['areaMode'], behaviors: {} }}
				options={DEFAULT_TOOL_OPTIONS}
				onChange={vi.fn()}
			/>
		);
		expect(inToolOptions(screen.getByRole('button', { name: 'Add to selection' }))).toBe(true);
		modes.unmount();
		render(
			<ColorPanel
				options={DEFAULT_TOOL_OPTIONS}
				recent={['#ff0000']}
				onColor={vi.fn()}
				onSwap={vi.fn()}
				onReset={vi.fn()}
			/>
		);
		expect(inToolOptions(screen.getByRole('textbox', { name: 'Fill (hex)' }))).toBe(true);
		expect(inToolOptions(screen.getByRole('button', { name: 'Swap colors' }))).toBe(true);
	});

	it('is a sheet or a drawer that holds them, which takes the focus as it opens, and nothing else', () => {
		render(
			<PanelHost placement="drawer" open onClose={vi.fn()} label="Color">
				<ColorPanel
					options={DEFAULT_TOOL_OPTIONS}
					recent={[]}
					onColor={vi.fn()}
					onSwap={vi.fn()}
					onReset={vi.fn()}
				/>
			</PanelHost>
		);
		const drawer = screen.getByRole('dialog', { name: 'Color' });
		expect(document.activeElement).toBe(drawer);
		expect(inToolOptions(drawer)).toBe(true);
		expect(inToolOptions(document.body)).toBe(false);
		expect(inToolOptions(null)).toBe(false);
	});
});
