import type { ReactNode } from 'react';

import { t } from '../../i18n/t.js';
import { classes } from './classes.js';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './icons.js';

/**
 * A titled panel (docs/ARCHITECTURE.md §7, "The interface"): the layers, the
 * properties, the colour. The header stays and the body scrolls, wherever the
 * frame puts it — in a sheet, a drawer or the dock (`PanelHost`). `actions`
 * sit in the header, before the close control the frame gives it when the
 * panel can be put away.
 */
export const Panel = ({
	title,
	children,
	onClose,
	actions,
	className,
}: {
	title: string;
	children: ReactNode;
	onClose?: () => void;
	actions?: ReactNode;
	className?: string;
}) => (
	<section className={classes('panel', className)} aria-label={title}>
		<header className="panel-header">
			<h2 className="panel-title">{title}</h2>
			{actions !== undefined && <div className="panel-actions">{actions}</div>}
			{onClose !== undefined && (
				<IconButton
					icon={<CloseIcon />}
					label={t('ui.closePanel')}
					onClick={onClose}
					className="panel-close"
				/>
			)}
		</header>
		<div className="panel-body">{children}</div>
	</section>
);
