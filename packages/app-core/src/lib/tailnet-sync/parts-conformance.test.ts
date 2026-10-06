/**
 * The Pages parts client against the `parts` section of
 * `spec/conformance/vault-drive-protocol.json` (ADR 0144): for every
 * exchange the client sends exactly the request the spec records and reads
 * the recorded answer as the protocol means it. The daemon replays the same
 * exchanges (`crates/daemon/src/vault_drive_conformance_tests.rs`).
 */
import { FILE_PART_BYTES } from "@opensesame/vault-core";
import { afterEach, describe, expect, it } from "vitest";
import spec from "../../../../../spec/conformance/vault-drive-protocol.json" with {
  type: "json",
};
import { DriveError, driveClientSeams } from "./client.js";
import { listDriveParts, readDrivePart, writeDrivePart } from "./parts.js";

const original = driveClientSeams.fetch;
const pairing = {
  url: spec.pairing.url,
  slot: spec.pairing.slot,
  key: spec.pairing.key,
  label: spec.pairing.label,
};
const base = `${pairing.url}${spec.parts.path.replace("{slot}", pairing.slot)}`;

function bytesOf(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

type PartExchange = {
  name: string;
  request: { method: string; key: string; part?: string; bytesB64?: string };
  response: {
    status: number;
    bytesB64?: string;
    body?: { parts?: string[]; error?: string };
  };
};

const EXCHANGES: readonly PartExchange[] = spec.parts.exchanges;

type Sent = {
  url: string;
  method: string;
  auth: string | null;
  body: BodyInit | null | undefined;
};

/** What the client made of the answer: a value, or the error it threw. */
async function outcomeOf(
  { request }: PartExchange,
  as: typeof pairing,
): Promise<Set<string> | Uint8Array | null | undefined | Error> {
  try {
    if (request.part && request.method === "PUT" && request.bytesB64) {
      await writeDrivePart(as, request.part, bytesOf(request.bytesB64));
      return undefined;
    }
    if (request.part) return await readDrivePart(as, request.part);
    return await listDriveParts(as);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}

afterEach(() => {
  driveClientSeams.fetch = original;
});

describe("the parts client, exchange by exchange", () => {
  for (const exchange of EXCHANGES) {
    it(exchange.name, async () => {
      const { request, response } = exchange;
      const key = request.key === "slot" ? pairing.key : "w".repeat(43);
      const sent: Sent[] = [];
      driveClientSeams.fetch = async (url, init) => {
        sent.push({
          url,
          method: String(init.method),
          auth: new Headers(init.headers).get("authorization"),
          body: init.body,
        });
        const body = response.bytesB64
          ? bytesOf(response.bytesB64)
          : response.body
            ? JSON.stringify(response.body)
            : null;
        return new Response(body, { status: response.status });
      };
      const outcome = await outcomeOf(exchange, { ...pairing, key });

      expect(sent).toHaveLength(1);
      expect(sent[0]?.method).toBe(request.method);
      expect(sent[0]?.url).toBe(
        request.part ? `${base}/${request.part}` : base,
      );
      expect(sent[0]?.auth).toBe(`Bearer ${key}`);
      if (request.bytesB64) {
        expect(sent[0]?.body).toEqual(bytesOf(request.bytesB64));
      }
      if (response.status === 401) {
        expect(outcome).toBeInstanceOf(DriveError);
      } else if (response.bytesB64) {
        expect(outcome).toEqual(bytesOf(response.bytesB64));
      } else if (response.status === 404) {
        expect(outcome).toBeNull();
      } else if (response.body?.parts) {
        expect(outcome).toEqual(new Set(response.body.parts));
      } else {
        expect(outcome).toBeUndefined();
      }
    });
  }

  it("seals parts no larger than the drive accepts", () => {
    // A part is a chunk and its 16-byte GCM tag.
    expect(FILE_PART_BYTES + 16).toBeLessThanOrEqual(
      spec.parts.limits.maxPartBytes,
    );
  });
});
