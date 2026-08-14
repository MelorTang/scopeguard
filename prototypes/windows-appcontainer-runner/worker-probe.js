const fs = require("node:fs");
const path = require("node:path");

const [kind, workspace, outsideDirectory, resultPath] = process.argv.slice(2);
if (!kind || !workspace || !outsideDirectory || !resultPath) {
  throw new Error("usage: worker-probe.js <kind> <workspace> <outside> <result>");
}

const allowedPath = path.join(workspace, `${kind}-output.txt`);
const deniedPath = path.join(outsideDirectory, `${kind}-outside.txt`);

fs.writeFileSync(allowedPath, `${kind}-ok`, "utf8");

let outsideWriteDenied = false;
let outsideWriteDetail = "write unexpectedly succeeded";
try {
  fs.writeFileSync(deniedPath, "blocked", "utf8");
} catch (error) {
  outsideWriteDenied = true;
  outsideWriteDetail = error instanceof Error ? error.message : String(error);
}

const result = {
  kind,
  passed:
    fs.existsSync(allowedPath) &&
    outsideWriteDenied &&
    !fs.existsSync(deniedPath) &&
    process.env.SCOPEGUARD_SECRET_SENTINEL === undefined,
  allowedWrite: fs.existsSync(allowedPath),
  outsideWriteDenied,
  outsideWriteDetail,
  parentSecretInherited:
    process.env.SCOPEGUARD_SECRET_SENTINEL !== undefined,
};

fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
process.exitCode = result.passed ? 0 : 1;
