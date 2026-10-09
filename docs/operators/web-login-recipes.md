# Web-login recipes: signers, signing and the canary

How an organization gets a web-login rotation to run on its own: store a
**recipe** (the change-password page and the fields on it), have it **signed**
by a key the organization pinned, and prove it with one **canary** run you
watch. The decision and its reasons are in
[ADR 0076](../adr/0076-autonomous-web-login-rotation.md) §4 and
[ADR 0159](../adr/0159-agent-hooks-interceptor.md); the recipe schema this
implements the executor's half of is
[rotation-recipe-schema](../architecture/rotation-recipe-schema.md).

Until a recipe exists and is trusted, a web-login rotation does nothing it was
not told to: the job parks with *no verified recipe for this origin* and says
so. That is by design — a rotation that guesses at a third party's settings
page is how an account gets locked.

In this document `opensesame rotate …` is `opensesame access connectors rotate
…`, which is how the binary spells it; the commands below use the full form.

## What a recipe is

A recipe is a statement about a site, the same for every user of it: one
origin, one https change-password URL on that origin, and the selectors the
executor acts on. It carries **no value, no account and no session**, and it is
not a new step language — the steps are the ones the executor already takes
(navigate, fill the current and new password from the vault by reference,
assert the new value is in the field, submit, verify by a fresh login), and the
document names only the page and the fields.

This is the example the rest of this page uses. It is the file
`docs/operators/examples/web-login-recipe.example.json`, and the tests run it:

```json
{
  "schema_version": 1,
  "recipe_id": "rcp_login_example",
  "origin": "https://login.example",
  "expires_at": "2030-01-01T00:00:00Z",
  "change_password": {
    "change_url": "https://login.example/.well-known/change-password",
    "current_password_selector": "#current-password",
    "new_password_selector": "#new-password",
    "confirm_password_selector": "#confirm-password",
    "submit_selector": "button[type=submit]"
  }
}
```

| Member | Meaning |
|---|---|
| `schema_version` | Must be `1`. |
| `recipe_id` | `rcp_` and 1 to 63 of `a-z`, `0-9`, `_`, `-`. Named in receipts and replay overlays. |
| `origin` | A canonical https origin: no path, query, fragment or credentials, the default port left off, the host in lower case. It is the one in the URL you store it under. |
| `expires_at` | RFC 3339, no more than 93 days from now when stored (a quarter, the schema's review checklist). After it the recipe is not replayed. |
| `change_password.change_url` | https, on the recipe's own origin, no credentials. |
| `change_password.*_selector` | The fields. `new_password_selector` and `submit_selector` are required; `current_password_selector` and `confirm_password_selector` are optional. Each is 1 to 512 characters. |
| `canary` | Optional: `{ "verified_at": … }`, a signer's attestation that the recipe completed a real change, verified by a fresh login. It counts only inside a verified signature, and only if it is under 90 days old. |
| `signature` | Optional: `{ "alg": "ed25519", "key_id": "rsk_…", "value": "<hex>" }`. `recipe sign` writes it. |

Every object is **closed**: a member this build does not know — `trust`, a
`steps` list, a `value` — is a refusal, never something a signature quietly
covers. A document is at most 16 KiB.

## Who trusts a recipe, and how

A recipe is **trusted only by a verification the Host performs**. A request
never names a trust, and no route accepts one.

1. **Signers.** An owner or admin pins the Ed25519 *public* keys the
   organization trusts to sign recipes (`signer add`). The Host never holds a
   private key. A key's id is derived from the key (`rsk_` and 32 hex of its
   SHA-256), so nobody picks one. Pinning takes a **step-up**: the operator
   token, or a native session carrying a fresh passkey (no session carries one
   today, so the operator token is what satisfies it). A role alone is not
   enough, because an agent framework often runs under an administrator's own
   token, and a key it could pin would sign the recipes that govern it.
   Revoking (`signer rm`) takes none — it is the safe direction — and is
   final: the key can never be pinned again. Keep the private key where the
   agent cannot read it: a key file readable by the user an agent runs as
   signs whatever that agent asks, and the Host cannot tell.
2. **Signature.** `recipe put` checks the document's signature against the
   pinned, unrevoked signers, over the document's RFC 8785 canonical JSON
   with a domain tag (`opensesame/web-login-recipe/v1`), so whitespace and
   member order change nothing and a signature for a recipe is not a signature
   for anything else. A signature that does not verify — an unpinned or
   revoked key, an edited document — is refused `422` and nothing is stored.
   An **unsigned** document is stored, as a `candidate`, and no run replays it.
3. **Canary.** A signed recipe is *verified*, not yet *proven*. It is
   `canary_verified` once a real change through it has been confirmed by a
   fresh login: either the signer attests it inside the signed document
   (`recipe sign --canary-at now`, which the signer answers for), or the Host
   records it itself after a run you started (`recipe canary`) completes. The
   Host's own record is against the exact document that ran, so a recipe
   replaced mid-run is not credited.

What a run needs:

| | Signed by a pinned key | Unexpired | A passing canary under 90 days old |
|---|---|---|---|
| **Attended** run (`recipe canary`: a person asked for it and drives it) | yes | yes | not needed |
| **Unattended** run (the lifecycle scanner, nobody watching) | yes | yes | yes |

An attended run needs no canary because it is how the first one happens. An
unattended run without one parks the job with *the recipe for this origin has
no passing canary yet*.

The runner does not take the stored `trust` on its word either. At the start of
every run it reads the stored document, checks its signature against the
signer's key as the store holds it *now*, checks it is the document its digest
names, and replays the steps in that document and nowhere else. So a revoked key
stops its recipes at the next run, and a row edited behind the Host's back is
the same as no recipe.

A run that finds the page no longer matches the recipe, or submits a change it
cannot confirm, **demotes** the recipe (`candidate`, canary `failed`): the
scanner stops running it alone until a person proves it again. A run that stops
for any other reason — a challenge, a person taking the page, a refused step —
proves nothing about the recipe and changes nothing. Re-signing the same steps
with a new expiry (a renewal) keeps what a real run proved; changing the steps
does not.

## A worked example

You need the operator token (`OPENSESAME_OPERATOR_TOKEN`) for the step-up, and
a signed-in native session of an owner or admin, who drives the canary from
their own browser.
`$RECIPE` is the example file above.

```bash
opensesame access connectors rotate signer keygen --out $KEY
opensesame access connectors rotate signer add --key $KEY --label release-signer
opensesame access connectors rotate recipe sign --key $KEY --expires-in-days 60 $RECIPE --out $SIGNED
opensesame access connectors rotate recipe put $SIGNED --if-version 0
opensesame access connectors rotate recipe canary https://login.example
opensesame access connectors rotate recipe get https://login.example
```

1. `signer keygen` writes a private key to `$KEY` (mode `0600`, never
   overwritten) and prints only its public half and id. Signing is a **local**
   act: the key is a file this process reads, never an argument, never printed
   and never sent.
2. `signer add` pins the public half. The Host answers with the key's id.
3. `recipe sign` writes `$SIGNED`: the same document, `expires_at` set 60 days
   out, and a signature. It refuses a recipe outside its window.
4. `recipe put` stores it. `--if-version` is the version you read (`0` for a
   new recipe); a recipe someone else changed since is refused, not overwritten.
   The answer says `trust: candidate` and `runnable.attended: true`: the
   signature checked, and nothing has proven it yet.
5. `recipe canary` asks for one attended run, driven from your own browser. The
   run answers `202` and goes on without the command; follow it with
   `opensesame access connectors rotate runs`.
6. `recipe get` now shows `trust: canary_verified`, the canary (`source: run`,
   the run's id) and `runnable.unattended: true`: the scanner may rotate this
   login on its own schedule.

To renew before it expires, sign the same file again with `--expires-in-days`
and `put` it at the version `get` printed. To take a recipe out of service at
once, revoke its signer (`signer rm KEY_ID`); to remove it, `recipe rm ORIGIN
--if-version N`.

## Reading what the Host holds

`recipe ls` and `signer ls` print tables (`--output json` for the JSON). Each
recipe shows its trust, version, signer, canary and whether a run may replay it
attended and unattended, each decided by the runner's own rule, so what you read
is what the next run will do.

## The Host API

All routes are for an owner or admin of the organization, or the operator, as a
native session — never an agent capability and never a browser grant. The
recipes govern the agent, so the agent has no tool to read or write them
(ADR 0076 §1, ADR 0159). The origin is a percent-encoded path segment
(`https%3A%2F%2Flogin.example`).

| Route | |
|---|---|
| `GET /api/v1/web-login/recipes` | The recipes, each with `runnable`. |
| `GET\|PUT\|DELETE /api/v1/web-login/recipes/{origin}` | One recipe. `PUT` and `DELETE` need `If-Match: "<version>"`; the version is the `ETag`. |
| `POST /api/v1/web-login/recipes/{origin}/canary` | One attended run, for the calling owner or admin only (a native session of their own — not the operator, who has no browser to drive, and not a member). |
| `GET\|POST /api/v1/web-login/signers` | List, and pin (step-up). |
| `DELETE /api/v1/web-login/signers/{key_id}` | Revoke. |

Every change commits an outbox audit event with its row —
`web_login.recipe.put`, `web_login.recipe.deleted`, `web_login.signer.pinned`,
`web_login.signer.revoked` — carrying ids and digests, never the document.
`openapi`: `spec/openapi/host-api.yaml`.

## What this does not do

- It does not record or teach recipes. There is no recorder and no teaching
  surface; a recipe is written by a person and signed by a person.
- It does not make a recipe safe to leave alone forever. A site changes on its
  own schedule, which is what the expiry, the canary's age and the demotion on
  drift are for.
- It does not widen what an agent may do. A recipe is selectors and one URL; the
  secret never appears in it, and the run is still hosted under the
  organization's agent-hooks policy ([agent hooks](agent-hooks.md)).
