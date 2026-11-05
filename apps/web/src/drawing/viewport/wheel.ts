import { type RefObject, useEffect } from 'react';

import type { Observable } from './observable.js';
import { panBy, toUser, type View, zoomAbout } from './transform.js';

/** How many screen pixels of wheel multiply the scale by e, with Ctrl or ⌘ held. */
const WHEEL_ZOOM = 0.002;
/** A wheel that counts in lines, as Firefox's does, is taken at this many pixels a line. */
const LINE_PX = 16;

/** A wheel's delta in pixels, whichever unit the browser gave it in. */
const wheelPixels = (delta: number, mode: number): number =>
	mode === WheelEvent.DOM_DELTA_LINE ? delta * LINE_PX : delta;

/**
 * A wheel over the viewport scrolls the drawing and, with Ctrl or ⌘, zooms it
 * about the cursor. By hand rather than React's `onWheel`, which is passive on
 * the root and so cannot keep the page from scrolling too.
 */
export const useWheel = (region: RefObject<HTMLElement | null>, views: Observable<View>): void => {
	useEffect(() => {
		const element = region.current;
		if (element === null) return undefined;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const current = views.get();
			const dx = wheelPixels(event.deltaX, event.deltaMode);
			const dy = wheelPixels(event.deltaY, event.deltaMode);
			if (event.ctrlKey || event.metaKey) {
				const rect = element.getBoundingClientRect();
				const [x, y] = toUser(current, event.clientX - rect.left, event.clientY - rect.top);
				views.set(zoomAbout(current, Math.exp(-dy * WHEEL_ZOOM), x, y));
				return;
			}
			views.set(panBy(current, -dx / current.scale, -dy / current.scale));
		};
		element.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			element.removeEventListener('wheel', onWheel);
		};
	}, [region, views]);
};
