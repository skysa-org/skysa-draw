import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu, type MenuPoint } from '../../src/components/ui/ContextMenu.js';
import type { MenuItem } from '../../src/components/ui/Menu.js';

/**
 * A menu at a point (docs/decisions/0004-the-interface.md, "The context
 * menu"), over the canvas: the list a button's menu has, keys and all, opened
 * where the right-click was, placed so that it stays in the window, closed by
 * whatever moves what it was about, and giving the focus back where it was.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

/** What happened, in order: each close and each choice, with where the focus was then. */
const makeItems = (journal: string[], extra: Readonly<Record<string, Partial<MenuItem>>> = {}) => {
	const item = (id: string, own: Partial<MenuItem> = {}): MenuItem => ({
		id,
		label: id,
		onSelect: () => journal.push(`select ${id} at ${focusedText()}`),
		...own,
		...extra[id],
	});
	return [
		item('Deselect', { shortcut: 'Ctrl+D' }),
		item('Select inverse'),
		item('Feather…', { separatorBefore: true }),
		item('Layer via copy', { separatorBefore: true, disabled: true }),
		item('Layer via cut'),
		item('Clear', { separatorBefore: true, danger: true }),
	];
};

const focusedText = () => document.activeElement?.textContent ?? '';

/** The editor, as far as the menu sees it: a canvas that opens it where it is right-clicked. */
const Canvas = ({
	items,
	journal,
	onOuterContextMenu,
}: {
	items: readonly MenuItem[];
	journal: string[];
	onOuterContextMenu?: () => void;
}) => {
	const [at, setAt] = useState<MenuPoint | undefined>(undefined);
	return (
		<div role="presentation" onContextMenu={onOuterContextMenu}>
			<button
				type="button"
				onContextMenu={(event) => {
					event.preventDefault();
					setAt({ x: event.clientX, y: event.clientY });
				}}
			>
				Canvas
			</button>
			<button type="button">Elsewhere</button>
			<ContextMenu
				label="Selection"
				items={items}
				at={at}
				onClose={() => {
					journal.push(`close at ${focusedText()}`);
					setAt(undefined);
				}}
			/>
		</div>
	);
};

const renderCanvas = (
	extra: Readonly<Record<string, Partial<MenuItem>>> = {},
	onOuterContextMenu?: () => void
) => {
	const journal: string[] = [];
	render(
		<Canvas
			items={makeItems(journal, extra)}
			journal={journal}
			onOuterContextMenu={onOuterContextMenu}
		/>
	);
	const canvas = screen.getByRole('button', { name: 'Canvas' });
	const openAt = (x = 100, y = 100) => {
		canvas.focus();
		fireEvent.contextMenu(canvas, { clientX: x, clientY: y });
		return screen.getByRole('menu', { name: 'Selection' });
	};
	return { journal, canvas, openAt };
};

/** A window `width` by `height`, and a menu `menuWidth` by `menuHeight` in it. */
const lay = (width: number, height: number, menuWidth: number, menuHeight: number) => {
	vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width);
	vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height);
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(menuWidth);
	vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(menuHeight);
};

const placed = (menu: HTMLElement) => ({
	top: menu.style.top,
	left: menu.style.left,
	maxHeight: menu.style.maxHeight,
});

describe('ContextMenu', () => {
	it('is nothing until it is given a point, and then a menu named for what it is about', () => {
		const { openAt } = renderCanvas();
		expect(screen.queryByRole('menu')).toBeNull();

		const menu = openAt();
		expect(menu.getAttribute('aria-label')).toBe('Selection');
		expect(screen.getAllByRole('menuitem')).toHaveLength(6);
		expect(screen.getByRole('menuitem', { name: 'Clear' }).className).toContain(
			'menu-item-danger'
		);
		const key = screen.getByText('Ctrl+D');
		expect(
			screen.getByRole('menuitem', { name: 'Deselect' }).getAttribute('aria-describedby')
		).toBe(key.id);
	});

	it('draws a rule before each item that begins a group, and none above the first', () => {
		const { openAt } = renderCanvas({ Deselect: { separatorBefore: true } });
		const menu = openAt();
		const rules = screen.getAllByRole('separator');
		expect(rules).toHaveLength(3);
		expect(rules.every((rule) => rule.className === 'menu-separator')).toBe(true);
		expect(menu.firstElementChild?.getAttribute('role')).toBe('menuitem');
		expect(rules.map((rule) => rule.nextElementSibling?.textContent)).toEqual([
			'Feather…',
			'Layer via copy',
			'Clear',
		]);
	});

	it('takes the focus to the first item that can be chosen, and moves with the arrows past rules and disabled items, wrapping', async () => {
		const user = userEvent.setup();
		const { openAt } = renderCanvas({ Deselect: { disabled: true } });
		openAt();
		expect(focusedText()).toBe('Select inverse');

		await user.keyboard('{ArrowDown}');
		expect(focusedText()).toBe('Feather…');
		await user.keyboard('{ArrowDown}');
		expect(focusedText()).toBe('Layer via cut');
		await user.keyboard('{ArrowDown}');
		expect(focusedText()).toBe('Clear');
		await user.keyboard('{ArrowDown}');
		expect(focusedText()).toBe('Select inverse');
		await user.keyboard('{ArrowUp}');
		expect(focusedText()).toBe('Clear');
		await user.keyboard('{Home}');
		expect(focusedText()).toBe('Select inverse');
		await user.keyboard('{End}');
		expect(focusedText()).toBe('Clear');
		// Moving among the items is not losing the focus.
		expect(screen.getByRole('menu')).toBeDefined();
	});

	it('takes the focus to itself when nothing in it can be chosen, so that Escape still closes it', async () => {
		const user = userEvent.setup();
		const disabled = { disabled: true };
		const { openAt, canvas } = renderCanvas({
			Deselect: disabled,
			'Select inverse': disabled,
			'Feather…': disabled,
			'Layer via cut': disabled,
			Clear: disabled,
		});
		const menu = openAt();
		expect(document.activeElement).toBe(menu);

		await user.keyboard('{ArrowDown}');
		expect(document.activeElement).toBe(menu);
		await user.keyboard('{Escape}');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(canvas);
	});

	it('closes on Escape, gives the focus back, and keeps the key from what holds it', async () => {
		const user = userEvent.setup();
		const { journal, canvas, openAt } = renderCanvas();
		const outer = vi.fn();
		openAt();
		window.addEventListener('keydown', outer);

		await user.keyboard('{Escape}');
		window.removeEventListener('keydown', outer);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(canvas);
		expect(journal).toEqual(['close at Canvas']);
		expect(outer).not.toHaveBeenCalled();
	});

	it('keeps every key pressed in it from the editor’s keys', async () => {
		const user = userEvent.setup();
		const { openAt } = renderCanvas();
		const outer = vi.fn();
		openAt();
		window.addEventListener('keydown', outer);

		await user.keyboard('d{Delete}{ArrowDown}');
		window.removeEventListener('keydown', outer);
		expect(outer).not.toHaveBeenCalled();
		expect(screen.getByRole('menu')).toBeDefined();
	});

	it('chooses with Enter, giving the focus back, then closing, then letting the item act', async () => {
		const user = userEvent.setup();
		const { journal, canvas, openAt } = renderCanvas();
		openAt();
		await user.keyboard('{ArrowDown}{Enter}');
		expect(journal).toEqual(['close at Canvas', 'select Select inverse at Canvas']);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(canvas);
	});

	it('chooses with Space and with a click', async () => {
		const user = userEvent.setup();
		const { journal, openAt } = renderCanvas();
		openAt();
		await user.keyboard('{End} ');
		expect(journal).toEqual(['close at Canvas', 'select Clear at Canvas']);

		openAt();
		await user.click(screen.getByRole('menuitem', { name: 'Feather…' }));
		expect(journal.slice(2)).toEqual(['close at Canvas', 'select Feather… at Canvas']);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('lets an item keep the focus it takes', async () => {
		const user = userEvent.setup();
		const { openAt } = renderCanvas({
			'Feather…': {
				onSelect: () => screen.getByRole('button', { name: 'Elsewhere' }).focus(),
			},
		});
		openAt();
		await user.click(screen.getByRole('menuitem', { name: 'Feather…' }));
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Elsewhere' }));
	});

	it('reads a disabled item as one, and does nothing when it is pressed', async () => {
		const user = userEvent.setup();
		const { journal, openAt } = renderCanvas();
		openAt();
		const copy = screen.getByRole('menuitem', { name: 'Layer via copy' });
		expect(copy.getAttribute('aria-disabled')).toBe('true');

		await user.click(copy);
		expect(journal).toEqual([]);
		expect(screen.getByRole('menu')).toBeDefined();
	});

	it('closes on Tab, the key spent, and gives the focus back', async () => {
		const user = userEvent.setup();
		const { journal, canvas, openAt } = renderCanvas();
		openAt();
		expect(fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' })).toBe(
			false
		);
		expect(journal).toEqual(['close at Canvas']);

		openAt();
		await user.tab();
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(canvas);
	});

	it('closes on a press outside it, which takes the focus where it lands, and not on one inside', async () => {
		const user = userEvent.setup();
		const { journal, openAt } = renderCanvas();
		const menu = openAt();
		fireEvent.pointerDown(menu);
		fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Deselect' }));
		expect(screen.getByRole('menu')).toBeDefined();

		const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
		await user.click(elsewhere);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(journal).toHaveLength(1);
		expect(document.activeElement).toBe(elsewhere);
	});

	it('keeps a press in it from what it is drawn over', () => {
		const under = vi.fn();
		render(
			<div role="presentation" onPointerDown={under}>
				<ContextMenu
					label="Selection"
					items={makeItems([])}
					at={{ x: 0, y: 0 }}
					onClose={vi.fn()}
				/>
			</div>
		);
		fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Deselect' }));
		expect(under).not.toHaveBeenCalled();
	});

	it('closes on a scroll or a wheel outside it, and not on one inside', () => {
		const { journal, canvas, openAt } = renderCanvas();
		const menu = openAt();
		fireEvent.scroll(menu);
		fireEvent.wheel(screen.getByRole('menuitem', { name: 'Clear' }));
		expect(screen.getByRole('menu')).toBeDefined();

		fireEvent.scroll(document);
		expect(screen.queryByRole('menu')).toBeNull();

		openAt();
		fireEvent.wheel(canvas);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(journal).toHaveLength(2);
	});

	it('closes when the window changes size or loses the focus, and gives the focus back', () => {
		const { journal, canvas, openAt } = renderCanvas();
		openAt();
		fireEvent(window, new Event('resize'));
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(canvas);

		openAt();
		fireEvent.blur(window);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(canvas);
		expect(journal).toHaveLength(2);
	});

	it('gives the focus back when the caller closes it, or it goes', () => {
		const canvas = () => screen.getByRole('button', { name: 'Canvas' });
		const view = (at: MenuPoint | undefined, shown = true) => (
			<>
				<button type="button">Canvas</button>
				{shown && (
					<ContextMenu
						label="Selection"
						items={makeItems([])}
						at={at}
						onClose={vi.fn()}
					/>
				)}
			</>
		);
		const { rerender } = render(view(undefined));
		canvas().focus();
		rerender(view({ x: 10, y: 10 }));
		expect(focusedText()).toBe('DeselectCtrl+D');
		rerender(view(undefined));
		expect(document.activeElement).toBe(canvas());

		rerender(view({ x: 10, y: 10 }));
		expect(focusedText()).toBe('DeselectCtrl+D');
		rerender(view({ x: 10, y: 10 }, false));
		expect(document.activeElement).toBe(canvas());
	});

	it('keeps a right-click on it from the browser and from what holds it', () => {
		const outer = vi.fn();
		const { openAt } = renderCanvas({}, outer);
		const menu = openAt();
		outer.mockClear();

		expect(fireEvent.contextMenu(screen.getByRole('menuitem', { name: 'Deselect' }))).toBe(
			false
		);
		expect(fireEvent.contextMenu(menu)).toBe(false);
		expect(outer).not.toHaveBeenCalled();
		expect(screen.getByRole('menu')).toBeDefined();
	});

	it('is in place, fixed at the point, where there is no Popover API', () => {
		lay(1000, 800, 200, 300);
		const { openAt } = renderCanvas();
		const menu = openAt(120, 140);
		expect(menu.hasAttribute('popover')).toBe(false);
		expect(menu.className).toBe('menu-list menu-context');
		expect(menu.style.position).toBe('fixed');
		expect(placed(menu)).toEqual({ top: '140px', left: '120px', maxHeight: '652px' });
		expect(menu.style.transformOrigin).toBe('0px 0px');
	});

	it('goes left of the point where it would run past the right edge, and above it where it would run past the foot', () => {
		lay(1000, 800, 200, 300);
		const { openAt } = renderCanvas();
		const right = openAt(900, 100);
		expect(placed(right)).toMatchObject({ top: '100px', left: '700px' });
		expect(right.style.transformOrigin).toBe('200px 0px');
		fireEvent.keyDown(right, { key: 'Escape' });

		const foot = openAt(100, 600);
		expect(placed(foot)).toEqual({ top: '300px', left: '100px', maxHeight: '492px' });
		fireEvent.keyDown(foot, { key: 'Escape' });

		const corner = openAt(900, 600);
		expect(placed(corner)).toMatchObject({ top: '300px', left: '700px' });
		expect(corner.style.transformOrigin).toBe('200px 300px');
	});

	it('where there is room on neither side, goes no further back than it must, and never past an edge', () => {
		lay(300, 800, 200, 300);
		const { openAt } = renderCanvas();
		expect(placed(openAt(150, 100))).toMatchObject({ left: '92px' });
		fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

		expect(placed(openAt(-50, 2000))).toEqual({
			top: '492px',
			left: '8px',
			maxHeight: '300px',
		});
	});

	it('is as tall as the window has room for, the rest scrolling', () => {
		lay(1000, 800, 200, 900);
		const { openAt } = renderCanvas();
		expect(placed(openAt(100, 400))).toEqual({ top: '8px', left: '100px', maxHeight: '784px' });
	});

	it('goes the other way from the point in a right-to-left language', () => {
		lay(1000, 800, 200, 300);
		const journal: string[] = [];
		const view = (at: MenuPoint) => (
			<div dir="rtl">
				<ContextMenu
					label="Selection"
					items={makeItems(journal)}
					at={at}
					onClose={vi.fn()}
				/>
			</div>
		);
		const { rerender } = render(view({ x: 500, y: 100 }));
		expect(placed(screen.getByRole('menu'))).toMatchObject({ left: '300px' });

		// Opened again at another point while open, it is placed again.
		rerender(view({ x: 100, y: 100 }));
		expect(placed(screen.getByRole('menu'))).toMatchObject({ left: '100px' });
	});

	it('focuses the first item again when it is opened at another point while open', () => {
		const view = (at: MenuPoint) => (
			<ContextMenu label="Selection" items={makeItems([])} at={at} onClose={vi.fn()} />
		);
		const { rerender } = render(view({ x: 10, y: 10 }));
		act(() => screen.getByRole('menuitem', { name: 'Clear' }).focus());
		rerender(view({ x: 10, y: 10 }));
		expect(focusedText()).toBe('Clear');
		rerender(view({ x: 20, y: 20 }));
		expect(focusedText()).toBe('DeselectCtrl+D');
	});
});

describe('ui.css, for the context menu', () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const css = readFileSync(join(here, '../../src/styles/ui.css'), 'utf8').replace(
		/\/\*[\s\S]*?\*\//g,
		''
	);
	const rule = (selector: string) =>
		[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
			.filter(([, selectors]) =>
				(selectors ?? '')
					.split(',')
					.map((each) => each.trim())
					.includes(selector)
			)
			.map(([, , body]) => body)
			.join('\n');

	it('fixes the menu to the window and lets what does not fit scroll, without the page', () => {
		const context = rule('.menu-context');
		expect(context).toContain('position: fixed;');
		expect(context).toContain('overflow: auto;');
		expect(context).toContain('overscroll-behavior: contain;');
		expect(context).toContain('width: max-content;');
	});

	it('draws a rule between groups, and keeps an item a target', () => {
		expect(rule('.menu-separator')).toContain('border-block-start: 1px solid var(--border);');
		expect(rule('.menu-item')).toMatch(/min-height: var\(--target\)/);
	});
});
