import { describe, expect, it } from 'vitest';

import {
	EDIT_ACTIONS,
	editActionFor,
	isHandKey,
	isTyping,
	type KeyLike,
	primaryKeyLabel,
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
	it('gives every tool one capital letter, and no two the same', () => {
		expect(Object.keys(TOOL_KEYS).sort()).toEqual([...TOOL_IDS].sort());
		const letters = Object.values(TOOL_KEYS);
		expect(new Set(letters).size).toBe(letters.length);
		letters.forEach((letter) => {
			expect(letter).toMatch(/^[A-Z]$/);
		});
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
			fill: 'G',
			eyedropper: 'I',
			rectangle: 'R',
			ellipse: 'O',
			line: 'L',
			pen: 'P',
			text: 'T',
			marquee: 'M',
			lasso: 'Q',
			crop: 'C',
		});
	});
});

describe('toolFor', () => {
	it('picks a tool by its letter, in either case, on every platform', () => {
		TOOL_IDS.forEach((id) => {
			const letter = TOOL_KEYS[id];
			expect(toolFor(key(letter), false)).toBe(id);
			expect(toolFor(key(letter.toLowerCase()), true)).toBe(id);
		});
	});

	it('is nothing with a modifier, for a key that is not a letter, or for a letter nobody uses', () => {
		expect(toolFor(key('v', { ctrlKey: true }), false)).toBeUndefined();
		expect(toolFor(key('v', { metaKey: true }), true)).toBeUndefined();
		expect(toolFor(key('v', { altKey: true }), false)).toBeUndefined();
		expect(toolFor(key('V', { shiftKey: true }), false)).toBeUndefined();
		expect(toolFor(key('Escape'), false)).toBeUndefined();
		expect(toolFor(key('F1'), false)).toBeUndefined();
		expect(toolFor(key('j'), false)).toBeUndefined();
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
		expect(editActionFor(key('x'), false)).toBe('swapColours');
		expect(editActionFor(key('X'), false)).toBe('swapColours');
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
		expect(editActionFor(key('Escape', { target }), false)).toBe('escape');
	});

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

describe('the labels', () => {
	it('show a tool its letter, and the primary key as the platform writes it', () => {
		expect(shortcutLabel('brush')).toBe('B');
		expect(shortcutLabel('select')).toBe('V');
		expect(primaryKeyLabel(true)).toBe('⌘');
		expect(primaryKeyLabel(false)).toBe('Ctrl');
	});
});
