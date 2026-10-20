import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseStore } from '../src/store.js';
import { RecordSchema } from '../src/domain.js';

const order = (id = 'order-1', observedAt = '2026-01-01T00:00:00Z') => RecordSchema.parse({
  kind: 'order', id, observedAt, status: 'paid', totalIdr: 10000,
  items: [{ title: 'Synthetic item', quantity: 1, unitPriceIdr: 10000 }],
});
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tokopedia-store-'));
  const path = join(dir, 'private', 'purchases.sqlite');
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('import is idempotent, updates append history, persistence and filters work', () => {
  const f = fixture();
  let store = new PurchaseStore(f.path);
  try {
    assert.deepEqual(store.importRecords([order()]), { inserted: 1, updated: 0, unchanged: 0 });
    assert.deepEqual(store.importRecords([order()]), { inserted: 0, updated: 0, unchanged: 1 });
    const reversed = Object.fromEntries(Object.entries(order()).reverse());
    assert.deepEqual(store.importRecords([reversed as ReturnType<typeof order>]), { inserted: 0, updated: 0, unchanged: 1 });
    const next = { ...order('order-1', '2026-01-02T00:00:00+00:00'), status: 'delivered' };
    assert.deepEqual(store.importRecords([next]), { inserted: 0, updated: 1, unchanged: 0 });
    assert.equal(store.history('order', 'order-1').length, 2);
    assert.equal(store.list('order', { query: 'SYNTHETIC', status: 'delivered' }).total, 1);
    assert.equal(store.list('order', { status: 'paid' }).total, 0);
    assert.equal(store.stats().counts.order, 1);
    assert.ok(store.stats().lastImportedAt);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.dir, 'private')).mode & 0o777, 0o700);
    store.close();
    store = new PurchaseStore(f.path);
    assert.deepEqual(store.get('order', 'order-1'), next);
  } finally { store.close(); f.cleanup(); }
});

test('whole batch rolls back for stale, conflicting, invalid and duplicate records', () => {
  const f = fixture(); const store = new PurchaseStore(f.path);
  try {
    store.importRecords([order()]);
    for (const bad of [order('order-1', '2025-12-31T23:00:00Z'), { ...order(), status: 'changed' }]) {
      assert.throws(() => store.importRecords([order('new'), bad]));
      assert.equal(store.get('order', 'new'), undefined);
      assert.equal(store.history('order', 'new').length, 0);
    }
    assert.throws(() => store.importRecords([order('order-1', '2026-01-01T08:00:00+08:00')]));
    assert.throws(() => store.importRecords([order('same'), order('same')]));
    assert.throws(() => store.importRecords([{ ...order('private-value'), totalIdr: -1 }]));
    assert.equal(store.stats().counts.order, 1);
    assert.equal(store.history('order', 'order-1').length, 1);
    try { store.importRecords([{ ...order(), status: 'secret-marker', unknown: true } as never]); }
    catch (error) { assert.doesNotMatch(String(error), /secret-marker/); }
  } finally { store.close(); f.cleanup(); }
});

test('strict bounded schemas reject secrets, unsafe amounts, URL spoofing and future snapshots', () => {
  for (const record of [
    { ...order(), cookies: 'private' },
    { ...order(), totalIdr: Number.MAX_SAFE_INTEGER + 1 },
    { ...order(), items: [{ title: 'test', quantity: 1, cookie: 'private' }] },
    { ...order(), observedAt: new Date(Date.now() + 600000).toISOString() },
    { ...order(), observedAt: '2026-01-01T00:00:00' },
    { ...order(), detailUrl: 'https://tokopedia.com.evil.test/foo' },
    { ...order(), detailUrl: 'https://user:pass@tokopedia.com/foo' },
    { ...order(), id: 'a'.repeat(161) },
    { kind:'chat',id:'chat',observedAt:order().observedAt,messages:[{id:'same',direction:'incoming',text:'one'},{id:'same',direction:'incoming',text:'two'}] },
  ]) assert.equal(RecordSchema.safeParse(record).success, false);
  assert.equal(RecordSchema.safeParse({ ...order(), detailUrl: 'https://www.tokopedia.com/a' }).success, true);
});

test('all record variants, order linking, pagination and safe search work', () => {
  const f = fixture(); const store = new PurchaseStore(f.path); const observedAt = order().observedAt;
  try {
    store.importRecords([
      order(),
      RecordSchema.parse({ kind: 'shipment', id: 'ship', observedAt, orderId: 'order-1', status: 'moving' }),
      RecordSchema.parse({ kind: 'transaction', id: 'txn', observedAt, orderId: 'order-1', type: 'payment', amountIdr: 10000, status: 'paid' }),
      RecordSchema.parse({ kind: 'chat', id: 'chat', observedAt, messages: [{ id: 'm', direction: 'incoming', text: 'Hello' }] }),
      RecordSchema.parse({ kind: 'product', id: 'prod', observedAt, title: 'Example', priceIdr: 1, url: 'https://tokopedia.com/example' }),
    ]);
    assert.equal(store.list('shipment', { orderId: 'order-1' }).total, 1);
    assert.equal(store.list('transaction', { orderId: 'other' }).total, 0);
    assert.equal(store.list('chat', { query: 'hello', limit: 1, offset: 1 }).records.length, 0);
    assert.equal(store.list('chat', { query: "' OR 1=1 --" }).total, 0);
    assert.throws(() => store.list('order', { limit: 0 }));
    assert.throws(() => store.list('order', { offset: -1 }));
    assert.throws(() => store.get('invalid' as never, 'order-1'));
    assert.throws(() => store.history('order', 'order-1', 101));
  } finally { store.close(); f.cleanup(); }
});

test('refuses symlink database and ancestor paths', () => {
  const f = fixture();
  try {
    symlinkSync(f.dir, join(f.dir, 'alias'));
    assert.throws(() => new PurchaseStore(join(f.dir, 'alias', 'db.sqlite')));
    symlinkSync(join(f.dir, 'target'), join(f.dir, 'db.sqlite'));
    assert.throws(() => new PurchaseStore(join(f.dir, 'db.sqlite')));
  } finally { f.cleanup(); }
});

test('does not chmod an existing shared parent or create a database in it', () => {
  const f=fixture();
  try {
    chmodSync(f.dir,0o755);
    assert.throws(()=>new PurchaseStore(join(f.dir,'records.sqlite')));
    assert.equal(statSync(f.dir).mode&0o777,0o755);
    assert.throws(()=>statSync(join(f.dir,'records.sqlite')));
  } finally {f.cleanup();}
});

test('incomplete chat and delivery snapshots cannot hide previously imported entries', () => {
  const f=fixture();const store=new PurchaseStore(f.path);
  const observedAt='2026-01-01T00:00:00Z';
  const message={id:'m1',direction:'incoming' as const,text:'Synthetic message'};
  const event={status:'Collected'};
  try {
    store.importRecords([
      {kind:'chat',id:'chat',observedAt,messages:[message]},
      {kind:'shipment',id:'shipment',orderId:'o1',observedAt,status:'moving',events:[event]}
    ]);
    assert.throws(()=>store.importRecords([{kind:'chat',id:'chat',observedAt:'2026-01-02T00:00:00Z',messages:[]}]));
    assert.throws(()=>store.importRecords([{kind:'shipment',id:'shipment',orderId:'o1',observedAt:'2026-01-02T00:00:00Z',status:'delivered',events:[]}]));
    assert.equal((store.get('chat','chat') as any).messages.length,1);
    assert.equal(store.history('chat','chat').length,1);
    store.importRecords([{kind:'chat',id:'chat',observedAt:'2026-01-02T00:00:00Z',messages:[message,{id:'m2',direction:'incoming',text:'New synthetic message'}]}]);
    assert.equal((store.get('chat','chat') as any).messages.length,2);
  } finally {store.close();f.cleanup();}
});
