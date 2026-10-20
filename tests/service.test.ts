import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseStore } from '../src/store.js';
import { PurchaseService } from '../src/service.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tokopedia-service-'));
  const store = new PurchaseStore(join(dir, 'private', 'records.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service: new PurchaseService(store) };
}
const at = '2026-10-01T08:00:00Z';

test('empty local database never claims Tokopedia has no orders or is connected', t => {
  const { service } = fixture(t);
  const health = service.status();
  assert.equal(health.mode, 'LOCAL_SNAPSHOTS');
  assert.equal(health.localSnapshotState, 'NO_IMPORTED_DATA');
  assert.equal(service.list('order', {}).provenance, 'manual_import');
});

test('message preparation preserves exact text and never pretends to send', t => {
  const { store, service } = fixture(t);
  store.importRecords([{kind:'chat',id:'chat-1',observedAt:at,shopName:'Synthetic Shop',messages:[]}]);
  const draft = service.prepareMessage({ chatId:'chat-1', text:'Apakah sudah dikirim?' });
  assert.equal(draft.status, 'DRAFT_NOT_SENT');
  assert.equal(draft.text, 'Apakah sudah dikirim?');
  assert.equal(draft.recipientChatId, 'chat-1');
  assert.equal(draft.liveRecipientVerified, false);
  assert.equal(draft.sourceObservedAt, at);
  assert.throws(() => service.prepareMessage({chatId:'unknown',text:'Hello'}));
});

test('purchase preparation uses integer IDR, preserves budget, and leaves fees unknown', t => {
  const { store, service } = fixture(t);
  store.importRecords([{kind:'product',id:'p1',observedAt:at,title:'Synthetic cable',priceIdr:25000,url:'https://www.tokopedia.com/example/cable'}]);
  const plan = service.preparePurchase({items:[{productId:'p1',quantity:2}],maxTotalIdr:60000});
  assert.equal(plan.status, 'PLAN_NOT_ORDERED');
  assert.equal(plan.itemsSubtotalIdr, 50000);
  assert.equal(plan.shippingAndFeesIdr, null);
  assert.equal(plan.finalTotalIdr, null);
  assert.equal(plan.maxTotalIdr, 60000);
  assert.equal(plan.subtotalWithinBudget, true);
  assert.equal(service.preparePurchase({items:[{productId:'p1',quantity:3}],maxTotalIdr:60000}).subtotalWithinBudget, false);
});

test('missing product and unsafe total cannot produce a usable purchase plan', t => {
  const { store, service } = fixture(t);
  assert.throws(() => service.preparePurchase({items:[{productId:'unknown',quantity:1}],maxTotalIdr:1}));
  store.importRecords([{kind:'product',id:'p1',observedAt:at,title:'Big',priceIdr:Number.MAX_SAFE_INTEGER,url:'https://www.tokopedia.com/example/big'}]);
  assert.throws(() => service.preparePurchase({items:[{productId:'p1',quantity:2}],maxTotalIdr:1}));
});
