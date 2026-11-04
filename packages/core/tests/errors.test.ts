import { describe, expect, it } from 'vitest';

import { messageOf } from '../src/errors.js';

describe('messageOf', () => {
	it('is the message of an Error, and a string as it is', () => {
		expect(messageOf(new TypeError('bad'))).toBe('bad');
		expect(messageOf(new (class Custom extends Error {})('custom'))).toBe('custom');
		expect(messageOf('plain')).toBe('plain');
	});

	it('says what else was thrown, without throwing over it', () => {
		expect(messageOf(undefined)).toBe('');
		expect(messageOf(null)).toBe('');
		expect(messageOf(42)).toBe('number thrown');
		expect(messageOf({ code: 1 })).toBe('object thrown');
	});
});
