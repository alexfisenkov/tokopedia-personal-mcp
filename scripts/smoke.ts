import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const dir=mkdtempSync(join(realpathSync(tmpdir()),'tokopedia-mcp-smoke-'));
const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'dist','index.js')],env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',TOKOPEDIA_DB_PATH:join(dir,'private','records.sqlite')},stderr:'pipe'});
const client=new Client({name:'tokopedia-smoke',version:'1.0.0'});
async function call(name:string,args:Record<string,unknown>={}) {
  const response=await client.callTool({name,arguments:args});
  assert.notEqual(response.isError,true,`Tool failed: ${name}`);
  const text=(response.content as {type:string;text?:string}[]).find(v=>v.type==='text')?.text;
  assert.ok(text);return JSON.parse(text);
}
try {
  await client.connect(transport);
  const catalogue=await client.listTools();
  assert.equal(catalogue.tools.length,12);
  assert.equal(catalogue.tools.some(t=>/^(send|place|pay|execute)/.test(t.name)),false);
  assert.equal((await call('status')).localSnapshotState,'NO_IMPORTED_DATA');
  assert.equal((await call('status')).mode,'LOCAL_SNAPSHOTS');
  const batch=JSON.parse(readFileSync(join(root,'examples','synthetic.json'),'utf8'));
  assert.equal((await call('import_records',batch)).inserted,5);
  assert.equal((await call('import_records',batch)).unchanged,5);
  assert.equal((await call('list_orders',{query:'USB'})).total,1);
  assert.equal((await call('get_order',{id:'demo-order'})).record.totalIdr,50000);
  assert.equal((await call('list_shipments',{orderId:'demo-order'})).total,1);
  assert.equal((await call('list_transactions',{orderId:'demo-order'})).total,1);
  assert.equal((await call('list_chats',{})).total,1);
  assert.equal((await call('get_chat',{id:'demo-chat'})).record.messages.length,1);
  assert.equal((await call('search_products',{query:'USB'})).total,1);
  assert.equal((await call('record_history',{kind:'order',id:'demo-order'})).versions.length,1);
  assert.equal((await call('prepare_message',{chatId:'demo-chat',text:'Apakah sudah dikirim?'})).status,'DRAFT_NOT_SENT');
  assert.equal((await call('prepare_purchase',{items:[{productId:'demo-product',quantity:2}],maxTotalIdr:60000})).status,'PLAN_NOT_ORDERED');
  const missing=await client.callTool({name:'prepare_message',arguments:{chatId:'private-missing-id',text:'private text'}});
  assert.equal(missing.isError,true);
  assert.equal(JSON.stringify(missing).includes('private text'),false);
  const unknown=await client.callTool({name:'send_message',arguments:{}});
  assert.equal(unknown.isError,true);
  console.log(JSON.stringify({result:'PASS',transport:'stdio',tools:catalogue.tools.length,syntheticOnly:true,mode:'LOCAL_SNAPSHOTS'}));
} finally {
  await client.close(); await transport.close(); rmSync(dir,{recursive:true,force:true});
}
