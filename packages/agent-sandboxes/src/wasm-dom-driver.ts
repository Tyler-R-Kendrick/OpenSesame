/**
 * The WASM-lane browser driver: a DOM-level driver with **no direct
 * network access**. Pages are fetched through the virtual-network relay
 * (`VirtualFetch`), parsed locally, and forms are filled/submitted as
 * serialized DOM state. The same code runs in Node (tests), a browser
 * tab, or a WASM host — only `linkedom` and the relay port are needed.
 *
 * Honest ceiling, same as every DOM/proxy lane: JavaScript-driven pages,
 * canvas widgets, and WebAuthn will not work here. Server-rendered form
 * flows (the long tail of password-reset pages) do. Challenges are still
 * surfaced as static observations so the run parks for a person through
 * the usual takeover channel instead of failing silently.
 */

import type {
  BrowserDriver,
  Observation,
} from "@opensesame/cua-password-reset";
import { parseHTML } from "linkedom";
import type { VirtualFetch } from "./vnet.js";

export interface WasmDomDriverOptions {
  virtualFetch: VirtualFetch;
  sessionId: string;
  allowedDomains: readonly string[];
}

// Structural DOM surface the driver needs. Declared locally so the driver
// does not depend on any one DOM implementation's types (linkedom here, a
// WASM DOM host there).
interface DomElement {
  tagName: string;
  textContent: string | null;
  ownerDocument: DomDocument | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
  closest(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  value?: string;
}

interface DomDocument {
  body: { textContent: string | null } | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

type Element = DomElement;

const ACTIVE_CAPTCHA =
  /verify you are human|verify you(?:'|’)re human|i(?:'|’)m not a robot|not a robot|select all (?:images|squares|tiles)|captcha (?:challenge|required|verification)|performing security verification|checking your browser/iu;

/**
 * The canonical phrase for an active human challenge found in page copy,
 * or null. Shared by DOM-level drivers so every lane parks identically.
 */
export function staticChallengePhrase(text: string): string | null {
  if (ACTIVE_CAPTCHA.test(text)) return "CAPTCHA verify you are human";
  if (/passkey|security key/iu.test(text))
    return "Passkey security key required";
  if (/text message/iu.test(text)) return "Text message code required";
  if (/authenticator|totp/iu.test(text))
    return "Authenticator TOTP code required";
  if (/one-time code|code from email|email code/iu.test(text))
    return "One-time code from email";
  return null;
}

function fieldKind(element: Element): Observation["fields"][number]["kind"] {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  if (type === "submit" || type === "button") return "button";
  if (type === "password") return "password";
  const name = element.getAttribute("name") ?? "";
  const label = labelOf(element);
  if (/totp|authenticator|one-time|otp/iu.test(`${name} ${label}`))
    return "otp";
  if (type === "email" || /email/iu.test(`${name} ${label}`)) return "email";
  return "text";
}

function associatedLabel(element: Element): string | null {
  const id = element.getAttribute("id");
  const doc = element.ownerDocument;
  if (id && doc) {
    const linked = doc.querySelector(`label[for="${id}"]`);
    if (linked?.textContent) return linked.textContent.trim().slice(0, 200);
  }
  const wrapping = element.closest("label");
  if (wrapping?.textContent) return wrapping.textContent.trim().slice(0, 200);
  return null;
}

function labelOf(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return aria.slice(0, 200);
  const associated = associatedLabel(element);
  if (associated) return associated;
  if (
    element.tagName.toLowerCase() === "button" ||
    element.tagName.toLowerCase() === "a"
  )
    return (element.textContent ?? "").trim().slice(0, 200);
  const placeholder = element.getAttribute("placeholder");
  if (placeholder) return placeholder.slice(0, 200);
  const value = element.getAttribute("value");
  if (value && (element.getAttribute("type") ?? "").toLowerCase() === "submit")
    return value.slice(0, 200);
  return (element.getAttribute("name") ?? "").slice(0, 200);
}

function parseDocument(html: string): DomDocument {
  const parsed = parseHTML(html);
  // SAFETY: parseHTML's document implements the structural surface above, exercised by the DOM driver tests.
  return parsed.document as DomDocument;
}

export class WasmDomDriver implements BrowserDriver {
  private document: DomDocument | null = null;
  private currentUrl = "about:blank";

  constructor(private readonly options: WasmDomDriverOptions) {}

  private assertAllowed(url: URL): void {
    if (!this.options.allowedDomains.includes(url.hostname))
      throw new Error("wasm driver: navigation left the approved domains");
  }

  private elements(): Element[] {
    if (!this.document) return [];
    return Array.from(
      this.document.querySelectorAll(
        "input, button, a[href], select, textarea",
      ),
    ).filter(
      (element) =>
        (element.getAttribute("type") ?? "").toLowerCase() !== "hidden",
    );
  }

  private elementForRef(ref: string): Element {
    const elements = this.elements();
    const index = Number(ref.slice(1)) - 1;
    const element = ref.startsWith("e") ? elements[index] : undefined;
    if (!element) throw new Error(`wasm driver: unknown ref ${ref}`);
    return element;
  }

  async open(url: string): Promise<void> {
    const target = new URL(url);
    this.assertAllowed(target);
    const response = await this.options.virtualFetch({
      sessionId: this.options.sessionId,
      url: target.href,
      method: "GET",
    });
    const finalUrl = new URL(response.url);
    this.assertAllowed(finalUrl);
    this.currentUrl = finalUrl.href;
    this.document = parseDocument(response.bodyText);
  }

  async snapshot(): Promise<Observation> {
    const fields = this.elements().map((element, index) => ({
      ref: `e${index + 1}`,
      kind: fieldKind(element),
      label: labelOf(element),
    }));
    const text = this.document?.body?.textContent ?? "";
    const challenge = staticChallengePhrase(text);
    if (
      challenge &&
      !fields.some((field) => field.label === challenge) &&
      fields.length < 100
    ) {
      fields.push({
        ref: `e${fields.length + 1}`,
        kind: "static" as const,
        label: challenge,
      });
    }
    return {
      id: crypto.randomUUID(),
      origin: new URL(this.currentUrl).origin,
      fields: fields.slice(0, 100),
    };
  }

  async click(ref: string): Promise<void> {
    const element = this.elementForRef(ref);
    const tag = element.tagName.toLowerCase();
    if (tag === "a") {
      const href = element.getAttribute("href");
      if (!href) throw new Error("wasm driver: link has no href");
      await this.open(new URL(href, this.currentUrl).href);
      return;
    }
    const form = element.closest("form");
    if (!form) return;
    await this.submitForm(form, element);
  }

  private serializeForm(form: Element, submitter: Element): URLSearchParams {
    const values = new URLSearchParams();
    const controls = form.querySelectorAll("input, select, textarea, button");
    for (const candidate of Array.from(controls)) {
      const name = candidate.getAttribute("name");
      if (!name || candidate.hasAttribute("disabled")) continue;
      const type = (candidate.getAttribute("type") ?? "text").toLowerCase();
      if (
        candidate.tagName.toLowerCase() === "button" ||
        type === "submit" ||
        type === "button"
      ) {
        if (candidate === submitter)
          values.append(name, candidate.getAttribute("value") ?? "");
        continue;
      }
      if (
        (type === "checkbox" || type === "radio") &&
        !candidate.hasAttribute("checked")
      )
        continue;
      values.append(
        name,
        candidate.value ?? candidate.getAttribute("value") ?? "",
      );
    }
    return values;
  }

  private async submitForm(form: Element, submitter: Element): Promise<void> {
    const method = (form.getAttribute("method") ?? "get").toUpperCase();
    const action = new URL(
      form.getAttribute("action") ?? this.currentUrl,
      this.currentUrl,
    );
    this.assertAllowed(action);
    const values = this.serializeForm(form, submitter);
    if (method === "GET") {
      action.search = values.toString();
      await this.open(action.href);
      return;
    }
    const response = await this.options.virtualFetch({
      sessionId: this.options.sessionId,
      url: action.href,
      method,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: values.toString(),
    });
    const finalUrl = new URL(response.url);
    this.assertAllowed(finalUrl);
    this.currentUrl = finalUrl.href;
    this.document = parseDocument(response.bodyText);
  }

  async fill(ref: string, value: string): Promise<void> {
    const element = this.elementForRef(ref);
    element.setAttribute("value", value);
    element.value = value;
  }

  async fillSecret(ref: string, value: string): Promise<void> {
    await this.fill(ref, value);
  }

  async pageUrl(): Promise<string> {
    return this.currentUrl;
  }

  async close(): Promise<void> {
    this.document = null;
    this.currentUrl = "about:blank";
  }
}
