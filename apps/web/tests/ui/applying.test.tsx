import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Apply, ApplyingProvider, useApply } from '../../src/components/ui/Applying.js';

/**
 * Work on a whole layer under way (docs/ARCHITECTURE.md §7, "The
 * interface"): a cover over the window from the start, unseen and unsaid
 * until the work has gone on 300 ms, then the work's words for the eye and,
 * politely, for a screen reader; once seen it stays 300 ms at least; it has
 * nothing to close it with, and keeps every key and press from the page. The
 * work begins two frames after the cover is in place, so the browser has
 * drawn it before work that holds the page begins.
 */

/** A frame, as the fake timers run `requestAnimationFrame`. */
const FRAME_MS = 16;

/** The provider's `apply`, as a component inside it has it. */
const providerApply = (): Apply => {
	const { result } = renderHook(useApply, { wrapper: ApplyingProvider });
	return (work, words) => result.current(work, words);
};

/** Work that settles when the test says. */
const deferred = <T,>() => {
	const settle: { resolve?: (value: T) => void; reject?: (error: unknown) => void } = {};
	const promise = new Promise<T>((resolve, reject) => {
		settle.resolve = resolve;
		settle.reject = reject;
	});
	return {
		promise,
		resolve: (value: T) => settle.resolve?.(value),
		reject: (error: unknown) => settle.reject?.(error),
	};
};

/** Time passing, and React's work with it. */
const pass = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

/** Work begun under the indicator, in React's turn, which ends as `apply` returns. */
const begin = <T,>(apply: Apply, work: () => T | PromiseLike<T>, words?: string): Promise<T> => {
	const begun: { done?: Promise<T> } = {};
	act(() => {
		begun.done = apply(work, words);
	});
	if (begun.done === undefined) throw new Error('apply gives back the work');
	return begun.done;
};

const cover = () => document.querySelector<HTMLElement>('.applying');

describe('useApply without the provider', () => {
	it('does the work at once and shows nothing', async () => {
		const { result } = renderHook(useApply);
		const work = vi.fn(() => 'done');
		const done = result.current(work);
		expect(work).toHaveBeenCalledTimes(1);
		await expect(done).resolves.toBe('done');
		expect(cover()).toBeNull();
	});
});

describe('the Applying indicator', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('puts its cover in place at once, unseen and unsaid, and begins the work two frames later', async () => {
		const apply = providerApply();
		const work = vi.fn(() => 'done');
		const done = begin(apply, work);
		expect(cover()).not.toBeNull();
		expect(screen.getByRole('status').textContent).toBe('');
		expect(work).not.toHaveBeenCalled();

		await pass(FRAME_MS);
		expect(work).not.toHaveBeenCalled();
		await pass(FRAME_MS);
		expect(work).toHaveBeenCalledTimes(1);
		await expect(done).resolves.toBe('done');
	});

	it('takes the cover away as soon as quick work is done, having said nothing', async () => {
		const apply = providerApply();
		const job = deferred<string>();
		const done = begin(apply, () => job.promise, 'Resizing the image…');
		await pass(100);
		expect(cover()).not.toBeNull();
		job.resolve('done');
		await pass(0);
		expect(cover()).toBeNull();
		await expect(done).resolves.toBe('done');
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('says the work’s own words, politely, once it has gone on 300 ms, and has nothing to close it with', async () => {
		const apply = providerApply();
		const job = deferred<void>();
		void begin(apply, () => job.promise, 'Resizing the image…');
		await pass(299);
		expect(screen.getByRole('status').textContent).toBe('');

		await pass(1);
		const status = screen.getByRole('status');
		expect(status.textContent).toBe('Resizing the image…');
		expect(status.getAttribute('aria-live')).toBe('polite');
		const card = cover()?.querySelector('.applying-card');
		expect(card?.textContent).toBe('Resizing the image…');
		// The card is for the eye; the status is what a screen reader says, once.
		expect(card?.getAttribute('aria-hidden')).toBe('true');
		expect(cover()?.querySelectorAll('button, [role="button"], a, input')).toHaveLength(0);
		// Seen from the delay the status waits, by the stylesheet's fade.
		expect(cover()?.style.animationDelay).toBe('300ms');

		job.resolve();
		await pass(300);
		expect(cover()).toBeNull();
	});

	it('says the words as the work ends where the page was held past the moment, while it stays', async () => {
		const apply = providerApply();
		const job = deferred<void>();
		void begin(apply, () => job.promise, 'Placing the picture…');
		await pass(2 * FRAME_MS);
		// The page held 400 ms by the work: no timer has had its turn.
		vi.setSystemTime(Date.now() + 400);
		job.resolve();
		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.getByRole('status').textContent).toBe('Placing the picture…');
		expect(cover()).not.toBeNull();
		await pass(300);
		expect(cover()).toBeNull();
	});

	it('says nothing late of work the page was held through to the end of its showing', async () => {
		const apply = providerApply();
		const job = deferred<void>();
		void begin(apply, () => job.promise);
		await pass(2 * FRAME_MS);
		vi.setSystemTime(Date.now() + 800);
		job.resolve();
		await act(async () => {
			await Promise.resolve();
		});
		expect(cover()).toBeNull();
	});

	it('says "Applying…" for work with no words of its own', async () => {
		const apply = providerApply();
		const job = deferred<void>();
		void begin(apply, () => job.promise);
		await pass(300);
		expect(screen.getByRole('status').textContent).toBe('Applying…');
		expect(cover()?.querySelector('.applying-card')?.textContent).toBe('Applying…');
		job.resolve();
		await pass(300);
	});

	it('stays 300 ms once seen, so work that ends as it appears does not flash it', async () => {
		const apply = providerApply();
		const job = deferred<void>();
		void begin(apply, () => job.promise);
		await pass(350);
		job.resolve();
		await pass(0);
		expect(cover()).not.toBeNull();
		await pass(249);
		expect(cover()).not.toBeNull();
		await pass(1);
		expect(cover()).toBeNull();
	});

	it('goes when the work fails, the failure being the caller’s', async () => {
		const apply = providerApply();
		const job = deferred<void>();
		const done = begin(apply, () => job.promise);
		const outcome = done.then(
			() => 'resolved',
			(error: unknown) => error
		);
		await pass(1000);
		job.reject(new Error('the picture would not decode'));
		await pass(0);
		expect(await outcome).toEqual(new Error('the picture would not decode'));
		expect(cover()).toBeNull();
	});

	it('goes when work that throws before it settles does', async () => {
		const apply = providerApply();
		const done = begin(apply, () => {
			throw new Error('no canvas');
		});
		const outcome = done.catch((error: unknown) => error);
		await pass(2 * FRAME_MS);
		expect(await outcome).toEqual(new Error('no canvas'));
		expect(cover()).toBeNull();
	});

	it('keeps every key from the page while it is there', async () => {
		const apply = providerApply();
		const heard = vi.fn();
		window.addEventListener('keydown', heard);
		const job = deferred<void>();
		void begin(apply, () => job.promise);

		const undo = fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
		expect(undo).toBe(false);
		expect(heard).not.toHaveBeenCalled();

		job.resolve();
		await pass(2 * FRAME_MS);
		expect(cover()).toBeNull();
		fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
		expect(heard).toHaveBeenCalledTimes(1);
		window.removeEventListener('keydown', heard);
	});

	it('keeps a press on it from taking the focus, and gives the focus back where one did', async () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const apply = providerApply();
		const job = deferred<void>();
		void begin(apply, () => job.promise);
		const element = cover();
		if (element === null) throw new Error('the cover is there');
		expect(fireEvent.pointerDown(element)).toBe(false);

		// A browser that moved the focus all the same.
		opener.blur();
		job.resolve();
		await pass(2 * FRAME_MS);
		expect(cover()).toBeNull();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});

	it('shows the latest work’s words while two are under way, and goes once both are done', async () => {
		const apply = providerApply();
		const first = deferred<void>();
		const second = deferred<void>();
		void begin(apply, () => first.promise, 'Trimming the canvas…');
		void begin(apply, () => second.promise, 'Resizing the image…');
		await pass(300);
		expect(screen.getAllByRole('status')).toHaveLength(1);
		expect(screen.getByRole('status').textContent).toBe('Resizing the image…');

		second.resolve();
		await pass(300);
		expect(cover()?.querySelector('.applying-card')?.textContent).toBe('Trimming the canvas…');
		first.resolve();
		await pass(300);
		expect(cover()).toBeNull();
	});

	it('lets the page go after a minute of work that never settles', async () => {
		const apply = providerApply();
		void begin(apply, () => new Promise<never>(() => undefined));
		await pass(59_000);
		expect(cover()).not.toBeNull();
		await pass(1_000);
		expect(cover()).toBeNull();
	});
});

/** A component inside the provider, as the frame's panels are. */
describe('ApplyingProvider', () => {
	it('shows what is inside it, and no cover while nothing is under way', () => {
		render(
			<ApplyingProvider>
				<p>The frame</p>
			</ApplyingProvider>
		);
		expect(screen.getByText('The frame')).toBeDefined();
		expect(cover()).toBeNull();
	});
});
