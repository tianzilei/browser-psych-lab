import { DatabaseWriter } from '../../dist/server/writer.js';
const writer = new DatabaseWriter(process.argv[2]);
await writer.start(); process.send({ ready: true });
process.on('message', async ({ command }) => {
  if (!command) { await writer.close(); process.exit(0); }
  try { process.send({ result: await writer.request(command) }); }
  catch (error) { process.send({ error: error.message }); }
});
