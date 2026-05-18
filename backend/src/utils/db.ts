import path from "path";
import fs from "fs/promises";
import bcrypt from "bcryptjs";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { logger } from "./logger";

type QueryResult<T = any> = { rows: T[] };

const jsonColumns = new Set([
  "urls",
  "scan_options",
  "auth_config",
  "selectors",
  "depths",
  "wcag_criteria",
  "act_rules",
  "tags",
  "steps",
  "a11y_tree"
]);

const booleanColumns = new Set(["is_active", "is_resolved", "false_positive"]);

function sqlitePath(): string {
  const configured = process.env.SQLITE_PATH || process.env.DATABASE_URL || "data/accessibility.sqlite";
  if (configured.startsWith("sqlite://")) {
    return configured.slice("sqlite://".length);
  }
  return configured;
}

function normalizeValue(value: any): any {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}

function hydrateRow(row: any): any {
  for (const key of Object.keys(row)) {
    if (key === "COUNT(*)") {
      row.count = row[key];
    }
    if (booleanColumns.has(key)) {
      row[key] = Boolean(row[key]);
    }
    if (jsonColumns.has(key) && typeof row[key] === "string" && row[key].length) {
      try {
        row[key] = JSON.parse(row[key]);
      } catch {
        // Keep legacy plain-text values as-is.
      }
    }
  }
  return row;
}

function toSqlite(sql: string, params: any[] = []): { sql: string; params: any[] } {
  const orderedParams: any[] = [];
  let converted = sql
    .replace(/NOW\(\)\s*\+\s*INTERVAL\s+'7 days'/gi, "datetime('now', '+7 days')")
    .replace(/NOW\(\)/gi, "datetime('now')");

  converted = converted.replace(/\$(\d+)/g, (_match, index) => {
    orderedParams.push(normalizeValue(params[Number(index) - 1]));
    return "?";
  });

  return {
    sql: converted,
    params: orderedParams.length ? orderedParams : params.map(normalizeValue)
  };
}

class SqlitePool {
  private connection?: Database;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const dbFile = path.resolve(process.cwd(), sqlitePath());
    await fs.mkdir(path.dirname(dbFile), { recursive: true });

    this.connection = await open({
      filename: dbFile,
      driver: sqlite3.Database
    });

    await this.connection.exec("PRAGMA foreign_keys = ON;");
    const schema = await fs.readFile(path.resolve(process.cwd(), "migrations", "init.sqlite.sql"), "utf8");
    await this.connection.exec(schema);
    await this.ensureIssueEvidenceColumns();
    await this.ensureAuditEventsTable();
    await this.ensureDefaultAdmin();
    await this.ensureDefaultUsers();

    logger.info(`SQLite database ready at ${dbFile}`);
  }

  private async ensureIssueEvidenceColumns(): Promise<void> {
    const columns = await this.connection!.all("PRAGMA table_info(issues)");
    const existing = new Set(columns.map((column: any) => column.name));
    if (!existing.has("evidence_screenshot")) {
      await this.connection!.exec("ALTER TABLE issues ADD COLUMN evidence_screenshot TEXT;");
    }
    if (!existing.has("evidence_explanation")) {
      await this.connection!.exec("ALTER TABLE issues ADD COLUMN evidence_explanation TEXT;");
    }
  }

  private async ensureAuditEventsTable(): Promise<void> {
    await this.connection!.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))),
        actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        action      TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id   TEXT,
        entity_name TEXT,
        metadata    TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
    `);
  }

  private async ensureDefaultAdmin(): Promise<void> {
    const email = process.env.DEFAULT_ADMIN_EMAIL || "admin@axessia.local";
    const password = process.env.DEFAULT_ADMIN_PASSWORD || "Admin@123";
    const hash = await bcrypt.hash(password, 12);

    await this.connection!.run(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, 'admin', 1)
       ON CONFLICT(email) DO UPDATE SET
         password_hash = excluded.password_hash,
         role = 'admin',
         is_active = 1,
         updated_at = datetime('now')`,
      [email, hash, "System Administrator"]
    );
  }

  private async ensureDefaultUsers(): Promise<void> {
    const password = "Accessibility";
    const hash = await bcrypt.hash(password, 12);
    for (let index = 1; index <= 5; index++) {
      const username = `user${index}`;
      await this.connection!.run(
        `INSERT INTO users (email, password_hash, full_name, role, is_active)
         VALUES (?, ?, ?, 'analyst', 1)
         ON CONFLICT(email) DO UPDATE SET
           password_hash = excluded.password_hash,
           full_name = excluded.full_name,
           role = 'analyst',
           is_active = 1,
           updated_at = datetime('now')`,
        [username, hash, `User ${index}`]
      );
    }
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    await this.ready;
    const query = toSqlite(sql, params);
    const returnsRows = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(query.sql) || /\bRETURNING\b/i.test(query.sql);

    if (returnsRows) {
      const rows = await this.connection!.all(query.sql, query.params);
      return { rows: rows.map(hydrateRow) as T[] };
    }

    await this.connection!.run(query.sql, query.params);
    return { rows: [] };
  }
}

export const db = new SqlitePool();
