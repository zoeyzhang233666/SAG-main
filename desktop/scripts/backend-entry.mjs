import { buildHttpServer } from './dist/src/api/server.js';
import { closePool } from './dist/src/db/pool.js';

const app = buildHttpServer();
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  try {
    await app.close();
    await closePool();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

process.on('message', message => { if (message?.type === 'shutdown') void shutdown(); });
process.on('disconnect', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  process.send({ type: 'ready', port });
} catch (error) {
  console.error(error);
  process.exit(1);
}
