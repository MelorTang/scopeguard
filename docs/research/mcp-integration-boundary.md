# MCP Integration Boundary: Dual Channels and Credential Protocol

> Status: Historical enterprise-route research. MCP is optional integration input under [ADR 0024](../adr/0024-adopt-a-personal-first-pi-rpc-workbench.md), not a V1 control-plane requirement.

Status: research recommendation for [GitHub issue #4](https://github.com/MelorTang/scopeguard/issues/4)
Research snapshot: 2026-08-13 (Asia/Shanghai)
Normative baseline: MCP `2026-07-28`, with explicitly bounded compatibility for `2025-11-25`

## Scope and decision context

This note resolves the transport, authentication, result, cancellation, proxy, and permission questions for two intentionally different MCP channels:

1. **Organization knowledge**: ScopeGuard Server is the MCP client. Desktop is not given the enterprise endpoint credential and does not connect to the enterprise MCP server directly.
2. **Personal or Workspace MCP**: ScopeGuard Desktop is the MCP host/client. The Member installs and configures a local `stdio` or remote Streamable HTTP connection, and the active Conversation Execution Profile governs local effects.

This preserves the boundaries established by [CONTEXT.md](../../CONTEXT.md), [ADR 0005](../adr/0005-authorize-knowledge-by-member.md), [ADR 0009](../adr/0009-separate-workspace-files-from-enterprise-rag.md), [ADR 0014](../adr/0014-govern-local-access-per-conversation.md), and [ADR 0017](../adr/0017-support-enterprise-and-personal-mcp.md). It is also consistent with the local/server split in [ADR 0004](../adr/0004-local-workspace-enterprise-control-plane.md), offline behavior in [ADR 0011](../adr/0011-allow-offline-access-to-local-work.md), server deployment assumptions in [ADR 0012](../adr/0012-deploy-a-single-node-enterprise-server.md), and admin ownership in [ADR 0020](../adr/0020-separate-the-admin-console-from-the-desktop.md).

Labels used below:

- **Specification fact**: required or described by an official MCP specification, SDK, RFC, or platform security document.
- **ScopeGuard V1 recommendation**: a product decision proposed here; it is not an MCP requirement.
- **Drift note**: a fact likely to change and therefore requiring revalidation.

## Decision summary

| Concern | Organization knowledge | Personal or Workspace MCP |
| --- | --- | --- |
| MCP client location | ScopeGuard Server only | ScopeGuard Desktop main/agent process only |
| V1 transport | HTTPS Streamable HTTP | Local `stdio`; advanced remote HTTPS Streamable HTTP |
| Protocol revisions | Prefer `2026-07-28`; allow `2025-11-25` fallback | Same allowlist; probe behavior differs for `stdio` |
| Credential owner | Organization Admin configures one service credential | Member authorizes and stores each connection locally |
| Preferred auth | OAuth Client Credentials with `private_key_jwt` | Authorization Code with PKCE for HTTP; allowlisted environment injection for `stdio` |
| Authorization subject | Logged-in Member at the ScopeGuard API boundary; one Organization-wide knowledge set in V1 | Member plus connection scope, Agent Policy, and Conversation Execution Profile |
| Exposed capability | One fixed, read-only search tool | Only reviewed tools from an enabled connection |
| Citation authority | Validated `structuredContent` with required source identity, location, and excerpt | MCP-native result content, with host validation; not projected as Organization evidence |
| Credential exposure | Never sent to Desktop, renderer, model, transcript, or Agent Template | Never sent to renderer, model, transcript, or Agent Template |
| Offline behavior | Explicitly unavailable | Local `stdio` may remain available; remote HTTP is unavailable |

## 1. Protocol and transport facts

### 1.1 Current protocol era

**Specification fact.** The current stable MCP release is `2026-07-28`, published as a stable release on 2026-07-28. It replaces connection-scoped initialization with stateless, self-contained requests and per-request capability metadata ([release](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28), [current specification](https://modelcontextprotocol.io/specification/2026-07-28)).

**Specification fact.** MCP `2026-07-28` is a new wire-protocol era. It has no `initialize`/`initialized` handshake, no protocol-level session, and no `Mcp-Session-Id`. Clients may use `server/discover`, while each request carries the protocol version and capabilities in `_meta` ([transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)). Revisions through `2025-11-25` use the legacy initialization/session model.

**SDK fact.** The official TypeScript SDK v2 supports both eras. `versionNegotiation: { mode: "auto" }` probes `server/discover` and falls back to a legacy `initialize`; no option or `mode: "legacy"` remains legacy-only. A modern-only pin rejects a legacy server. The SDK can accept a cached `PriorDiscovery`, but the host is responsible for freshness ([official protocol-version guide](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions), [2026-07-28 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)).

**ScopeGuard V1 recommendation.** Pin `@modelcontextprotocol/client` to `2.0.0` initially. That is the current stable release at this research snapshot ([official release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fclient%402.0.0)). Permit exactly `2026-07-28` and `2025-11-25`; prefer modern and reject older revisions. Do not implement the deprecated `2024-11-05` HTTP+SSE transport, WebSocket, or a custom transport.

### 1.2 Streamable HTTP

**Specification fact.** Modern Streamable HTTP exposes one MCP endpoint. Every JSON-RPC message is a separate HTTP `POST`; a request receives either one `application/json` response or a request-scoped SSE response. The client must accept both. The former GET stream, protocol sessions, and SSE resumability are absent in `2026-07-28` ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)).

**Specification fact.** Each modern POST includes `MCP-Protocol-Version` and `Mcp-Method`; `tools/call`, `resources/read`, and `prompts/get` also include `Mcp-Name`. The body remains the source of truth. A server may mark primitive tool arguments with `x-mcp-header`, and conforming HTTP clients must mirror valid declarations into `Mcp-Param-*` headers. Sensitive values should not be marked because headers are visible to intermediaries ([request metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata), [tool definition rules](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#custom-headers-from-tool-parameters)).

**Specification fact.** HTTP servers must validate `Origin`, should bind localhost-only local servers to loopback, and should authenticate connections ([Streamable HTTP security](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-endpoint)).

**ScopeGuard V1 recommendation.** Organization MCP uses HTTPS Streamable HTTP only. Desktop remote MCP also requires HTTPS, except an explicitly configured loopback development endpoint may use HTTP. Both channels use the SDK's modern-first negotiation. Legacy fallback may use the SDK's `2025-11-25` Streamable HTTP mechanics, but no separate legacy HTTP+SSE endpoint is supported.

**ScopeGuard V1 recommendation.** The Organization search tool contract prohibits `x-mcp-header` on every input property. The server rejects a discovered Organization tool definition that attempts to mirror the query, collection IDs, credentials, Member identifiers, or other arguments into HTTP headers.

### 1.3 stdio

**Specification fact.** With `stdio`, the client launches a subprocess; messages are UTF-8, newline-delimited JSON-RPC on stdin/stdout. A message cannot contain an embedded newline, stdout must contain protocol messages only, and stderr may carry logs. Graceful shutdown closes stdin, waits for exit, and then escalates to platform process termination if needed ([stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)).

**SDK fact.** Modern-first auto-negotiation over `stdio` can require a disposable sibling process because some legacy servers exit when they receive a request before `initialize`. The SDK therefore makes protocol-verdict caching a host responsibility ([official protocol-version guide](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)).

**ScopeGuard V1 recommendation.** Desktop supports `stdio` only for Member-configured personal or Workspace connections. The connection editor shows the exact executable, arguments, working directory, and names of injected environment variables before first launch. It never invokes a shell to interpret a command string. In Request Approval and Auto Approve, verification probes and normal server processes run through the same OS-enforced Managed Execution Sandbox as other Agent-triggered code and fail closed if the sandbox cannot be established.

**ScopeGuard V1 recommendation.** Run modern/legacy auto-probing during explicit **Verify connection**, cache the verdict for 24 hours keyed by a fingerprint of executable, arguments, working directory, environment-variable names, and server package/binary metadata, and use `PriorDiscovery` on normal starts. Re-probe when the fingerprint changes, the cache expires, or negotiation fails. The verification UI states that probing may launch a disposable second process.

## 2. Authentication and credential custody

### 2.1 MCP HTTP authorization facts

**Specification fact.** MCP authorization is optional. When used, HTTP transports should follow the MCP authorization specification; `stdio` should not use that OAuth flow and should retrieve credentials from its environment ([authorization protocol requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#protocol-requirements)).

**Specification fact.** A protected MCP server is an OAuth resource server. It must publish RFC 9728 Protected Resource Metadata; clients must use that metadata and support both RFC 8414 Authorization Server Metadata and OpenID Connect Discovery. Client registration priority is Client ID Metadata Documents, pre-registration, then deprecated Dynamic Client Registration compatibility ([authorization overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).

**Specification fact.** Clients must send the MCP server's canonical URI as `resource` in both authorization and token requests. Bearer tokens go in the `Authorization` header on every HTTP request and never in a URI query. The server must validate the token audience and must not accept or transit tokens issued for another resource. Invalid or expired tokens produce 401; insufficient scope produces 403 ([resource and token requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#resource-parameter-implementation), [token handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#access-token-usage)).

**Specification fact.** Public clients must use PKCE, verify server support, and use `S256`. Clients must validate authorization-response `iss` as specified and securely store tokens; access tokens should be short lived and public-client refresh tokens must rotate ([authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)).

### 2.2 Organization service authentication

**Specification fact.** The official `io.modelcontextprotocol/oauth-client-credentials` extension defines machine-to-machine OAuth Client Credentials. It supports a client secret and RFC 7523 JWT bearer assertions, recommending JWT/private-key authentication ([official extension documentation](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials)).

**Drift note.** Client Credentials remains listed as **Draft**, not Stable, in the official authorization-extension repository as of 2026-08-13 ([ext-auth status](https://github.com/modelcontextprotocol/ext-auth#extensions)). Its wire and SDK surface can change independently of the core protocol.

**ScopeGuard V1 recommendation.** Organization connection configuration uses this closed enum:

```text
oauth_client_credentials_private_key_jwt   preferred
oauth_client_credentials_secret            allowed compatibility
static_bearer                              explicit compatibility exception
```

For OAuth modes, the Organization Admin pre-registers a confidential service principal. ScopeGuard requests only the provider-defined read scope, with `mcp:knowledge.read` as the expected contract name, and the canonical Organization MCP endpoint as `resource`. The Admin UI must display the actual provider scope because MCP does not standardize scope names.

Use `private_key_jwt` where the provider supports it. Keep the private key or client secret encrypted at rest in ScopeGuard Server's secret store, decrypt only in the MCP client process, rotate independently of application deploys, and obtain short-lived access tokens. `static_bearer` is allowed only when the provider lacks the OAuth profile; it requires an Admin-visible expiry/rotation record and is never copied to Desktop.

The inbound ScopeGuard Member session and outbound MCP service token are separate credentials with separate audiences. The server never forwards a Member token to MCP and never forwards the MCP token to another API. MCP explicitly forbids token passthrough because it breaks audience and security boundaries ([official security guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#token-passthrough)).

### 2.3 Desktop remote HTTP authentication

**ScopeGuard V1 recommendation.** Remote personal or Workspace HTTP connections use this closed enum:

```text
oauth_authorization_code_pkce   preferred
static_bearer                   advanced compatibility
none                            loopback HTTP only
```

For OAuth, Desktop uses the system browser, Authorization Code plus PKCE `S256`, a random `state`, issuer binding, and a loopback IP redirect on a random ephemeral port. Native applications should use an external user-agent rather than an embedded web view, and loopback redirects are the standard desktop pattern ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)). ScopeGuard supports Client ID Metadata Documents or a pre-registered public client; deprecated Dynamic Client Registration is a last compatibility option.

Authorization and metadata URLs are parsed as URLs, restricted to HTTPS except loopback development HTTP, validated on every redirect, and opened with a platform API rather than a shell. Server-side discovery additionally blocks private, reserved, loopback, and link-local destinations unless the Organization deployment has an explicit internal-endpoint allowlist. These controls address the MCP-documented OAuth SSRF, DNS rebinding, and authorization-URL attack paths ([official MCP security practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#server-side-request-forgery-ssrf), [authorization URL validation](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#oauth-authorization-url-validation)).

### 2.4 Desktop `stdio` credentials and local storage

**ScopeGuard V1 recommendation.** A `stdio` connection stores only credential references in its connection JSON. Secret values remain in OS-backed secure storage and are injected into an allowlisted, minimal child environment at spawn time only when required by that connection. ScopeGuard does not inherit the entire Desktop environment, display secret values after save, include them in logs/crash reports, or expose them to renderer IPC, the model, tool arguments, transcripts, Agent Templates, or Workspace files. The sandbox policy grants no ambient access to the Desktop credential store.

Electron `safeStorage` uses macOS Keychain and Windows DPAPI, while Linux protection depends on the available secret service. Electron documents that Windows does not protect against other applications in the same user session and Linux may fall back to insecure `basic_text` ([Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)). Therefore Desktop must:

- keep encryption/decryption in the main process;
- prefer the asynchronous API and honor key-rotation indications;
- fail closed for new MCP secret storage when encryption is unavailable;
- reject Linux `basic_text` for persistent MCP credentials;
- document Windows same-user-process exposure in the threat model.

## 3. Server-side Organization knowledge proxy

### 3.1 Required boundary

**ScopeGuard V1 recommendation.** Desktop never receives an Organization MCP endpoint credential and never makes an Organization MCP request. The call path is:

```text
Desktop
  -> ScopeGuard application API with Member session
  -> Organization knowledge policy gate
  -> server-side fixed MCP adapter
  -> enterprise knowledge MCP endpoint
  -> validated evidence projection
  -> Desktop
```

The application API accepts `conversationId`, `query`, optional `collectionIds`, and `limit`. It derives Member, Organization, Agent, and policy context from authenticated server state. It does not accept caller-supplied `organizationId`, `memberId`, MCP endpoint, tool name, credential reference, or OAuth scope.

The server enforces:

1. active Member status in the Organization;
2. the Agent Policy capability `organization_knowledge.read`;
3. V1 Organization-wide collection access, identical for every active Member as required by ADR 0005;
4. a configured and healthy Organization MCP connection;
5. one allowlisted tool named `search_organization_knowledge`.

Agent identity and Agent Template identity never select knowledge ACLs. Agent Templates may recommend using Organization knowledge but cannot configure a connection, select credentials, or enlarge policy.

### 3.2 Data minimization and upstream ownership

**ScopeGuard V1 recommendation.** The proxy sends only the normalized query, authorized collection identifiers, result limit, and an opaque correlation ID. It does not send the full conversation transcript, Workspace files, local paths, provider keys, Member session token, Member email, or unrelated Organization metadata.

The enterprise knowledge service remains responsible for ingestion, indexing, retrieval, source lifecycle, and source ACL behavior. ScopeGuard owns Member authorization at its boundary, the fixed MCP client, result validation, evidence projection, presentation, and bounded operational diagnostics. ScopeGuard must not expose arbitrary upstream tools, resources, or prompts through this connection.

The server validates the configured endpoint, every OAuth discovery URL, redirect target, and resolved IP. Public endpoints require normal SSRF blocking; private enterprise endpoints require an explicit deployment allowlist and still block cloud metadata/link-local addresses. Official MCP guidance recommends HTTPS, redirect validation, private-range controls, and an egress proxy for server-side clients ([SSRF mitigations](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#server-side-request-forgery-ssrf)).

### 3.3 Safe citation projection

The server converts each accepted upstream result into a Desktop-safe evidence item:

```json
{
  "citationRef": "opaque server-generated reference",
  "citationId": "c1",
  "rank": 1,
  "title": "Source title",
  "locationLabel": "p. 12 / section 3.2",
  "excerpt": "Verbatim source excerpt",
  "mimeType": "application/pdf",
  "openUrl": "/api/organization-knowledge/citations/<citationRef>"
}
```

`citationRef` is random, non-enumerable, and bound server-side to Organization, source identity/revision, and the originating evidence record. Opening `openUrl` reauthorizes the current Member and then redirects or proxies to the source without placing any enterprise credential in the URL. Possession of a state handle is not authentication; the current MCP security guide requires state handles to be non-predictable and bound to authenticated identity ([state-handle guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#state-handle-hijacking)).

Desktop may persist the safe title, location label, excerpt, and citation reference with the local transcript. It must not persist access tokens, raw provider headers, or a source URL that embeds credentials. Offline, the stored excerpt may be displayed as historical evidence, but source opening and new Organization retrieval are explicitly unavailable.

## 4. Organization tool and citation/result contract

### 4.1 What MCP standardizes, and what it does not

**Specification fact.** MCP tools have `inputSchema`, optional `outputSchema`, unstructured `content`, and `structuredContent`. When `outputSchema` exists, a server must conform and a client should validate. A tool returning structured content should also return its serialized JSON in a text block for compatibility ([tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#structured-content)). Tool content may include `resource_link` and embedded resource blocks.

**Specification fact.** MCP `2026-07-28` does not define a general citation, source ID, excerpt, page/section locator, or provenance object. `resource_link` provides a URI and display metadata but does not require the evidence fields ScopeGuard needs. This is an absence in the authoritative [2026-07-28 schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/2026-07-28/schema/2026-07-28/schema.ts), so the citation contract below is ScopeGuard-specific.

### 4.2 Fixed input schema

**ScopeGuard V1 recommendation.** The Organization server must expose exactly one callable tool, `search_organization_knowledge`, with this input schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["query", "limit"],
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "collectionIds": {
      "type": "array",
      "items": { "type": "string", "minLength": 1, "maxLength": 200 },
      "maxItems": 20,
      "uniqueItems": true
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    }
  }
}
```

ScopeGuard sends `limit: 8` by default. Collection IDs are server-resolved identifiers from configured Organization collections, not arbitrary URIs or paths.

### 4.3 Fixed output schema

**ScopeGuard V1 recommendation.** The tool's `outputSchema` is:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "status", "results", "warnings"],
  "properties": {
    "schemaVersion": {
      "const": "scopeguard.organization-knowledge-result.v1"
    },
    "status": {
      "enum": ["complete", "partial"]
    },
    "results": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "citationId",
          "rank",
          "sourceId",
          "title",
          "uri",
          "location",
          "excerpt"
        ],
        "properties": {
          "citationId": { "type": "string", "pattern": "^c[1-9][0-9]*$" },
          "rank": { "type": "integer", "minimum": 1, "maximum": 20 },
          "sourceId": { "type": "string", "minLength": 1, "maxLength": 500 },
          "title": { "type": "string", "minLength": 1, "maxLength": 500 },
          "uri": { "type": "string", "format": "uri", "maxLength": 2048 },
          "location": {
            "type": "object",
            "additionalProperties": false,
            "required": ["kind", "label"],
            "properties": {
              "kind": {
                "enum": ["page", "section", "line", "timecode", "record", "other"]
              },
              "label": { "type": "string", "minLength": 1, "maxLength": 500 },
              "start": { "type": "string", "maxLength": 200 },
              "end": { "type": "string", "maxLength": 200 }
            }
          },
          "excerpt": { "type": "string", "minLength": 1, "maxLength": 4000 },
          "mimeType": { "type": "string", "maxLength": 200 },
          "revision": { "type": "string", "maxLength": 500 },
          "score": { "type": "number" }
        }
      }
    },
    "warnings": {
      "type": "array",
      "maxItems": 20,
      "items": { "type": "string", "minLength": 1, "maxLength": 1000 }
    }
  }
}
```

Contract semantics:

- `structuredContent` is authoritative and must validate against this schema. ScopeGuard ignores free-form text as Organization evidence.
- `content` contains a text block with the same JSON serialization for legacy compatibility. Optional `resource_link` blocks are informational only.
- `citationId` and `rank` are unique and contiguous within one response. `score` is provider-specific ranking data, not a confidence or truth score.
- `complete` with an empty `results` array means only "no matches returned for this query". It does not prove that no relevant Organization knowledge exists.
- `partial` requires at least one warning and is visibly marked incomplete. Each valid result may be used as evidence, but the set must not be represented as exhaustive.
- An unavailable service, timeout, cancellation, authorization failure, malformed response, or zero valid citations is not an empty success. Return an explicit unavailable/error state and inject no Organization evidence into model context.
- Drop an invalid item, mark the response `partial`, and record a sanitized warning. Reject the whole call if top-level validation fails, every item is invalid, duplicate citation IDs remain, or the decoded response exceeds 512 KiB.
- A model-rendered citation is valid only when its `citationId` resolves to the immutable evidence set supplied for that model run. Unknown or fabricated IDs are rendered as unverified text, never as a clickable citation.

MCP distinguishes JSON-RPC/protocol errors from tool execution errors (`isError: true`) ([tool error handling](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)). ScopeGuard maps both to a typed application failure and never interprets an error's text content as evidence.

## 5. Timeout, cancellation, and retry contract

**Specification fact.** Implementations should time out every sent request, cancel after timeout, may reset an inactivity clock on progress, and should always retain an absolute maximum. HTTP cancellation closes the request's SSE response stream; `stdio` sends `notifications/cancelled`. Servers should stop work and free resources, but cancellation is best effort and clients should ignore a late response ([cancellation specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)).

**ScopeGuard V1 recommendation.** Apply these exact limits:

| Operation | Inactivity timeout | Absolute timeout |
| --- | ---: | ---: |
| `server/discover`, legacy initialization, `tools/list` | 10 s | 10 s |
| Each OAuth metadata/token network request | 10 s | 10 s |
| One non-interactive OAuth discovery/token attempt | 30 s aggregate | 30 s |
| Desktop browser authorization callback | 5 min | 5 min |
| Organization `tools/call` | 30 s, reset by valid progress | 60 s |
| Personal/Workspace `tools/call` | 60 s, reset by valid progress | 300 s |
| Graceful `stdio` process shutdown | n/a | 5 s, then terminate; kill after 2 s more |

Use one `AbortSignal` from UI/application request through projection, MCP SDK, HTTP stream or `stdio` cancellation, and downstream retrieval. Timeout and user cancellation are distinct terminal states. Late results are discarded and cannot enter the conversation's active context.

There is no automatic retry for Desktop personal/Workspace `tools/call`, because MCP annotations are untrusted and a timed-out call may already have caused a side effect. After reauthorization or reconnect, the Member or agent must initiate a new call under the normal approval rules. Organization search is contractually read-only and may be replayed exactly once after a successful access-token refresh; network, timeout, malformed-result, and 5xx failures are not retried in V1.

Cancellation does not imply rollback. For any non-read-only Desktop tool, timeout/cancellation is recorded as `effect_unknown`, not failed-with-no-effect. V1 does not enable the optional MCP Tasks extension; long-running operations beyond the limits above are unsupported.

## 6. Desktop personal and Workspace MCP behavior

### 6.1 Connection scopes

**ScopeGuard V1 recommendation.** Every Desktop connection has an immutable owner scope:

- `personal`: available to the Member's local conversations after explicit per-conversation selection.
- `workspace`: available only inside one local Workspace and stored locally; it is not an Organization-shared credential or server-synced team connection in V1.

Changing scope creates a new connection record and does not copy credentials automatically. Agent Templates can name a recommended connection capability but cannot install a server, start a process, open OAuth, import a secret, enable a connection, or broaden its scope.

Connection setup and first enablement are always explicit Member actions, independent of Conversation Execution Profile. Official MCP security guidance requires showing the exact local startup command, obtaining consent, and restricting local processes with sandboxing and least privilege ([local server guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#local-mcp-server-compromise)).

### 6.2 Reviewed effect manifest

**Specification fact.** MCP tool annotations such as `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` are hints, and clients must treat them as untrusted unless the server is trusted. MCP itself cannot enforce the host's consent or permission model ([tools safety](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [core security principles](https://modelcontextprotocol.io/specification/2026-07-28#security-and-trust-safety)).

**ScopeGuard V1 recommendation.** On verification, Desktop snapshots each tool's name, description, input schema, output schema, and annotations. The Member reviews a ScopeGuard-owned effect manifest:

```text
filesystem: none | workspace_read | workspace_write | outside_workspace
process:    none | command | script
network:    none | declared_hosts | open
effect:     read | write | destructive | unknown
```

MCP annotations may prefill this form but never authorize execution. `unknown` maps to the most restrictive category. A changed tool name/schema/manifest hash disables that tool until reviewed again. Roots are context hints, not a sandbox; the Desktop host must enforce actual file, process, and network restrictions.

### 6.3 Permission mapping

Three gates are cumulative and evaluated in this order:

1. connection is enabled and selected for this personal/Workspace scope;
2. Organization Agent Policy permits the connection/tool category;
3. the active Conversation Execution Profile permits or approves this invocation.

The most restrictive gate wins. Only the Member can upgrade the active profile.

| Invocation category | Request Approval | Auto Approve | Full Access |
| --- | --- | --- | --- |
| Reviewed read strictly inside Workspace; no network/process | Auto | Auto | Auto |
| Reviewed write strictly inside Workspace | Prompt | Auto | Auto |
| Reviewed command/script restricted to Workspace | Prompt | Auto | Auto |
| Reviewed remote HTTP call or declared-host network | Prompt | Auto | Auto |
| Outside-Workspace file access | Prompt | Prompt | Auto |
| Open/undeclared network access | Prompt | Prompt | Auto |
| Reviewed tool with `unknown` effect | Prompt | Prompt | Auto |
| Changed or unreviewed tool | Block until explicit Member review | Block until explicit Member review | Block until explicit Member review |
| Install/enable connection, change executable/endpoint, add scope/secret | Explicit Member action | Explicit Member action | Explicit Member action |
| Read/export raw credentials | Never | Never | Never |

For remote tools, a claimed read-only operation is still a network disclosure because request data leaves the computer. Auto Approve therefore requires a reviewed host allowlist and effect manifest. Full Access removes local per-call prompts but does not override Agent Policy, connection ownership/scope, Organization knowledge rules, enterprise permissions, or credential isolation.

Profile downgrade cancels in-flight calls that exceed the new profile and restarts affected `stdio` servers under the new sandbox. Profile upgrade is effective only after Member confirmation. ScopeGuard retains only the bounded operational state required to execute, present, cancel, and recover the current or recent Run. It does not create a durable MCP audit ledger or user-facing receipt. Diagnostics exclude secrets and raw evidence excerpts and follow the local Run-retention policy.

## 7. Recommended V1 contract

The implementation ticket following this research should treat the following as the V1 contract:

1. Use official TypeScript MCP client `2.0.0`; allow protocol `2026-07-28` and legacy `2025-11-25` only, modern first. Revalidate before dependency lock because MCP and SDK releases are date-sensitive.
2. Organization knowledge is server-side HTTPS Streamable HTTP. Desktop calls a ScopeGuard application endpoint and never receives the MCP endpoint credential. The server exposes only a fixed, read-only `search_organization_knowledge` adapter.
3. Organization auth is pre-registered OAuth Client Credentials, preferring `private_key_jwt`, then client secret. Static Bearer is an explicit compatibility exception. The service credential stays in server secret storage, uses the minimum read scope, and is never a Member or provider token passthrough.
4. Organization access is authorized by the logged-in Member plus `organization_knowledge.read`; V1 gives every active Organization Member the same knowledge set. Agent and Agent Template identities do not select knowledge permissions.
5. The Organization tool uses the exact input/output schemas above. Only validated `structuredContent` is evidence. Every evidence item requires source ID, title, canonical URI, precise location label, and verbatim excerpt. Unknown, malformed, partial, unavailable, timeout, and cancelled states remain explicit.
6. Desktop supports Member-managed local `stdio` and advanced remote HTTPS Streamable HTTP. Remote OAuth uses system-browser Authorization Code plus PKCE. Secrets are OS-protected and main-process-only; `stdio` receives only allowlisted environment variables.
7. Desktop connection setup is always explicit. Runtime calls require connection scope, Agent Policy, and Conversation Execution Profile. ScopeGuard's reviewed effect manifest, not untrusted MCP annotations, drives approval and sandbox enforcement.
8. Use the timeout table above, propagate one cancellation signal end to end, discard late results, and do not automatically retry arbitrary tool calls. V1 does not enable Tasks, custom transports, WebSocket, or deprecated HTTP+SSE.
9. Organization citation opening uses an authenticated ScopeGuard route backed by an opaque citation reference. It reauthorizes the current Member and never places provider credentials in Desktop state, URLs, logs, transcripts, or model context.
10. Before implementation acceptance, run official SDK interoperability/conformance tests against one modern HTTP server, one legacy HTTP server, one modern `stdio` server, one legacy `stdio` server, OAuth PKCE, client credentials, cancellation races, malformed/oversized evidence, tool-list drift, offline state, and secret-store failure.

## 8. Unresolved risks

1. **Client Credentials stability.** The official extension is still Draft. Pin its extension identifier and tested SDK version, and reassess its normative text before implementation and before each SDK upgrade.
2. **Provider contract gap.** Scope names, source URI schemes, stable source/revision identifiers, collection semantics, and support for the required citation schema must be negotiated with the enterprise knowledge provider. A provider that cannot return source location plus excerpt cannot satisfy the V1 evidence contract.
3. **Citation retention.** Product/legal policy must set retention for server-side `citationRef` records and cached excerpts. Deleting or revoking a source must not leave a permanently openable server reference, while local historical transcripts still need an honest stale/unavailable state.
4. **Internal endpoint versus SSRF policy.** Some enterprise MCP services may be private-network endpoints. Operations must define an explicit allowlist and egress policy rather than weakening private/link-local blocking globally.
5. **Legacy fallback exposure.** Supporting `2025-11-25` adds session and negotiation behavior absent from modern MCP. Keep it behind the official SDK, test auth-gated probes, date cached verdicts, and remove fallback when provider adoption permits.
6. **Desktop sandbox parity.** Enforcing equivalent file/process/network limits on Windows and macOS is platform work, not an MCP feature. Personal/Workspace MCP must not be considered complete until those controls are tested against malicious local servers.
7. **Windows secret threat model.** Electron documents that DPAPI-backed `safeStorage` does not isolate secrets from another process running as the same Windows user. Decide whether the V1 enterprise threat model accepts that limitation or requires a stronger hardware/enterprise credential broker.
8. **Threshold tuning.** The proposed 512 KiB response, 4,000-character excerpt, and timeout limits are conservative defaults without production retrieval measurements. Changes must preserve explicit partial/unavailable semantics and cannot silently truncate into an apparently complete result.
