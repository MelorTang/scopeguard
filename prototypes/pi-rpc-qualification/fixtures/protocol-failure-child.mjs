const leakedValue =
  process.env.SCOPEGUARD_PROTOCOL_FAILURE_SECRET ?? "missing-secret";

process.stderr.write(
  `Authorization: Bearer ${leakedValue}\n${"x".repeat(64_000)}\n`,
);
setTimeout(() => process.stdout.write(`{not-json:${leakedValue}\n`), 150);
setInterval(() => {}, 1_000);
