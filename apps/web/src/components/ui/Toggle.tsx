import { t } from '../../i18n/t.js';
import { CheckIcon } from './icons.js';

/**
 * An option that is on or off (docs/ARCHITECTURE.md §7, "The interface"): a
 * check box beside its name, as Photoshop's options bar shows Auto-Select
 * and Contiguous. The name is always shown, since no icon says what an
 * option like Auto-select or Constrain does. A button pressed or not
 * (`aria-pressed`), named by its words, so a tool bar's arrow keys reach it
 * as they reach the bar's other buttons, and a target tall either way. A key
 * that turns it on and off is in the tooltip after the name, as a tool's is;
 * with none there is no tooltip, since the name is shown already.
 */
export const Toggle = ({
	label,
	pressed,
	onChange,
	shortcut,
}: Readonly<{
	label: string;
	pressed: boolean;
	onChange: (pressed: boolean) => void;
	shortcut?: string;
}>) => (
	<button
		type="button"
		className="toggle"
		aria-pressed={pressed}
		title={shortcut === undefined ? undefined : t('ui.labelWithShortcut', { label, shortcut })}
		onClick={() => onChange(!pressed)}
	>
		<span className="toggle-box" aria-hidden="true">
			<CheckIcon size={14} />
		</span>
		{label}
	</button>
);
