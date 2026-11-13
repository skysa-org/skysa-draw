import { type Cell, cell } from '@skysa/storage';

/**
 * A value the viewport's handlers write and React reads through
 * `useSyncExternalStore`: the view, and the selection. Not React state, on
 * purpose. The view is set from the first layout effect, from a tool's own
 * methods in the middle of a stroke and from a wheel listener attached by
 * hand, and the React Compiler's rules refuse a state setter called from an
 * effect; an observable is set from anywhere and React is told after.
 */
export type Observable<T> = Readonly<{
	get: () => T;
	set: (value: T) => void;
	subscribe: (listener: () => void) => () => void;
}>;

export const observable = <T>(initial: T): Observable<T> => {
	const value: Cell<T> = cell(initial);
	const listeners = new Set<() => void>();
	return {
		get: () => value.current,
		set: (next) => {
			// The same value is not a change, so a clear of nothing tells nobody.
			if (Object.is(next, value.current)) return;
			value.current = next;
			listeners.forEach((listener) => listener());
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};
