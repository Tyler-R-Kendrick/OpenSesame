import { describe, expect, it } from "vitest";
import { canonicalResource } from "./resource.js";

describe("RFC 8707 resource indicators", () => {
  it("keeps the one spelling a resource has", () => {
    for (const ok of [
      "https://api.openai.com/v1",
      "https://openrouter.ai/api/v1",
      "https://generativelanguage.googleapis.com/v1beta",
      "https://api.deepseek.com",
      "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
      "https://api.synthetic.new/openai/v1",
    ]) {
      expect(canonicalResource(ok)).toBe(ok);
    }
  });

  it("refuses every other spelling rather than repairing it", () => {
    for (const bad of [
      "",
      "api.openai.com/v1",
      "http://api.openai.com/v1",
      "ftp://api.openai.com/v1",
      "//api.openai.com/v1",
      "https://",
      "https:///v1",
      "https://API.openai.com/v1",
      "https://api.OpenAI.com/v1",
      "https://api.openai.com/v1/",
      "https://api.openai.com/",
      "https://api.openai.com:443/v1",
      "https://api.openai.com:8443/v1",
      "https://user@api.openai.com/v1",
      "https://user:pw@api.openai.com/v1",
      "https://api.openai.com@evil.test/v1",
      "https://evil.test#@api.openai.com/v1",
      "https://api.openai.com/v1?x=1",
      "https://api.openai.com/v1#frag",
      "https://api.openai.com/v1?",
      "https://api.openai.com/./v1",
      "https://api.openai.com/../v1",
      "https://api.openai.com/v1/..",
      "https://api.openai.com//v1",
      "https://api.openai.com/v1//x",
      "https://api.openai.com/%2e%2e/v1",
      "https://api.openai.com/v1%2fx",
      "https://api.openai.com/v1\\x",
      "https://api.openai.com/v1 x",
      "https://api.openai.com/v1\n",
      "https://api.openai.com\t/v1",
      "https://apí.openai.com/v1",
      "https://xn--pi-hpa.openai.com./v1",
      "https://api.openai.com./v1",
      "https://127.0.0.1/v1",
      "https://localhost/v1",
      "https://[::1]/v1",
      "https://-bad.example.com/v1",
      `https://${"a".repeat(64)}.example.com/v1`,
      `https://api.openai.com/${"a".repeat(600)}`,
    ]) {
      expect(() => canonicalResource(bad), JSON.stringify(bad)).toThrow();
    }
    for (const notAString of [
      null,
      undefined,
      4,
      {},
      [],
      ["https://api.openai.com/v1"],
    ]) {
      expect(() => canonicalResource(notAString)).toThrow();
    }
  });
});
