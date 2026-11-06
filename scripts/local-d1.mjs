import { DatabaseSync } from 'node:sqlite';

function values(args) { return args.map(value => typeof value === 'boolean' ? Number(value) : value === undefined ? null : value); }
function result(results, started, changes = 0, lastRowId = 0) {
  return { results, success: true, meta: { duration: Date.now() - started, changes: Number(changes), last_row_id: Number(lastRowId), rows_read: results.length, rows_written: Number(changes) } };
}

export function openLocalD1(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  class Statement {
    constructor(sql, bindings = []) { this.sql = sql; this.bindings = bindings; }
    bind(...bindings) { return new Statement(this.sql, values(bindings)); }
    _all() { return sqlite.prepare(this.sql).all(...this.bindings).map(row => ({ ...row })); }
    _run() { return sqlite.prepare(this.sql).run(...this.bindings); }
    async all() { const started = Date.now(); return result(this._all(), started); }
    async first(column) { const row = sqlite.prepare(this.sql).get(...this.bindings); return row == null ? null : column ? row[column] : { ...row }; }
    async raw({ columnNames = false } = {}) { const stmt = sqlite.prepare(this.sql); stmt.setReturnArrays(true); const rows = stmt.all(...this.bindings); return columnNames ? [stmt.columns().map(column => column.name), ...rows] : rows; }
    async run() { const started = Date.now(); const info = this._run(); return result([], started, info.changes, info.lastInsertRowid); }
  }
  return {
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const rows = statements.map(statement => {
          const started = Date.now();
          const stmt = sqlite.prepare(statement.sql);
          if (stmt.columns().length) return result(stmt.all(...statement.bindings).map(row => ({ ...row })), started);
          const info = stmt.run(...statement.bindings);
          return result([], started, info.changes, info.lastInsertRowid);
        });
        sqlite.exec('COMMIT'); return rows;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    async exec(sql) { const started = Date.now(); sqlite.exec(sql); return { count: 1, duration: Date.now() - started }; },
    close() { sqlite.close(); }
  };
}
