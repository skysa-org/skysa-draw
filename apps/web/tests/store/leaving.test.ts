import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { holdLeaving, letLeave, releaseLeaving } from '../../src/store/leaving.js';
import { asksBeforeLeaving as asks } from '../support/leaving.js';

afterEach(letLeave);

const LOSING = () => true;

describe('the leave prompt', () => {
	it('asks while anything holds it that would lose something, and only then', () => {
		const drawing = Symbol('a drawing');
		const other = Symbol('another');
		expect(asks()).toBe(false);

		holdLeaving(drawing, LOSING);
		holdLeaving(other, LOSING);
		expect(asks()).toBe(true);
		releaseLeaving(drawing);
		expect(asks()).toBe(true);
		releaseLeaving(other);

		expect(asks()).toBe(false);
	});

	it('asks each holder as the page goes, not as it held on', () => {
		const lost = { now: false };
		holdLeaving(Symbol('a drawing'), () => lost.now);
		holdLeaving(Symbol('another'), () => false);
		expect(asks()).toBe(false);

		lost.now = true;

		expect(asks()).toBe(true);
	});

	it('is held once by a holder that holds it twice', () => {
		const drawing = Symbol('a drawing');
		holdLeaving(drawing, LOSING);
		holdLeaving(drawing, LOSING);

		releaseLeaving(drawing);

		expect(asks()).toBe(false);
	});

	it('is listened for only while held, and asks as browsers before Chrome 119 hear it too', () => {
		const adding = vi.spyOn(window, 'addEventListener');
		const removing = vi.spyOn(window, 'removeEventListener');
		onTestFinished(() => {
			adding.mockRestore();
			removing.mockRestore();
		});
		const drawing = Symbol('a drawing');

		holdLeaving(drawing, LOSING);
		const listener = adding.mock.calls.find(([type]) => type === 'beforeunload')?.[1];
		const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
		(listener as (event: unknown) => void)(event);
		releaseLeaving(drawing);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(event.returnValue).toBe(true);
		expect(removing).toHaveBeenCalledWith('beforeunload', listener);
	});

	it('lets go of every hold at once, for a reload that must not ask', () => {
		const removing = vi.spyOn(window, 'removeEventListener');
		onTestFinished(() => {
			removing.mockRestore();
		});
		holdLeaving(Symbol('a drawing'), LOSING);
		holdLeaving(Symbol('another'), LOSING);

		letLeave();
		expect(asks()).toBe(false);
		expect(removing).toHaveBeenCalledWith('beforeunload', expect.any(Function));

		// Forgotten, not only unheard: a hold after it is the only one.
		const next = Symbol('a drawing opened since');
		holdLeaving(next, LOSING);
		releaseLeaving(next);
		expect(asks()).toBe(false);
	});
});
