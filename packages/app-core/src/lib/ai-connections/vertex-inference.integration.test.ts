import { afterEach, expect, it, vi } from "vitest";
import { gcpKeyFile, installGcpKey } from "../native-gcp.test-support.js";
import { TOKEN, vertexFixture } from "./vertex-http.test-support.js";
import { inferVertexAi } from "./vertex-inference.js";
import {
  type VertexAiDraft,
  VertexAiTargetSchema,
  vertexConnectionTarget,
  vertexResourceBase,
} from "./vertex-target.js";
installGcpKey();
afterEach(() => vi.restoreAllMocks());
function draft(
  credential: "service-account" | "access-token" = "service-account",
): VertexAiDraft {
  return {
    providerId: "google-vertex",
    name: "Vertex",
    family: "gemini_generate_content",
    baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
    model: "gemini-2.5-flash",
    authentication: "api-key",
    apiKey: credential === "service-account" ? gcpKeyFile() : TOKEN,
    tokenParameter: "max_tokens",
    vertex: { project: "my-project-123", location: "us-central1", credential },
  };
}
const input = {
  model: "gemini-2.5-flash",
  messages: [
    { role: "system" as const, content: "Stay concise." },
    { role: "user" as const, content: "Actual question." },
  ],
  maxOutputTokens: 32,
};
it.each(["service-account", "access-token"] as const)(
  "uses actual %s auth and exact finite Vertex protocol",
  async (credential) => {
    const fixture = await vertexFixture();
    const onText = vi.fn();
    try {
      const configured = draft(credential);
      await expect(
        inferVertexAi(
          configured,
          input,
          fixture.port,
          fixture.port.assertCurrent,
          onText,
        ),
      ).resolves.toEqual({
        providerId: "google-vertex",
        model: input.model,
        answer: "Exact Vertex answer.",
      });
      expect(fixture.records).toHaveLength(
        credential === "service-account" ? 2 : 1,
      );
      if (credential === "service-account")
        expect(fixture.records[0]).toMatchObject({
          path: "/token",
          authenticated: true,
          ended: true,
        });
      const call = fixture.records.at(-1);
      expect(call).toMatchObject({
        path: "/v1/projects/my-project-123/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
        authenticated: true,
        ended: true,
      });
      expect(JSON.parse(call?.body ?? "null")).toEqual({
        contents: [{ role: "user", parts: [{ text: "Actual question." }] }],
        systemInstruction: { parts: [{ text: "Stay concise." }] },
        generationConfig: { maxOutputTokens: 32 },
      });
      expect(call?.body).not.toContain(configured.apiKey);
      expect(onText).toHaveBeenCalledExactlyOnceWith("Exact Vertex answer.");
      expect(fixture.faults).toEqual([]);
    } finally {
      await fixture.close();
    }
  },
);
it("uses same public target for global native and explicitly configured BYO mount", async () => {
  const fixture = await vertexFixture();
  try {
    const global = draft("access-token");
    global.vertex.location = "global";
    global.baseUrl = vertexResourceBase(global.vertex);
    await inferVertexAi(
      global,
      input,
      fixture.port,
      fixture.port.assertCurrent,
    );
    expect(fixture.records[0]?.path).toContain("/locations/global/");
    const byo = draft("access-token");
    byo.providerId = "byo-ai";
    byo.baseUrl = "http://localhost:41999/custom/vertex";
    await inferVertexAi(byo, input, fixture.port, fixture.port.assertCurrent);
    expect(fixture.records[1]?.path).toBe(
      "/custom/vertex/projects/my-project-123/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
    );
  } finally {
    await fixture.close();
  }
});
it.each(["unauthorized", "malformed", "echo"])(
  "does not publish a result after actual %s provider response",
  async (mode) => {
    const fixture = await vertexFixture();
    const onText = vi.fn();
    try {
      fixture.setMode(mode);
      await expect(
        inferVertexAi(
          draft(),
          input,
          fixture.port,
          fixture.port.assertCurrent,
          onText,
        ),
      ).rejects.toThrow();
      expect(onText).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);
it.each(["hold-token", "held"])(
  "physically closes actual %s response on original owner withdrawal",
  async (mode) => {
    const fixture = await vertexFixture();
    const onText = vi.fn();
    try {
      fixture.setMode(mode);
      const running = inferVertexAi(
        draft(),
        input,
        fixture.port,
        fixture.port.assertCurrent,
        onText,
      );
      const refused = expect(running).rejects.toThrow();
      await expect
        .poll(() => fixture.records.length)
        .toBe(mode === "hold-token" ? 1 : 2);
      expect(fixture.records.at(-1)?.ended).toBe(false);
      fixture.abort.abort();
      await refused;
      await expect.poll(() => fixture.records.at(-1)?.closed).toBe(true);
      expect(fixture.records.at(-1)?.ended).toBe(false);
      expect(onText).not.toHaveBeenCalled();
    } finally {
      await fixture.close();
    }
  },
);
it("refuses foreign provider/family/mode, unknown public fields and native endpoint mismatch before egress", async () => {
  const fixture = await vertexFixture();
  try {
    expect(
      VertexAiTargetSchema.safeParse({ ...draft().vertex, accessToken: TOKEN })
        .success,
    ).toBe(false);
    for (const change of [
      { providerId: "openai" },
      { family: "openai_chat" as const },
      { baseUrl: "https://evil.example/v1" },
      { vertex: { ...draft().vertex, project: "../secret" } },
    ])
      await expect(
        inferVertexAi(
          { ...draft(), ...change },
          input,
          fixture.port,
          fixture.port.assertCurrent,
        ),
      ).rejects.toThrow();
    expect(fixture.records).toEqual([]);
    expect(() =>
      vertexConnectionTarget({ ...draft(), vertex: undefined }),
    ).toThrow();
    expect(
      vertexConnectionTarget({
        ...draft(),
        providerId: "byo-ai",
        vertex: undefined,
      }),
    ).toBeNull();
  } finally {
    await fixture.close();
  }
});
