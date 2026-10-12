import { describe, expect, it } from "vitest";
import { catalogProviders } from "./connector-catalog.js";
import { docLink, isFnoxLink } from "./doc-link.js";

describe("docLink", () => {
  it("calls a page on fnox's site fnox's documentation, never the product's", () => {
    expect(
      docLink("Bitwarden", "https://fnox.jdx.dev/providers/bitwarden.html"),
    ).toEqual({
      url: "https://fnox.jdx.dev/providers/bitwarden.html",
      label: "fnox documentation",
      short: "fnox docs",
    });
  });

  it("calls a bare marketing homepage a website", () => {
    expect(docLink("Adobe", "https://adobe.io")).toMatchObject({
      label: "Adobe website",
      short: "Website",
    });
    expect(docLink("Lucid", "https://lucid.app/")?.label).toBe("Lucid website");
  });

  it("keeps the front page of a documentation host documentation", () => {
    expect(
      docLink("Nebius", "https://docs.tokenfactory.nebius.com/")?.label,
    ).toBe("Nebius documentation");
    expect(docLink("Workday", "https://doc.workday.com/")?.label).toBe(
      "Workday documentation",
    );
  });

  it("calls a path on the product's own site documentation", () => {
    expect(
      docLink("Bitwarden", "https://bitwarden.com/help/bitwarden-apis/"),
    ).toMatchObject({ label: "Bitwarden documentation", short: "Docs" });
  });

  it("draws nothing for an absent, malformed or non-https address", () => {
    expect(docLink("X", null)).toBeNull();
    expect(docLink("X", "not a url")).toBeNull();
    expect(docLink("X", "http://example.com/docs")).toBeNull();
  });
});

describe("the catalog's documentation links", () => {
  const rows = catalogProviders();

  it("never labels fnox's page as the product's documentation", () => {
    for (const row of rows) {
      const link = docLink(row.displayName, row.docsUrl);
      if (isFnoxLink(row.docsUrl ?? ""))
        expect(link?.label, row.id).toBe("fnox documentation");
      else expect(link?.label, row.id).not.toBe("fnox documentation");
    }
  });

  it("points a vendor's product at the vendor, leaving fnox only where the row is fnox's own concept", () => {
    const fnoxOnly = rows
      .filter((row) => isFnoxLink(row.docsUrl ?? ""))
      .map((row) => row.id)
      .sort();
    // These are fnox's own providers (a plaintext file, a sealed file, an
    // encrypted remote, a command, the OS keychain): no vendor documents them.
    expect(fnoxOnly).toEqual([
      "custom-command",
      "encrypted-remote",
      "keychain",
      "plain",
      "sealed-local",
    ]);
  });
});
