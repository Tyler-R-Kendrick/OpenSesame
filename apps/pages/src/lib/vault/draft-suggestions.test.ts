import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestItemMetadata } from "../../webmcp/draft-suggestions.js";
import {
  draftSuggestionSeams,
  suggestDraftLabels,
} from "./draft-suggestions.js";

const original = draftSuggestionSeams.model;
const originalActivation = draftSuggestionSeams.userActivated;
afterEach(() => {
  draftSuggestionSeams.model = original;
  draftSuggestionSeams.userActivated = originalActivation;
});

function model(answer = '{"name":"Example login","username":"quiet_fox"}') {
  const prompt = vi.fn(async () => answer);
  const destroy = vi.fn();
  const create = vi.fn(async () => ({ prompt, destroy }));
  draftSuggestionSeams.model = () => ({
    availability: async () => "available",
    create,
  });
  return { prompt, destroy, create };
}

describe("bounded on-device label suggestions", () => {
  it("allows model preparation only with both explicit consent and browser user activation", async () => {
    const fake = model();
    draftSuggestionSeams.model = () => ({
      availability: async () => "downloadable",
      create: fake.create,
    });
    draftSuggestionSeams.userActivated = () => false;
    await expect(
      suggestDraftLabels(
        { typeId: "login" },
        new AbortController().signal,
        true,
      ),
    ).rejects.toThrow("local_model_not_ready");
    expect(fake.create).not.toHaveBeenCalled();
    draftSuggestionSeams.userActivated = () => true;
    expect(
      await suggestDraftLabels(
        { typeId: "login" },
        new AbortController().signal,
        true,
      ),
    ).toMatchObject({ name: "Example login" });
    expect(fake.create).toHaveBeenCalledOnce();
  });
  it("passes only category and site origin and destroys the isolated session", async () => {
    const fake = model();
    expect(
      await suggestDraftLabels(
        { typeId: "login", website: "https://example.com/private-path" },
        new AbortController().signal,
      ),
    ).toEqual({ name: "Example login", username: "quiet_fox" });
    expect(fake.prompt).toHaveBeenCalledWith(
      '{"category":"login","website":"https://example.com"}',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fake.destroy).toHaveBeenCalledOnce();
  });
  it.each(["unavailable", "downloadable", "downloading"] as const)(
    "never downloads or falls back when %s",
    async (availability) => {
      const fake = model();
      draftSuggestionSeams.model = () => ({
        availability: async () => availability,
        create: fake.create,
      });
      await expect(
        suggestDraftLabels({ typeId: "login" }, new AbortController().signal),
      ).rejects.toThrow("local_model_not_ready");
      expect(fake.create).not.toHaveBeenCalled();
    },
  );
  it("handles an absent API and an already cancelled request", async () => {
    expect(originalActivation()).toBe(false);
    draftSuggestionSeams.model = () => null;
    await expect(
      suggestDraftLabels({ typeId: "login" }, new AbortController().signal),
    ).rejects.toThrow("local_model_not_ready");
    const fake = model();
    await expect(
      suggestDraftLabels({ typeId: "login" }, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([
    "null",
    "[]",
    "{}",
    '{"name":"<script>","username":"user"}',
    '{"name":"x","username":"x","password":"secret"}',
    '{"name":"x","username":"a b"}',
    "x".repeat(257),
  ])("refuses malformed, extra and executable output", async (answer) => {
    const fake = model(answer);
    await expect(
      suggestDraftLabels({ typeId: "login" }, new AbortController().signal),
    ).rejects.toThrow();
    expect(fake.destroy).toHaveBeenCalledOnce();
  });
  it("rejects secret-bearing context before model creation", async () => {
    const fake = model();
    await expect(
      suggestDraftLabels(
        { typeId: "login", website: "https://example.com/?token=SENTINEL" },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fake.create).not.toHaveBeenCalled();
  });
  it("makes the same suggestion available through the metadata MCP tool", async () => {
    model();
    expect(
      await suggestItemMetadata({
        action: "suggest",
        kind: "login",
        source: "browser",
        url: "https://example.com",
      }),
    ).toEqual({
      status: "suggested",
      source: "browser",
      name: "Example login",
      username: "quiet_fox",
    });
    const random = await suggestItemMetadata({
      action: "suggest",
      kind: "secret",
    });
    expect(Object.keys(random).sort()).toEqual([
      "name",
      "source",
      "status",
      "username",
    ]);
    await expect(
      suggestItemMetadata({
        action: "suggest",
        kind: "login",
        password: "SENTINEL",
      }),
    ).rejects.toThrow("invalid_suggestion_arguments");
  });
});
