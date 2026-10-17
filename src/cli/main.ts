#!/usr/bin/env bun
import { boot, startBackground } from "../boot.ts";
import { startServer } from "../server/main.ts";

const [cmd = "serve"] = process.argv.slice(2);

if (cmd === "serve") {
  const rt = await boot();
  startBackground(rt);
  const server = startServer(rt);
  console.log(`Tidequill is running on http://localhost:${server.port}`);
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
