import type { KeyboardEvent, ReactNode, Ref } from 'react';

import { t } from '../../i18n/t.js';
import { classes } from './classes.js';

/**
 * A control that is its icon (docs/ARCHITECTURE.md §7, "The interface"): the
 * label is what a screen reader says and what the tooltip shows, and the hit
 * area is `--target` either way, whatever the pointer. A key that does what
 * it does is in the tooltip after the label, as a tool's is. The optional
 * `menu` props are for `Menu`, whose trigger is one of these.
 */
export const IconButton = ({
	icon,
	label,
	shortcut,
	onClick,
	disabled,
	pressed,
	className,
	ref,
	haspopup,
	expanded,
	controls,
	onKeyDown,
}: {
	icon: ReactNode;
	label: string;
	shortcut?: string;
	onClick: () => void;
	disabled?: boolean;
	pressed?: boolean;
	className?: string;
	ref?: Ref<HTMLButtonElement>;
	haspopup?: 'menu';
	expanded?: boolean;
	controls?: string;
	onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) => (
	<button
		ref={ref}
		type="button"
		className={classes('icon-button', className)}
		aria-label={label}
		title={shortcut === undefined ? label : t('ui.labelWithShortcut', { label, shortcut })}
		aria-pressed={pressed}
		aria-haspopup={haspopup}
		aria-expanded={expanded}
		aria-controls={controls}
		disabled={disabled}
		onClick={onClick}
		onKeyDown={onKeyDown}
	>
		{icon}
	</button>
);
