import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, parse, resolve, join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { KindSchema, RecordSchema, type Kind, type PurchaseRecord } from './domain.js';

const identity = z.string().min(1).max(160);
const ListOptions = z.object({ query: z.string().max(500).optional(), status: z.string().max(160).optional(),
  orderId: identity.optional(), limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0) }).strict();
type Options = { query?: string; status?: string; orderId?: string; limit?: number; offset?: number };
type Row = { payload: string; hash: string; observed_at: string; imported_at: string };
function fail(code: string): never { throw new Error(code); }
function checked<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('INVALID_INPUT');
  return parsed.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function rejectSymlinks(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const segment of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, segment);
    try { if (lstatSync(current).isSymbolicLink()) fail('UNSAFE_DATABASE_PATH'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export class PurchaseStore {
  private db: DatabaseSync;
  constructor(path: string) {
    try {
      if (typeof path !== 'string' || !isAbsolute(path)) fail('UNSAFE_DATABASE_PATH');
      const fullPath = resolve(path);
      rejectSymlinks(fullPath);
      mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 });
      rejectSymlinks(fullPath);
      // Never change permissions on a pre-existing user/shared folder.
      if ((lstatSync(dirname(fullPath)).mode & 0o077) !== 0) fail('UNSAFE_DATABASE_DIRECTORY');
      try {
        const fd = openSync(fullPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        closeSync(fd);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!lstatSync(fullPath).isFile() || lstatSync(fullPath).isSymbolicLink()) fail('UNSAFE_DATABASE_PATH');
      chmodSync(fullPath, 0o600);
      this.db = new DatabaseSync(fullPath);
      this.db.function('contains_text', (payload, needle) =>
        String(payload).toLowerCase().includes(String(needle).toLowerCase()) ? 1 : 0);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS records (
          kind TEXT NOT NULL, id TEXT NOT NULL, observed_at TEXT NOT NULL,
          imported_at TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS history (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
          observed_at TEXT NOT NULL, imported_at TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS history_identity ON history(kind,id,seq);`);
    } catch { fail('DATABASE_OPEN_FAILED'); }
  }

  importRecords(records: PurchaseRecord[]): { inserted: number; updated: number; unchanged: number } {
    const validated = checked(z.array(RecordSchema).min(1).max(1000), records);
    // Limit total encoded size as well as per-field size, before entering SQLite.
    const snapshots = validated.map(record => ({ record, payload: canonical(record) }));
    if (snapshots.reduce((sum, snapshot) => sum + Buffer.byteLength(snapshot.payload), 0) > 20_000_000) fail('IMPORT_TOO_LARGE');
    const keys = new Set<string>();
    for (const { record } of snapshots) {
      const key = JSON.stringify([record.kind, record.id]);
      if (keys.has(key)) fail('DUPLICATE_RECORD');
      keys.add(key);
    }
    const result = { inserted: 0, updated: 0, unchanged: 0 };
    let begun = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); begun = true;
      const importedAt = new Date().toISOString();
      for (const { record, payload } of snapshots) {
        const hash = createHash('sha256').update(payload).digest('hex');
        const previous = this.db.prepare('SELECT * FROM records WHERE kind=? AND id=?').get(record.kind, record.id) as Row | undefined;
        if (previous?.hash === hash) { result.unchanged++; continue; }
        if (previous && Date.parse(previous.observed_at) >= Date.parse(record.observedAt)) fail('SNAPSHOT_CONFLICT');
        if(previous) {
          const old=JSON.parse(previous.payload) as PurchaseRecord;
          if(old.kind==='chat' && record.kind==='chat') {
            const known=new Set(record.messages.map(m=>m.id));
            if(old.messages.some(m=>!known.has(m.id))) fail('INCOMPLETE_SNAPSHOT');
          }
          if(old.kind==='shipment' && record.kind==='shipment') {
            const known=new Set(record.events.map(canonical));
            if(old.events.some(event=>!known.has(canonical(event)))) fail('INCOMPLETE_SNAPSHOT');
          }
        }
        this.db.prepare(`INSERT INTO records(kind,id,observed_at,imported_at,hash,payload) VALUES(?,?,?,?,?,?)
          ON CONFLICT(kind,id) DO UPDATE SET observed_at=excluded.observed_at,imported_at=excluded.imported_at,
          hash=excluded.hash,payload=excluded.payload`).run(record.kind, record.id, record.observedAt, importedAt, hash, payload);
        this.db.prepare('INSERT INTO history(kind,id,observed_at,imported_at,hash,payload) VALUES(?,?,?,?,?,?)')
          .run(record.kind, record.id, record.observedAt, importedAt, hash, payload);
        if (previous) result.updated++; else result.inserted++;
      }
      this.db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      if (begun) { try { this.db.exec('ROLLBACK'); } catch { /* Preserve safe generic error. */ } }
      if (error instanceof Error && error.message === 'SNAPSHOT_CONFLICT') throw error;
      fail('IMPORT_FAILED');
    }
  }

  list(kind: Kind, options: Options = {}): { records: PurchaseRecord[]; total: number; limit: number; offset: number } {
    checked(KindSchema, kind); const parsed = checked(ListOptions, options);
    try {
      const filters=['kind=?'];
      const params:Array<string|number>=[kind];
      if(parsed.status!==undefined) {filters.push("json_extract(payload,'$.status')=?");params.push(parsed.status);}
      if(parsed.orderId!==undefined) {
        filters.push(kind==='order'?"id=?":"json_extract(payload,'$.orderId')=?");params.push(parsed.orderId);
      }
      if(parsed.query!==undefined) {filters.push('contains_text(payload,?)=1');params.push(parsed.query);}
      const where=filters.join(' AND ');
      const total=(this.db.prepare(`SELECT COUNT(*) AS total FROM records WHERE ${where}`).get(...params) as {total:number}).total;
      const rows=this.db.prepare(`SELECT payload FROM records WHERE ${where} ORDER BY julianday(observed_at) DESC,id ASC LIMIT ? OFFSET ?`)
        .all(...params,parsed.limit,parsed.offset) as Array<{payload:string}>;
      return {records:rows.map(row=>JSON.parse(row.payload) as PurchaseRecord),total,limit:parsed.limit,offset:parsed.offset};
    } catch { fail('READ_FAILED'); }
  }

  get(kind: Kind, id: string): PurchaseRecord | undefined {
    checked(KindSchema, kind); checked(identity, id);
    try {
      const row = this.db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id) as { payload: string } | undefined;
      return row ? JSON.parse(row.payload) as PurchaseRecord : undefined;
    } catch { fail('READ_FAILED'); }
  }

  history(kind: Kind, id: string, limit = 20): Array<{ observedAt: string; importedAt: string; hash: string; record: PurchaseRecord }> {
    checked(KindSchema, kind); checked(identity, id); checked(z.number().int().min(1).max(100), limit);
    try {
      const rows = this.db.prepare('SELECT * FROM history WHERE kind=? AND id=? ORDER BY seq DESC LIMIT ?').all(kind, id, limit) as Row[];
      return rows.map(row => ({ observedAt: row.observed_at, importedAt: row.imported_at, hash: row.hash, record: JSON.parse(row.payload) as PurchaseRecord }));
    } catch { fail('READ_FAILED'); }
  }

  stats(): { counts: Record<Kind, number>; lastImportedAt: string | null } {
    try {
      const counts: Record<Kind, number> = { order: 0, shipment: 0, transaction: 0, chat: 0, product: 0 };
      for (const row of this.db.prepare('SELECT kind,COUNT(*) AS count FROM records GROUP BY kind').all() as Array<{ kind: Kind; count: number }>) counts[row.kind] = row.count;
      const latest = this.db.prepare('SELECT MAX(imported_at) AS latest FROM history').get() as { latest: string | null };
      return { counts, lastImportedAt: latest.latest };
    } catch { fail('READ_FAILED'); }
  }
  close(): void { try { this.db.close(); } catch { fail('DATABASE_CLOSE_FAILED'); } }
}
