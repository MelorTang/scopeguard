const fs = require("node:fs");
const path = require("node:path");

const [workspace, outsideDirectory, runtimePackRoot, resultPath] =
  process.argv.slice(2);
if (!workspace || !outsideDirectory || !runtimePackRoot || !resultPath) {
  throw new Error(
    "usage: runtime-pack-probe.js <workspace> <outside> <runtime-pack> <result>",
  );
}

const allowedPath = path.join(workspace, "bundled-node-output.txt");
const outsidePath = path.join(outsideDirectory, "bundled-node-outside.txt");
const runtimePath = path.join(runtimePackRoot, "sandbox-write.txt");

fs.writeFileSync(allowedPath, "bundled-node-ok", "utf8");

function deniedWrite(target) {
  try {
    fs.writeFileSync(target, "blocked", "utf8");
    return { denied: false, detail: "write unexpectedly succeeded" };
  } catch (error) {
    return {
      denied: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const outsideWrite = deniedWrite(outsidePath);
const runtimeWrite = deniedWrite(runtimePath);
const result = {
  kind: "bundled-node",
  passed:
    fs.existsSync(allowedPath) &&
    outsideWrite.denied &&
    runtimeWrite.denied &&
    !fs.existsSync(outsidePath) &&
    !fs.existsSync(runtimePath) &&
    process.env.SCOPEGUARD_SECRET_SENTINEL === undefined,
  allowedWrite: fs.existsSync(allowedPath),
  outsideWriteDenied: outsideWrite.denied,
  outsideWriteDetail: outsideWrite.detail,
  runtimeWriteDenied: runtimeWrite.denied,
  runtimeWriteDetail: runtimeWrite.detail,
  parentSecretInherited:
    process.env.SCOPEGUARD_SECRET_SENTINEL !== undefined,
};

fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf8");
process.exitCode = result.passed ? 0 : 1;
