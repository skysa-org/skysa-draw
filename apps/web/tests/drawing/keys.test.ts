import { describe, expect, it } from 'vitest';

import {
	EDIT_ACTIONS,
	editActionFor,
	isHandKey,
	isTyping,
	type KeyLike,
	nudgeFor,
	primaryKeyLabel,
	shortcutFor,
	shortcutLabel,
	TOOL_KEYS,
	toolFor,
} from '../../src/drawing/keys.js';
import { TOOL_IDS } from '../../src/drawing/tools/types.js';

/**
 * The keys (docs/decisions/0004-the-interface.md): one map, read here the
 * way the frame reads a keyboard event.
 */

const key = (name: string, init: Partial<KeyLike> = {}): KeyLike => ({
	key: name,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	altKey: false,
	...init,
});

const field = (): HTMLInputElement => {
	const input = document.createElement('input');
	document.body.appendChild(input);
	return input;
};

describe('TOOL_KEYS', () => {
	it('gives every tool one capital letter, shared only by Photoshop’s healing group', () => {
		expect(Object.keys(TOOL_KEYS).sort()).toEqual([...TOOL_IDS].sort());
		const letters = Object.values(TOOL_KEYS);
		letters.forEach((letter) => {
			expect(letter).toMatch(/^[A-Z]$/);
		});
		const shared = TOOL_IDS.filter(
			(id) => letters.filter((letter) => letter === TOOL_KEYS[id]).length > 1
		);
		expect(shared).toEqual(['remove', 'redEye']);
	});

	it('is the table in the decision', () => {
		expect(TOOL_KEYS).toEqual({
			select: 'V',
			node: 'A',
			hand: 'H',
			zoom: 'Z',
			pencil: 'N',
			brush: 'B',
			eraser: 'E',
			smudge: 'S',
			remove: 'J',
			redEye: 'J',
			fill: 'G',
			eyedropper: 'I',
			rectangle: 'R',
			ellipse: 'O',
			line: 'L',
			pen: 'P',
			text: 'T',
			marquee: 'M',
			lasso: 'Q',
			wand: 'W',
			crop: 'C',
		});
	});
});

describe('toolFor', () => {
	it('picks a tool by its letter, in either case, on every platform, keeping the one in hand of its group', () => {
		TOOL_IDS.forEach((id) => {
			const letter = TOOL_KEYS[id];
			expect(toolFor(key(letter), false, id)).toBe(id);
			expect(toolFor(key(letter.toLowerCase()), true, id)).toBe(id);
		});
		TOOL_IDS.filter((id) => id !== 'redEye').forEach((id) => {
			expect(toolFor(key(TOOL_KEYS[id]), false)).toBe(id);
		});
	});

	it('picks a group’s first from another tool, and goes round the group with Shift, as Photoshop’s J', () => {
		expect(toolFor(key('j'), false, 'brush')).toBe('remove');
		expect(toolFor(key('J'), false)).toBe('remove');
		expect(toolFor(key('j'), false, 'redEye')).toBe('redEye');
		expect(toolFor(key('J', { shiftKey: true }), false, 'remove')).toBe('redEye');
		expect(toolFor(key('J', { shiftKey: true }), true, 'redEye')).toBe('remove');
		expect(toolFor(key('J', { shiftKey: true }), false, 'brush')).toBe('remove');
		// A letter of one tool takes no Shift.
		expect(toolFor(key('B', { shiftKey: true }), false, 'brush')).toBeUndefined();
	});

	it('is nothing with a modifier, for a key that is not a letter, or for a letter nobody uses', () => {
		expect(toolFor(key('v', { ctrlKey: true }), false)).toBeUndefined();
		expect(toolFor(key('v', { metaKey: true }), true)).toBeUndefined();
		expect(toolFor(key('v', { altKey: true }), false)).toBeUndefined();
		expect(toolFor(key('V', { shiftKey: true }), false)).toBeUndefined();
		expect(toolFor(key('Escape'), false)).toBeUndefined();
		expect(toolFor(key('F1'), false)).toBeUndefined();
		expect(toolFor(key('k'), false)).toBeUndefined();
		expect(toolFor(key('j', { altKey: true }), false)).toBeUndefined();
	});

	it('is nothing while typing in a field', () => {
		expect(toolFor(key('v', { target: field() }), false)).toBeUndefined();
	});
});

describe('isTyping', () => {
	it('is a field with the focus: an input, a textarea, a select, or anything editable', () => {
		expect(isTyping(field())).toBe(true);
		expect(isTyping(document.createElement('textarea'))).toBe(true);
		expect(isTyping(document.createElement('select'))).toBe(true);
		const editable = document.createElement('div');
		editable.setAttribute('contenteditable', '');
		const inside = document.createElement('span');
		editable.appendChild(inside);
		expect(isTyping(editable)).toBe(true);
		expect(isTyping(inside)).toBe(true);
	});

	it('is not the body, a button, a thing marked not editable, or nothing', () => {
		expect(isTyping(document.body)).toBe(false);
		expect(isTyping(document.createElement('button'))).toBe(false);
		const frozen = document.createElement('div');
		frozen.setAttribute('contenteditable', 'false');
		expect(isTyping(frozen)).toBe(false);
		expect(isTyping(null)).toBe(false);
		expect(isTyping(undefined)).toBe(false);
		expect(isTyping(window)).toBe(false);
	});
});

describe('nudgeFor', () => {
	it("nudges by a pixel per arrow, and ten with Shift, as Photoshop's move tool", () => {
		expect(nudgeFor(key('ArrowLeft'))).toEqual([-1, 0]);
		expect(nudgeFor(key('ArrowRight'))).toEqual([1, 0]);
		expect(nudgeFor(key('ArrowUp'))).toEqual([0, -1]);
		expect(nudgeFor(key('ArrowDown', { shiftKey: true }))).toEqual([0, 10]);
	});

	it('leaves an arrow with Ctrl, ⌘ or Alt, one in a field, and any other key alone', () => {
		expect(nudgeFor(key('ArrowLeft', { ctrlKey: true }))).toBeUndefined();
		expect(nudgeFor(key('ArrowLeft', { metaKey: true }))).toBeUndefined();
		expect(nudgeFor(key('ArrowLeft', { altKey: true }))).toBeUndefined();
		expect(nudgeFor(key('ArrowLeft', { target: field() }))).toBeUndefined();
		expect(nudgeFor(key('h'))).toBeUndefined();
	});
});

describe('isHandKey', () => {
	it('is Space, bare or with Shift, outside a field', () => {
		expect(isHandKey(key(' '))).toBe(true);
		expect(isHandKey(key(' ', { shiftKey: true }))).toBe(true);
		expect(isHandKey(key(' ', { target: document.body }))).toBe(true);
	});

	it('is not Space with Ctrl, ⌘ or Alt, nor in a field, nor any other key', () => {
		expect(isHandKey(key(' ', { ctrlKey: true }))).toBe(false);
		expect(isHandKey(key(' ', { metaKey: true }))).toBe(false);
		expect(isHandKey(key(' ', { altKey: true }))).toBe(false);
		expect(isHandKey(key(' ', { target: field() }))).toBe(false);
		expect(isHandKey(key('h'))).toBe(false);
		expect(isHandKey(key('Spacebar'))).toBe(false);
	});

	it('leaves Space to a control the keyboard is on, which Space presses', () => {
		const button = document.createElement('button');
		const toggle = document.createElement('div');
		toggle.setAttribute('role', 'switch');
		expect(isHandKey(key(' ', { target: button }))).toBe(false);
		expect(isHandKey(key(' ', { target: toggle }))).toBe(false);
	});

	it('keeps Space the hand on the control a pointer last pressed, which keeps the focus in Chrome', () => {
		const button = document.createElement('button');
		const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		button.append(icon);
		expect(isHandKey(key(' ', { target: button }), icon)).toBe(true);
		expect(isHandKey(key(' ', { target: button }), button)).toBe(true);
		expect(isHandKey(key(' ', { target: button }), document.body)).toBe(false);
		expect(isHandKey(key(' ', { target: button }), null)).toBe(false);
	});

	it('picks no tool and no action, so the frame leaves Space to the viewport', () => {
		expect(toolFor(key(' '), false)).toBeUndefined();
		expect(editActionFor(key(' '), false)).toBeUndefined();
		expect(editActionFor(key(' '), true)).toBeUndefined();
	});
});

describe('editActionFor', () => {
	const primary = (isMac: boolean) => (isMac ? { metaKey: true } : { ctrlKey: true });

	it.each([true, false])('reads the editing keys with the primary key (mac: %s)', (isMac) => {
		const held = primary(isMac);
		expect(editActionFor(key('z', held), isMac)).toBe('undo');
		expect(editActionFor(key('Z', { ...held, shiftKey: true }), isMac)).toBe('redo');
		expect(editActionFor(key('y', held), isMac)).toBe('redo');
		expect(editActionFor(key('0', held), isMac)).toBe('fit');
		expect(editActionFor(key('1', held), isMac)).toBe('actualSize');
		expect(editActionFor(key('=', held), isMac)).toBe('zoomIn');
		expect(editActionFor(key('+', held), isMac)).toBe('zoomIn');
		expect(editActionFor(key('+', { ...held, shiftKey: true }), isMac)).toBe('zoomIn');
		expect(editActionFor(key('-', held), isMac)).toBe('zoomOut');
		expect(editActionFor(key('N', { ...held, shiftKey: true }), isMac)).toBe('newLayer');
		expect(editActionFor(key('j', held), isMac)).toBe('duplicate');
		expect(editActionFor(key('a', held), isMac)).toBe('selectAll');
		expect(editActionFor(key('d', held), isMac)).toBe('deselect');
		expect(editActionFor(key('n', held), isMac)).toBeUndefined();
		expect(editActionFor(key('D', { ...held, shiftKey: true }), isMac)).toBeUndefined();
		expect(editActionFor(key('z', { ...held, altKey: true }), isMac)).toBeUndefined();
	});

	it('takes ⌘ on a Mac and Ctrl elsewhere, and not the other one', () => {
		expect(editActionFor(key('z', { metaKey: true }), true)).toBe('undo');
		expect(editActionFor(key('z', { ctrlKey: true }), true)).toBeUndefined();
		expect(editActionFor(key('z', { ctrlKey: true }), false)).toBe('undo');
		expect(editActionFor(key('z', { metaKey: true }), false)).toBeUndefined();
	});

	it('reads the bare keys', () => {
		expect(editActionFor(key('Delete'), false)).toBe('delete');
		expect(editActionFor(key('Backspace'), true)).toBe('delete');
		expect(editActionFor(key('Escape'), false)).toBe('escape');
		expect(editActionFor(key(']'), false)).toBe('sizeUp');
		expect(editActionFor(key('['), false)).toBe('sizeDown');
		expect(editActionFor(key('x'), false)).toBe('swapColors');
		expect(editActionFor(key('X'), false)).toBe('swapColors');
		expect(editActionFor(key('d'), false)).toBe('resetColors');
		expect(editActionFor(key('D'), true)).toBe('resetColors');
		expect(editActionFor(key('v'), false)).toBeUndefined();
		expect(editActionFor(key('x', { ctrlKey: true }), true)).toBeUndefined();
	});

	it.each([true, false])(
		'makes a new layer with Insert, which a browser tab hears, bare only (mac: %s)',
		(isMac) => {
			expect(editActionFor(key('Insert'), isMac)).toBe('newLayer');
			// Shift and Insert pastes, and Ctrl and Insert copies, on Windows and Linux.
			expect(editActionFor(key('Insert', { shiftKey: true }), isMac)).toBeUndefined();
			expect(editActionFor(key('Insert', primary(isMac)), isMac)).toBeUndefined();
			expect(editActionFor(key('Insert', { altKey: true }), isMac)).toBeUndefined();
			expect(editActionFor(key('Insert', { target: field() }), isMac)).toBeUndefined();
			expect(toolFor(key('Insert'), isMac)).toBeUndefined();
		}
	);

	it.each([true, false])(
		'leaves select-all and deselect to a field, which selects its own text (mac: %s)',
		(isMac) => {
			const target = field();
			const held = { ...primary(isMac), target };
			expect(editActionFor(key('a', held), isMac)).toBeUndefined();
			expect(editActionFor(key('d', held), isMac)).toBeUndefined();
			expect(editActionFor(key('a', primary(isMac)), isMac)).toBe('selectAll');
		}
	);

	it('does nothing while typing, except Escape, which always means stop', () => {
		const target = field();
		expect(editActionFor(key('z', { ctrlKey: true, target }), false)).toBeUndefined();
		expect(editActionFor(key('Backspace', { target }), false)).toBeUndefined();
		expect(editActionFor(key('x', { target }), false)).toBeUndefined();
		expect(editActionFor(key('d', { target }), false)).toBeUndefined();
		expect(editActionFor(key('Escape', { target }), false)).toBe('escape');
	});

	it.each([true, false])(
		'reads the selection’s keys: Photoshop’s and Krita’s (mac: %s)',
		(isMac) => {
			const held = primary(isMac);
			expect(editActionFor(key('I', { ...held, shiftKey: true }), isMac)).toBe(
				'selectInverse'
			);
			expect(editActionFor(key('J', { ...held, shiftKey: true }), isMac)).toBe('layerViaCut');
			expect(editActionFor(key('F6', { shiftKey: true }), isMac)).toBe('feather');
			expect(editActionFor(key('Backspace', { altKey: true }), isMac)).toBe('fillArea');
			expect(editActionFor(key('Backspace', held), isMac)).toBe('fillAreaStroke');
			expect(editActionFor(key('F5', { shiftKey: true }), isMac)).toBe('fillDialog');
			expect(editActionFor(key('Backspace', { shiftKey: true }), isMac)).toBe('fillDialog');
			// I alone is the eyedropper's, F6 and F5 alone the browser's, Shift and Delete a delete.
			expect(editActionFor(key('i', held), isMac)).toBeUndefined();
			expect(editActionFor(key('F6'), isMac)).toBeUndefined();
			expect(editActionFor(key('F6', held), isMac)).toBeUndefined();
			expect(editActionFor(key('F5'), isMac)).toBeUndefined();
			expect(
				editActionFor(key('Backspace', { ...held, shiftKey: true }), isMac)
			).toBeUndefined();
			expect(editActionFor(key('Delete', { shiftKey: true }), isMac)).toBe('delete');
		}
	);

	it.each([true, false])(
		'reads Alt with Backspace alone, and no other Alt key (mac: %s)',
		(isMac) => {
			expect(editActionFor(key('Delete', { altKey: true }), isMac)).toBeUndefined();
			expect(editActionFor(key('x', { altKey: true }), isMac)).toBeUndefined();
			expect(editActionFor(key(']', { altKey: true }), isMac)).toBeUndefined();
			expect(
				editActionFor(key('Backspace', { altKey: true, shiftKey: true }), isMac)
			).toBeUndefined();
			// AltGr is Ctrl and Alt on Windows.
			expect(
				editActionFor(key('Backspace', { altKey: true, ctrlKey: true }), isMac)
			).toBeUndefined();
			expect(
				editActionFor(key('Backspace', { altKey: true, metaKey: true }), isMac)
			).toBeUndefined();
		}
	);

	it('leaves Alt with Backspace to a field, where it deletes a word', () => {
		expect(
			editActionFor(key('Backspace', { altKey: true, target: field() }), false)
		).toBeUndefined();
	});

	it.each([true, false])(
		'leaves the primary key or Shift with Backspace to a field (mac: %s)',
		(isMac) => {
			expect(
				editActionFor(key('Backspace', { ...primary(isMac), target: field() }), isMac)
			).toBeUndefined();
			expect(
				editActionFor(key('Backspace', { shiftKey: true, target: field() }), isMac)
			).toBeUndefined();
		}
	);

	it('only ever answers with one of the actions', () => {
		const keys = [
			'z',
			'y',
			'0',
			'1',
			'=',
			'+',
			'-',
			'n',
			'd',
			'Delete',
			'Backspace',
			'Insert',
			'Escape',
			']',
			'[',
			'x',
			'i',
			'j',
			'F6',
			'F5',
		];
		const seen = keys.flatMap((name) =>
			[true, false].flatMap((isMac) =>
				[{}, primary(isMac), { ...primary(isMac), shiftKey: true }].map((held) =>
					editActionFor(key(name, held), isMac)
				)
			)
		);
		seen.filter((action) => action !== undefined).forEach((action) => {
			expect(EDIT_ACTIONS).toContain(action);
		});
	});
});

describe('shortcutFor', () => {
	/** A shown key read back as the event it names: `⇧⌘I` or `Ctrl+Shift+I` as Shift, the primary key and I. */
	const GLYPHS: Readonly<Record<string, string>> = {
		'⌫': 'Backspace',
		'↩': 'Enter',
		'⎋': 'Escape',
		Esc: 'Escape',
	};
	const pressed = (label: string, isMac: boolean): KeyLike => {
		if (isMac) {
			const name = label.replace(/^[⌥⇧⌘]+/, '');
			return key(GLYPHS[name] ?? name, {
				altKey: label.includes('⌥'),
				shiftKey: label.includes('⇧'),
				metaKey: label.includes('⌘'),
			});
		}
		const parts = label.split('+');
		const last = label.endsWith('++') ? '+' : (parts.at(-1) ?? '');
		return key(GLYPHS[last] ?? last, {
			ctrlKey: parts.includes('Ctrl'),
			shiftKey: parts.includes('Shift'),
			altKey: parts.includes('Alt'),
		});
	};

	it.each([true, false])(
		'shows for each action a key the map reads as that action (mac: %s)',
		(isMac) => {
			EDIT_ACTIONS.forEach((action) => {
				const label = shortcutFor(action, isMac);
				if (label === undefined) return;
				expect(editActionFor(pressed(label, isMac), isMac)).toBe(action);
			});
		}
	);

	it('writes a chord as each platform does', () => {
		expect(shortcutFor('selectInverse', true)).toBe('⇧⌘I');
		expect(shortcutFor('selectInverse', false)).toBe('Ctrl+Shift+I');
		expect(shortcutFor('swapColors', true)).toBe('X');
		expect(shortcutFor('resetColors', false)).toBe('D');
		expect(shortcutFor('feather', true)).toBe('⇧F6');
		expect(shortcutFor('feather', false)).toBe('Shift+F6');
		expect(shortcutFor('fillArea', true)).toBe('⌥⌫');
		expect(shortcutFor('fillArea', false)).toBe('Alt+Backspace');
		expect(shortcutFor('fillAreaStroke', true)).toBe('⌘⌫');
		expect(shortcutFor('fillAreaStroke', false)).toBe('Ctrl+Backspace');
		expect(shortcutFor('fillDialog', true)).toBe('⇧F5');
		expect(shortcutFor('fillDialog', false)).toBe('Shift+F5');
		expect(shortcutFor('duplicate', false)).toBe('Ctrl+J');
		expect(shortcutFor('zoomIn', false)).toBe('Ctrl++');
		expect(shortcutFor('delete', true)).toBe('⌫');
		expect(shortcutFor('delete', false)).toBe('Delete');
	});

	it('shows no key a Mac in a tab cannot press, nor one for an action without one', () => {
		expect(shortcutFor('newLayer', false)).toBe('Insert');
		expect(shortcutFor('newLayer', true)).toBeUndefined();
		expect(shortcutFor('sizeUp', false)).toBeUndefined();
		expect(shortcutFor(undefined, false)).toBeUndefined();
	});

	it('shows Enter and Escape as each keyboard prints them, for a transform’s Apply and Cancel', () => {
		expect(shortcutFor('commit', true)).toBe('↩');
		expect(shortcutFor('commit', false)).toBe('Enter');
		expect(shortcutFor('escape', true)).toBe('⎋');
		expect(shortcutFor('escape', false)).toBe('Esc');
		expect(editActionFor(key('Enter'), false)).toBe('commit');
		expect(editActionFor(key('Enter', { target: field() }), false)).toBeUndefined();
	});
});

describe('the labels', () => {
	it('show a tool its letter, and the primary key as the platform writes it', () => {
		expect(shortcutLabel('brush')).toBe('B');
		expect(shortcutLabel('select')).toBe('V');
		expect(primaryKeyLabel(true)).toBe('⌘');
		expect(primaryKeyLabel(false)).toBe('Ctrl');
	});
});
