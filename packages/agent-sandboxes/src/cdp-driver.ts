/**
 * A `BrowserDriver` over the Chrome DevTools Protocol, for external
 * browser providers (Cloudflare Browser Run and any other CDP endpoint).
 *
 * Network boundary: the Fetch domain pauses every request in the
 * session before it leaves the browser. Only approved domains (and
 * inert data/blob/about URLs) continue; redirects, subresources,
 * sockets, and beacons to anywhere else are failed in the browser,
 * before page scripts or a reset credential can reach them.
 *
 * Credential boundary: fills run inside one evaluation that first
 * proves the element lives in the current approved document, and
 * secret entry requires the document origin to still match the last
 * approved snapshot before the driver types anything.
 */

import type {
  BrowserDriver,
  Observation,
} from "@opensesame/cua-password-reset";
import { z } from "zod";
import { installCdpSessionBoundary } from "./cdp-boundary.js";
import type { CdpConnection, CdpJsonValue } from "./cdp-connection.js";
import { staticChallengePhrase } from "./wasm-dom-driver.js";

export { cdpLockdownScript, isAllowedCdpRequest } from "./cdp-boundary.js";

const attachedToTargetSchema = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ targetId: z.string() }),
});

const frameTreeSchema = z.object({
  frameTree: z.object({ frame: z.object({ url: z.string() }) }),
});

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
  private browserContextId = "";

  private approvedOrigin: string | undefined;

  private constructor(
    private readonly connection: CdpConnection,
    private readonly options: CdpDriverOptions,
  ) {}

  private boundaryReady: ((sessionId: string) => void) | undefined;
  private readonly boundarySessions = new Map<string, boolean>();

  /** Attach to a browser-level CDP endpoint and open a fresh page. */
  static async connect(
    connection: CdpConnection,
    options: CdpDriverOptions,
  ): Promise<CdpBrowserDriver> {
    const driver = new CdpBrowserDriver(connection, options);
    connection.on("Target.attachedToTarget", (params) => {
      void driver.handleAttachedTarget(params);
    });
    await connection.call("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const attached = new Promise<string>((resolve) => {
      driver.boundaryReady = resolve;
    });
    const context = await connection.call<{ browserContextId: string }>(
      "Target.createBrowserContext",
      { disposeOnDetach: true },
    );
    driver.browserContextId = context.browserContextId;
    const created = await connection.call<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank", browserContextId: driver.browserContextId },
    );
    driver.targetId = created.targetId;
    driver.sessionId = await Promise.race([
      attached,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("cdp driver: page target did not attach")),
          15_000,
        );
      }),
    ]);
    if (!driver.boundarySessions.get(driver.sessionId))
      throw new Error("cdp driver: network boundary could not be installed");
    await connection.call("Page.enable", {}, driver.sessionId);
    await connection.call("Runtime.enable", {}, driver.sessionId);
    return driver;
  }

  /**
   * Every related target (the page, workers, child frames) starts
   * paused; install the boundary on its session before resuming it.
   * A session whose boundary cannot be installed is never resumed.
   */
  private async handleAttachedTarget(
    params: CdpJsonValue | undefined,
  ): Promise<void> {
    const parsed = attachedToTargetSchema.safeParse(params);
    if (!parsed.success) return;
    const { sessionId } = parsed.data;
    const installed = await installCdpSessionBoundary(
      this.connection,
      sessionId,
      this.options.allowedDomains,
    );
    this.boundarySessions.set(sessionId, installed);
    if (installed)
      await this.connection
        .call("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .catch(() => {});
    if (parsed.data.targetInfo.targetId === this.targetId || !this.sessionId)
      this.boundaryReady?.(sessionId);
  }

  private assertAllowed(url: URL): void {
    if (!this.options.allowedDomains.includes(url.hostname))
      throw new Error("cdp driver: navigation left the approved domains");
  }

  /**
   * Prove, inside the page, that a snapshot ref still belongs to the
   * current approved document. Returns the document URL so secret
   * entry can also bind to the last approved snapshot origin.
   */
  private async assertRefDocument(ref: string): Promise<string> {
    const tree = frameTreeSchema.parse(
      await this.connection.call<unknown>(
        "Page.getFrameTree",
        {},
        this.sessionId,
      ),
    );
    const frameUrl = new URL(tree.frameTree.frame.url);
    this.assertAllowed(frameUrl);
    if (this.approvedOrigin && frameUrl.origin !== this.approvedOrigin)
      throw new Error("cdp driver: document changed since the snapshot");
    const href = await this.evaluate(
      `(() => {
        const el = window.__opensesameRefs?.get(${JSON.stringify(ref)});
        if (!el || !el.isConnected || el.ownerDocument !== document)
          throw new Error("ref left the approved document");
        return location.href;
      })()`,
      z.string(),
    );
    const url = new URL(href);
    this.assertAllowed(url);
    if (this.approvedOrigin && url.origin !== this.approvedOrigin)
      throw new Error("cdp driver: document changed since the snapshot");
    return href;
  }

  private async evaluate<T>(
    expression: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
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
    const value = await this.evaluate(SNAPSHOT_SCRIPT, snapshotValueSchema);
    const url = new URL(value.url);
    this.assertAllowed(url);
    this.approvedOrigin = url.origin;
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
    await this.evaluate(
      `(() => { const el = window.__opensesameRefs?.get(${JSON.stringify(ref)}); if (!el) throw new Error("unknown ref"); el.click(); return true; })()`,
      z.boolean(),
    );
    await this.waitForLoad();
    this.assertAllowed(new URL(await this.pageUrl()));
  }

  /**
   * Set a field value in one evaluation bound to the snapshot's
   * element: the script re-proves the approved document and origin
   * synchronously before writing, so focus tricks or navigation
   * between CDP calls cannot redirect the value to another control
   * or document. Used for secrets and plain fills alike.
   */
  private async fillBound(ref: string, value: string): Promise<void> {
    await this.assertRefDocument(ref);
    const href = await this.evaluate(
      `(() => {
        const allowed = new Set(${JSON.stringify([...this.options.allowedDomains])});
        if (!allowed.has(location.hostname))
          throw new Error("document left the approved domains");
        const expectedOrigin = ${JSON.stringify(this.approvedOrigin ?? "")};
        if (expectedOrigin && location.origin !== expectedOrigin)
          throw new Error("document changed since the snapshot");
        const el = window.__opensesameRefs?.get(${JSON.stringify(ref)});
        if (!el || !el.isConnected || el.ownerDocument !== document)
          throw new Error("ref left the approved document");
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
          ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
          ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return location.href;
      })()`,
      z.string(),
    );
    const url = new URL(href);
    this.assertAllowed(url);
    if (this.approvedOrigin && url.origin !== this.approvedOrigin)
      throw new Error("cdp driver: document changed since the snapshot");
  }

  async fill(ref: string, value: string): Promise<void> {
    await this.fillBound(ref, value);
  }

  async fillSecret(ref: string, value: string): Promise<void> {
    await this.fillBound(ref, value);
  }

  async pageUrl(): Promise<string> {
    return this.evaluate("location.href", z.string()).catch(() => "");
  }

  async close(): Promise<void> {
    // Disposing the run's context destroys its pages, cookies, and
    // storage with it; nothing carries into the next run on a shared
    // or long-lived endpoint.
    if (this.browserContextId) {
      await this.connection
        .call("Target.disposeBrowserContext", {
          browserContextId: this.browserContextId,
        })
        .catch(() => {});
    } else if (this.targetId) {
      await this.connection
        .call("Target.closeTarget", { targetId: this.targetId })
        .catch(() => {});
    }
    this.connection.close();
  }
}
