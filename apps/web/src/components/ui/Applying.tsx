import { cell } from '@skysa/draw-core';
import {
	createContext,
	type Dispatch,
	type PointerEvent,
	type ReactNode,
	type SetStateAction,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { createPortal, flushSync } from 'react-dom';

import { t } from '../../i18n/t.js';
import { HAS_POPOVER, raise } from './MenuList.js';

/**
 * Work on a whole layer or the whole drawing, under way (docs/ARCHITECTURE.md
 * §7, "The interface"): Image size with Resample, Trim, a fill, a merge. On a
 * big raster layer such work holds the page for a while, and this says so, in
 * the operation's own words where it has some and "Applying…" where not, over
 * a dimmed window and a bar that does not say how far, as Content-Aware's
 * line over the canvas does not.
 *
 * While work is under way nothing else can be used, so no edit lands in the
 * middle of it: the indicator covers the whole window, in the top layer where
 * the browser has one, over every sheet and drawer, and takes every press and
 * every key. It has no close control and Escape does not put it away; it goes
 * when the work does. The focus stays where it was, and so comes back to
 * nothing new.
 *
 * It is in place from the start but seen only once the work has gone on for
 * `SHOWN_AFTER_MS`, so quick work never flashes it. The delay and the fade
 * are the stylesheet's, in opacity alone, which the browser's compositor runs
 * even while the page's own thread is held: work that holds it from its first
 * step is begun two frames after the indicator is put in place, so the
 * indicator is drawn, and fades in on time, whatever the work then does to
 * the page. A screen reader is told politely at the same moment, by a status
 * that was there, empty, before the words came into it, or, where the page
 * was held past that moment and the work ended in it, as the work ends, while
 * the indicator stays on to be seen. Once seen it stays
 * `SHOWN_AT_LEAST_MS`, so work that ends just as it appears does not flash it
 * either; work that never settles gives it up after `GIVEN_UP_AFTER_MS`,
 * rather than holding the page for good.
 *
 * `apply(work, words)` does the work under it and settles as the work does.
 * Without the provider, as where a panel is shown on its own, it does the
 * work at once and shows nothing.
 */

/** How long work goes before the indicator is seen and heard. */
const SHOWN_AFTER_MS = 300;

/** Once seen, how long at least it stays. */
const SHOWN_AT_LEAST_MS = 300;

/** How long it waits for work that does not settle before it lets the page go. */
const GIVEN_UP_AFTER_MS = 60_000;

/**
 * How long a frame is waited for at most: none comes while the page is
 * hidden, and the work is not to wait for the page to be seen again.
 */
const FRAME_AT_MOST_MS = 100;

/** Does `work` under the indicator, in `words`, or "Applying…"; settles as the work does. */
export type Apply = <T>(work: () => T | PromiseLike<T>, words?: string) => Promise<T>;

/** Work under way: its words, and whether a screen reader has been told them yet. */
type Job = Readonly<{ id: number; words: string; heard: boolean }>;

/** Without the provider: the work at once, with nothing shown. */
const plainly: Apply = (work) => new Promise((resolve) => resolve(work()));

const ApplyingContext = createContext<Apply>(plainly);

/** The next frame, or `FRAME_AT_MOST_MS` from now where none comes sooner. */
const nextFrame = (): Promise<void> =>
	new Promise((resolve) => {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
		setTimeout(resolve, FRAME_AT_MOST_MS);
	});

/**
 * After two frames: the first draws what was put in the page before it, the
 * second begins once the first is on its way to the screen, its animations
 * with it.
 */
const afterTwoFrames = (): Promise<void> => nextFrame().then(nextFrame);

/** The work, or its giving up, whichever comes first; the work itself is not stopped. */
const settledOrGivenUp = <T,>(work: Promise<T>): Promise<unknown> =>
	Promise.race([
		work.then(
			() => undefined,
			() => undefined
		),
		new Promise((resolve) => setTimeout(resolve, GIVEN_UP_AFTER_MS)),
	]);

/** How long the indicator stays once work is done, `elapsed` after it was put in place. */
const holdFor = (elapsed: number): number => {
	const seen = elapsed - SHOWN_AFTER_MS;
	return seen < 0 ? 0 : Math.max(0, SHOWN_AT_LEAST_MS - seen);
};

/** The provider's `apply`, which keeps the work under way in `setJobs`. */
const applier = (setJobs: Dispatch<SetStateAction<readonly Job[]>>): Apply => {
	const count = cell(0);
	return (work, words = t('ui.applying')) => {
		count.current += 1;
		const id = count.current;
		const began = Date.now();
		// In the page now, not at React's next turn, so the two frames draw it.
		flushSync(() => setJobs((jobs) => [...jobs, { id, words, heard: false }]));
		const hear = () =>
			setJobs((jobs) => jobs.map((job) => (job.id === id ? { ...job, heard: true } : job)));
		const heard = setTimeout(hear, SHOWN_AFTER_MS);
		const done = afterTwoFrames().then(work);
		void settledOrGivenUp(done).then(() => {
			clearTimeout(heard);
			const close = () => setJobs((jobs) => jobs.filter((job) => job.id !== id));
			const hold = holdFor(Date.now() - began);
			if (hold === 0) {
				close();
				return;
			}
			// Seen and still shown: said now where the page was held past the
			// moment it was to be, and the work settled before the timer could.
			hear();
			setTimeout(close, hold);
		});
		return done;
	};
};

/** Every key, while work is under way, before anything else in the page hears it. */
const keepKey = (event: KeyboardEvent): void => {
	event.preventDefault();
	event.stopImmediatePropagation();
};

/** A press on the cover, which is nothing to focus: the focus stays where it was. */
const keepFocus = (event: PointerEvent<HTMLDivElement>): void => {
	event.preventDefault();
};

/**
 * The cover over the window while work is under way: the card, with the
 * latest work's words and the bar, for the eye; the status, with the words
 * of the latest work gone on long enough to be seen, for a screen reader.
 */
const Cover = ({ words, heard }: Readonly<{ words: string; heard: string | undefined }>) => {
	const ref = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (ref.current !== null) raise(ref.current);
	}, []);

	// The window's capture phase comes before every other listener but those
	// put there earlier. Where a press took the focus all the same, it goes
	// back where it was.
	useEffect(() => {
		const had = document.activeElement;
		window.addEventListener('keydown', keepKey, true);
		return () => {
			window.removeEventListener('keydown', keepKey, true);
			const lost =
				document.activeElement === null || document.activeElement === document.body;
			if (lost && had instanceof HTMLElement && had.isConnected) had.focus();
		};
	}, []);

	return createPortal(
		<div
			ref={ref}
			className="applying"
			popover={HAS_POPOVER ? 'manual' : undefined}
			// The delay is the one the status waits, kept in one place.
			style={{ animationDelay: `${String(SHOWN_AFTER_MS)}ms` }}
			onPointerDown={keepFocus}
		>
			<div className="applying-card" aria-hidden="true">
				<span>{words}</span>
				<span className="applying-bar" />
			</div>
			<p role="status" aria-live="polite" className="visually-hidden">
				{heard}
			</p>
		</div>,
		document.body
	);
};

/**
 * Gives what is inside it `apply` (`useApply`), and shows the indicator while
 * any work it was given is under way: the frame's, around the drawing open.
 */
export const ApplyingProvider = ({ children }: Readonly<{ children: ReactNode }>) => {
	const [jobs, setJobs] = useState<readonly Job[]>([]);
	const [apply] = useState(() => applier(setJobs));
	const latest = jobs.at(-1);
	return (
		<ApplyingContext value={apply}>
			{children}
			{latest !== undefined && (
				<Cover words={latest.words} heard={jobs.findLast((job) => job.heard)?.words} />
			)}
		</ApplyingContext>
	);
};

/** The `apply` of the provider around this, or the work done plainly where there is none. */
export const useApply = (): Apply => useContext(ApplyingContext);
