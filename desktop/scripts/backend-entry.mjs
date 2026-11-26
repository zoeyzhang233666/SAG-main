import {buildHttpServer} from './dist/src/api/server.js';
import {closePool} from './dist/src/db/pool.js';
const app=buildHttpServer();let closing=false;
async function shutdown(){if(closing)return;closing=true;const t=setTimeout(()=>process.exit(1),8000);t.unref();try{await app.close();await closePool();process.exit(0);}catch(e){console.error(e);process.exit(1);}}
process.on('message',m=>{if(m?.type==='shutdown')void shutdown();});
process.on('disconnect',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
try{await app.listen({host:'127.0.0.1',port:Number(process.env.HTTP_PORT)});}catch(e){console.error(e);process.exit(1);}
