/**
 * Whether the browser would ask before the page goes (`store/leaving.ts`): a
 * listener of its leave prompt cancels the event.
 */
export const asksBeforeLeaving = (): boolean =>
	!window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
