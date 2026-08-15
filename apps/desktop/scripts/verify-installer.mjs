import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseRoot = join(desktopRoot, "release");
const candidates = (await readdir(releaseRoot))
  .filter((name) => /^ScopeGuard-.+-x64-setup\.exe$/.test(name));
if (candidates.length !== 1) {
  throw new Error(`Expected one Windows setup executable, found ${candidates.length}.`);
}

const installerPath = join(releaseRoot, candidates[0]);
const installerStat = await stat(installerPath);
if (!installerStat.isFile() || installerStat.size < 50 * 1024 * 1024) {
  throw new Error("Windows setup executable is missing or unexpectedly small.");
}
const installerBytes = await readFile(installerPath);

console.log(JSON.stringify({
  installerPath,
  installerBytes: installerStat.size,
  installerSha256: createHash("sha256").update(installerBytes).digest("hex"),
  signatureExpected: false,
}, null, 2));
