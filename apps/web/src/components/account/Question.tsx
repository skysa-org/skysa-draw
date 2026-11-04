import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useRef,
} from 'react';

import { t } from '../../i18n/t.js';
import { useFloatingPlacement } from '../shell/placement.js';
import { Panel } from '../ui/Panel.js';
import { PanelHost } from '../ui/PanelHost.js';

/**
 * The two ways the account panel says more than its line has room for, built
 * once here on the shared kit (docs/ARCHITECTURE.md §7, "The interface"):
 *
 * - `Question`, a question asked in place, in the panel: a re-scan, a
 *   disconnect, moving or discarding what a source never sent. Not modal, so
 *   the rest of the library stays usable; its buttons are one row at its end,
 *   Cancel first and the answer last, and the answer has the focus as it
 *   opens. Escape is Cancel, and is the question's alone: a sheet or a drawer
 *   the panel is in is not put away with it.
 * - `InfoSheet`, something said at length over the library — the devices on
 *   an account, how its syncing is going, what its provider keeps from the
 *   app — in the sheet or the drawer the frame places (`useFloatingPlacement`).
 */

interface Closing {
	readonly onClose: () => void;
	readonly busy: boolean;
}

const ClosingContext = createContext<Closing | undefined>(undefined);

/** Where the focus starts: the first field, else the answer, else whatever can take it. */
const firstOf = (element: HTMLElement): HTMLElement | null =>
	element.querySelector<HTMLElement>(
		'input:not(:disabled):not([type="hidden"]), [data-answer] button:not(:disabled)'
	) ?? element.querySelector<HTMLElement>('button:not(:disabled), a[href]');

/**
 * Typing somewhere else: a question that took a moment to come — a last push
 * to finish first — does not take the user out of a field they went to
 * meanwhile.
 */
const typingElsewhere = (element: HTMLElement): boolean => {
	const active = document.activeElement;
	return (
		active instanceof HTMLElement &&
		!element.contains(active) &&
		(active.matches('input, textarea, select') || active.isContentEditable)
	);
};

/**
 * A question asked in place. Each step of a question that has more than one is
 * drawn as a `Question` of its own, keyed by the step, so the next step's
 * answer takes the focus as the first one's did. Put away, it gives the focus
 * back to what had it as it opened, where the focus went with it: a menu's
 * `⋯`, the button that asked.
 *
 * `alertdialog` for a question that has to be answered before anything goes
 * on, as the editor's own delete question is (`TopBar`).
 */
export const Question = ({
	label,
	role = 'group',
	onClose,
	busy = false,
	returnFocus,
	className,
	children,
}: Readonly<{
	label: string;
	role?: 'group' | 'alertdialog';
	/** Escape, and the Cancel that starts the row. */
	onClose: () => void;
	/** Something is under way that Cancel would not stop: it waits, and Escape with it. */
	busy?: boolean;
	/**
	 * Where the focus goes back to, where that is not simply what had it as the
	 * question opened: in Safari a press on a button does not give it the focus.
	 */
	returnFocus?: RefObject<HTMLElement | null>;
	className?: string;
	children: ReactNode;
}>) => {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const element = ref.current;
		if (element === null) return undefined;
		const active = document.activeElement;
		const opener =
			returnFocus?.current ??
			(active instanceof HTMLElement && active !== document.body ? active : null);
		if (!typingElsewhere(element)) firstOf(element)?.focus();
		return () => {
			const now = document.activeElement;
			const lost = now === null || now === document.body;
			if (lost && opener?.isConnected === true) opener.focus();
		};
		// Once, as it opens: where it goes back to is where it came from.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// A listener rather than an `onKeyDown`: the group is not itself a control,
	// and its buttons are, and the key bubbles up from them.
	useEffect(() => {
		const element = ref.current;
		if (element === null) return undefined;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			if (!busy) onClose();
		};
		element.addEventListener('keydown', onKey);
		return () => element.removeEventListener('keydown', onKey);
	}, [onClose, busy]);

	return (
		<div
			ref={ref}
			role={role}
			aria-label={label}
			className={className === undefined ? 'question' : `question ${className}`}
		>
			<ClosingContext.Provider value={{ onClose, busy }}>{children}</ClosingContext.Provider>
		</div>
	);
};

/**
 * A question's buttons: one row at its end — Cancel and whatever else can be
 * done first, the answer last, where the focus starts. With nothing to put in
 * it, no row.
 */
export const QuestionActions = ({
	primary,
	children,
}: Readonly<{ primary?: ReactNode; children?: ReactNode }>) => {
	const closing = useContext(ClosingContext);
	return (
		<div className="question-actions">
			{closing !== undefined && (
				<button type="button" disabled={closing.busy} onClick={closing.onClose}>
					{t('common.cancel')}
				</button>
			)}
			{children}
			{primary !== undefined && (
				<span className="question-answer" data-answer="">
					{primary}
				</span>
			)}
		</div>
	);
};

/**
 * Something said at length, over the library: a titled panel in the sheet or
 * drawer the frame places, put away by its ✕, by Escape, or by a press beside
 * it, the focus going back to what opened it (`PanelHost`). `actions` are what
 * can be done about what it says, in a row at its end.
 */
export const InfoSheet = ({
	title,
	onClose,
	actions,
	children,
}: Readonly<{
	title: string;
	onClose: () => void;
	actions?: ReactNode;
	children: ReactNode;
}>) => {
	const placement = useFloatingPlacement();
	return (
		<PanelHost placement={placement} open onClose={onClose} label={title} side="end">
			<Panel title={title} onClose={onClose} className="info-sheet">
				{children}
				{actions !== undefined && <div className="question-actions">{actions}</div>}
			</Panel>
		</PanelHost>
	);
};
