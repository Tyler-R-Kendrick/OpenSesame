/**
 * The Pages drive client against `spec/conformance/vault-drive-protocol.json`
 * (ADR 0143): for every exchange, the client must send exactly the request
 * the spec records and read the recorded answer the way the protocol means
 * it. The daemon replays the same exchanges against its real router
 * (`crates/daemon/src/vault_drive_conformance_tests.rs`).
 */
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, describe, expect, it } from "vitest";
import spec from "../../../../../spec/conformance/vault-drive-protocol.json" with {
  type: "json",
};
import {
  DriveError,
  driveClientSeams,
  readDrive,
  writeDrive,
} from "./client.js";
import { PAIRING_PREFIX, parsePairingCode } from "./pairing.js";
import {
  DRIVE_SNAPSHOT_FORMAT,
  type DriveSnapshot,
  parseDriveSnapshot,
} from "./snapshot.js";

const original = driveClientSeams.fetch;
const pairing = {
  url: spec.pairing.url,
  slot: spec.pairing.slot,
  key: spec.pairing.key,
  label: spec.pairing.label,
};
const WRONG_KEY = "w".repeat(43);

const SNAPSHOTS: JsonObject = spec.snapshots;

/** `"$name"` → `snapshots[name]`, anywhere in a value. */
function resolve(value: BoundaryValue): BoundaryValue {
  if (isString(value) && value.startsWith("$")) {
    return SNAPSHOTS[value.slice(1)];
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, resolve(inner)]),
    );
  }
  return value;
}

type Sent = {
  url: string;
  method: string;
  auth: string | null;
  body: BoundaryValue;
};

/** Answer the next request with `response`, recording what was sent. */
function answerWith(response: {
  status: number;
  body: BoundaryValue;
}): Sent[] {
  const sent: Sent[] = [];
  driveClientSeams.fetch = async (url, init) => {
    sent.push({
      url,
      method: String(init.method),
      auth: new Headers(init.headers).get("authorization"),
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(resolve(response.body)), {
      status: response.status,
    });
  };
  return sent;
}

afterEach(() => {
  driveClientSeams.fetch = original;
});

describe("drive protocol conformance", () => {
  it("reads the pairing code the daemon prints", () => {
    expect(PAIRING_PREFIX).toBe(spec.pairing.prefix);
    expect(parsePairingCode(spec.pairing.code)).toEqual(pairing);
  });

  it("agrees on the snapshot format, and every recorded snapshot parses", () => {
    expect(DRIVE_SNAPSHOT_FORMAT).toBe(spec.snapshotFormat);
    for (const snapshot of Object.values(spec.snapshots)) {
      expect(parseDriveSnapshot(snapshot)).toEqual(snapshot);
    }
  });

  for (const exchange of spec.exchanges) {
    it(exchange.name, async () => {
      const { request, response } = exchange;
      const as = {
        ...pairing,
        key: request.key === "slot" ? pairing.key : WRONG_KEY,
      };
      const sent = answerWith(response);
      const sentBody = "body" in request ? resolve(request.body) : undefined;
      const body: JsonObject | undefined = isJsonObject(sentBody)
        ? sentBody
        : undefined;
      const snapshot: DriveSnapshot = overlapCast(body?.snapshot);
      const call =
        request.method === "GET"
          ? readDrive(as)
          : writeDrive(as, Number(body?.expected_generation), snapshot);
      const outcome = await call.catch((error: DriveError) => error);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        url: `${pairing.url}${spec.path.replace("{slot}", pairing.slot)}`,
        method: request.method,
        auth: `Bearer ${as.key}`,
        body,
      });

      const answer: JsonObject = overlapCast(resolve(response.body));
      if (response.status === 200 && request.method === "GET") {
        expect(outcome).toEqual({
          generation: answer.generation,
          snapshot: answer.snapshot,
        });
      } else if (response.status === 200) {
        expect(outcome).toEqual({ ok: true, generation: answer.generation });
      } else if (response.status === 409) {
        expect(outcome).toEqual({ ok: false, generation: answer.generation });
      } else {
        expect(outcome).toBeInstanceOf(DriveError);
        const refused: DriveError = overlapCast(outcome);
        expect(refused.status).toBe(response.status);
      }
    });
  }
});
