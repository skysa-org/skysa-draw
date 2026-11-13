import { CatchBoundary } from '@tanstack/react-router';

import { StaleTabGate } from './StaleTabGate.js';
import { UpdatePrompt } from './UpdatePrompt.js';

/** Nothing in place of the bars: the page goes on without them. */
const NoBars = () => null;

/**
 * The bars along the window's foot (`.app-foot`): the stale window's
 * (`StaleTabGate`) over the one that says a new build is waiting
 * (`UpdatePrompt`). Beside the router (`main.tsx`), not in its root route,
 * so that the screen put in place of the app on an error still has them;
 * and in a boundary of their own, since out of the root route's, so that one
 * of them failing takes the bars away and not the page.
 */
export const AppFoot = ({ beforeUpdate }: { beforeUpdate?: () => Promise<void> }) => (
	<CatchBoundary getResetKey={() => 0} errorComponent={NoBars}>
		<div className="app-foot">
			<StaleTabGate />
			<UpdatePrompt beforeUpdate={beforeUpdate} />
		</div>
	</CatchBoundary>
);
