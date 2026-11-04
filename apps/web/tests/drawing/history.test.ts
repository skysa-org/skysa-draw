import { describe, expect, it } from 'vitest';

import { createHistory, HISTORY_BYTES } from '../../src/drawing/document/history.js';
import type { Command } from '../../src/drawing/document/model.js';

/**
 * Undo and redo for one drawing (docs/ARCHITECTURE.md §7, "Commands and
 * history"): the order steps come back in, the redo branch a new step cuts
 * off, and the cap in bytes that lets the oldest steps go.
 */

const command = (label: string, bytes = 1): Command => ({
	label,
	bytes,
	apply: () => undefined,
	revert: () => undefined,
});

describe('the history', () => {
	it('is capped at 256 MiB unless told otherwise', () => {
		expect(HISTORY_BYTES).toBe(256 * 1024 * 1024);
	});

	it('starts at the origin with nothing to undo or redo', () => {
		const history = createHistory();
		expect(history.canUndo()).toBe(false);
		expect(history.canRedo()).toBe(false);
		expect(history.atOrigin()).toBe(true);
		expect(history.undo()).toBeUndefined();
		expect(history.redo()).toBeUndefined();
	});

	it('undoes newest first and redoes in the order undone', () => {
		const history = createHistory();
		const [a, b, c] = [command('a'), command('b'), command('c')];
		[a, b, c].forEach(history.push);
		expect(history.atOrigin()).toBe(false);

		expect(history.undo()).toBe(c);
		expect(history.undo()).toBe(b);
		expect(history.canRedo()).toBe(true);
		expect(history.redo()).toBe(b);
		expect(history.undo()).toBe(b);
		expect(history.undo()).toBe(a);
		expect(history.canUndo()).toBe(false);
		expect(history.atOrigin()).toBe(true);
		expect(history.redo()).toBe(a);
		expect(history.redo()).toBe(b);
		expect(history.redo()).toBe(c);
		expect(history.redo()).toBeUndefined();
	});

	it('drops what was undone when a new step is pushed', () => {
		const history = createHistory();
		const [a, b, c] = [command('a'), command('b'), command('c')];
		history.push(a);
		history.push(b);
		history.undo();
		history.push(c);

		expect(history.canRedo()).toBe(false);
		expect(history.redo()).toBeUndefined();
		expect(history.undo()).toBe(c);
		expect(history.undo()).toBe(a);
	});

	it('lets the oldest steps go once what it keeps passes the limit', () => {
		const history = createHistory(10);
		const [a, b, c] = [command('a', 4), command('b', 4), command('c', 4)];
		[a, b, c].forEach(history.push);

		expect(history.undo()).toBe(c);
		expect(history.undo()).toBe(b);
		expect(history.undo()).toBeUndefined();
		// The opened state is out of reach once a step is gone, undone or not.
		expect(history.atOrigin()).toBe(false);
	});

	it('lets several go at once for one large step, but never the step just pushed', () => {
		const history = createHistory(10);
		[command('a', 3), command('b', 3), command('c', 3)].forEach(history.push);
		const large = command('large', 25);
		history.push(large);

		expect(history.undo()).toBe(large);
		expect(history.undo()).toBeUndefined();
		expect(history.atOrigin()).toBe(false);
	});

	it('counts an undone step out of what it keeps, until it is redone', () => {
		const history = createHistory(10);
		const [a, b] = [command('a', 6), command('b', 4)];
		history.push(a);
		history.push(b);
		history.undo();
		const c = command('c', 4);
		history.push(c);

		expect(history.undo()).toBe(c);
		expect(history.undo()).toBe(a);
		expect(history.atOrigin()).toBe(true);
	});
});
