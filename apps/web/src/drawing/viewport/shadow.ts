/**
 * The shadow root the viewport mounts the drawing's root in
 * (docs/ARCHITECTURE.md §7, "The editor"; §9), and the rules it holds.
 */

/**
 * The shadow root's own rules: the host fills the stage, and the drawing's
 * root fills the host, its own `width` and `height` attributes being
 * presentation, which these win over. The root alone, `:host > svg`: an `<svg>`
 * nested in the drawing keeps the size it gives itself. Never set on the root
 * itself: the document is not changed by being looked at (CLAUDE.md).
 */
const SHADOW_RULES =
	':host { display: block; width: 100%; height: 100%; } :host > svg { display: block; width: 100%; height: 100%; }';

/**
 * The rules, as one sheet every viewport's shadow adopts where the browser
 * has constructed stylesheets, and as a `<style>` of its own where it has not
 * (jsdom, which has no `adoptedStyleSheets`).
 */
const shadowSheet = (): CSSStyleSheet | undefined => {
	if (typeof CSSStyleSheet !== 'function' || !('replaceSync' in CSSStyleSheet.prototype)) {
		return undefined;
	}
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(SHADOW_RULES);
	return sheet;
};

const SHEET = shadowSheet();

/**
 * Where the drawing's root goes: a shadow root on the mount, made once, so the
 * drawing's own `<style>`, which the sanitizer keeps (docs/ARCHITECTURE.md
 * §9), applies to the drawing and to nothing of the app's — an inline SVG's
 * stylesheet is otherwise the whole page's, and could restyle the app or lay
 * a `position: fixed` element over it. Pointer events still reach the
 * viewport's handlers: they bubble out of the shadow, retargeted to the host.
 */
export const shadowOf = (host: HTMLElement): ShadowRoot => {
	if (host.shadowRoot !== null) return host.shadowRoot;
	const shadow = host.attachShadow({ mode: 'open' });
	if (SHEET !== undefined && 'adoptedStyleSheets' in shadow) {
		// eslint-disable-next-line functional/immutable-data -- a shadow root adopts sheets by assignment, as the DOM asks for it
		shadow.adoptedStyleSheets = [SHEET];
		return shadow;
	}
	const style = host.ownerDocument.createElement('style');
	style.append(SHADOW_RULES);
	shadow.appendChild(style);
	return shadow;
};
