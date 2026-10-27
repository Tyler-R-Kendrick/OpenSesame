import type { PasswordMethod } from "@opensesame/vault-core";
import type { Page } from "@playwright/test";
import {
  type BrowserDriver,
  BrowserStepExecutor,
  type BrowserStepPorts,
  CandidateCustody,
  type CheckpointJournal,
  DurableJournal,
  DurableResetRunner,
  type ExactFormProxyPort,
  type HumanChallenge,
  MemoryCheckpointJournal,
  type Observation,
  RESET_ACTIONS,
  type ResetAction,
  type ResetEffects,
  type ResetRun,
  fixedGrants,
  resetResource,
} from "../src/index.js";
import { grant } from "../src/test-support.js";
import type { Challenge, MockResetSite } from "./mock-site.js";

export const PEPPER = "person-pepper";

export const method: PasswordMethod = {
  id: "password-1",
  type: "password",
  generator: {
    id: "derived",
    counter: 1,
    rules: {
      length: 24,
      lower: true,
      upper: true,
      digits: true,
      symbols: true,
      avoidAmbiguous: false,
      minDigits: 1,
      minSymbols: 1,
    },
  },
  pepper: true,
  pepperAt: "end",
  secret: Buffer.alloc(32, 7).toString("base64"),
  changedAt: "2026-10-27T00:00:00.000Z",
};

export function resetRun(
  site: MockResetSite,
  challenge: Challenge = null,
): ResetRun {
  const domain = new URL(site.origin).hostname;
  return {
    id: "run-1",
    domain,
    origin: site.origin,
    itemId: "item-1",
    transport: "cdp",
    grantIds: Object.fromEntries(
      RESET_ACTIONS.map((action) => [action, `grant:${action}`]),
    ),
    cursor: 0,
    status: "running",
    updatedAt: new Date().toISOString(),
    recipe: {
      schemaVersion: 1,
      review: "approved",
      domain,
      entryPath: "/reset",
      allowedOrigins: [site.origin],
      steps: [
        { id: "open", primitive: "navigate", path: "/reset" },
        {
          id: "identify",
          primitive: "fill-field",
          ref: "e1",
          expectedLabel: "Email",
          purpose: "identifier",
        },
        {
          id: "request",
          primitive: "click",
          ref: "e2",
          expectedLabel: "Send reset link",
        },
        { id: "mail", primitive: "await-email-link" },
        ...(challenge
          ? [{ id: "challenge", primitive: "await-human" } as const]
          : []),
        {
          id: "password",
          primitive: "fill-field",
          ref: "e3",
          expectedLabel: "New password",
          purpose: "new-password",
        },
        {
          id: "submit",
          primitive: "submit",
          ref: "e4",
          expectedLabel: "Save password",
        },
        { id: "verify", primitive: "verify-login" },
      ],
    },
  };
}

class PlaywrightDriver implements BrowserDriver {
  constructor(private readonly page: Page) {}

  async open(url: string): Promise<void> {
    await this.page.goto(url);
  }

  async snapshot(): Promise<Observation> {
    const path = new URL(this.page.url()).pathname;
    const fields: Observation["fields"] = [];
    if (path === "/reset")
      fields.push(
        { ref: "e1", kind: "email", label: "Email" },
        { ref: "e2", kind: "button", label: "Send reset link" },
      );
    if (path === "/reset/link") {
      const text = await this.page.locator("body").innerText();
      const challenge = /CAPTCHA/iu.test(text)
        ? "CAPTCHA verify you are human"
        : /One-time code/iu.test(text)
          ? "One-time code from email"
          : /Authenticator/iu.test(text)
            ? "Authenticator TOTP code required"
            : /Passkey/iu.test(text)
              ? "Passkey security key required"
              : null;
      if (challenge) fields.push({ ref: "e9", kind: "text", label: challenge });
      const save = await this.page
        .locator("form[action='/password'] button")
        .innerText();
      fields.push(
        { ref: "e3", kind: "password", label: "New password" },
        { ref: "e4", kind: "button", label: save },
      );
    }
    return {
      id: crypto.randomUUID(),
      origin: new URL(this.page.url()).origin,
      fields,
    };
  }

  async click(ref: string): Promise<void> {
    if (ref === "e2")
      await this.page.locator("form[action='/request'] button").click();
    else if (ref === "e4")
      await this.page.locator("form[action='/password'] button").click();
    else throw new Error("Unknown test ref");
  }

  async fill(ref: string, value: string): Promise<void> {
    if (ref !== "e1" && ref !== "e3") throw new Error("Unknown test ref");
    await this.page
      .locator(ref === "e1" ? "input[name='email']" : "input[name='password']")
      .fill(value);
  }

  async fillSecret(ref: string, value: string): Promise<void> {
    if (ref !== "e3") throw new Error("Unexpected secret field");
    await this.page.locator("input[name='password']").fill(value);
  }
}

export function proxy(page: Page): ExactFormProxyPort {
  let armed: Parameters<ExactFormProxyPort["arm"]>[0] | undefined;
  void page.route("**/password", async (route) => {
    if (!armed) throw new Error("Unarmed password submission");
    const request = route.request();
    const values = new URLSearchParams(request.postData() ?? "");
    const appearances =
      [...values.values()].join(" ").split(armed.synthetic).length - 1;
    if (
      request.method() !== armed.proof.method ||
      values.getAll(armed.proof.field).length !== 1 ||
      values.get(armed.proof.field) !== armed.synthetic ||
      appearances !== 1
    )
      throw new Error("Password form did not match its proof");
    const field = armed.proof.field;
    await armed.withRealPassword(async (password) => {
      values.set(field, password);
      await route.continue({ postData: values.toString() });
    });
  });
  return {
    exactFormSubstitution: true,
    arm: async (input) => {
      armed = input;
    },
  };
}

export function runtime(
  page: Page,
  site: MockResetSite,
  challenge: Challenge = null,
  store: CheckpointJournal = new MemoryCheckpointJournal(),
  withProxy = false,
) {
  const initial = resetRun(site, challenge);
  if (withProxy) initial.transport = "proxy";
  if (withProxy)
    initial.recipe.proxySubstitution = {
      origin: site.origin,
      method: "POST",
      path: "/password",
      field: "password",
      contentType: "application/x-www-form-urlencoded",
      identityEncoding: true,
      untransformedForm: true,
      canaryVerified: true,
    };
  const provider = fixedGrants(
    Object.fromEntries(
      RESET_ACTIONS.map((action: ResetAction) => [
        action,
        {
          ...grant(action, new Date()),
          resources: [resetResource(initial.domain, initial.itemId)],
        },
      ]),
    ),
  );
  const custody = new CandidateCustody(
    method,
    () => PEPPER,
    () => {
      const live = provider.grant("password_reset.password.produce", initial);
      if (live.actions[0] !== "password_reset.password.produce")
        throw new Error("Not authorized");
    },
  );
  const challenges: HumanChallenge[] = [];
  const verifyLogin = async () => {
    await page.goto(`${site.origin}/login`);
    await page.locator("input[name='email']").fill("person@example.test");
    await custody.withPassword((password) =>
      page.locator("input[name='password']").fill(password),
    );
    await page.locator("form[action='/login'] button").click();
    return new URL(page.url()).pathname === "/account";
  };
  const browser = new PlaywrightDriver(page);
  const stepPorts: BrowserStepPorts = {
    identifier: async () => "person@example.test",
    mailbox: { resetLink: async () => site.resetLink() },
    candidate: custody,
    authorizeProxy: () => {
      provider.grant("password_reset.proxy.substitute", initial);
    },
    takeover: {
      handoff: async (challenge) => {
        challenges.push(challenge);
      },
      resume: async () => {
        await page.locator("form[action='/challenge/clear'] button").click();
      },
    },
    verifyLogin,
  };
  if (withProxy && initial.recipe.proxySubstitution)
    stepPorts.proxy = proxy(page);
  const executor = new BrowserStepExecutor(browser, stepPorts);
  const effects: ResetEffects = {
    execute: (step, current, context) =>
      executor.execute(step, current, context),
    backupCandidate: async () => {},
    verifyCandidate: async () =>
      (await verifyLogin()) ? "verified" : "not_active",
    promoteCandidate: async () => {},
    compensate: async () => {
      site.restorePassword();
      return "compensated";
    },
  };
  const journal = new DurableJournal(store);
  return {
    initial,
    custody,
    challenges,
    effects,
    journal,
    runner: new DurableResetRunner(journal, effects, provider),
  };
}
