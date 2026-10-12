/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import type { JsonValue } from "@opensesame/os-domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function jsonResponse(body: JsonValue, status = 200): Response {
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
      const body = await new Request(input, init).text();
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

  it("tells a member when the relay refuses the publish", async () => {
    const calls: { role: string | null }[] = [];
    orgVaultDirectorySeams.fetch = async (_input, init) => {
      calls.push({
        role: new Headers(init?.headers).get("x-opensesame-org-role"),
      });
      return jsonResponse({ error: "forbidden" }, 403);
    };
    render(<OrgVaultDirectoryPanel />);
    fireEvent.change(screen.getByLabelText("Relay URL"), {
      target: { value: "http://127.0.0.1:9" },
    });
    fireEvent.change(screen.getByLabelText("Principal"), {
      target: { value: "bee" },
    });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "member" },
    });
    fireEvent.change(screen.getByLabelText("Owner"), {
      target: { value: "acme" },
    });
    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "ledger" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create vault" }));
    await waitFor(() => {
      expect(listNotices()[0]?.body).toBe(
        "A member cannot publish that address.",
      );
    });
    expect(calls[0]?.role).toBe("member");
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
