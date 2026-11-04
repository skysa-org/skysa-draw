import type { ProviderKind } from '@skysa/draw-core';
import type { ReactNode } from 'react';

import type { ConnectedSource } from '../../store/connection.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';

/**
 * Which kind of place a source is, in front of its name: on its row, and on
 * each provider the `+` offers. This app's own marks, drawn in the line style
 * of the rest of its icons (`components/ui/icons.tsx`): a device for this
 * device's drawings, and a cloud for an account at a provider, whichever it
 * is. The provider's name is always beside the mark, or in the control that
 * holds it, and says which; no vendor's logo is copied in (skysa-notes ships
 * the vendors' own, which are their trademarks and outside its license).
 *
 * Decorative everywhere: the name is beside it, or the button it is in says it.
 */

/** What a source's mark is chosen by: its provider, or this device. */
export type SourceKind = ProviderKind | 'local' | undefined;

export const sourceKind = (
	source: Pick<ConnectedSource, 'connectionId' | 'provider'>
): SourceKind => (source.connectionId === LOCAL_CONNECTION_ID ? 'local' : source.provider);

const Mark = ({ children, size = 20 }: Readonly<{ children: ReactNode; size?: number }>) => (
	<svg
		viewBox="0 0 24 24"
		width={size}
		height={size}
		fill="none"
		stroke="currentColor"
		strokeWidth={1.75}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		focusable="false"
		className="provider-icon"
	>
		{children}
	</svg>
);

/** A device: this one, or the others signed in on an account (`Devices`). */
export const DeviceIcon = ({ size }: Readonly<{ size?: number }>) => (
	<Mark {...(size === undefined ? {} : { size })}>
		<rect x="3.5" y="5" width="17" height="11" rx="1.5" />
		<path d="M2 19h20" />
	</Mark>
);

/** Storage at a provider: a cloud, whichever provider it is. */
const CloudIcon = () => (
	<Mark>
		<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z" />
	</Mark>
);

/**
 * `alert`: the source needs connecting again (`needsReconnect`), which a red
 * dot on the mark's corner says, as a phone's app icon says it has news. The
 * dot is decorative too: what holds the mark says it in words.
 */
export const ProviderIcon = ({
	kind,
	alert = false,
}: Readonly<{ kind: SourceKind; alert?: boolean }>) => {
	const shown = kind === 'local' ? <DeviceIcon /> : <CloudIcon />;
	if (!alert) return shown;
	return (
		<span className="provider-icon-alert">
			{shown}
			<span className="provider-icon-badge" />
		</span>
	);
};
