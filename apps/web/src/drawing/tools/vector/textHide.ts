import { cell } from '@skysa/storage';

/**
 * The text a field is open on, hidden while it is (`text.ts`): the field is
 * drawn over it in the words being typed, and the old words would show
 * through around them. The drawing is not touched, since its text is
 * serialized from the live root, and a save, an undo or a redo while the
 * field is open would keep whatever the root held then. It is hidden by a
 * rule outside it instead, as the hole a move leaves is (`raster/hole.ts`):
 * a `<style>` beside the root in the viewport's shadow root, which styles the
 * drawing (docs/ARCHITECTURE.md §7, "The editor") and which the file never
 * holds. The rule names the element by its layer's id and its place under
 * it, child by child, and hides it and what it holds by `visibility`, which
 * keeps its box for a tool to measure, as `display` would not. The caller
 * says again what to hide after each change of the document, which may move
 * the element or put a copy in its place. Where the root leaves the shadow
 * root, as it does when the drawing is closed or another is opened in the
 * same viewport, the rule goes, and the caller is told. Where the root is
 * not in a shadow root, as in a test that does not mount it, nothing is
 * hidden.
 */

/** Marks the `<style>` that hides the text being edited, for a test to find and nothing else. */
export const HIDDEN_TEXT_MARK = 'data-draw-text-hidden';

/** An element to hide, and the layer it is in, or is. */
export type Edited = Readonly<{ layer: Element; element: Element }>;

export type HiddenText = Readonly<{
	/** `edited` hidden, in place of what was; nothing, for none. */
	hide: (edited: Edited | undefined) => void;
	/** The rule taken away, and the watch on the root with it. */
	remove: () => void;
}>;

const NOTHING_HIDDEN: HiddenText = { hide: () => undefined, remove: () => undefined };

/** A value as a CSS string, for an attribute selector: escaped by `CSS.escape` where the platform has it, as jsdom does not. */
const quoted = (value: string): string => {
	const css = (globalThis as { CSS?: { escape?: (ident: string) => string } }).CSS;
	const escaped = css?.escape?.(value) ?? value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ');
	return `"${escaped}"`;
};

/**
 * Where `element` is under `layer`, a step for each level down: its place
 * among its parent's children, from 1, as `:nth-child` counts; none for an
 * element not under it.
 */
const stepsDown = (layer: Element, element: Element): readonly number[] | undefined => {
	if (element === layer) return [];
	const parent = element.parentElement;
	const above = parent === null ? undefined : stepsDown(layer, parent);
	return parent === null || above === undefined
		? undefined
		: [...above, [...parent.children].indexOf(element) + 1];
};

/** The rule that hides the element and everything it holds; none for no element, or a layer with no id. */
const hidingRule = (edited: Edited | undefined): string => {
	const id = edited?.layer.getAttribute('id') ?? '';
	const steps = edited === undefined ? undefined : stepsDown(edited.layer, edited.element);
	if (id === '' || steps === undefined) return '';
	const selector = [`[id=${quoted(id)}]`, ...steps.map((step) => `:nth-child(${step})`)].join(
		' > '
	);
	return `${selector}, ${selector} * { visibility: hidden !important; }`;
};

/** A rule beside `root` that hides what it is told to, until `remove`; `gone` told once the root has left its shadow root. */
export const hideText = (root: SVGSVGElement, gone: () => void): HiddenText => {
	const parent = root.parentNode;
	if (!(parent instanceof ShadowRoot)) return NOTHING_HIDDEN;
	const style = parent.ownerDocument.createElement('style');
	style.setAttribute(HIDDEN_TEXT_MARK, '');
	const shown = cell('');
	const removed = cell(false);
	const hide = (edited: Edited | undefined): void => {
		const rule = root.parentNode === parent && !removed.current ? hidingRule(edited) : '';
		if (rule === shown.current) return;
		shown.current = rule;
		if (rule === '') {
			style.remove();
			return;
		}
		style.replaceChildren(rule);
		if (style.parentNode !== parent) parent.insertBefore(style, root);
	};
	const release = (watch: MutationObserver): void => {
		removed.current = true;
		watch.disconnect();
		style.remove();
	};
	const watch = new MutationObserver((_, observer) => {
		if (root.parentNode === parent) return;
		release(observer);
		gone();
	});
	watch.observe(parent, { childList: true });
	return { hide, remove: () => release(watch) };
};
