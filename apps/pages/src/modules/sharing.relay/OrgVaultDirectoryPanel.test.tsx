/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrgVaultDirectoryPanel,
  orgVaultDirectorySeams,
} from "./OrgVaultDirectoryPanel.js";

afterEach(() => {
  cleanup();
  orgVaultDirectorySeams.fetch = undefined;
  clearNotices();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OrgVaultDirectoryPanel", () => {
  it("creates an organization vault and lists it by owner", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    orgVaultDirectorySeams.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, method, body });
      if (method === "POST") {
        return jsonResponse(
          {
            vault: {
              ownerKind: "organization",
              owner: "acme",
              slug: "ledger",
            },
          },
          201,
        );
      }
      return jsonResponse({
        vaults: [{ ownerKind: "organization", owner: "acme", slug: "ledger" }],
      });
    };
    render(<OrgVaultDirectoryPanel />);
    fireEvent.change(screen.getByLabelText("Relay URL"), {
      target: { value: "http://127.0.0.1:9" },
    });
    fireEvent.change(screen.getByLabelText("Principal"), {
      target: { value: "ada" },
    });
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "acme" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "ledger" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create vault" }));
    expect(await screen.findByText("acme/ledger")).toBeTruthy();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://127.0.0.1:9/v1/org-vaults");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      ownerKind: "organization",
      owner: "acme",
      slug: "ledger",
    });
    expect(calls[1]?.url).toContain("owner=acme");
    expect(listNotices()).toEqual([]);
  });

  it("lists by owner without creating", async () => {
    orgVaultDirectorySeams.fetch = async () =>
      jsonResponse({
        vaults: [{ ownerKind: "user", owner: "ada", slug: "personal" }],
      });
    render(<OrgVaultDirectoryPanel />);
    fireEvent.change(screen.getByLabelText("Relay URL"), {
      target: { value: "https://relay.example" },
    });
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "List vaults" }));
    expect(await screen.findByText("ada/personal")).toBeTruthy();
  });
});
