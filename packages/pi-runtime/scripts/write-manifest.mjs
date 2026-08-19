import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TRUSTED_EXTENSION_MANIFEST } from "../dist/extension-trust-root.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const [file, expectedHash] of Object.entries(TRUSTED_EXTENSION_MANIFEST.files)) {
  const actualHash = createHash("sha256")
    .update(await readFile(join(root, "dist", file)))
    .digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`Trusted extension asset changed without a trust-root update: ${file}`);
  }
}
await writeFile(
  join(root, "dist", "extension-manifest.json"),
  `${JSON.stringify(TRUSTED_EXTENSION_MANIFEST, null, 2)}\n`,
);
