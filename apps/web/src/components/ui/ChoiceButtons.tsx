import type { ReactNode } from 'react';

import { IconButton } from './IconButton.js';

/**
 * One of the choices: what it chooses, its name in words, its icon, and the
 * key that makes it for a moment, where one does.
 */
export type Choice<T extends string> = Readonly<{
	value: T;
	label: string;
	icon: ReactNode;
	shortcut?: string;
}>;

/**
 * One of a few options, each shown by its icon (docs/ARCHITECTURE.md §7,
 * "The interface"), as Photoshop's options bar shows the selection tools'
 * four modes: a group named for what it chooses, of icon buttons a target
 * either way, each named in whole words, with its key in its tooltip after
 * its name where it has one, and the one in force pressed.
 *
 * The buttons are pressed or not (`aria-pressed`) in a `group`, as the tool
 * bar's tools are, and not radios in a `radiogroup`: a radio group promises
 * that the arrow keys move the choice, and inside a tool bar the arrows are
 * the bar's (`ToolBar`), moving the focus along all its buttons, past the
 * group's ends, without choosing. So each is a button the arrows reach as
 * they reach the bar's others, and Space or Enter presses. Pressing the one
 * in force changes nothing, as a radio's would not.
 */
export const ChoiceButtons = <T extends string>({
	label,
	choices,
	value,
	onChange,
}: Readonly<{
	label: string;
	choices: readonly Choice<T>[];
	value: T;
	onChange: (value: T) => void;
}>) => (
	<div role="group" aria-label={label} className="choice-buttons">
		{choices.map((choice) => (
			<IconButton
				key={choice.value}
				icon={choice.icon}
				label={choice.label}
				shortcut={choice.shortcut}
				pressed={choice.value === value}
				onClick={() => {
					if (choice.value !== value) onChange(choice.value);
				}}
			/>
		))}
	</div>
);
