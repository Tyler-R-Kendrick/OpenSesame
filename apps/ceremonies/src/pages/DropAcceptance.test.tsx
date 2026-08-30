/** @vitest-environment jsdom */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropSeams } from "../lib/drop.js";
import { ClaimCeremony } from "./ClaimCeremony.js";
import { DropAcceptance } from "./DropAcceptance.js";

const fetchFn = vi.hoisted(() => vi.fn());

function b64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Test-side seal, mirroring the sharer's text layout in apps/pages. */
async function sealText(text: string, name = "Deploy token") {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text),
  );
  return {
    manifest: {
      kind: "secret-drop",
      name,
      contentType: "text/plain",
      ciphertext: b64(ct),
      nonce: b64(iv),
    },
    fragmentKey: b64url(raw),
  };
}

function presented(manifest: BoundaryValue): Response {
  return new Response(
    JSON.stringify({
      id: "clm_1",
      state: "presented",
      targetManifest: manifest,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function refused(body: BoundaryValue, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchFn.mockReset();
  Object.assign(dropSeams, { fetchFn });
});

afterEach(() => {
  cleanup();
  Object.assign(dropSeams, { fetchFn });
});

describe("drop acceptance", () => {
  it("renders the reveal after the single presentation", async () => {
    const { manifest, fragmentKey } = await sealText("s3cr3t-api-token");
    fetchFn.mockResolvedValueOnce(presented(manifest));

    render(<DropAcceptance token="osc_clm_a.b" fragmentKey={fragmentKey} />);
    fireEvent.change(screen.getByLabelText(/Drop code/i), {
      target: { value: "ABCD-EFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Open drop/i }));

    await screen.findByText("s3cr3t-api-token");
    expect(screen.getByText(/now burned/i)).toBeTruthy();
    // The bearer and the fragment key went nowhere near the request body.
    const [, init] = fetchFn.mock.calls.at(-1) ?? [];
    const request: RequestInit = overlapCast(init ?? {});
    const body = String(request.body ?? "");
    expect(body).not.toContain(fragmentKey);
    expect(JSON.parse(body)).toEqual({
      token: "osc_clm_a.b",
      userCode: "ABCD-EFGH",
    });
  });

  it("renders the consumed line on a second visit", async () => {
    fetchFn.mockResolvedValueOnce(
      refused({ error: "INVALID_TRANSITION" }, 422),
    );

    render(<DropAcceptance token="osc_clm_a.b" fragmentKey="a2V5" />);
    fireEvent.change(screen.getByLabelText(/Drop code/i), {
      target: { value: "ABCD-EFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Open drop/i }));

    await screen.findByText("This drop was already opened.");
  });

  it("keeps the drop unburned when the code is wrong", async () => {
    fetchFn.mockResolvedValueOnce(refused({ error: "invalid_user_code" }, 401));

    render(<DropAcceptance token="osc_clm_a.b" fragmentKey="a2V5" />);
    fireEvent.change(screen.getByLabelText(/Drop code/i), {
      target: { value: "WRONG-CODE" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Open drop/i }));

    await screen.findByText(/did not match this drop/i);
    // Still on the code form — the presentation never happened.
    expect(screen.getByLabelText(/Drop code/i)).toBeTruthy();
  });
});

describe("claim ceremony drop branch", () => {
  it("routes a link carrying token and key straight to the drop", () => {
    window.location.hash = "#token=osc_clm_a.b&key=a2V5LW1hdGVyaWFs";
    render(
      <MemoryRouter>
        <ClaimCeremony />
      </MemoryRouter>,
    );
    expect(screen.getByText("Someone dropped you a secret")).toBeTruthy();
    // Fragment discipline: the bearer and key leave the URL immediately.
    expect(window.location.hash).toBe("");
  });

  it("leaves a bare-token link on the claim path", () => {
    window.location.hash = "#other=1";
    render(
      <MemoryRouter>
        <ClaimCeremony />
      </MemoryRouter>,
    );
    expect(screen.getByText("Review and accept this claim")).toBeTruthy();
  });
});
