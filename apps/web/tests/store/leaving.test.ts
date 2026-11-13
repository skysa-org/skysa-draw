import { afterEach, describe, expect, it, vi } from 'vitest';

import { holdLeaving, letLeave, releaseLeaving } from '../../src/store/leaving.js';

/** Whether the browser would ask before the page goes: a listener of its leave prompt cancels the event. */
const asks = () => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }));

afterEach(letLeave);

describe('the leave prompt', () => {
	it('asks while anything holds it, and only then', () => {
		const drawing = Symbol('a drawing');
		const other = Symbol('another');
		expect(asks()).toBe(false);

		holdLeaving(drawing);
		holdLeaving(other);
		expect(asks()).toBe(true);
		releaseLeaving(drawing);
		expect(asks()).toBe(true);
		releaseLeaving(other);

		expect(asks()).toBe(false);
	});

	it('is held once by a holder that holds it twice', () => {
		const drawing = Symbol('a drawing');
		holdLeaving(drawing);
		holdLeaving(drawing);

		releaseLeaving(drawing);

		expect(asks()).toBe(false);
	});

	it('is listened for only while held, and asks as browsers before Chrome 119 hear it too', () => {
		const adding = vi.spyOn(window, 'addEventListener');
		const removing = vi.spyOn(window, 'removeEventListener');
		const drawing = Symbol('a drawing');

		holdLeaving(drawing);
		const listener = adding.mock.calls.find(([type]) => type === 'beforeunload')?.[1];
		const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
		(listener as (event: unknown) => void)(event);
		releaseLeaving(drawing);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(event.returnValue).toBe(true);
		expect(removing).toHaveBeenCalledWith('beforeunload', listener);
	});

	it('lets go of every hold at once, for a reload that must not ask', () => {
		holdLeaving(Symbol('a drawing'));
		holdLeaving(Symbol('another'));

		letLeave();
		expect(asks()).toBe(false);

		// Forgotten, not only unheard: a hold after it is the only one.
		const next = Symbol('a drawing opened since');
		holdLeaving(next);
		releaseLeaving(next);
		expect(asks()).toBe(false);
	});
});
