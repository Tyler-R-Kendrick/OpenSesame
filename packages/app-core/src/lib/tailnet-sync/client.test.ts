import { afterEach, describe, expect, it } from "vitest";
import {
  DriveError,
  driveClientSeams,
  readDrive,
  writeDrive,
} from "./client.js";
import { PAIRING } from "./drive.fixture.js";
import { DRIVE_SNAPSHOT_FORMAT, type DriveSnapshot } from "./snapshot.js";

const original = driveClientSeams.fetch;
const calls: { url: string; init: RequestInit }[] = [];

function answer(status: number, body: object | null): void {
  driveClientSeams.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
    });
  };
}

const SNAPSHOT: DriveSnapshot = {
  format: DRIVE_SNAPSHOT_FORMAT,
  v: 1,
  tomb: "personal",
  header: { v: 1, createdAt: "2026-01-01T00:00:00.000Z" },
  body: { ivB64: "aXY=", ctB64: "Y3Q=" },
  rev: 4,
};

afterEach(() => {
  driveClientSeams.fetch = original;
  calls.length = 0;
});

describe("drive client", () => {
  it("reads an empty slot with the key as a bearer and no cookies", async () => {
    answer(200, { generation: 0, snapshot: null });
    expect(await readDrive(PAIRING)).toEqual({ generation: 0, snapshot: null });
    const [call] = calls;
    expect(call?.url).toBe(
      "https://desk.tail1234.ts.net/v1/vault-drive/slots/slot-0000aaaa/snapshot",
    );
    expect(call?.init.credentials).toBe("omit");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(
      `Bearer ${PAIRING.key}`,
    );
  });

  it("parses a stored snapshot", async () => {
    answer(200, { generation: 3, snapshot: SNAPSHOT });
    expect(await readDrive(PAIRING)).toEqual({
      generation: 3,
      snapshot: SNAPSHOT,
    });
  });

  it("refuses a slot that holds something else", async () => {
    answer(200, { generation: 3, snapshot: { format: "other" } });
    await expect(readDrive(PAIRING)).rejects.toThrow(/not a vault snapshot/);
  });

  it("sends the expected generation and reports a lost race", async () => {
    answer(409, { error: "generation_mismatch", generation: 7 });
    expect(await writeDrive(PAIRING, 6, SNAPSHOT)).toEqual({
      ok: false,
      generation: 7,
    });
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.expected_generation).toBe(6);
    expect(calls[0]?.init.method).toBe("PUT");
  });

  it("reports a write that landed", async () => {
    answer(200, { generation: 7 });
    expect(await writeDrive(PAIRING, 6, SNAPSHOT)).toEqual({
      ok: true,
      generation: 7,
    });
  });

  it("turns a revoked key into a pairing error", async () => {
    answer(401, { error: "unauthorized" });
    const error = await readDrive(PAIRING).catch((caught) => caught);
    expect(error).toBeInstanceOf(DriveError);
    expect(error.message).toMatch(/Pair again/);
  });

  it("names an oversized vault", async () => {
    answer(413, null);
    await expect(writeDrive(PAIRING, 0, SNAPSHOT)).rejects.toThrow(/larger/);
  });
});
