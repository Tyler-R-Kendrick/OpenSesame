import { isFunction } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import * as api from "../index.js";

describe("package barrel", () => {
  it("re-exports the public surface", () => {
    expect(isFunction(api.createOpenSesameProvider)).toBe(true);
    expect(isFunction(api.canonicalResource)).toBe(true);
    expect(isFunction(api.isResourceAllowed)).toBe(true);
    expect(isFunction(api.isPkceRequired)).toBe(true);
    expect(isFunction(api.readOAuthProviderEnv)).toBe(true);
    expect(isFunction(api.createMemoryAdapterConstructor)).toBe(true);
    expect(isFunction(api.createPostgresAdapterConstructor)).toBe(true);
    expect(isFunction(api.MemoryPairwiseSubjectStore)).toBe(true);
    expect(isFunction(api.createPairwiseIdentifierCallback)).toBe(true);
    expect(isFunction(api.createClientAdmissionPolicy)).toBe(true);
    expect(isFunction(api.defaultAdmissionFromEnv)).toBe(true);
    expect(isFunction(api.ClientAdmissionError)).toBe(true);
    expect(isFunction(api.SafeMetadataFetcher)).toBe(true);
    expect(isFunction(api.UnsafeMetadataUrlError)).toBe(true);
    expect(isFunction(api.assertSafeMetadataUrl)).toBe(true);
    expect(isFunction(api.EnvSigningKeyProvider)).toBe(true);
    expect(api.ORIGIN_PROFILE_FORBIDDEN_SCOPES).toContain("offline_access");
  });
});
