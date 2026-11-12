/**
 * Minimal in-memory stand-in for Cloudflare D1, built on node:sqlite.
 * Covers only what worker/db.ts uses: prepare().bind().first()/all()/run() and batch().
 */
import { DatabaseSync } from 'node:sqlite';

type Param = string | number | null;

export function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON'); // D1 enforces foreign keys too.

  class Statement {
    sql: string;
    params: Param[];
    constructor(sql: string, params: Param[] = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params: Param[]) {
      for (const p of params) if (p === undefined) throw new Error('D1_TYPE_ERROR: undefined bound');
      return new Statement(this.sql, params);
    }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
      if (!row) return null;
      return column ? row[column] : { ...row };
    }
    async all() {
      const rows = sqlite.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
      return { results: rows.map((r) => ({ ...r })), success: true, meta: {} };
    }
    async run() {
      const r = sqlite.prepare(this.sql).run(...this.params);
      return { results: [], success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
    }
  }

  return {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;
}
