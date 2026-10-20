import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PurchaseStore } from './store.js';
import { createServer } from './server.js';

const dbPath=process.env.TOKOPEDIA_DB_PATH??join(homedir(),'.local','share','tokopedia-personal-mcp','records.sqlite');
if(!isAbsolute(dbPath)) {console.error('TOKOPEDIA_DB_PATH must be absolute');process.exit(1);}
try {
  const store=new PurchaseStore(dbPath);
  const server=createServer(store);
  let closing=false;
  async function close() {
    if(closing) return;
    closing=true;
    await server.close(); store.close();
  }
  process.once('SIGINT',()=>void close().finally(()=>process.exit(0)));
  process.once('SIGTERM',()=>void close().finally(()=>process.exit(0)));
  const transport=new StdioServerTransport();
  transport.onclose=()=>void close();
  await server.connect(transport);
} catch {
  console.error('Tokopedia MCP startup failed. Verify Node >=24 and private database path permissions.');
  process.exitCode=1;
}
