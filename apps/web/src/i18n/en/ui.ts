/**
 * The shared components (docs/ARCHITECTURE.md §7, "The interface"): the few
 * words a panel, a sheet, a menu or a field says of itself, whatever it holds.
 * `{label}` is a control's name and `{shortcut}` its key, `{hex}` a color as
 * `#rrggbb`.
 */
export const ui = {
	/** A panel's close control. */
	closePanel: 'Close panel',
	/** A sheet's handle, for a screen reader: dragging it resizes the sheet, and dragging it down closes it. */
	sheetHandle: 'Drag to resize',
	/** A tool button's tooltip, when the tool has a key. */
	labelWithShortcut: '{label} ({shortcut})',
	/** The color field's text, where a color is typed as `#rrggbb`; `{label}` is the field's, "Fill" or "Stroke". */
	hex: '{label} (hex)',
	/** The color field's toggle for no color at all: no fill, no stroke. */
	none: 'None',
	/** The row of colors used lately. */
	recentColors: 'Recent colors',
	/** One of the colors used lately, named by its value. */
	recentColor: 'Use {hex}',
} as const;
