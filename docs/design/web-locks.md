# Web Locks

Status: implemented for every shared browser-local ledger.

The PWA uses the browser's [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
to serialize writes that more than one tab, window or worker can reach. The
lock manager is a browser capability, not a server feature: it never leaves the
origin, and it is released when the holding context is destroyed.

## Lock names

One namespace per vault and ledger:

```text
opensesame:local-session:<tomb>
opensesame:local-share:<tomb>
opensesame:local-share-pending:<tomb>
opensesame:local-audit:<tomb>
opensesame:local-receipts:<tomb>
opensesame:local-rotation:<tomb>
```

`<tomb>` is the vault's local identifier. The names are stable across tabs and
workers on the same origin.

## Coverage

| Area | Lock | Why |
|---|---|---|
| Vault body writes | body write lock | one sealed body revision at a time |
| Vault open leases | shared/exclusive open lease | a writer waits for readers; a new reader waits for a writer |
| Capability commits | capability lock | durable generation compare and commit |
| Local directory | directory lock | revision-checked identity writes |
| Vault sessions | `local-session` | create, start, stop, redeem, expiry sweep |
| Standing shares | `local-share` | create, revoke, session revoke, pending-share drop |
| Pending shares | `local-share-pending` | submit, approve, deny |
| Access audit | `local-audit` | append connector grant/revoke events |
| Receipts | `local-receipts` | append value-blind receipts |
| Rotation queue | `local-rotation` | one relay pass per vault |

The vault body, open lease and capability locks are described in their own
design notes. This document covers the four local Access ledgers.

## Order

When an operation needs more than one ledger, the order is:

```text
session -> share -> audit / receipts
pending share -> share -> audit / receipts
rotation -> schedule/event writes
```

A session start takes the session lock, issues shares under the share lock and
then records receipts. A share grant takes the share lock and then appends the
connector trail under the audit lock. Approval of a pending share holds the
pending-share lock, creates the share under the share lock, then removes the
request. No path takes a lock to the left after one to the right. This is what keeps concurrent tabs from deadlocking.

The lock helper also keeps an in-tab promise chain per name. That chain gives
FIFO order inside one tab; Web Locks gives it across tabs. Both are needed: the
chain does not coordinate tabs, and Web Locks does not promise FIFO fairness.

## Fallback

`withLocalAccessLedgerLock` behaves in three ways:

1. **Web Locks present**: request the named lock, refresh the file from durable
   storage, run the action, release.
2. **No Web Locks, memory-backed vault**: refresh and run locally. This is the
   test and ephemeral-vault path.
3. **No Web Locks, persistent vault**: refuse the write with
   `Web Locks are required for shared access writes.` A persistent vault must
   not have two tabs write the same ledger without a fence.

The fallback is deliberately fail-closed only for durable shared writes. A
read-only view still works, and a browser without Web Locks can still use the
vault; it cannot mutate these ledgers from two contexts at once.

## What Web Locks do not cover

- They are origin-scoped. Two different origins, browsers or profiles do not
  share them.
- They do not defend against a hostile same-origin script. The PWA's CSP and
  same-origin model do.
- They are not a substitute for the sealed vault key, authorization checks or
  revision checks. They only serialize writers.
- They do not persist across a full browser restart. The browser releases a
  lock when its context ends.
- The implementation does not use `steal`, because taking a live lock would
  break the revision check that already guards the write.

## Diagnostics

A future settings panel can read `navigator.locks.query()` to show held and
pending names. It must display lock names only; they contain a local tomb
identifier, not a secret. `query()` is not required for correctness and is not
in the current port type.

## Test rule

Browser tests that stub `navigator.locks` must queue **per lock name**, not with
one global queue. A global queue deadlocks as soon as an action takes a second
distinct ledger lock, which the real browser allows. The fixtures for local
requests, access bootstrap and vault sessions use per-name queues.

## Native/PWA split

- **PWA**: uses Web Locks for coordination between tabs and workers.
- **Native CLI/daemon**: uses its own file and process locks; it does not pretend
  to hold browser Web Locks.
- **Host**: has no role in lock acquisition and never sees a lock name.

## Acceptance

- Two concurrent share writes both survive; neither overwrites the other.
- Two concurrent pending submissions return the same request.
- Two concurrent vault-session creates both survive.
- A session start issues shares while holding the session lock, in the order
  session then share.
- A share revoke records its trail before removing the share.
- A persistent vault with no Web Locks refuses a shared access write.
- A memory-backed vault with no Web Locks still completes the write locally.
- Tests use per-name lock queues.
