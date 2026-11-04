import type { KeyboardEvent, ReactNode, Ref } from 'react';

import { classes } from './classes.js';

/**
 * A control that is its icon (docs/ARCHITECTURE.md §7, "The interface"): the
 * label is what a screen reader says and what the tooltip shows, and the hit
 * area is `--target` either way, whatever the pointer. The optional `menu`
 * props are for `Menu`, whose trigger is one of these.
 */
export const IconButton = ({
	icon,
	label,
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
		title={label}
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
