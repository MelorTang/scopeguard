import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(desktopRoot, "src", "preload.cjs");
const targetPath = join(desktopRoot, "dist", "preload.cjs");

mkdirSync(dirname(targetPath), { recursive: true });
copyFileSync(sourcePath, targetPath);
