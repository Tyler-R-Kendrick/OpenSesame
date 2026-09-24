/**
 * What each press of the join ceremony does (ADR 0136).
 *
 * An offer, once looked up, belongs to the endpoint and the invite it was
 * looked up with. Editing either lets go of it in memory — it is never
 * shown under another endpoint, and its bearer and code are never sent to
 * one — and no invite is presented twice from this device.
 */
import {
  JoinError,
  type JoinErrorCode,
  resolveEndpoint,
} from "@opensesame/app-core/lib/join/client.js";
import {
  acceptedItemIds,
  initialSelection,
  toggleItem,
} from "@opensesame/app-core/lib/join/consent.js";
import {
  normalizeInviteCode,
  parseInvite,
} from "@opensesame/app-core/lib/join/invite.js";
import type { JoinOffer } from "@opensesame/app-core/lib/join/wire.js";
import {
  type JoinRoad,
  nextJoinStep,
} from "@opensesame/app-core/screens/join/join-model.js";
import {
  DEAD,
  type Fields,
  type Offered,
  codeOf,
  deps,
  firstError,
} from "./join-state.js";

async function run(f: Fields, action: () => Promise<void>) {
  f.busy.set(true);
  f.error.set(null);
  try {
    await action();
  } catch (caught) {
    if (!f.lifetime.current.signal.aborted)
      f.error.set(codeOf(caught instanceof JoinError ? caught : null));
  } finally {
    if (!f.lifetime.current.signal.aborted) f.busy.set(false);
  }
}

/** The invite on screen, checked; the endpoint on screen, normalized. */
function current(f: Fields) {
  const endpoint = resolveEndpoint(f.endpoint.value);
  const invite = parseInvite(f.inviteText.value);
  if (!invite) throw new JoinError("bad_invite");
  return { endpoint, token: invite.token };
}

/** The offer, only if it belongs to what is on screen now. */
function heldFor(f: Fields, endpoint: string, token: string): Offered | null {
  const offered = f.offered.value;
  return offered && offered.endpoint === endpoint && offered.token === token
    ? offered
    : null;
}

/** Refused before reaching the offer, or the offer is dead: nothing spent. */
function unspent(code: JoinErrorCode | null): boolean {
  return (
    code === "verify_failed" ||
    code === "approval_expired" ||
    (code !== null && DEAD.includes(code))
  );
}

/** Present once, from this device, ever — or refuse to. */
async function present(endpoint: string, token: string): Promise<JoinOffer> {
  const held = deps.readPendingJoin();
  if (held && held.token === token) {
    if (held.endpoint !== endpoint) throw new JoinError("invite_elsewhere");
    return held.offer;
  }
  if (await deps.wasPresented(token)) throw new JoinError("invite_presented");
  // Marked before it goes out: an answer lost to a closed screen or a dropped
  // connection may still have spent the offer.
  await deps.markPresented(token, null);
  try {
    const offer = await deps.presentInvite(endpoint, token);
    await deps.markPresented(token, offer.expiresAt);
    return offer;
  } catch (caught) {
    if (unspent(caught instanceof JoinError ? caught.code : null))
      await deps.forgetPresented(token);
    throw caught;
  }
}

async function lookUp(f: Fields) {
  const { endpoint, token } = current(f);
  const offer = await present(endpoint, token);
  deps.writePendingJoin({ endpoint, token, offer });
  f.offered.set({ endpoint, token, offer });
  f.selection.set(initialSelection(offer));
}

/**
 * A join happened: forget the offer and the authority, and retire the front
 * door (ADR 0115) — only now, and never over an operator's own record.
 */
async function joined(f: Fields) {
  deps.clearPendingJoin();
  deps.endJoinAuthority();
  if (deps.loadSetup() === null) {
    await deps
      .completeSetup({ ways: [], service: false, skipped: [], joined: true })
      .catch(() => undefined);
  }
  f.step.set("done");
}

async function claim(f: Fields) {
  const { endpoint, token } = current(f);
  const offered = heldFor(f, endpoint, token);
  if (!offered) return lookUp(f);
  try {
    f.claimed.set(
      await deps.claimInvite(endpoint, {
        token,
        code: f.code.value,
        acceptedItemIds: acceptedItemIds(offered.offer, f.selection.value),
      }),
    );
  } catch (caught) {
    if (caught instanceof JoinError && DEAD.includes(caught.code)) {
      deps.clearPendingJoin();
      f.offered.set(null);
    }
    throw caught;
  }
  await joined(f);
}

async function ask(f: Fields) {
  const receipt = await deps.askToJoin(
    f.endpoint.value,
    f.sessionId.value,
    f.note.value,
  );
  f.receipt.set(receipt);
  // Asking seats nobody: only an admission is a join. A pending ask ends the
  // ceremony without retiring anything.
  if (receipt.decision === "admitted") return joined(f);
  deps.endJoinAuthority();
  f.step.set("done");
}

/** The first rung: checked here, sent nowhere. */
async function where(f: Fields) {
  const road = f.road.value;
  f.endpoint.set(resolveEndpoint(f.endpoint.value));
  if (road === "invite") {
    current(f);
    if (!normalizeInviteCode(f.code.value)) throw new JoinError("code_format");
  }
  f.step.set(nextJoinStep(road, "where"));
}

function commit(f: Fields): Promise<void> | undefined {
  const road = f.road.value;
  const step = f.step.value;
  const endpoint = f.endpoint.value;
  switch (step) {
    case "where":
      return run(f, () => where(f));
    case "approve":
      return run(f, async () => {
        f.prompt.set(await deps.beginApproval(endpoint));
      });
    case "verify":
      // Called from the press itself: the verification window is a popup.
      return run(f, async () => {
        await deps.verifyAt(endpoint, f.lifetime.current.signal);
        f.step.set(nextJoinStep(road, step));
      });
    case "review":
      return run(f, () => claim(f));
    case "ask":
      return run(f, () => ask(f));
    default:
      return;
  }
}

/** An edit clears what it could fix — never "this address cannot join". */
function edit(f: Fields, field: { set: (next: string) => void }) {
  return (next: string) => {
    field.set(next);
    f.error.set(firstError(null));
  };
}

/** Editing what an offer or a listing was read for lets go of it. */
function editWhere(f: Fields, field: { set: (next: string) => void }) {
  return (next: string) => {
    edit(f, field)(next);
    f.offered.set(null);
    f.sessions.set(null);
  };
}

/** Back to the first rung, the one place anything can be changed. */
function back(f: Fields) {
  const step = f.step.value;
  if (f.busy.value || step === "where" || step === "done") return;
  f.prompt.set(null);
  f.error.set(null);
  f.sessions.set(null);
  f.step.set("where");
  deps.endJoinAuthority();
}

export function controls(f: Fields) {
  return {
    commit: () => commit(f),
    chooseRoad(next: JoinRoad) {
      if (f.step.value !== "where" || f.busy.value) return;
      f.road.set(next);
      f.error.set(firstError(null));
    },
    setEndpoint: editWhere(f, f.endpoint),
    setInviteText(next: string) {
      editWhere(f, f.inviteText)(next);
      // A pasted link that names its endpoint fills the field, in view,
      // before anything is sent — never silently at the press.
      const named = parseInvite(next)?.endpoint;
      if (named) f.endpoint.set(named);
    },
    toggle(id: string) {
      const offered = f.offered.value;
      if (offered)
        f.selection.set(toggleItem(offered.offer, f.selection.value, id));
    },
    setCode: edit(f, f.code),
    setSessionId: edit(f, f.sessionId),
    setNote: edit(f, f.note),
    back: () => back(f),
    /**
     * Walk away. Authority ends now; a looked-up offer stays in this tab
     * until it expires, because asking the endpoint again would burn it.
     */
    abandon() {
      f.lifetime.current.abort();
      deps.endJoinAuthority();
    },
  };
}

export function acceptedCount(f: Fields): number {
  const offered = f.offered.value;
  return offered ? acceptedItemIds(offered.offer, f.selection.value).length : 0;
}
