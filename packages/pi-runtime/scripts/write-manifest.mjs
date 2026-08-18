import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["approval-extension.js", "approval-policy.js"];
const entries = {};
for (const file of files) {
  entries[file] = createHash("sha256")
    .update(await readFile(join(root, "dist", file)))
    .digest("hex");
}
await writeFile(
  join(root, "dist", "extension-manifest.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    piVersion: "0.84.2",
    composition: [
      { id: "scopeguard-tool-policy", role: "policy", entrypoint: "approval-extension.js" },
    ],
    files: entries,
  }, null, 2)}\n`,
);
