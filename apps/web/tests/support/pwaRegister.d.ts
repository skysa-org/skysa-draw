/**
 * vite-plugin-pwa's registration, the file behind `virtual:pwa-register`,
 * which ships no types of its own. Imported as it is, its placeholders not
 * filled in, it registers in prompt mode, as this app's build does.
 */
declare module 'vite-plugin-pwa/dist/client/build/register.js' {
	export const registerSW: (options?: {
		immediate?: boolean;
		onNeedRefresh?: () => void;
		onNeedReload?: () => void;
	}) => (reloadPage?: boolean) => Promise<void>;
}
