# ADR 0177: Password workflows follow the vault that owns the credentials

Status: Accepted

## Context

The 2password parity gauntlet spans native password-manager commands and
browser users. OpenSesame has separate native provider, local browser vault,
Host agent MCP, extension runner, and native credential wallet boundaries.
A surface must not claim a provider operation merely because it can display
its name.

## Decision

Native provider workflows execute in core and are exposed through the CLI.
The provider session, `op` subprocess, human-selected plaintext outputs,
stdin candidate, credential creation and updates remain on that native
human/device plane. No browser remote command runner is introduced.

The PWA operates on its own unlocked local vault through shared app-core.
Its password workflow sheet supports reference search, inventory,
organization audit, reference-only environment templates, and human-only
private credential creation, comparison and update, and deliberate local credential or env downloads. These are equivalent
workflows over a different vault; browser references use `os://`, not `op://`.
They do not claim access to a native 1Password account.

The local adapter follows [Accounts and login methods](0172-accounts-and-login-methods.md). References bind individual method IDs; comparison and update select one password method and preserve every sibling method. Pepper-sealed and Sphinx passwords require the existing human account controls and are never substituted with a stored plaintext value. Those human controls use a shared core write guard that retains the original account across private prompts, checks current write authority, refuses withdrawal or concurrent edits, and verifies readback after one save.

Actual metadata operations are exposed through Pages WebMCP under existing
dedicated workflow permissions and unlock/share checks. Plaintext values, human
candidate input and mutations that accept those values never become agent
tools. A metadata-only handoff tool accepts an action selector, navigates to the matching human control, and requires the human to enter private input or confirm a plaintext download. It never accepts private values or returns plaintext, as required by [ADR 0005](0005-authority-handle-connectionref.md) and
[ADR 0065](0065-agent-surface-parity.md).

Host MCP remains a Host capability client. It has neither browser vault
custody nor native provider custody. It therefore does not claim inventory
or audit of either vault, and does not add a static discovery tool as a
substitute for a working operation. Native workflows remain available to
authorized native CLI callers; browser agent metadata workflows run in
Pages WebMCP.

The extension popup opens `/vault?workflow=password` in the PWA. That human
handoff offers task selectors for create, compare, update, read and env-resolve, and a separate Access Requests navigation link. Each carries only fixed workflow selectors and uses `noopener noreferrer`.
The extension runner's independently sealed candidates and origin grants
stay under [ADR 0076](0076-autonomous-web-login-rotation.md); this link
does not grant access to the PWA vault or make it a shared runner store.

Android and Apple authenticator applications remain OpenID4VC wallets,
under [ADR 0086](0086-wallet-native-interaction-layer.md). They are excluded
from native password-provider and browser-vault workflows because they
have neither store nor provider integration. Mobile browser and installed
PWA users use the same password workflow sheet. Native wallet password
parity is not claimed.

The protocol MCP client exposes a discoverable read-only resource at
`opensesame://guides/password-workflows`. It contains human routes and
custody guidance rather than fabricated vault inventory or native request
state. It does not call the Host or grant approval. Browser pairing currently
has sync and join ceilings; native password request metadata and decisions
require a separately authorized native bridge before a browser can execute
them. Access can explain native CLI approval and lease controls without
claiming that Identity ceremonies govern an independent provider request.

## Native request execution through protocol MCP

The existing Host MCP task path freezes an operation, resource, audience and
arguments under the task ceiling, then `task_invoke_l1` submits only the
frozen digest. This is the applicable agent execution path for a future
native private-request connector; a separate Node subprocess tool would
bypass that authority and is not an integration.

Today, the native lease database and request executor belong to the human
CLI adapter. The connector-host module supplies pure binding policy but no
registered request connector. Native leases bind a local-store principal,
not the Host's organization and authenticated task principal. Consequently
an agent passing a local lease ID to an existing Host invocation has no
supported executor or equivalent authorization contract. A guidance
resource is a handoff, not native request execution parity.

A real connector must receive a `ConnectionRef` rather than a provider
secret reference, resolve approved provider custody internally, and freeze
the exact destination, header, prefix and lease identifier into the task
intent. It must bind the lease to the authenticated principal and
organization, enforce the connection and task ceilings, atomically reserve
a use before secret access, apply the native DNS/redirect/response limits,
and return an allowlisted receipt with status and byte count only.
Approving a lease remains a human ceremony. Neither the provider value nor
the upstream response body may enter an agent result. Existing constrained
HTTP returns a scrubbed response body, so that executor's response contract
cannot be treated as this receipt-only private request contract.

Once this connector is implemented and registered, the existing frozen
task tools can invoke it without adding a secret-reading MCP tool. Until
then, native request execution is an explicit protocol MCP exclusion;
Identity/local-vault approvals and local lease IDs do not substitute for
authorized Host connections.

## Credential-bearing process startup

Both CLI adapters reserve interpreter startup variables before provider
execution. Shared core policies reject these keys in injected assignments
and environment templates, including case variants and ambiguous dotenv
syntax. Helpers remove inherited startup hooks before authenticating.
Environment execution reads the source once and supplies an owner-only
snapshot of the validated contents; changing the original file cannot
restore a startup hook between validation and execution. The selected child
receives ordinary resolved variables after the provider service token is
removed. Snapshots are removed after execution.

## Verification

Parity evidence must distinguish native provider execution from browser
local-vault execution and exclusions. CLI/provider runtime tests, unlocked
PWA/WebMCP tests, and an extension handoff test verify their respective
boundaries. A registry binding or a documentation label alone is not proof
of behavior.
