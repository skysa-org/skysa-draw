import { answer, type DigestRequest } from './digestAnswer.js';

/**
 * The worker a drawing's text is digested in (`./digest.ts` starts it, once,
 * and keeps it): a request for each text, and a reply for each, carrying the
 * request's id, since the page can have several waiting at once.
 */
self.addEventListener('message', (event: MessageEvent<DigestRequest>) => {
	void answer(event.data).then((reply) => {
		self.postMessage(reply);
	});
});
