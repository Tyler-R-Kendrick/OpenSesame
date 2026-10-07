/**
 * The companion's popup. It is extension-owned UI outside the page, which is
 * what makes its keys trusted gestures (ADR 0150 §6.4): the site switch, the
 * pairing key and the fill key.
 *
 * - The site switch asks the browser for exactly this site's host (and the
 *   daemon's loopback host) on the person's own click, and only a grant the
 *   browser reports is passed on; switching off asks for nothing.
 * - It shows the origin in view, the names of entries stored for exactly
 *   that origin, and a pairing code to approve on this computer.
 * - Every status is one mark whose words are its `aria-label` and `title`.
 * - It never receives a value: every answer is a status or an outcome.
 */
import type { Outcome } from "../fill/protocol";
import type {
  ErrorReply,
  FillStatus,
  OutcomeReply,
  PairState,
} from "../fill/wire";
import { DAEMON_PATTERN, hostPattern } from "../sites/patterns";
import { describeOutcome, toneOf } from "./say";

type StatusAnswer = FillStatus | ErrorReply;

/** The background, spoken to through decoded replies (`wire.ts`). */
export interface PanelPorts {
  check(): void;
  status(): Promise<StatusAnswer>;
  trigger(reference: string | undefined): Promise<OutcomeReply | ErrorReply>;
  enable(origin: string): Promise<StatusAnswer>;
  disable(): Promise<StatusAnswer>;
  pair(): Promise<PairState | ErrorReply>;
  /** `permissions.request`, called inside the click that asked for it. */
  request(origins: readonly string[]): Promise<boolean>;
}

export interface PanelElements {
  readonly origin: HTMLElement;
  readonly site: HTMLButtonElement;
  readonly pair: HTMLButtonElement;
  readonly code: HTMLOutputElement;
  readonly refs: HTMLFieldSetElement;
  readonly go: HTMLButtonElement;
  readonly mark: HTMLElement;
}

function mark(els: PanelElements, outcome: Outcome): void {
  const words = describeOutcome(outcome);
  els.mark.dataset.tone = toneOf(outcome);
  els.mark.setAttribute("aria-label", words);
  els.mark.setAttribute("title", words);
}

function chosen(refs: HTMLFieldSetElement): string | undefined {
  return (
    refs.querySelector<HTMLInputElement>('input[name="fill-ref"]:checked')
      ?.value ?? undefined
  );
}

function renderRefs(els: PanelElements, references: readonly string[]): void {
  const legend = els.refs.querySelector("legend");
  els.refs.replaceChildren(...(legend ? [legend] : []));
  references.forEach((reference, index) => {
    const label = els.refs.ownerDocument.createElement("label");
    const radio = els.refs.ownerDocument.createElement("input");
    radio.type = "radio";
    radio.name = "fill-ref";
    radio.value = reference;
    radio.checked = index === 0;
    label.append(radio, ` ${reference}`);
    els.refs.appendChild(label);
  });
  els.refs.hidden = references.length < 2;
}

function statusOutcome(status: FillStatus): Outcome {
  if (!status.origin) return "no_page";
  if (!status.enabled) return "site_off";
  if (status.passkey) return "passkey_offered";
  if (status.error) return status.error;
  return status.references.length === 0 ? "no_match" : "ready";
}

function render(els: PanelElements, status: FillStatus): void {
  els.origin.textContent = status.origin ?? "";
  els.site.hidden = status.origin === null;
  els.site.setAttribute("aria-checked", String(status.enabled));
  renderRefs(els, status.enabled ? status.references : []);
  els.pair.hidden = status.error !== "not_paired";
  const ready = status.enabled && !status.error;
  els.go.hidden = !ready || status.references.length === 0;
  els.go.disabled = status.passkey;
  mark(els, statusOutcome(status));
}

export interface PanelController {
  invalidate(): void;
  refresh(): Promise<void>;
}

/** Wire the popup: load status, then answer the three keys. */
export async function mountPanel(
  els: PanelElements,
  begin: () => PanelPorts,
): Promise<PanelController> {
  let current: FillStatus | null = null;
  let generation = 0;
  const invalidate = () => {
    generation += 1;
    current = null;
    els.origin.textContent = "";
    els.code.value = "";
    renderRefs(els, []);
    els.site.hidden = els.pair.hidden = els.go.hidden = true;
  };
  const operation = () => {
    const ports = begin();
    const original = generation;
    const live = () => {
      try {
        ports.check();
        return generation === original;
      } catch {
        return false;
      }
    };
    return { ports, live };
  };
  const show = (answer: StatusAnswer) => {
    if ("error" in answer && !("references" in answer)) {
      // No status to act on: offer no fill until one arrives.
      els.go.hidden = true;
      mark(els, answer.error);
      return;
    }
    current = answer;
    render(els, answer);
  };

  els.site.addEventListener("click", async () => {
    const { ports, live } = operation();
    const origin = current?.origin;
    if (!origin) return;
    if (current?.enabled) {
      const answer = await ports.disable();
      if (live()) show(answer);
      return;
    }
    const pattern = hostPattern(origin);
    const granted = pattern
      ? await ports.request([pattern, DAEMON_PATTERN])
      : false;
    if (!live()) return;
    if (!granted) {
      mark(els, "permission_not_granted");
      return;
    }
    const answer = await ports.enable(origin);
    if (live()) show(answer);
  });

  els.pair.addEventListener("click", async () => {
    const { ports, live } = operation();
    const granted = await ports.request([DAEMON_PATTERN]);
    if (!live()) return;
    if (!granted) {
      mark(els, "permission_not_granted");
      return;
    }
    const reply = await ports.pair();
    if (!live()) return;
    if ("error" in reply) {
      mark(els, reply.error);
    } else if (reply.state === "pending") {
      els.code.value = `${reply.code.slice(0, 4)}-${reply.code.slice(4)}`;
    } else {
      els.code.value = "";
      const answer = await ports.status();
      if (live()) show(answer);
    }
  });

  els.go.addEventListener("click", async () => {
    const { ports, live } = operation();
    const reply = await ports.trigger(chosen(els.refs));
    if (live()) mark(els, "error" in reply ? reply.error : reply.outcome);
  });

  const refresh = async () => {
    invalidate();
    const { ports, live } = operation();
    const answer = await ports.status();
    if (live()) show(answer);
  };
  await refresh();
  return { refresh, invalidate };
}
