import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digestJson } from "./dani-control-plane.ts";

export type MemoryKind = "profile" | "project" | "person" | "recap" | "fact" | "procedure";
/** user = derived personal memory; workflow = versioned procedural memory. Job state and live external state never live here. */
export type MemoryCategory = "user" | "workflow";
export type MemoryStatus = "active" | "superseded" | "retracted" | "expired";
export interface MemorySource { type: string; id: string; observedAt: string }
export interface MemoryWrite {
  ownerId: string; workspaceId?: string; kind: MemoryKind; key: string; value: unknown;
  source: MemorySource; confidence: number;
  category?: MemoryCategory; expiresAt?: string | null; freshForMs?: number | null;
}
export interface MemorySearchOptions { workspaceId?: string; limit?: number; now?: Date; includeStale?: boolean }
export interface MemoryHit { id: string; kind: MemoryKind; key: string; value: unknown; confidence: number; updated_at: string; stale: boolean; requiresRefresh: boolean; provenance: { source_type: string; source_id: string; observed_at: string }[] }

const DEFAULT_WORKSPACE = "default";
const now = () => new Date().toISOString();
const COLUMNS = "id,owner_id,workspace_id,kind,key,value,value_digest,confidence,category,status,version,source_observed_at,expires_at,fresh_for_ms,correction_of,created_at,updated_at";

export class MemorySidecar {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS memory_items(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL DEFAULT 'default',kind TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,value_digest TEXT NOT NULL,confidence REAL NOT NULL,category TEXT NOT NULL DEFAULT 'user',status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,source_observed_at TEXT,expires_at TEXT,fresh_for_ms INTEGER,correction_of TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_id,workspace_id,kind,key,value_digest));
      CREATE TABLE IF NOT EXISTS memory_provenance(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,source_type TEXT NOT NULL,source_id TEXT NOT NULL,observed_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(item_id,source_type,source_id));
      CREATE TABLE IF NOT EXISTS memory_history(id TEXT PRIMARY KEY,item_id TEXT,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,type TEXT NOT NULL,detail TEXT NOT NULL,at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(key,value,content='memory_items',content_rowid='rowid',tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_items BEGIN INSERT INTO memory_fts(rowid,key,value)VALUES(new.rowid,new.key,new.value);END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_items BEGIN INSERT INTO memory_fts(memory_fts,rowid,key,value)VALUES('delete',old.rowid,old.key,old.value);END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_items BEGIN INSERT INTO memory_fts(memory_fts,rowid,key,value)VALUES('delete',old.rowid,old.key,old.value);INSERT INTO memory_fts(rowid,key,value)VALUES(new.rowid,new.key,new.value);END;`);
    this.migrate();
  }
  /** Add lifecycle columns to databases created by the M0 skeleton. */
  private migrate() {
    const cols = (this.db.prepare("PRAGMA table_info(memory_items)").all() as { name: string }[]).map(c => c.name);
    const add = (name: string, ddl: string) => { if (!cols.includes(name)) this.db.exec(`ALTER TABLE memory_items ADD COLUMN ${ddl}`); };
    add("workspace_id", "workspace_id TEXT NOT NULL DEFAULT 'default'");
    add("category", "category TEXT NOT NULL DEFAULT 'user'");
    add("version", "version INTEGER NOT NULL DEFAULT 1");
    add("source_observed_at", "source_observed_at TEXT");
    add("expires_at", "expires_at TEXT");
    add("fresh_for_ms", "fresh_for_ms INTEGER");
    add("correction_of", "correction_of TEXT");
  }
  close() { this.db.close(); }

  private history(itemId: string | null, ownerId: string, workspaceId: string, type: string, detail: unknown) {
    this.db.prepare("INSERT INTO memory_history(id,item_id,owner_id,workspace_id,type,detail,at) VALUES(?,?,?,?,?,?,?)").run(randomUUID(), itemId, ownerId, workspaceId, type, JSON.stringify(detail), now());
  }
  private static assertSource(source: MemorySource) {
    if (!source || !source.type || !source.id || !source.observedAt || Number.isNaN(Date.parse(source.observedAt))) throw new Error("memory writes require a source with type, id and a valid observedAt");
  }
  private winner(ownerId: string, workspaceId: string, kind: string, key: string) {
    return this.db.prepare("SELECT * FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=? AND status='active' ORDER BY confidence DESC,updated_at DESC,rowid DESC LIMIT 1").get(ownerId, workspaceId, kind, key) as Record<string, unknown> | undefined;
  }

  write(input: MemoryWrite) {
    MemorySidecar.assertSource(input.source);
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE, category = input.category ?? "user", at = now(), id = randomUUID();
    const value = JSON.stringify(input.value), digest = digestJson(input.value);
    const version = category === "workflow"
      ? Number((this.db.prepare("SELECT MAX(version) v FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=?").get(input.ownerId, workspaceId, input.kind, input.key) as { v: number | null }).v ?? 0) + 1
      : 1;
    this.db.prepare(`INSERT OR IGNORE INTO memory_items(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.ownerId, workspaceId, input.kind, input.key, value, digest, input.confidence, category, "active", version, input.source.observedAt, input.expiresAt ?? null, input.freshForMs ?? null, null, at, at);
    const item = this.db.prepare("SELECT id FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=? AND value_digest=?").get(input.ownerId, workspaceId, input.kind, input.key, digest) as { id: string };
    this.db.prepare("INSERT OR IGNORE INTO memory_provenance VALUES(?,?,?,?,?,?)").run(randomUUID(), item.id, input.source.type, input.source.id, input.source.observedAt, at);
    this.history(item.id, input.ownerId, workspaceId, "write", { kind: input.kind, key: input.key, category, version, digest });
    this.reconcile(input.ownerId, workspaceId, input.kind, input.key);
    return item.id;
  }

  private reconcile(ownerId: string, workspaceId: string, kind: string, key: string) {
    // Workflow memory is versioned: the highest version always wins. User memory is
    // confidence-ordered; ties resolve to the most recent write (rowid is monotonic),
    // so equal-millisecond writes stay deterministic on every platform.
    const category = (this.db.prepare("SELECT category FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=? AND status='active' LIMIT 1").get(ownerId, workspaceId, kind, key) as { category: string } | undefined)?.category;
    const order = category === "workflow" ? "ORDER BY version DESC,updated_at DESC,rowid DESC" : "ORDER BY confidence DESC,updated_at DESC,rowid DESC";
    const rows = this.db.prepare(`SELECT id,confidence FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=? AND status='active' ${order}`).all(ownerId, workspaceId, kind, key) as { id: string; confidence: number }[];
    if (rows.length < 2) return;
    const winnerRow = rows[0]!;
    for (const row of rows.slice(1)) if (category === "workflow" || row.confidence <= winnerRow.confidence) this.db.prepare("UPDATE memory_items SET status='superseded',updated_at=? WHERE id=?").run(now(), row.id);
  }

  /** Explicit correction: supersedes every active value for the key regardless of confidence, keeps history. */
  correct(input: MemoryWrite) {
    MemorySidecar.assertSource(input.source);
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE, at = now(), id = randomUUID();
    const previous = this.winner(input.ownerId, workspaceId, input.kind, input.key);
    const value = JSON.stringify(input.value), digest = digestJson(input.value);
    this.db.prepare(`INSERT OR IGNORE INTO memory_items(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.ownerId, workspaceId, input.kind, input.key, value, digest, input.confidence, input.category ?? "user", "active", previous ? Number(previous.version) + 1 : 1, input.source.observedAt, input.expiresAt ?? null, input.freshForMs ?? null, previous ? String(previous.id) : null, at, at);
    const item = this.db.prepare("SELECT id FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=? AND value_digest=?").get(input.ownerId, workspaceId, input.kind, input.key, digest) as { id: string };
    this.db.prepare("INSERT OR IGNORE INTO memory_provenance VALUES(?,?,?,?,?,?)").run(randomUUID(), item.id, input.source.type, input.source.id, input.source.observedAt, at);
    for (const row of this.db.prepare("SELECT id FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=? AND status='active' AND id<>?").all(input.ownerId, workspaceId, input.kind, input.key, item.id) as { id: string }[]) {
      this.db.prepare("UPDATE memory_items SET status='superseded',updated_at=? WHERE id=?").run(at, row.id);
      this.history(row.id, input.ownerId, workspaceId, "correction", { supersededBy: item.id, kind: input.kind, key: input.key });
    }
    this.history(item.id, input.ownerId, workspaceId, "correction", { corrects: previous ? String(previous.id) : null, kind: input.kind, key: input.key });
    return item.id;
  }

  /** Retract everything derived from one source; restores the best surviving value for each affected key. */
  retractSource(ownerId: string, source: { type: string; id: string }) {
    const items = this.db.prepare("SELECT m.id,m.workspace_id,m.kind,m.key FROM memory_items m JOIN memory_provenance p ON p.item_id=m.id WHERE m.owner_id=? AND p.source_type=? AND p.source_id=? AND m.status IN ('active','superseded')").all(ownerId, source.type, source.id) as { id: string; workspace_id: string; kind: string; key: string }[];
    const keys = new Set<string>();
    for (const item of items) {
      this.db.prepare("UPDATE memory_items SET status='retracted',updated_at=? WHERE id=?").run(now(), item.id);
      this.history(item.id, ownerId, item.workspace_id, "retraction", { source, kind: item.kind, key: item.key });
      keys.add(JSON.stringify([item.workspace_id, item.kind, item.key]));
    }
    for (const compound of keys) {
      const [workspaceId, kind, key] = JSON.parse(compound) as [string, string, string];
      const active = this.winner(ownerId, workspaceId, kind, key);
      if (active) continue;
      const restore = this.db.prepare("SELECT id FROM memory_items WHERE owner_id=? AND workspace_id=? AND kind=? AND key=? AND status='superseded' ORDER BY confidence DESC,updated_at DESC,rowid DESC LIMIT 1").get(ownerId, workspaceId, kind, key) as { id: string } | undefined;
      if (restore) {
        this.db.prepare("UPDATE memory_items SET status='active',updated_at=? WHERE id=?").run(now(), restore.id);
        this.history(restore.id, ownerId, workspaceId, "restore", { afterRetractionOf: source, kind, key });
      }
    }
    return items.length;
  }

  /** Targeted forget: hard-deletes items, provenance (cascade) and FTS rows (trigger). No value is retained in history. */
  forget(filter: { ownerId: string; workspaceId?: string; kind?: MemoryKind; key?: string }) {
    const clauses = ["owner_id=?"], args: unknown[] = [filter.ownerId];
    if (filter.workspaceId) { clauses.push("workspace_id=?"); args.push(filter.workspaceId); }
    if (filter.kind) { clauses.push("kind=?"); args.push(filter.kind); }
    if (filter.key) { clauses.push("key=?"); args.push(filter.key); }
    const where = clauses.join(" AND ");
    const rows = this.db.prepare(`SELECT id,workspace_id,kind,key FROM memory_items WHERE ${where}`).all(...args as string[]) as { id: string; workspace_id: string; kind: string; key: string }[];
    for (const row of rows) {
      this.db.prepare("DELETE FROM memory_items WHERE id=?").run(row.id);
      this.history(null, filter.ownerId, row.workspace_id, "forget", { kind: row.kind, key: row.key, itemId: row.id });
    }
    return rows.length;
  }
  forgetOwner(ownerId: string) {
    const count = Number((this.db.prepare("SELECT COUNT(*) c FROM memory_items WHERE owner_id=?").get(ownerId) as { c: number }).c);
    this.db.prepare("DELETE FROM memory_items WHERE owner_id=?").run(ownerId);
    this.history(null, ownerId, "*", "forget", { ownerWide: true, count });
    return count;
  }

  /** Retention sweep: active items past expiresAt become expired and leave search results. */
  sweepExpired(at = now()) {
    const rows = this.db.prepare("SELECT id,owner_id,workspace_id,kind,key FROM memory_items WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?").all(at) as { id: string; owner_id: string; workspace_id: string; kind: string; key: string }[];
    for (const row of rows) {
      this.db.prepare("UPDATE memory_items SET status='expired',updated_at=? WHERE id=?").run(at, row.id);
      this.history(row.id, row.owner_id, row.workspace_id, "expire", { kind: row.kind, key: row.key });
    }
    return rows.length;
  }

  private isStale(row: Record<string, unknown>, at: Date) {
    const iso = at.toISOString();
    if (row.expires_at && String(row.expires_at) <= iso) return true;
    if (row.fresh_for_ms != null && row.source_observed_at) return Date.parse(String(row.source_observed_at)) + Number(row.fresh_for_ms) <= at.getTime();
    return false;
  }

  search(ownerId: string, query: string, opts: number | MemorySearchOptions = {}): MemoryHit[] {
    const options: MemorySearchOptions = typeof opts === "number" ? { limit: opts } : opts;
    const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE, at = options.now ?? new Date(), limit = Math.min(options.limit ?? 8, 20);
    const tokens = query.trim().split(/\s+/).filter(Boolean).map(x => `"${x.replaceAll('"', '')}"`).join(" OR ");
    if (!tokens) return [];
    const rows = this.db.prepare(`SELECT m.id,m.kind,m.key,m.value,m.confidence,m.updated_at,m.expires_at,m.fresh_for_ms,m.source_observed_at,bm25(memory_fts) rank FROM memory_fts JOIN memory_items m ON m.rowid=memory_fts.rowid WHERE memory_fts MATCH ? AND m.owner_id=? AND m.workspace_id=? AND m.status='active' ORDER BY rank,m.confidence DESC,m.updated_at DESC,m.rowid DESC LIMIT ?`).all(tokens, ownerId, workspaceId, limit * 2) as Record<string, unknown>[];
    const out: MemoryHit[] = [];
    for (const r of rows) {
      const stale = this.isStale(r, at);
      if (stale && options.includeStale === false) continue;
      out.push({ id: String(r.id), kind: r.kind as MemoryKind, key: String(r.key), value: JSON.parse(String(r.value)), confidence: Number(r.confidence), updated_at: String(r.updated_at), stale, requiresRefresh: stale, provenance: this.db.prepare("SELECT source_type,source_id,observed_at FROM memory_provenance WHERE item_id=?").all(String(r.id)) as MemoryHit["provenance"] });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Current-state reads: stale memory may orient, but only fresh memory satisfies; otherwise callers must re-fetch. */
  current(ownerId: string, key: string, opts: { workspaceId?: string; kind?: MemoryKind; now?: Date } = {}) {
    const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE, at = opts.now ?? new Date();
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE owner_id=? AND workspace_id=? AND key=? AND status='active'${opts.kind ? " AND kind=?" : ""} ORDER BY confidence DESC,updated_at DESC,rowid DESC`).all(...(opts.kind ? [ownerId, workspaceId, key, opts.kind] : [ownerId, workspaceId, key])) as Record<string, unknown>[];
    for (const row of rows) if (!this.isStale(row, at)) return { status: "fresh" as const, item: { id: String(row.id), value: JSON.parse(String(row.value)), confidence: Number(row.confidence), sourceObservedAt: row.source_observed_at ? String(row.source_observed_at) : null } };
    const stalest = rows[0];
    if (stalest) return { status: "stale" as const, requiresRefresh: true as const, staleItem: { id: String(stalest.id), value: JSON.parse(String(stalest.value)), sourceObservedAt: stalest.source_observed_at ? String(stalest.source_observed_at) : null } };
    return { status: "missing" as const };
  }

  context(ownerId: string, query: string, maxChars = 4000, opts: MemorySearchOptions = {}) {
    const results = this.search(ownerId, query, opts);
    const out: string[] = [];
    let used = 0;
    for (const r of results) {
      const line = `[${r.kind}:${r.key}] ${JSON.stringify(r.value)} (sources: ${r.provenance.map(p => `${p.source_type}:${p.source_id}`).join(", ")}${r.stale ? ", STALE - re-fetch before use" : ""})`;
      if (used + line.length > maxChars) break;
      out.push(line); used += line.length;
    }
    return out.join("\n");
  }

  historyOf(itemId: string) {
    return this.db.prepare("SELECT type,detail,at FROM memory_history WHERE item_id=? ORDER BY at").all(itemId).map((r: any) => ({ ...r, detail: JSON.parse(r.detail) }));
  }
}
