import { CheckIcon } from './icons.js';

/**
 * An option that is on or off (docs/ARCHITECTURE.md §7, "The interface"): a
 * check box beside its name, as Photoshop's options bar shows Auto-Select
 * and Contiguous. The name is always shown, since no icon says what an
 * option like Auto-select or Constrain does. A button pressed or not
 * (`aria-pressed`), named by its words, so a tool bar's arrow keys reach it
 * as they reach the bar's other buttons, and a target tall either way.
 */
export const Toggle = ({
	label,
	pressed,
	onChange,
}: Readonly<{
	label: string;
	pressed: boolean;
	onChange: (pressed: boolean) => void;
}>) => (
	<button
		type="button"
		className="toggle"
		aria-pressed={pressed}
		onClick={() => onChange(!pressed)}
	>
		<span className="toggle-box" aria-hidden="true">
			<CheckIcon size={14} />
		</span>
		{label}
	</button>
);
