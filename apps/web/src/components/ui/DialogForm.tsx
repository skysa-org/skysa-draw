import '../../styles/dialogs.css';

import { type ReactNode, type RefObject, type SyntheticEvent, useEffect, useRef } from 'react';

import { t } from '../../i18n/t.js';
import { Panel } from './Panel.js';

/**
 * A dialog's form (docs/decisions/0004-the-interface.md, "The context
 * menu"): a titled panel of groups of controls, and Cancel and Apply under
 * them, for a dialog of the frame's, which the frame puts in a sheet on
 * compact and in a drawer elsewhere (`PanelHost`). Apply, or Enter, does what
 * the dialog asks and closes it; Cancel, Escape or a tap beside it close it
 * with nothing done, Escape and the tap being the host's. While `canApply`
 * is false Apply is shown disabled, and neither it nor Enter does anything.
 *
 * Enter applies from any control but a button, a text field and a color
 * picker, whose Enter is their own; a radio drawn as a button is a radio
 * still, and Enter applies from it as from a native one. The focus starts on
 * the first field, a number, a text or a list to choose from, or on the
 * choice made in the first group of choices, whichever comes first, a field's
 * text selected so that what is typed replaces it. The browser's own checks
 * are off: what is valid is the dialog's to say, by `canApply` and by each
 * field's `invalid`, the same in every browser.
 *
 * An Apply that starts work that takes a while, Export's render, is not
 * closed by Apply (`closesOnApply` false): the dialog says it is `busy` while
 * the work lasts, the form marked so for a screen reader and Apply's words
 * saying what is under way, and Apply and Enter do nothing until it is done;
 * the dialog then closes itself, or stays open to say the work failed.
 */

/** An Enter that is the control's own: a button's press, a text field's or the color picker's. */
const keepsEnter = (target: EventTarget | null): boolean =>
	(target instanceof HTMLButtonElement && target.getAttribute('role') !== 'radio') ||
	target instanceof HTMLTextAreaElement ||
	(target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'color'));

/** Where the focus starts: the first field, or the first choice made, whichever comes first. */
const FIRST =
	'input[type="number"], input[type="text"], select, input:checked, [role="radio"][aria-checked="true"]';

/**
 * Enter applies, and the focus goes to the first field once the sheet or the
 * drawer has taken it as it opens, which it does after the form's own
 * effects have run. Native listeners, since the form itself is not a control
 * to hang a key handler on.
 */
const useDialogKeys = (form: RefObject<HTMLFormElement | null>): void => {
	useEffect(() => {
		const element = form.current;
		if (element === null) return undefined;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
			if (keepsEnter(event.target)) return;
			event.preventDefault();
			element.requestSubmit();
		};
		element.addEventListener('keydown', onKeyDown);
		queueMicrotask(() => {
			if (!element.isConnected) return;
			const first = element.querySelector<HTMLElement>(FIRST);
			first?.focus();
			if (first instanceof HTMLInputElement && first.type !== 'radio') first.select();
		});
		return () => element.removeEventListener('keydown', onKeyDown);
	}, [form]);
};

export const DialogForm = ({
	title,
	applyLabel,
	canApply = true,
	busy = false,
	closesOnApply = true,
	onApply,
	onClose,
	children,
}: Readonly<{
	title: string;
	/** The words on the button that applies; while `busy`, what is under way. */
	applyLabel: string;
	canApply?: boolean;
	/** At work on what Apply asked: Apply and Enter wait until it is done. */
	busy?: boolean;
	/** Whether Apply closes the dialog; where not, the dialog closes itself, by `onClose`, once its work is done. */
	closesOnApply?: boolean;
	/** Does what the dialog asks; the dialog closes after it, unless `closesOnApply` is false. */
	onApply: () => void;
	onClose: () => void;
	children: ReactNode;
}>) => {
	const form = useRef<HTMLFormElement>(null);
	useDialogKeys(form);
	const ready = canApply && !busy;
	const onSubmit = (event: SyntheticEvent) => {
		event.preventDefault();
		if (!ready) return;
		onApply();
		if (closesOnApply) onClose();
	};
	return (
		<Panel title={title} onClose={onClose}>
			<form
				ref={form}
				className="field-groups"
				noValidate
				aria-busy={busy || undefined}
				onSubmit={onSubmit}
			>
				{children}
				<div className="dialog-actions">
					<button type="button" onClick={onClose}>
						{t('common.cancel')}
					</button>
					<button type="submit" className="primary" disabled={!ready}>
						{applyLabel}
					</button>
				</div>
			</form>
		</Panel>
	);
};
