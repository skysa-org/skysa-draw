import { documentNames } from '@skysa/storage';

import { DRAWING_EXTENSION } from '../config.js';

/**
 * This app's documents' names: a drawing's ends `.svg` (`DRAW_FORMAT`), and a
 * copy of one keeps it. For the app's own code; the engine and the providers
 * are handed the format and ask it instead (skysa-notes' record 0018).
 */
export const { isDocumentName: isDrawingName, conflictPath } = documentNames(DRAWING_EXTENSION);
