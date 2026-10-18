import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const server = await startServer(loadConfig());
console.log(`listening on port ${server.port}`);

// Render sends SIGTERM before every deploy and restart
const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
