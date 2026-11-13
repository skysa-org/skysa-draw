import { createRootRoute, Outlet } from '@tanstack/react-router';

import { ErrorScreen } from '../components/shell/ErrorScreen.js';

const RootLayout = () => (
	<div className="app">
		<Outlet />
	</div>
);

export const Route = createRootRoute({
	component: RootLayout,
	// The last boundary there is: a route without one of its own lands here, and
	// so does anything the layout itself throws.
	errorComponent: ErrorScreen,
});
