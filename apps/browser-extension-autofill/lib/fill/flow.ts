/**
 * The steps of one fill (ADR 0150 §6.4): find the page, choose the entry,
 * arm one gesture, and answer the guard's value request. `service.ts` routes
 * messages to these; every step takes the shared `Flow`.
 */
import { type SenderFacts, webOriginOf } from "./admit";
import type { Trigger } from "./guard";
import { type Flow, type Page, type RuntimeSender, codeOf } from "./ports";
import { ARM_MESSAGE } from "./protocol";
import type {
  ArmMessage,
  FillStatus,
  GuardReply,
  OutcomeReply,
  ValueReply,
  ValueRequest,
} from "./wire";

const CHOICE_PREFIX = "fillChoice:";

export async function page(flow: Flow): Promise<Page | null> {
  const tab = await flow.ports.activeTab();
  const origin = webOriginOf(tab?.url);
  return tab && origin ? { tab, origin } : null;
}

/** Reach the guard; inject it into frame 0 only if it is not listening. */
async function deliver(
  flow: Flow,
  here: Page,
  message: ArmMessage,
): Promise<GuardReply> {
  try {
    return await flow.ports.send(here.tab.id, message);
  } catch {
    await flow.ports.inject(here.tab.id);
    return flow.ports.send(here.tab.id, message);
  }
}

/** Arm one gesture (a fill) or none (a probe) and ask the guard. */
async function arm(
  flow: Flow,
  here: Page,
  trigger: Trigger,
  reference: string | null,
): Promise<GuardReply> {
  const message: ArmMessage = {
    type: ARM_MESSAGE,
    mode: reference === null ? "probe" : "fill",
    nonce: flow.ports.nonce(),
    origin: here.origin,
    trigger,
    armedAt: flow.ports.now(),
  };
  if (reference !== null) {
    flow.ledger.arm({
      nonce: message.nonce,
      tabId: here.tab.id,
      origin: here.origin,
      reference,
      trigger,
      armedAt: message.armedAt,
    });
  }
  try {
    return await deliver(flow, here, message);
  } catch {
    return { outcome: "guard_unavailable" };
  }
}

async function chooseReference(
  flow: Flow,
  origin: string,
  chosen: string | undefined,
): Promise<string> {
  const { daemon, choices } = flow.ports;
  const references = await daemon.match(origin);
  if (chosen !== undefined) {
    if (!references.includes(chosen)) return "no_match";
    await choices.set(`${CHOICE_PREFIX}${origin}`, chosen);
    return chosen;
  }
  const remembered = await choices.get(`${CHOICE_PREFIX}${origin}`);
  if (remembered !== undefined && references.includes(remembered)) {
    return remembered;
  }
  if (references.length === 1) return references[0] ?? "no_match";
  return references.length === 0 ? "no_match" : "choose_in_popup";
}

/** What the popup draws: never probes or asks the daemon for a site off. */
export async function status(flow: Flow): Promise<FillStatus> {
  const here = await page(flow);
  const off = { enabled: false, references: [], passkey: false };
  if (!here) return { origin: null, ...off };
  if (!(await flow.ports.sites.isEnabled(here.origin))) {
    return { origin: here.origin, ...off };
  }
  const passkey = (await arm(flow, here, "popup", null)).passkey === true;
  try {
    const references = [...(await flow.ports.daemon.match(here.origin))];
    return { origin: here.origin, enabled: true, references, passkey };
  } catch (cause) {
    const error = codeOf(cause);
    return {
      origin: here.origin,
      enabled: true,
      references: [],
      passkey,
      error,
    };
  }
}

/** A person pressed the command or the popup's fill key. */
export async function trigger(
  flow: Flow,
  how: Trigger,
  chosen?: string,
): Promise<OutcomeReply> {
  const here = await page(flow);
  if (!here) return { outcome: "no_page" };
  if (!(await flow.ports.sites.isEnabled(here.origin))) {
    return { outcome: "site_off" };
  }
  let reference: string;
  try {
    reference = await chooseReference(flow, here.origin, chosen);
  } catch (cause) {
    return { outcome: codeOf(cause) };
  }
  if (reference === "no_match" || reference === "choose_in_popup") {
    return { outcome: reference };
  }
  const reply = await arm(flow, here, how, reference);
  return { outcome: reply.outcome ?? "guard_unavailable" };
}

/** The guard asks for the value: the one reply that carries it. */
export async function value(
  flow: Flow,
  request: ValueRequest,
  sender: RuntimeSender,
): Promise<ValueReply> {
  const facts: SenderFacts = { ...sender, tabId: sender.tab?.id };
  const admission = flow.ledger.take(request.nonce, facts, flow.ports.now());
  if (!admission.ok) return { refusal: admission.refusal };
  const { reference, origin } = admission.record;
  if (!(await flow.ports.sites.isEnabled(origin))) {
    return { refusal: "site_off" };
  }
  try {
    return {
      value: await flow.ports.daemon.value(reference, origin, request.field),
    };
  } catch (cause) {
    return { refusal: codeOf(cause) };
  }
}
