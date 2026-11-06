import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu, type MenuPoint } from '../../src/components/ui/ContextMenu.js';
import { Menu, type MenuItem } from '../../src/components/ui/Menu.js';

/**
 * An item's submenu (`MenuItem.submenu`), in a button's menu and in a menu at
 * a point alike, after the WAI-ARIA menu pattern's submenus: the item says it
 * has a menu and whether it is open; the arrow toward the end of the line,
 * Enter, Space and a press open it with the focus on its first item, and a
 * mouse resting on the item opens it after a moment; the arrow back and
 * Escape close it alone, the focus back on its item; a choice in it closes
 * every list and then acts; Tab and a press outside close everything.
 */

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Who has the focus: a control by its name, an item by its text. */
const focused = () =>
	document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '';

/** Photoshop's Image menu, cut down: its rotation a submenu, its Mode one that cannot open now. */
const makeItems = (journal: string[], extra: Readonly<Record<string, Partial<MenuItem>>> = {}) => {
	const item = (id: string, own: Partial<MenuItem> = {}): MenuItem => ({
		id,
		label: id,
		onSelect: () => journal.push(`select ${id} at ${focused()}`),
		...own,
		...extra[id],
	});
	return [
		item('Mode', { disabled: true, submenu: [item('RGB'), item('Grayscale')] }),
		item('Image size…', { shortcut: 'Ctrl+Alt+I' }),
		item('Image rotation', {
			separatorBefore: true,
			submenu: [
				item('180°', { icon: <svg data-testid="rotate-icon" /> }),
				item('90° clockwise', { checked: true }),
				item('90° counterclockwise', { checked: false }),
				item('Arbitrary…', { separatorBefore: true, disabled: true }),
				item('Flip canvas horizontal', { separatorBefore: true }),
				item('Flip canvas vertical', { danger: true }),
			],
		}),
		item('Trim…'),
	];
};

const renderMenu = (extra: Readonly<Record<string, Partial<MenuItem>>> = {}, dir?: 'rtl') => {
	const journal: string[] = [];
	render(
		<div dir={dir}>
			<Menu label="Image" icon={<svg />} items={makeItems(journal, extra)} />
			<button type="button">Elsewhere</button>
		</div>
	);
	const trigger = screen.getByRole('button', { name: 'Image' });
	return { journal, trigger };
};

const parentItem = () => screen.getByRole('menuitem', { name: 'Image rotation' });
const submenu = () => screen.getByRole('menu', { name: 'Image rotation' });
const noSubmenu = () => screen.queryByRole('menu', { name: 'Image rotation' });

/** The editor's canvas, as far as a menu at a point sees it. */
const Canvas = ({ items, journal }: { items: readonly MenuItem[]; journal: string[] }) => {
	const [at, setAt] = useState<MenuPoint | undefined>(undefined);
	return (
		<>
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
				label="Image"
				items={items}
				at={at}
				onClose={() => {
					journal.push(`close at ${focused()}`);
					setAt(undefined);
				}}
			/>
		</>
	);
};

const renderCanvas = () => {
	const journal: string[] = [];
	render(<Canvas items={makeItems(journal)} journal={journal} />);
	const canvas = screen.getByRole('button', { name: 'Canvas' });
	const openAt = () => {
		canvas.focus();
		fireEvent.contextMenu(canvas, { clientX: 100, clientY: 100 });
		return screen.getByRole('menu', { name: 'Image' });
	};
	return { journal, canvas, openAt };
};

describe('A submenu in a button’s menu', () => {
	it('is opened from a menuitem that says it has a menu, whether it is open, and which it is', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		const item = parentItem();
		expect(item.getAttribute('role')).toBe('menuitem');
		expect(item.getAttribute('aria-haspopup')).toBe('menu');
		expect(item.getAttribute('aria-expanded')).toBe('false');
		expect(item.hasAttribute('aria-controls')).toBe(false);
		expect(item.querySelector('.menu-item-more')?.getAttribute('aria-hidden')).toBe('true');
		expect(item.querySelector('.menu-item-more svg')).not.toBeNull();
		// An item without one says nothing of a menu.
		const trim = screen.getByRole('menuitem', { name: 'Trim…' });
		expect(trim.hasAttribute('aria-haspopup')).toBe(false);
		expect(trim.hasAttribute('aria-expanded')).toBe(false);
		expect(trim.querySelector('.menu-item-more')).toBeNull();
		expect(noSubmenu()).toBeNull();

		await user.keyboard('{ArrowDown}{ArrowRight}');
		expect(item.getAttribute('aria-expanded')).toBe('true');
		expect(item.getAttribute('aria-controls')).toBe(submenu().id);
		expect(submenu().getAttribute('aria-label')).toBe('Image rotation');
	});

	it('opens with ArrowRight on its first item that can be chosen, and closes with ArrowLeft, the focus back on its item and the menu open', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		expect(focused()).toBe('Image size…Ctrl+Alt+I');
		// ArrowRight on an item with no submenu does nothing.
		await user.keyboard('{ArrowRight}');
		expect(focused()).toBe('Image size…Ctrl+Alt+I');
		expect(screen.getAllByRole('menu')).toHaveLength(1);

		await user.keyboard('{ArrowDown}{ArrowRight}');
		expect(submenu()).toBeDefined();
		expect(focused()).toBe('180°');

		await user.keyboard('{ArrowLeft}');
		expect(noSubmenu()).toBeNull();
		expect(document.activeElement).toBe(parentItem());
		expect(screen.getByRole('menu', { name: 'Image' })).toBeDefined();
		expect(parentItem().getAttribute('aria-expanded')).toBe('false');
	});

	it('closes with Escape alone, the focus back on its item; a second Escape closes the menu', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		const outer = vi.fn();
		await user.click(trigger);
		await user.keyboard('{ArrowDown}{ArrowRight}');
		window.addEventListener('keydown', outer);

		await user.keyboard('{Escape}');
		expect(noSubmenu()).toBeNull();
		expect(document.activeElement).toBe(parentItem());
		expect(screen.getByRole('menu', { name: 'Image' })).toBeDefined();

		await user.keyboard('{Escape}');
		window.removeEventListener('keydown', outer);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		expect(outer).not.toHaveBeenCalled();
	});

	it('opens with Enter and with Space, on its first item that can be chosen', async () => {
		const user = userEvent.setup();
		const { journal, trigger } = renderMenu();
		await user.click(trigger);
		await user.keyboard('{ArrowDown}{Enter}');
		expect(focused()).toBe('180°');
		await user.keyboard('{Escape}');

		await user.keyboard(' ');
		expect(focused()).toBe('180°');
		expect(journal).toEqual([]);
	});

	it('moves among its own items with the arrows, past rules and disabled ones, wrapping, and the menu’s arrows pass over them', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		await user.keyboard('{ArrowDown}{ArrowRight}');
		await user.keyboard('{ArrowDown}{ArrowDown}');
		expect(focused()).toBe('90° counterclockwise');
		await user.keyboard('{ArrowDown}');
		expect(focused()).toBe('Flip canvas horizontal');
		await user.keyboard('{ArrowDown}{ArrowDown}');
		expect(focused()).toBe('180°');
		await user.keyboard('{ArrowUp}');
		expect(focused()).toBe('Flip canvas vertical');
		await user.keyboard('{Home}');
		expect(focused()).toBe('180°');
		await user.keyboard('{End}');
		expect(focused()).toBe('Flip canvas vertical');
		// Neither the arrow into a submenu nor the menu's own keys leave it.
		await user.keyboard('{ArrowRight}');
		expect(focused()).toBe('Flip canvas vertical');

		await user.keyboard('{ArrowLeft}{ArrowDown}');
		expect(focused()).toBe('Trim…');
		await user.keyboard('{ArrowDown}');
		expect(focused()).toBe('Image size…Ctrl+Alt+I');
	});

	it('closes when the arrows move the focus off its item in the menu', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		await user.keyboard('{ArrowDown}');
		act(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		});
		fireEvent.pointerEnter(parentItem(), { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(submenu()).toBeDefined();
		expect(document.activeElement).toBe(parentItem());

		fireEvent.keyDown(parentItem(), { key: 'ArrowDown' });
		expect(noSubmenu()).toBeNull();
		expect(focused()).toBe('Trim…');
	});

	it('chooses an item in it once, closing everything and giving the focus back before the item acts', async () => {
		const user = userEvent.setup();
		const { journal, trigger } = renderMenu();
		await user.click(trigger);
		await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}{Enter}');
		expect(journal).toEqual(['select 90° clockwise at Image']);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it('opens on a press of its item, and chooses with a click, once', async () => {
		const user = userEvent.setup();
		const { journal, trigger } = renderMenu();
		await user.click(trigger);
		await user.click(parentItem());
		expect(submenu()).toBeDefined();
		expect(focused()).toBe('180°');
		// A second press keeps it open.
		await user.click(parentItem());
		expect(submenu()).toBeDefined();
		expect(journal).toEqual([]);

		await user.click(screen.getByRole('menuitem', { name: 'Flip canvas horizontal' }));
		expect(journal).toEqual(['select Flip canvas horizontal at Image']);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it('does nothing for a disabled item in it, and stays open', async () => {
		const user = userEvent.setup();
		const { journal, trigger } = renderMenu();
		await user.click(trigger);
		await user.click(parentItem());
		const arbitrary = screen.getByRole('menuitem', { name: 'Arbitrary…' });
		expect(arbitrary.getAttribute('aria-disabled')).toBe('true');
		await user.click(arbitrary);
		expect(journal).toEqual([]);
		expect(submenu()).toBeDefined();
	});

	it('draws rules, icons, choices and destroying items as a menu does', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		await user.click(parentItem());
		const menu = submenu();
		const rules = [...menu.querySelectorAll('[role="separator"]')];
		expect(rules.map((rule) => rule.nextElementSibling?.textContent)).toEqual([
			'Arbitrary…',
			'Flip canvas horizontal',
		]);
		expect(menu.querySelector('.menu-item-icon [data-testid="rotate-icon"]')).not.toBeNull();
		const clockwise = screen.getByRole('menuitemradio', { name: '90° clockwise' });
		expect(clockwise.getAttribute('aria-checked')).toBe('true');
		expect(
			screen
				.getByRole('menuitemradio', { name: '90° counterclockwise' })
				.getAttribute('aria-checked')
		).toBe('false');
		expect(screen.getByRole('menuitem', { name: 'Flip canvas vertical' }).className).toContain(
			'menu-item-danger'
		);
	});

	it('closes everything on Tab from it', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		await user.keyboard('{ArrowDown}{ArrowRight}');
		await user.tab();
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('closes everything on a press outside, and not on one in it', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		await user.click(parentItem());
		fireEvent.pointerDown(submenu());
		fireEvent.pointerDown(screen.getByRole('menuitem', { name: '180°' }));
		fireEvent.scroll(submenu());
		expect(submenu()).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('does not open from a disabled item, by a key, a press or the pointer resting, and the arrows pass over it', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu();
		await user.click(trigger);
		const mode = screen.getByRole('menuitem', { name: 'Mode' });
		expect(mode.getAttribute('aria-disabled')).toBe('true');
		expect(mode.getAttribute('aria-haspopup')).toBe('menu');
		expect(mode.getAttribute('aria-expanded')).toBe('false');
		await user.keyboard('{End}{ArrowDown}');
		expect(focused()).toBe('Image size…Ctrl+Alt+I');

		await user.click(mode);
		act(() => mode.focus());
		await user.keyboard('{ArrowRight}{Enter}');
		expect(screen.queryByRole('menu', { name: 'Mode' })).toBeNull();

		act(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		});
		fireEvent.pointerEnter(mode, { pointerType: 'mouse' });
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.queryByRole('menu', { name: 'Mode' })).toBeNull();
		expect(mode.getAttribute('aria-expanded')).toBe('false');
	});

	it('goes the other way in a right-to-left language: ArrowLeft opens it and ArrowRight closes it', async () => {
		const user = userEvent.setup();
		const { trigger } = renderMenu({}, 'rtl');
		await user.click(trigger);
		await user.keyboard('{ArrowDown}{ArrowRight}');
		expect(noSubmenu()).toBeNull();
		await user.keyboard('{ArrowLeft}');
		expect(focused()).toBe('180°');
		await user.keyboard('{ArrowLeft}');
		expect(focused()).toBe('180°');
		await user.keyboard('{ArrowRight}');
		expect(noSubmenu()).toBeNull();
		expect(document.activeElement).toBe(parentItem());
	});
});

describe('A submenu, for a mouse or a pen resting on its item', () => {
	const openMenu = () => {
		const result = renderMenu();
		fireEvent.click(result.trigger);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		return result;
	};
	const rest = (element: HTMLElement, pointerType = 'mouse') => {
		fireEvent.pointerEnter(element, { pointerType });
	};
	const wait = (ms: number) => {
		act(() => {
			vi.advanceTimersByTime(ms);
		});
	};

	it('opens after a moment, the focus on its item, not in it', () => {
		openMenu();
		rest(parentItem());
		wait(150);
		expect(noSubmenu()).toBeNull();
		wait(50);
		expect(submenu()).toBeDefined();
		expect(parentItem().getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement).toBe(parentItem());
	});

	it('opens for a pen too, and not for a finger, whose press is a tap', () => {
		openMenu();
		rest(parentItem(), 'touch');
		wait(1000);
		expect(noSubmenu()).toBeNull();

		rest(parentItem(), 'pen');
		wait(200);
		expect(submenu()).toBeDefined();
	});

	it('does not open when the pointer goes on to another item before the moment is out', () => {
		openMenu();
		rest(parentItem());
		wait(100);
		rest(screen.getByRole('menuitem', { name: 'Trim…' }));
		wait(1000);
		expect(noSubmenu()).toBeNull();
	});

	it('closes when the pointer rests on another item of the menu, a while longer', () => {
		openMenu();
		rest(parentItem());
		wait(200);
		rest(screen.getByRole('menuitem', { name: 'Trim…' }));
		wait(250);
		expect(submenu()).toBeDefined();
		wait(50);
		expect(noSubmenu()).toBeNull();
		expect(screen.getByRole('menu', { name: 'Image' })).toBeDefined();
	});

	it('stays open when the pointer crosses another item on its way into it, or comes back to its item', () => {
		openMenu();
		rest(parentItem());
		wait(200);
		rest(screen.getByRole('menuitem', { name: 'Trim…' }));
		wait(150);
		fireEvent.pointerOver(screen.getByRole('menuitem', { name: '180°' }), {
			pointerType: 'mouse',
		});
		wait(1000);
		expect(submenu()).toBeDefined();

		rest(screen.getByRole('menuitem', { name: 'Trim…' }));
		wait(150);
		rest(parentItem());
		wait(1000);
		expect(submenu()).toBeDefined();
	});

	it('gives the focus in it back to its item when the pointer closes it', () => {
		openMenu();
		fireEvent.click(parentItem());
		expect(focused()).toBe('180°');
		rest(screen.getByRole('menuitem', { name: 'Trim…' }));
		wait(300);
		expect(noSubmenu()).toBeNull();
		expect(document.activeElement).toBe(parentItem());
	});

	it('gives way to another item’s, and a press before the moment is out opens it at once', () => {
		const journal: string[] = [];
		const item = (id: string, own: Partial<MenuItem> = {}): MenuItem => ({
			id,
			label: id,
			onSelect: () => journal.push(id),
			...own,
		});
		render(
			<Menu
				label="Image"
				icon={<svg />}
				items={[
					item('Mode', { submenu: [item('RGB'), item('Grayscale')] }),
					item('Adjustments', { submenu: [item('Levels…'), item('Curves…')] }),
				]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Image' }));
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const mode = screen.getByRole('menuitem', { name: 'Mode' });
		const adjustments = screen.getByRole('menuitem', { name: 'Adjustments' });
		rest(mode);
		wait(200);
		expect(screen.getByRole('menu', { name: 'Mode' })).toBeDefined();
		rest(adjustments);
		wait(300);
		expect(screen.queryByRole('menu', { name: 'Mode' })).toBeNull();
		expect(screen.getByRole('menu', { name: 'Adjustments' })).toBeDefined();
		expect(document.activeElement).toBe(adjustments);

		rest(mode);
		fireEvent.click(mode);
		expect(screen.getByRole('menu', { name: 'Mode' })).toBeDefined();
		expect(focused()).toBe('RGB');
		wait(1000);
		expect(screen.getByRole('menu', { name: 'Mode' })).toBeDefined();
		expect(journal).toEqual([]);
	});
});

describe('A submenu in a menu at a point', () => {
	it('opens with ArrowRight and closes with Escape alone, the menu still open; then Escape closes the menu, the focus back on the canvas', async () => {
		const user = userEvent.setup();
		const { journal, canvas, openAt } = renderCanvas();
		openAt();
		await user.keyboard('{ArrowDown}{ArrowRight}');
		expect(focused()).toBe('180°');

		await user.keyboard('{Escape}');
		expect(noSubmenu()).toBeNull();
		expect(document.activeElement).toBe(parentItem());
		expect(journal).toEqual([]);

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('menu')).toBeNull();
		expect(journal).toEqual(['close at Canvas']);
		expect(document.activeElement).toBe(canvas);
	});

	it('chooses an item in it once: the focus back, then closing, then the item acting', async () => {
		const user = userEvent.setup();
		const { journal, canvas, openAt } = renderCanvas();
		openAt();
		await user.click(parentItem());
		await user.click(screen.getByRole('menuitemradio', { name: '90° counterclockwise' }));
		expect(journal).toEqual(['close at Canvas', 'select 90° counterclockwise at Canvas']);
		expect(screen.queryByRole('menu')).toBeNull();
		expect(document.activeElement).toBe(canvas);
	});

	it('closes everything on Tab from it, the key spent, the focus back on the canvas', async () => {
		const user = userEvent.setup();
		const { journal, canvas, openAt } = renderCanvas();
		openAt();
		await user.keyboard('{ArrowDown}{ArrowRight}');
		expect(fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' })).toBe(
			false
		);
		expect(journal).toEqual(['close at Canvas']);
		expect(document.activeElement).toBe(canvas);
	});

	it('closes everything on a press outside, and not on a press, a scroll or a wheel in it', async () => {
		const user = userEvent.setup();
		const { journal, openAt } = renderCanvas();
		openAt();
		await user.click(parentItem());
		fireEvent.pointerDown(screen.getByRole('menuitem', { name: '180°' }));
		fireEvent.scroll(submenu());
		fireEvent.wheel(screen.getByRole('menuitem', { name: '180°' }));
		expect(submenu()).toBeDefined();
		expect(journal).toEqual([]);

		await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
		expect(screen.queryByRole('menu')).toBeNull();
		expect(journal).toHaveLength(1);
	});

	it('keeps a press and a right-click in it from what the menu is drawn over', async () => {
		const user = userEvent.setup();
		const { openAt } = renderCanvas();
		openAt();
		await user.click(parentItem());
		const under = vi.fn();
		document.addEventListener('pointerdown', under);
		const inside = screen.getByRole('menuitem', { name: '180°' });
		fireEvent.pointerDown(inside);
		document.removeEventListener('pointerdown', under);
		expect(under).not.toHaveBeenCalled();
		expect(fireEvent.contextMenu(inside)).toBe(false);
	});
});

/** A box on the page, as `getBoundingClientRect` gives it. */
const box = (left: number, top: number, width: number, height: number) => ({
	x: left,
	y: top,
	left,
	top,
	right: left + width,
	bottom: top + height,
	width,
	height,
	toJSON: () => ({}),
});

describe('Where a submenu goes', () => {
	/**
	 * A window `width` by `height`, a submenu 200 by `menuHeight` in it, and
	 * the menu it opens from at `left`, `menuWidth` wide, with its rotation
	 * item at `itemTop`.
	 */
	const lay = (
		width: number,
		height: number,
		place: Readonly<{ left: number; menuWidth: number; itemTop: number; menuHeight?: number }>,
		dir?: 'rtl'
	) => {
		vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width);
		vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(height);
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
		vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(place.menuHeight ?? 300);
		renderMenu({}, dir);
		fireEvent.click(screen.getByRole('button', { name: 'Image' }));
		const item = parentItem();
		const menu = screen.getByRole('menu', { name: 'Image' });
		vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(
			box(place.left, 40, place.menuWidth, 240)
		);
		vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(
			box(place.left + 5, place.itemTop, place.menuWidth - 10, 44)
		);
		fireEvent.click(item);
		const shown = submenu();
		return {
			position: shown.style.position,
			top: shown.style.top,
			left: shown.style.left,
			maxHeight: shown.style.maxHeight,
			transformOrigin: shown.style.transformOrigin,
		};
	};

	it('is beside its item, after the menu, its top level with the item, as tall as fits', () => {
		expect(lay(1000, 800, { left: 100, menuWidth: 200, itemTop: 140 })).toEqual({
			position: 'fixed',
			top: '140px',
			left: '300px',
			maxHeight: '652px',
			transformOrigin: '0px 0px',
		});
	});

	it('goes before the menu where there is no room after it', () => {
		expect(lay(1000, 800, { left: 700, menuWidth: 200, itemTop: 140 })).toMatchObject({
			left: '500px',
			transformOrigin: '200px 0px',
		});
	});

	it('where there is room on neither side, overlaps the menu from the side with more, rather than run past an edge', () => {
		expect(lay(360, 800, { left: 8, menuWidth: 344, itemTop: 140 })).toMatchObject({
			left: '152px',
		});
	});

	it('overlaps from the start where that side has more room', () => {
		expect(lay(400, 800, { left: 150, menuWidth: 230, itemTop: 140 })).toMatchObject({
			left: '8px',
		});
	});

	it('rises as far as keeps it in the window, and scrolls what does not fit', () => {
		expect(lay(1000, 800, { left: 100, menuWidth: 200, itemTop: 700 })).toMatchObject({
			top: '492px',
			maxHeight: '300px',
			transformOrigin: '0px 208px',
		});
	});

	it('is as tall as the window has room for, the rest scrolling', () => {
		expect(
			lay(1000, 800, { left: 100, menuWidth: 200, itemTop: 140, menuHeight: 900 })
		).toMatchObject({ top: '8px', maxHeight: '784px' });
	});

	it('goes the other way in a right-to-left language', () => {
		expect(lay(1000, 800, { left: 500, menuWidth: 200, itemTop: 140 }, 'rtl')).toMatchObject({
			left: '300px',
			transformOrigin: '200px 0px',
		});
	});
});

describe('ui.css, for a submenu', () => {
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

	it('fixes it to the window and lets what does not fit scroll, without the page', () => {
		const sub = rule('.menu-submenu');
		expect(sub).toContain('position: fixed;');
		expect(sub).toContain('overflow: auto;');
		expect(sub).toContain('overscroll-behavior: contain;');
		expect(sub).toContain('width: max-content;');
	});

	it('turns the chevron round in a right-to-left language, and marks the item whose submenu is open', () => {
		expect(rule('.menu-item-more:dir(rtl)')).toContain('scale: -1 1;');
		expect(rule(".menu-item[aria-expanded='true']")).toContain('background: var(--hover-bg);');
	});
});
