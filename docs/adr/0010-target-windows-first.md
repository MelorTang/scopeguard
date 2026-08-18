# Target Windows first

Status: Active in principle; amended by [ADR 0024](./0024-adopt-a-personal-first-pi-rpc-workbench.md) on 2026-08-18.

ScopeGuard V1 will treat Windows 10 and 11 on x64 as the release acceptance
platform and macOS on Apple Silicon as a development and secondary support
platform. Linux, Windows on ARM, and macOS on Intel are outside V1 support. The
Desktop will be distributed as a manually installed Windows package, keep its
application data under the Member's OS user profile, and allow a Workspace to
reference a user-selected local folder. Automated update infrastructure is
deferred until the product has a stable internal release process.
