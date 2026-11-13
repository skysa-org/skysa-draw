import { makeWay, updateChannel } from '@skysa/client';
import { createRootRoute, Outlet } from '@tanstack/react-router';

import { ErrorScreen } from '../components/shell/ErrorScreen.js';
import { StaleTabGate } from '../components/shell/StaleTabGate.js';
import { UpdatePrompt } from '../components/shell/UpdatePrompt.js';
import { syncScheduler } from '../sync/runtime.js';

/**
 * Before a new build takes over: syncing paused here and in every other tab,
 * so no request of the old build's is cut off half way (`makeWay`, the kit's
 * client's).
 */
const beforeUpdate = (): Promise<void> => makeWay(syncScheduler, updateChannel());

const RootLayout = () => (
	<div className="app">
		<Outlet />
		<div className="app-foot">
			<StaleTabGate />
			<UpdatePrompt beforeUpdate={beforeUpdate} />
		</div>
	</div>
);

export const Route = createRootRoute({
	component: RootLayout,
	// The last boundary there is: a route without one of its own lands here, and
	// so does anything the layout itself throws.
	errorComponent: ErrorScreen,
});
