import { CatchBoundary } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';

import { subscribeTabState, tabState } from '../../store/staleTab.js';
import { StaleTabGate } from './StaleTabGate.js';
import { UpdatePrompt } from './UpdatePrompt.js';

/** Nothing in place of a bar: the page, and the other bar, go on without it. */
const NoBar = () => null;

/**
 * The bars along the window's foot (`.app-foot`): the stale window's
 * (`StaleTabGate`) over the one that says a new build is waiting
 * (`UpdatePrompt`). Beside the router (`main.tsx`), not in its root route,
 * so that the screen put in place of the app on an error still has them;
 * and each in a boundary of its own, since out of the root route's, so that
 * one failing takes itself away and not the page, nor the other: the gate is
 * what stops strokes going into a window that can no longer save them. The
 * gate's is tried again each time the window's state changes, so that one
 * failure while there was nothing to say does not leave the window without
 * it once there is.
 */
export const AppFoot = ({ beforeUpdate }: { beforeUpdate?: () => Promise<void> }) => {
	const state = useSyncExternalStore(subscribeTabState, tabState);
	return (
		<div className="app-foot">
			<CatchBoundary getResetKey={() => state} errorComponent={NoBar}>
				<StaleTabGate />
			</CatchBoundary>
			<CatchBoundary getResetKey={() => 0} errorComponent={NoBar}>
				<UpdatePrompt beforeUpdate={beforeUpdate} />
			</CatchBoundary>
		</div>
	);
};
