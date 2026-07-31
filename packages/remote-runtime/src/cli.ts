#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { RemoteRuntimeService } from "./service.js";

const token = process.env.SCOPEGUARD_RUNTIME_TOKEN?.trim();
if (!token) {
  throw new Error("SCOPEGUARD_RUNTIME_TOKEN is required.");
}

const databasePath = process.env.SCOPEGUARD_RUNTIME_DB
  ?? join(homedir(), ".scopeguard-runtime", "runtime.sqlite");
const host = process.env.SCOPEGUARD_RUNTIME_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.SCOPEGUARD_RUNTIME_PORT ?? "8787", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("SCOPEGUARD_RUNTIME_PORT must be a valid TCP port.");
}

const service = new RemoteRuntimeService({ databasePath, token, host, port });
const address = await service.start();
process.stdout.write(`ScopeGuard Runtime listening at ${address.baseUrl}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await service.close();
  process.exit(0);
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
