import { createPortal } from 'react-dom';

import { t } from '../../i18n/t.js';
import type { AccountSlot } from '../sources/SourcePanel.js';
import { IconButton } from '../ui/IconButton.js';
import { MoreIcon } from '../ui/icons.js';
import { Menu, type MenuItem } from '../ui/Menu.js';

/**
 * The panel's actions as one `⋯` menu, drawn into the end of the showing
 * source's row as every other source's is drawn into its own (`SourcePanel`).
 * There with nothing in it too, unavailable, so the rows keep their shape from
 * source to source. First, as a folder's menu would have it: what the source
 * is called, then what can be done with it.
 *
 * A panel drawn with no sources above it — on its own, as a test draws it —
 * has no row to put the menu in, and it goes where the panel is instead,
 * named by the panel's own name for the source.
 */
export const ActionsMenu = ({
	slot,
	name,
	items,
}: Readonly<{ slot: AccountSlot | undefined; name: string; items: readonly MenuItem[] }>) => {
	const onRename = slot?.onRename;
	const all =
		onRename === undefined
			? items
			: [{ id: 'rename', label: t('account.menu.rename'), onSelect: onRename }, ...items];
	const label = t('account.menu.sourceLabel', { name: slot?.name ?? name });
	const menu =
		all.length === 0 ? (
			<IconButton icon={<MoreIcon />} label={label} onClick={() => undefined} disabled />
		) : (
			<Menu label={label} icon={<MoreIcon />} items={all} align="end" />
		);
	if (slot === undefined) return <div className="account-menu">{menu}</div>;
	return slot.menuIn === null ? null : createPortal(menu, slot.menuIn);
};
