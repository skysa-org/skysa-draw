import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

/**
 * Migrations run once, in order, against whatever a deployment already holds —
 * and a migration that fails half way is worse than one that never ran, because
 * `wrangler d1 migrations apply` has no rollback and the next attempt starts
 * from the wreckage. One file so far, written by `drizzle-kit generate` from
 * `src/db/schema.ts`; CI checks that the two still agree.
 */

const DIR = new URL('../migrations/', import.meta.url).pathname;

const files = (): string[] =>
	readdirSync(DIR)
		.filter((name) => name.endsWith('.sql'))
		.sort();

const statements = (name: string): string[] =>
	readFileSync(join(DIR, name), 'utf8')
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => statement !== '');

const open = (): DatabaseSync => {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	for (const name of files()) {
		for (const statement of statements(name)) db.exec(statement);
	}
	return db;
};

const tables = (db: DatabaseSync): string[] =>
	(
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
			name: string;
		}[]
	).map((row) => row.name);

describe('the migrations', () => {
	it('start at 0000 and apply cleanly from empty, in order', () => {
		expect(files()[0]).toMatch(/^0000_/);
		expect(open).not.toThrow();
	});

	it('make the two tables the schema has, and nothing carried over from skysa-notes', () => {
		// A connection and a device's grant on it: no users, no identities, no
		// sessions (docs/decisions/0002-carried-over-from-skysa-notes.md). A table
		// nothing reads, holding live refresh tokens, is the worst of both.
		expect(tables(open())).toEqual(['grants', 'storage_connections']);
	});

	it('separate every statement, so wrangler can stop at the one that failed', () => {
		for (const name of files()) {
			for (const statement of statements(name)) {
				expect(statement.match(/;/g) ?? [], `${name}: ${statement}`).toHaveLength(
					statement.endsWith(';') ? 1 : 0
				);
			}
		}
	});

	it('leave a grant unreachable, but still there, once its connection goes', () => {
		const db = open();
		db.prepare(
			'INSERT INTO storage_connections (id, provider, account_id, display_name, secret_ciphertext, secret_iv, secret_key_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
		).run('c', 'dropbox', 'dbid:1', 'x', 'c', 'i', 'k1');
		db.prepare(
			'INSERT INTO grants (id, connection_id, secret_hash, created_at, last_used_at) VALUES (?, ?, ?, 0, 0)'
		).run('g', 'c', 'h');

		db.prepare('DELETE FROM storage_connections WHERE id = ?').run('c');

		// The DDL has to be `ON DELETE set null`: a cascade would delete the row
		// and free its hash for anyone holding a copy of the credential to claim
		// again (`grants` in src/db/schema.ts).
		expect(db.prepare('SELECT id, connection_id FROM grants').all()).toEqual([
			{ id: 'g', connection_id: null },
		]);
	});
});
