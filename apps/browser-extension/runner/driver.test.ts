import type { RunnerStepRequest } from "@opensesame/api-client";
import { describe, expect, it } from "vitest";
import type { DriverDeps } from "./context";
import { runStep } from "./driver";
import { RUN, open, setup } from "./test-support/driver-rig";
import { refusalFor } from "./test-support/fake-host";
import { CURRENT } from "./test-support/rig";
import { RP } from "./test-support/site";

describe("every outcome the driver builds is one the Host would accept", () => {
  it("passes the fake Host's canonical check, whatever the step", async () => {
    const { step, r } = await setup();
    const handle = `candidate:${crypto.randomUUID()}`;
    const requests: RunnerStepRequest[] = [
      { step: "navigate", url: `${RP}/account/password` },
      { step: "navigate", url: "https://evil.example/" },
      { step: "wait_for", selector: "#new" },
      { step: "wait_for", selector: "#missing" },
      { step: "wait_for", selector: "###" },
      { step: "generate_candidate", handle },
      { step: "seal_candidate", handle },
      {
        step: "fill_credential",
        reference: "current_password",
        selector: "#current",
      },
      { step: "fill_credential", reference: handle, selector: "#new" },
      { step: "fill_credential", reference: handle, selector: "#nope" },
      {
        step: "fill_credential",
        reference: "candidate:unknown-handle-0000",
        selector: "#new",
      },
      { step: "assert_present", reference: handle, selector: "#new" },
      { step: "assert_present", reference: handle, selector: "###" },
      { step: "read_dom_redacted", strip: ["#new"] },
      { step: "screenshot_redacted", epoch: 1, mask_selectors: ["#new"] },
      { step: "submit", selector: "#nope" },
      { step: "verify_login", reference: handle },
      {
        step: "capture_credential",
        slot: "app_id",
        selector: "#x",
        recipient: "r",
      },
      {
        step: "capture_download",
        slot: "private_key",
        content_type: "x",
        recipient: "r",
      },
      { step: "promote_candidate", handle },
    ];
    for (const request of requests) {
      const outcome = await step(request);
      expect(
        refusalFor(request.step, JSON.parse(JSON.stringify(outcome))),
        JSON.stringify([request, outcome]),
      ).toBeNull();
    }
    void r;
  });
});

describe("fill_credential", () => {
  it("resolves the reference where the value is held and answers only whether it landed", async () => {
    const { step, pages } = await setup();
    await open(step);
    const outcome = await step({
      step: "fill_credential",
      reference: "current_password",
      selector: "#current",
    });
    expect(outcome).toEqual({ outcome: "filled", filled: "Ok" });
    expect(JSON.stringify(outcome)).not.toContain(CURRENT);
    expect(await pages.presence("#current", CURRENT)).toBe("present");
  });

  it("answers NoSuchField for a node that cannot take it", async () => {
    const { step } = await setup();
    await open(step);
    expect(
      await step({
        step: "fill_credential",
        reference: "current_password",
        selector: "#nothing",
      }),
    ).toEqual({ outcome: "filled", filled: "NoSuchField" });
  });

  it("fails when the reference names nothing this run may use", async () => {
    const { step, r } = await setup();
    await open(step);
    const ours = `candidate:${crypto.randomUUID()}`;
    // A candidate made for another run, and one made for another origin.
    await r.vault.generate({ runId: "run:other", origin: RP }, ours);
    const elsewhere = `candidate:${crypto.randomUUID()}`;
    await r.vault.generate(
      { runId: "run:1", origin: "https://other.example" },
      elsewhere,
    );
    for (const reference of [
      ours,
      elsewhere,
      "candidate:not-made-here-0000",
      "password",
      "",
    ]) {
      expect(
        await step({ step: "fill_credential", reference, selector: "#new" }),
        reference,
      ).toEqual({ outcome: "failed", error: "transport" });
    }
  });

  it("fails when there is no credential to resolve", async () => {
    const { step } = await setup({ credential: false });
    await open(step);
    expect(
      await step({
        step: "fill_credential",
        reference: "current_password",
        selector: "#current",
      }),
    ).toEqual({ outcome: "failed", error: "transport" });
  });
});

describe("assert_present", () => {
  it("is Present only for the very value, Mismatch for another, Absent for none", async () => {
    const { step, r } = await setup();
    await open(step);
    const handle = `candidate:${crypto.randomUUID()}`;
    await step({ step: "generate_candidate", handle });
    const assert = () =>
      step({ step: "assert_present", reference: handle, selector: "#new" });
    expect(await assert()).toEqual({ outcome: "presence", presence: "Absent" });
    await step({
      step: "fill_credential",
      reference: handle,
      selector: "#new",
    });
    expect(await assert()).toEqual({
      outcome: "presence",
      presence: "Present",
    });
    await step({
      step: "fill_credential",
      reference: "current_password",
      selector: "#new",
    });
    expect(await assert()).toEqual({
      outcome: "presence",
      presence: "Mismatch",
    });
    void r;
  });

  it("fails rather than pass when the reference cannot be resolved", async () => {
    const { step } = await setup();
    await open(step);
    expect(
      await step({
        step: "assert_present",
        reference: "candidate:nope-nope-0000",
        selector: "#new",
      }),
    ).toEqual({ outcome: "failed", error: "transport" });
  });
});

describe("the custody steps", () => {
  it("generate, seal and promote walk a candidate into the vault", async () => {
    const { step, r } = await setup();
    const handle = `candidate:${crypto.randomUUID()}`;
    expect(await step({ step: "generate_candidate", handle })).toEqual({
      outcome: "done",
    });
    // The same handle twice is a protocol error, not a second candidate.
    expect(await step({ step: "generate_candidate", handle })).toEqual({
      outcome: "failed",
      error: "transport",
    });
    expect(await step({ step: "promote_candidate", handle })).toEqual({
      outcome: "failed",
      error: "transport",
    });
    expect(await step({ step: "seal_candidate", handle })).toEqual({
      outcome: "sealed",
      backed_up: true,
    });
    expect(await step({ step: "promote_candidate", handle })).toEqual({
      outcome: "done",
    });
    expect((await r.vault.getEntry(RP))?.previous).toBe(CURRENT);
  });

  it("a malformed handle is never generated", async () => {
    const { step } = await setup();
    for (const handle of [
      "",
      "candidate:",
      "candidate:../x",
      "x",
      "candidate:a b c d e f g h",
    ]) {
      expect(
        await step({ step: "generate_candidate", handle }),
        handle,
      ).toEqual({
        outcome: "failed",
        error: "transport",
      });
    }
  });

  it("seal says not backed up with no Host to back it up to", async () => {
    const { r, pages } = await setup();
    const handle = `candidate:${crypto.randomUUID()}`;
    const bare: DriverDeps = {
      run: RUN,
      pages,
      vault: r.vault,
      backup: null,
      epoch: { epoch: 0, layout: null },
    };
    await runStep({ step: "generate_candidate", handle }, bare);
    expect(await runStep({ step: "seal_candidate", handle }, bare)).toEqual({
      outcome: "sealed",
      backed_up: false,
    });
  });

  it("seal says not backed up when the store throws", async () => {
    const { r, step } = await setup();
    const handle = `candidate:${crypto.randomUUID()}`;
    await step({ step: "generate_candidate", handle });
    r.host.push = async () => {
      throw new Error("boom");
    };
    expect(await step({ step: "seal_candidate", handle })).toEqual({
      outcome: "sealed",
      backed_up: false,
    });
  });
});

describe("a step that throws", () => {
  it("is a failure the Host can read, never an unreadable answer", async () => {
    const { step, pages } = await setup();
    pages.waitFor = async () => {
      throw new Error("tab crashed");
    };
    expect(await step({ step: "wait_for", selector: "#x" })).toEqual({
      outcome: "failed",
      error: "transport",
    });
  });
});

describe("verify_login", () => {
  it("is Works only for a login that completed, in a context that is then closed", async () => {
    const { step, r } = await setup();
    const handle = `candidate:${crypto.randomUUID()}`;
    await step({ step: "generate_candidate", handle });
    // The site still holds the old password: the candidate is refused.
    expect(await step({ step: "verify_login", reference: handle })).toEqual({
      outcome: "verified",
      verified: "Rejected",
    });
    // The current password is what the site holds: a login with it works.
    expect(
      await step({ step: "verify_login", reference: "current_password" }),
    ).toEqual({
      outcome: "verified",
      verified: "Works",
    });
    expect(r.browser.privateWindows).toEqual({ opened: 2, closed: 2 });
  });

  it("waits for the signed-in marker no longer than the login window", async () => {
    const { step, deps } = await setup();
    const waits: number[] = [];
    const fresh = deps.pages.fresh.bind(deps.pages);
    deps.pages.fresh = async () => {
      const clean = await fresh();
      if (clean === null) return null;
      const waitFor = clean.waitFor.bind(clean);
      clean.waitFor = (selector, timeoutMs) => {
        waits.push(timeoutMs ?? 0);
        return waitFor(selector, timeoutMs);
      };
      return clean;
    };
    const handle = `candidate:${crypto.randomUUID()}`;
    await step({ step: "generate_candidate", handle });
    expect(await step({ step: "verify_login", reference: handle })).toEqual({
      outcome: "verified",
      verified: "Rejected",
    });
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(deps.loginWindowMs ?? 0);
  });
});
