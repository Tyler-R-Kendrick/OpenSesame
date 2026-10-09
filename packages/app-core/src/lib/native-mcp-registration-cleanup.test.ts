import { describe, expect, it, vi } from "vitest";
import { target } from "./native-mcp-oauth-fixtures.test-helper.js";
import { deleteNativeMcpRegistration } from "./native-mcp-registration-cleanup.js";

const client = {
  client_id: "issued-client",
  registration_client_uri:
    "https://express-mcp-service.adobe.io/register/issued-client",
  registration_access_token: "private-management-token",
};
describe("actual RFC7592 registration cleanup", () => {
  it.each([204, 404, 410])(
    "deletes only the returned management URI and handles idempotent status %i",
    async (status) => {
      const fetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          expect(request.url).toBe(client.registration_client_uri);
          expect(request.method).toBe("DELETE");
          expect(request.credentials).toBe("omit");
          expect(request.redirect).toBe("manual");
          expect(request.headers.get("authorization")).toBe(
            "Bearer private-management-token",
          );
          return new Response(null, { status });
        },
      );
      expect(
        await deleteNativeMcpRegistration(target, client, {
          fetch,
          assertCurrent: () => undefined,
        }),
      ).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "https://other.example.org/register/client",
    "https://express-mcp-service.adobe.io/token/client",
    "https://express-mcp-service.adobe.io/register-other/client",
  ])(
    "refuses server-announced URI outside the pinned DCR path %s",
    async (registration_client_uri) => {
      const fetch = vi.fn(async () => new Response(null, { status: 204 }));
      await expect(
        deleteNativeMcpRegistration(
          target,
          { ...client, registration_client_uri },
          { fetch, assertCurrent: () => undefined },
        ),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("does not invent deletion when the provider returned no management receipt", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    expect(
      await deleteNativeMcpRegistration(
        target,
        { client_id: "public-client" },
        { fetch, assertCurrent: () => undefined },
      ),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains a failed deletion as unresolved rather than pretending cleanup succeeded", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(
      deleteNativeMcpRegistration(target, client, {
        fetch,
        assertCurrent: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "authorization" });
  });
});
