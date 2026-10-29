/**
 * A `BrowserDriver` over the Chrome DevTools Protocol, for external
 * browser providers (Cloudflare Browser Run and any other CDP endpoint).
 * Construction is disabled until the provider can enforce network and
 * credential-entry isolation throughout the browser session.
 */

import type {
  BrowserDriver,
  Observation,
} from "@opensesame/cua-password-reset";
import { z } from "zod";
import type { CdpConnection } from "./cdp-connection.js";
import { staticChallengePhrase } from "./wasm-dom-driver.js";

export function requireSafeCdpBrowser(): void {
  throw new Error(
    "CDP browser provider is temporarily unavailable: browser network and credential isolation is not established",
  );
}

const SNAPSHOT_SCRIPT = `(() => {
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "submit" || type === "button") return "button";
    if (type === "password") return "password";
    const hint = (el.getAttribute("name") || "") + " " + labelOf(el);
    if (/totp|authenticator|one-time|otp/iu.test(hint)) return "otp";
    if (type === "email" || /email/iu.test(hint)) return "email";
    return "text";
  };
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.slice(0, 200);
    if (el.id) {
      const linked = document.querySelector('label[for="' + el.id + '"]');
      if (linked && linked.textContent) return linked.textContent.trim().slice(0, 200);
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping.textContent) return wrapping.textContent.trim().slice(0, 200);
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || tag === "a") return (el.textContent || "").trim().slice(0, 200);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.slice(0, 200);
    if ((el.getAttribute("type") || "").toLowerCase() === "submit" && el.getAttribute("value"))
      return el.getAttribute("value").slice(0, 200);
    return (el.getAttribute("name") || "").slice(0, 200);
  };
  const elements = [...document.querySelectorAll("input, button, a[href], select, textarea")]
    .filter((el) => (el.getAttribute("type") || "").toLowerCase() !== "hidden");
  window.__opensesameRefs = new Map(elements.map((el, i) => ["e" + (i + 1), el]));
  return {
    url: location.href,
    text: document.body ? document.body.innerText : "",
    fields: elements.map((el, i) => ({
      ref: "e" + (i + 1),
      kind: kindOf(el),
      label: labelOf(el),
    })),
  };
})()`;

const snapshotValueSchema = z.object({
  url: z.string(),
  text: z.string(),
  fields: z.array(
    z.object({
      ref: z.string(),
      kind: z.enum(["email", "text", "password", "otp", "button", "link"]),
      label: z.string(),
    }),
  ),
});

const evaluateResultSchema = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.object({ text: z.string().optional() }).optional(),
});

export interface CdpDriverOptions {
  allowedDomains: readonly string[];
  /** Milliseconds to wait for a navigation to settle. */
  loadTimeoutMs?: number;
}

export class CdpBrowserDriver implements BrowserDriver {
  private sessionId = "";
  private targetId = "";

  private constructor(
    private readonly connection: CdpConnection,
    private readonly options: CdpDriverOptions,
  ) {
    requireSafeCdpBrowser();
  }

  /** Attach to a browser-level CDP endpoint and open a fresh page. */
  static async connect(
    connection: CdpConnection,
    options: CdpDriverOptions,
  ): Promise<CdpBrowserDriver> {
    const driver = new CdpBrowserDriver(connection, options);
    const created = await connection.call<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    driver.targetId = created.targetId;
    const attached = await connection.call<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: driver.targetId, flatten: true },
    );
    driver.sessionId = attached.sessionId;
    await connection.call("Page.enable", {}, driver.sessionId);
    await connection.call("Runtime.enable", {}, driver.sessionId);
    return driver;
  }

  private assertAllowed(url: URL): void {
    if (!this.options.allowedDomains.includes(url.hostname))
      throw new Error("cdp driver: navigation left the approved domains");
  }

  private async evaluate<T>(
    expression: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    requireSafeCdpBrowser();
    const raw = await this.connection.call<unknown>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    );
    const parsed = evaluateResultSchema.parse(raw);
    if (parsed.exceptionDetails)
      throw new Error(
        `cdp driver: page evaluation failed (${parsed.exceptionDetails.text ?? "exception"})`,
      );
    return schema.parse(parsed.result.value);
  }

  private async waitForLoad(): Promise<void> {
    requireSafeCdpBrowser();
    const timeout = this.options.loadTimeoutMs ?? 15_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await this.evaluate(
        "document.readyState",
        z.string(),
      ).catch(() => "loading");
      if (state === "complete" || state === "interactive") return;
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async open(url: string): Promise<void> {
    requireSafeCdpBrowser();
    const target = new URL(url);
    this.assertAllowed(target);
    await this.connection.call(
      "Page.navigate",
      { url: target.href },
      this.sessionId,
    );
    await this.waitForLoad();
    this.assertAllowed(new URL(await this.pageUrl()));
  }

  async snapshot(): Promise<Observation> {
    requireSafeCdpBrowser();
    const value = await this.evaluate(SNAPSHOT_SCRIPT, snapshotValueSchema);
    const url = new URL(value.url);
    this.assertAllowed(url);
    const fields: Observation["fields"] = value.fields.slice(0, 100);
    const challenge = staticChallengePhrase(value.text);
    if (
      challenge &&
      !fields.some((field) => field.label === challenge) &&
      fields.length < 100
    ) {
      fields.push({
        ref: `e${fields.length + 1}`,
        kind: "static",
        label: challenge,
      });
    }
    return { id: crypto.randomUUID(), origin: url.origin, fields };
  }

  async click(ref: string): Promise<void> {
    requireSafeCdpBrowser();
    await this.evaluate(
      `(() => { const el = window.__opensesameRefs?.get(${JSON.stringify(ref)}); if (!el) throw new Error("unknown ref"); el.click(); return true; })()`,
      z.boolean(),
    );
    await this.waitForLoad();
  }

  async fill(ref: string, value: string): Promise<void> {
    requireSafeCdpBrowser();
    await this.evaluate(
      `(() => {
        const el = window.__opensesameRefs?.get(${JSON.stringify(ref)});
        if (!el) throw new Error("unknown ref");
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
          ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
          ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
      z.boolean(),
    );
  }

  async fillSecret(ref: string, value: string): Promise<void> {
    requireSafeCdpBrowser();
    await this.evaluate(
      `(() => { const el = window.__opensesameRefs?.get(${JSON.stringify(ref)}); if (!el) throw new Error("unknown ref"); el.focus(); el.select?.(); return true; })()`,
      z.boolean(),
    );
    await this.connection.call(
      "Input.insertText",
      { text: value },
      this.sessionId,
    );
  }

  async pageUrl(): Promise<string> {
    requireSafeCdpBrowser();
    return this.evaluate("location.href", z.string()).catch(() => "");
  }

  async close(): Promise<void> {
    requireSafeCdpBrowser();
    if (this.targetId) {
      await this.connection
        .call("Target.closeTarget", { targetId: this.targetId })
        .catch(() => {});
    }
    this.connection.close();
  }
}
