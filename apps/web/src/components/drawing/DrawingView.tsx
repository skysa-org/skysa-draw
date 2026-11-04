import { useEffect, useMemo } from 'react';

import { t } from '../../i18n/t.js';

/**
 * The SVG as an image: a `blob:` URL in an `<img>`, which the browser renders
 * with no script of the file's running and no reach into the page
 * (docs/ARCHITECTURE.md §7, "Still an image"; §9). The editor puts a drawing
 * into the DOM through a sanitizer so it can be worked on; this is how a file
 * the editor cannot open stays shown, as the browser draws it, and never
 * rewritten.
 */
const useObjectUrl = (text: string): string => {
	const url = useMemo(
		() => URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })),
		[text]
	);
	useEffect(
		() => () => {
			URL.revokeObjectURL(url);
		},
		[url]
	);
	return url;
};

export const DrawingView = ({ text, title }: { text: string; title: string }) => {
	const url = useObjectUrl(text);
	return (
		<div className="drawing-canvas">
			<img src={url} alt={t('drawings.preview', { title })} />
		</div>
	);
};
