# Pi RPC Qualification Harness

This disposable prototype qualifies official
`@earendil-works/pi-coding-agent@0.84.2`, tag `v0.84.2`, commit
`914cf1472e715297caa30db4b9535d534a9eb718`, under the MIT license. It does not
modify or replace ScopeGuard's product Runtime.

Run the complete, independently locked qualification from the repository root:

```bash
pnpm qualify:pi-rpc
```

That command performs a frozen install against this directory's own
`pnpm-lock.yaml`, typechecks every extension, then runs every assertion. The prototype is not a member of
the root pnpm workspace, and Pi does not appear in the root lockfile. This keeps
Pi's transitive peer graph out of Desktop's Vite resolution.

The harness starts a deterministic local OpenAI-compatible Provider, isolated
Pi profiles, Workspaces, Sessions, and real RPC child processes. It exits
non-zero on any failed assertion and removes temporary state on success or
failure. No real Provider credential is required or persisted.

## Approval Contract

The committed extension manifest pins each allowed extension by SHA-256 and
orders the ScopeGuard policy last. Pi extension discovery is disabled; startup
loads only the manifest paths and rejects unknown files, hash drift, more than
one policy, or any extension after the policy. Test-only Tool
registration and mutation fixtures must appear before that final policy.

The policy is default fail-closed:

- `read` is the only explicit read-only auto-allow entry;
- `bash`, `write`, and `edit` always require host confirmation;
- every unknown or unclassified Tool is blocked without execution.

Model text and Tool arguments never select the policy. Each confirmation
contains the Tool call ID, Tool name, canonical input, and its SHA-256. The host
binds those fields to the owning Pi process and opaque RPC request ID. The RPC
adapter accepts only one exact `confirmed`, `cancelled`, or `value` response
shape and writes the request's fixed type and ID after validation.

The qualification proves unmarked bash, write, edit, and a registered unknown
mutating Tool cannot bypass this policy. It also proves a declared earlier
mutator is visible to the final policy, while a mutator placed after approval is
rejected before process spawn.

## Evidence Layout

- `run.mjs` is the short scenario orchestrator.
- `qualification/` owns shared context, evidence vocabulary, and assertions.
- `scenarios/` contains independent executable qualification scenarios.
- `extensions/` contains the policy and explicit test fixtures.
- `fixtures/extension-manifest.json` is the controlled composition manifest.
- `RESULT.md` records observed output and the candidate verdict.

`RpcProcess` bounds stderr by actual UTF-8 bytes, redacts diagnostics, and
propagates malformed JSONL as a protocol error. The forced-failure fixture uses
multibyte stderr and proves child, Provider, profile, Workspace, Session, and
temporary-root cleanup.

See `../../docs/research/pi-rpc-qualification.md` for pinned primary-source
analysis and `../../docs/adr/0025-adopt-pi-rpc-with-an-extension-approval-bridge.md`
for the candidate decision.
