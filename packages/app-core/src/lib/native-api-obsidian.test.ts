import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { testNativeApiCredential } from "./native-api-connectors.js";
import {
  installNativeApiTests,
  nativeAnswers,
} from "./native-api.test-support.js";

installNativeApiTests();
const draft = {
  providerId: "obsidian",
  parameters: { host: "127.0.0.1", port: "27124" },
  credentials: { api_key: "synthetic-token" },
};

describe("Obsidian vault root verification", () => {
  it("accepts an empty files array and returns no filenames", async () => {
    const provider = nativeAnswers({ body: { files: [] } });
    const result = await testNativeApiCredential(draft, provider.transport);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(result.label).toBeTruthy();
    const other = nativeAnswers({ body: { files: ["private-note.md"] } });
    const named = await testNativeApiCredential(draft, other.transport);
    expect(JSON.stringify(named)).not.toContain("private-note.md");
  });

  const malformed: BoundaryValue[] = [
    {},
    { files: null },
    { files: {} },
    { files: "not an array" },
  ];
  it.each(malformed)("rejects malformed vault listings", async (body) => {
    const provider = nativeAnswers({ body });
    await expect(
      testNativeApiCredential(draft, provider.transport),
    ).rejects.toThrow();
  });

  it("rejects authentication refusal", async () => {
    const provider = nativeAnswers({
      status: 401,
      body: { error: "unauthorized" },
    });
    await expect(
      testNativeApiCredential(draft, provider.transport),
    ).rejects.toThrow();
  });
});
