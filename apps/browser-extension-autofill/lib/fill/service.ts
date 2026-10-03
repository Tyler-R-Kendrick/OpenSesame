/**
 * The background's fill service (ADR 0150 §6.4): who may ask for what.
 *
 * Nothing runs on page load. The guard is registered only for sites a person
 * switched on (`lib/sites`), and even there it only listens. A gesture on
 * extension-owned UI — the manifest command, or the popup's fill key — is
 * the only thing that starts a fill: the background arms one nonce for the
 * tab's own origin and asks the guard in frame 0 to check the page. Only if
 * the guard's checks pass does it ask back for the value, and only if the
 * background's own checks on that sender pass — the browser's frame id and
 * origin, not the page's word, and the site still switched on — does the
 * daemon get called (`flow.ts`). The value goes to the guard in that one
 * reply and nowhere else: the popup, the command and the badge see outcome
 * codes.
 */
import { ArmLedger } from "./admit";
import { page, status, trigger, value } from "./flow";
import type { Trigger } from "./guard";
import { type FillPorts, type Flow, type RuntimeSender, codeOf } from "./ports";
import type {
  ErrorReply,
  FillRequest,
  FillStatus,
  OutcomeReply,
  PairState,
  ValueReply,
} from "./wire";

/** Every answer the background gives on `opensesame.fill`. */
export type BackgroundReply =
  | FillStatus
  | OutcomeReply
  | ErrorReply
  | ValueReply;

const FORBIDDEN: ErrorReply = { error: "forbidden_sender" };

/** Switch the tab in view on; the popup already holds the browser's grant. */
async function enable(
  flow: Flow,
  requested: string,
): Promise<FillStatus | ErrorReply> {
  const here = await page(flow);
  if (!here) return { error: "no_page" };
  if (requested !== here.origin) return { error: "origin_mismatch" };
  const outcome = await flow.ports.sites.enable(here.origin);
  return outcome === "enabled" ? status(flow) : { error: outcome };
}

async function disable(flow: Flow): Promise<FillStatus | ErrorReply> {
  const here = await page(flow);
  if (!here) return { error: "no_page" };
  await flow.ports.sites.disable(here.origin);
  return status(flow);
}

/** This extension's own page (the popup), not a tab's content script. */
function fromOwnPage(flow: Flow, sender: RuntimeSender): boolean {
  return (
    sender.id === flow.ports.ownId &&
    sender.tab === undefined &&
    sender.url?.startsWith(flow.ports.ownBase) === true
  );
}

/** `opensesame.fill.pair`: a pairing code for the popup to show. */
async function pairFrom(
  flow: Flow,
  sender: RuntimeSender,
): Promise<PairState | ErrorReply> {
  if (!fromOwnPage(flow, sender)) return FORBIDDEN;
  try {
    return await flow.ports.daemon.pair();
  } catch (cause) {
    return { error: codeOf(cause) };
  }
}

/** Route one decoded `opensesame.fill` request by who sent it. */
async function handle(
  flow: Flow,
  request: FillRequest,
  sender: RuntimeSender,
): Promise<BackgroundReply> {
  if (request.op === "value") {
    return sender.tab === undefined ? FORBIDDEN : value(flow, request, sender);
  }
  if (!fromOwnPage(flow, sender)) return FORBIDDEN;
  switch (request.op) {
    case "status":
      return status(flow);
    case "trigger":
      return trigger(flow, "popup", request.reference);
    case "enable":
      return enable(flow, request.origin);
    case "disable":
      return disable(flow);
  }
}

export function createFillService(ports: FillPorts) {
  const flow: Flow = { ports, ledger: new ArmLedger(ports.ownId) };
  return {
    handle: (request: FillRequest, sender: RuntimeSender) =>
      handle(flow, request, sender),
    pairFrom: (sender: RuntimeSender) => pairFrom(flow, sender),
    trigger: (how: Trigger) => trigger(flow, how),
    status: () => status(flow),
    ledger: flow.ledger,
  };
}
