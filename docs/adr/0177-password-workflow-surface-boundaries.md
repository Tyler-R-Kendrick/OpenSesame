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

The PWA operates on its own unlocked local vault through shared app-core, and
it has no password-workflow screen of its own. Each capability lives where the
vault already shows what it acts on, and is drawn from the controls the vault
already uses:

| Capability | Where a person does it |
| --- | --- |
| Find, inventory | The vault list and its search; the list is the inventory |
| Reference-only environment template | A key on the item's toolbar: one `os://` reference per secret field, no values |
| Plaintext `.env` | The key beside it, which asks twice: the first press writes nothing |
| Read one value | The field's own reveal and copy |
| Compare, replace a login's password | The update key on the password row. Enter, then a compare key whose answer is a mark; save is the verified write |
| Organization review | **Password health**, as findings that link to the item |
| Create a credential | New item |

The item page gains no section: the credentials an item holds are already its
rows, so a second listing of them (a "References" group) would only repeat what
is above it. A type chosen while an account is a draft is installed for that
draft and remembered by nothing; abandoning the account gives it back, and
saving an account with a credential of that type is what makes it the vault's.

These are equivalent workflows over a different vault; browser references use
`os://`, not `op://`. They do not claim access to a native 1Password account.
Provider administration, process execution and native leases stay on the native
CLI, and the browser draws no form for them.

The local adapter follows [Accounts and login methods](0172-accounts-and-login-methods.md). References bind individual method IDs; comparison and update select one password method and preserve every sibling method. Pepper-sealed and Sphinx passwords require the existing human account controls and are never substituted with a stored plaintext value. Those human controls use a shared core write guard that retains the original account across private prompts, checks current write authority, refuses withdrawal or concurrent edits, and verifies readback after one save.

Actual metadata operations are exposed through Pages WebMCP under existing
dedicated workflow permissions and unlock/share checks. Plaintext values, human
candidate input and mutations that accept those values never become agent
tools. A metadata-only handoff tool accepts an action selector and, optionally,
an item id; it navigates to the new-item page or the item's own page, where the
human enters private input or confirms a plaintext download. It never accepts
private values or returns plaintext, as required by [ADR 0005](0005-authority-handle-connectionref.md) and
[ADR 0065](0065-agent-surface-parity.md).

Host MCP remains a Host capability client. It has neither browser vault
custody nor native provider custody. It therefore does not claim inventory
or audit of either vault, and does not add a static discovery tool as a
substitute for a working operation. Native workflows remain available to
authorized native CLI callers; browser agent metadata workflows run in
Pages WebMCP. The protocol MCP client advertises none of this: it exposes Host
API tools, and a catalogue of PWA addresses is not one.

The extension has no password workflow. Its independently sealed candidates and
origin grants stay under [ADR 0076](0076-autonomous-web-login-rotation.md); it
neither opens nor reads the PWA vault for these tasks, and its popup draws no
link to them.

Android and Apple authenticator applications remain OpenID4VC wallets,
under [ADR 0086](0086-wallet-native-interaction-layer.md). They are excluded
from native password-provider and browser-vault workflows because they
have neither store nor provider integration. Mobile browser and installed
PWA users use the same item pages. Native wallet password parity is not
claimed.

## Native request execution through protocol MCP

Native leases and requests belong to the human CLI. The PWA holds neither the
lease store nor the provider session and draws no form that prepares their
commands; Access administers the local vault's own grants and requests.

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

## Amendment 2026-10-07: the workflow sheet was a misreading

The first integration put every workflow on one bolt-on screen, "Password
workflows", reachable from the vault toolbar, the phone Add menu, the
extension popup and a `?workflow=password` address, and added a native
request-command form to Access and a resource to the protocol MCP client. The
request had been to expose the existing workflows *in the natural item-detail
or organization-health context* (`item-context.invocation`,
`health-context.invocation`). The sheet duplicated those contexts in raw
fieldsets, labels and a JSON dump, ignored DESIGN.md's control rules (word
buttons, explainer prose, a second way out) and gave the same task two homes.
It is removed with its entry points; the table above is the only PWA surface.
A first replacement then drew a "References" group at the foot of the item that
repeated the credentials above it, and was rejected for the same reason; the
two template keys sit on the toolbar instead.
`createPrivateCredential` goes with it: New item is how a person creates an
item, and a second creation path with its own duplicate rule was not one the
vault asked for.

The local audit also treated a folder as the place a tag would be, so that a
vault with no tags did not report every key and token as untagged.
