import { describe, expect, it } from "vitest";
import * as api from "../index.js";

describe("package barrel", () => {
  it("re-exports the public surface", () => {
    expect(typeof api.createOpenSesameProvider).toBe("function");
    expect(typeof api.canonicalResource).toBe("function");
    expect(typeof api.isResourceAllowed).toBe("function");
    expect(typeof api.isPkceRequired).toBe("function");
    expect(typeof api.readOAuthProviderEnv).toBe("function");
    expect(typeof api.createMemoryAdapterConstructor).toBe("function");
    expect(typeof api.createPostgresAdapterConstructor).toBe("function");
    expect(typeof api.MemoryPairwiseSubjectStore).toBe("function");
    expect(typeof api.createPairwiseIdentifierCallback).toBe("function");
    expect(typeof api.createClientAdmissionPolicy).toBe("function");
    expect(typeof api.defaultAdmissionFromEnv).toBe("function");
    expect(typeof api.ClientAdmissionError).toBe("function");
    expect(typeof api.SafeMetadataFetcher).toBe("function");
    expect(typeof api.UnsafeMetadataUrlError).toBe("function");
    expect(typeof api.assertSafeMetadataUrl).toBe("function");
    expect(typeof api.EnvSigningKeyProvider).toBe("function");
    expect(api.ORIGIN_PROFILE_FORBIDDEN_SCOPES).toContain("offline_access");
  });
});
