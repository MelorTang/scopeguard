# Pi RPC Qualification Harness

This disposable prototype qualifies the exact Pi RPC package pinned in the
repository lockfile. It does not modify or replace ScopeGuard's product Runtime.

The fixed target is `@earendil-works/pi-coding-agent@0.84.2`, corresponding to
official tag `v0.84.2` and commit
`914cf1472e715297caa30db4b9535d534a9eb718` under the MIT license. Install the
repository dependencies with the pinned lockfile before running the harness:

```bash
pnpm install --frozen-lockfile
```

Run the full matrix from the repository root:

```bash
pnpm qualify:pi-rpc
```

The command exits non-zero on any failed assertion. It starts a deterministic
local OpenAI-compatible fake Provider, creates isolated Pi config, Workspace,
and Session directories under the operating-system temporary directory, starts
real Pi RPC child processes, scans temporary files for the fake credential, and
removes all temporary state before success or failure exit.

The harness loads `approval-extension.ts` through Pi's official `--extension`
argument. It verifies the actual pre-execution `tool_call` -> RPC confirm ->
matching-ID host response -> execute/block path. Reject, cancel, timeout,
extension error, and host disconnect are tested as fail-closed cases; an
observed `tool_execution_start` is never treated as approval.

`RpcProcess` keeps only bounded, redacted stderr and converts invalid JSONL into
a propagated protocol error. A forced-failure fixture asserts child and Provider
termination plus removal of its temporary profile, Workspace, and Sessions.

The harness deliberately removes inherited environment variables whose names
look like credentials and sets `PI_OFFLINE=1` and `PI_TELEMETRY=0`. It never
requires or exercises a real Provider key. A real-provider smoke is optional
future evidence and must not weaken or replace this deterministic gate.

Pi is an exact dependency of this private prototype workspace rather than the
root or a product package. pnpm still uses one shared lockfile, so Pi's
transitive `yaml` peer affects Vite's peer-resolution snapshot. This is an
intentional Phase 1 lockfile effect, not a product import. Phase 2 must move the
pin to the Runtime-owning package and review the regenerated shared lockfile.

`fixtures/expected-contract.json` contains stable expected event categories and
one explicitly synthetic future event used only to prove fail-safe unknown-event
handling. It is not represented as an event emitted by Pi.

See `RESULT.md` for the observed matrix and candidate verdict, and
`../../docs/research/pi-rpc-qualification.md` for pinned primary-source analysis.
