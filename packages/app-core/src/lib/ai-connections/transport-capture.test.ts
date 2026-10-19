import { afterEach, expect, it, vi } from "vitest";
import { tlsFetch } from "../test/native-s3-backup-fixtures.js";
import { inferAiConnection } from "./inference.js";
import { aiNativeTlsFixture } from "./native-tls.test-support.js";
import { aiConnectionDraft } from "./presets.js";
import {
  aiConnectionTransport,
  bindAiConnectionTransport,
  captureAiConnectionTransport,
} from "./transport.js";
import type { AiConnectionTransport } from "./types.js";

const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});
function port(): AiConnectionTransport {
  const lifetime = new AbortController();
  return {
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
    fetch: vi.fn(async () => new Response("original answer")),
  };
}
it("preserves projection getter identity and captures once only at explicit workflow entry", async () => {
  const snapshot = port();
  const capture = vi.fn(() => snapshot);
  const original = { ...port(), capture };
  releases.push(bindAiConnectionTransport(original));
  expect(aiConnectionTransport()).toBe(original);
  expect(aiConnectionTransport()).toBe(original);
  expect(capture).not.toHaveBeenCalled();
  const held = captureAiConnectionTransport();
  expect(Object.isFrozen(held)).toBe(true);
  expect(held.capture).toBeUndefined();
  expect(await (await held.fetch("https://models.example/v1")).text()).toBe(
    "original answer",
  );
  expect(capture).toHaveBeenCalledTimes(1);
  expect(aiConnectionTransport()).toBe(original);
});
it("retains prototype methods and both original receivers", async () => {
  class Port {
    signal = new AbortController().signal;
    answer = "inherited answer";
    assertCurrent() {
      expect(this.signal.aborted).toBe(false);
    }
    fetch() {
      return Promise.resolve(new Response(this.answer));
    }
    assertEndpointAllowed(endpoint: string) {
      expect(this.answer).toBe("inherited answer");
      expect(endpoint).toBe("https://models.example/v1");
    }
  }
  const snapshot = new Port();
  class Authority extends Port {
    capture() {
      expect(this).toBe(original);
      return snapshot;
    }
  }
  const original = new Authority();
  releases.push(bindAiConnectionTransport(original));
  const held = captureAiConnectionTransport();
  held.assertEndpointAllowed?.("https://models.example/v1");
  expect(await (await held.fetch("https://models.example/v1")).text()).toBe(
    "inherited answer",
  );
});
it.each(["assert", "capture"])(
  "rejects reentrant replacement during original %s",
  (where) => {
    const replacement = port();
    const original = port();
    if (where === "assert")
      original.assertCurrent = () => {
        releases.push(bindAiConnectionTransport(replacement));
      };
    else
      original.capture = () => {
        releases.push(bindAiConnectionTransport(replacement));
        return replacement;
      };
    releases.push(bindAiConnectionTransport(original));
    expect(captureAiConnectionTransport).toThrow("changed");
    expect(aiConnectionTransport()).toBe(replacement);
  },
);
it.each(
  ["original", "snapshot"].flatMap((which) =>
    [
      "fetch",
      "assertCurrent",
      "capture",
      "signal",
      "assertEndpointAllowed",
    ].map((field) => ({ which, field })),
  ),
)("refuses changed $which $field before another send", ({ which, field }) => {
  const snapshot = port();
  const original = { ...port(), capture: () => snapshot };
  releases.push(bindAiConnectionTransport(original));
  const held = captureAiConnectionTransport();
  const replacement = vi.fn(async () => new Response("replacement"));
  Object.assign(which === "original" ? original : snapshot, {
    [field]: field === "signal" ? new AbortController().signal : replacement,
  });
  expect(() => held.fetch("https://models.example/v1")).toThrow("changed");
  expect(replacement).not.toHaveBeenCalled();
});

it("never borrows a replacement registration after an await or stale disposer", async () => {
  const original = port();
  const release = bindAiConnectionTransport(original);
  releases.push(release);
  const held = captureAiConnectionTransport();
  const replacement = port();
  releases.push(bindAiConnectionTransport(replacement));
  release();
  await Promise.resolve();
  expect(held.assertCurrent).toThrow("changed");
  expect(() => held.fetch("https://models.example/v1")).toThrow("changed");
  expect(replacement.fetch).not.toHaveBeenCalled();
  expect(aiConnectionTransport()).toBe(replacement);
});
it("checks original registration again after snapshot assertions and endpoint admission", () => {
  const snapshot = port();
  const original = { ...port(), capture: () => snapshot };
  releases.push(bindAiConnectionTransport(original));
  let replace = false;
  snapshot.assertEndpointAllowed = () => {
    if (replace) releases.push(bindAiConnectionTransport(port()));
  };
  const held = captureAiConnectionTransport();
  replace = true;
  expect(() =>
    held.assertEndpointAllowed?.("https://models.example/v1"),
  ).toThrow("changed");
});

it.each([false, true])(
  "consumes a strictly verified TLS fixture with stream=%s through one explicit snapshot",
  async (stream) => {
    const http = await aiNativeTlsFixture("Standalone TLS answer", [
      "snapshot-fixture-key",
    ]);
    try {
      releases.push(
        bindAiConnectionTransport({ ...port(), fetch: http.secureFetch }),
      );
      const captured = captureAiConnectionTransport();
      const draft = {
        ...aiConnectionDraft("byo-ai"),
        baseUrl: `https://127.0.0.1:${http.port}/custom/v1`,
        model: "standalone-model",
        apiKey: "snapshot-fixture-key",
      };
      const chunks: string[] = [];
      await expect(
        inferAiConnection(
          draft,
          {
            model: draft.model,
            messages: [{ role: "user", content: "Owned TLS inference" }],
            maxOutputTokens: 16,
          },
          captured,
          captured.assertCurrent,
          stream ? (text) => chunks.push(text) : undefined,
        ),
      ).resolves.toEqual({
        providerId: "byo-ai",
        model: draft.model,
        answer: "Standalone TLS answer",
      });
      expect(http.requests).toHaveLength(1);
      expect(http.requests[0]?.headers.authorization).toBe(
        "Bearer snapshot-fixture-key",
      );
      if (stream) expect(chunks.join("")).toBe("Standalone TLS answer");
    } finally {
      await http.close();
    }
  },
);
it("the owned TLS fixture refuses an incorrect bearer key", async () => {
  const http = await aiNativeTlsFixture("No credential echo", [
    "expected-fixture-key",
  ]);
  try {
    const response = await http.secureFetch(
      `https://127.0.0.1:${http.port}/custom/v1/chat/completions`,
      {
        method: "POST",
        headers: { authorization: "Bearer wrong-fixture-key" },
        body: "{}",
      },
    );
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  } finally {
    await http.close();
  }
});

it("refuses the same TLS endpoint without its owned certificate authority", async () => {
  const http = await aiNativeTlsFixture("Untrusted response", ["fixture-key"]);
  try {
    await expect(
      tlsFetch(new Uint8Array())(
        `https://127.0.0.1:${http.port}/custom/v1/chat/completions`,
        {
          method: "POST",
          headers: { authorization: "Bearer fixture-key" },
          body: "{}",
        },
      ),
    ).rejects.toThrow(/certificate|self-signed/i);
    expect(http.requests).toEqual([]);
  } finally {
    await http.close();
  }
});

it("refuses replacement performed by a held snapshot assertion itself", () => {
  const snapshot = port();
  let replace = false;
  snapshot.assertCurrent = () => {
    if (replace) releases.push(bindAiConnectionTransport(port()));
  };
  releases.push(
    bindAiConnectionTransport({ ...port(), capture: () => snapshot }),
  );
  const held = captureAiConnectionTransport();
  replace = true;
  expect(held.assertCurrent).toThrow("changed");
});
