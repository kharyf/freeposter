import { startApp } from "./app.ts";

let stop: () => Promise<void>;
try {
  ({ stop } = await startApp());
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const shutdown = async () => {
  await stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
