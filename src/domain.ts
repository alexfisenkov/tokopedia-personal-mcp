import { z } from 'zod';

const text = (max = 500) => z.string().min(1).max(max);
const id = text(160);
const timestamp = z.string().max(64).datetime({ offset: true });
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokopediaUrl = z.string().max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['tokopedia.com', 'www.tokopedia.com'].includes(url.hostname)
      && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}, 'INVALID_TOKOPEDIA_URL');
const base = {
  id,
  observedAt: timestamp.refine((value) => Date.parse(value) <= Date.now() + 300_000, 'FUTURE_SNAPSHOT'),
};
export const KindSchema = z.enum(['order', 'shipment', 'transaction', 'chat', 'product']);
export type Kind = z.infer<typeof KindSchema>;
export const RecordSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('order'), status: text(160), totalIdr: money.optional(),
    items: z.array(z.object({ title: text(1000), quantity: z.number().int().positive().max(1_000_000),
      unitPriceIdr: money.optional() }).strict()).max(500), detailUrl: tokopediaUrl.optional() }).strict(),
  z.object({ ...base, kind: z.literal('shipment'), orderId: id, status: text(160), courier: text(160).optional(),
    trackingNumber: text(200).optional(), events: z.array(z.object({ at: timestamp.optional(),
      status: text(500), location: text(500).optional() }).strict()).max(1000).default([]) }).strict(),
  z.object({ ...base, kind: z.literal('transaction'), orderId: id.optional(), type: z.enum(['payment', 'refund', 'other']),
    amountIdr: money, currency: z.literal('IDR').default('IDR'), status: text(160) }).strict(),
  z.object({ ...base, kind: z.literal('chat'), shopName: text(500).optional(),
    messages: z.array(z.object({ id, sentAt: timestamp.optional(), direction: z.enum(['incoming', 'outgoing']),
      text: text(20_000) }).strict()).max(1000).refine(messages=>new Set(messages.map(m=>m.id)).size===messages.length,'DUPLICATE_MESSAGE_ID') }).strict(),
  z.object({ ...base, kind: z.literal('product'), title: text(1000), priceIdr: money,
    shopName: text(500).optional(), url: tokopediaUrl }).strict(),
]);
export type PurchaseRecord = z.infer<typeof RecordSchema>;
