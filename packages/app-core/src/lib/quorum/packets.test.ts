import { sha256 } from "@noble/hashes/sha2";
/**
 * Packets (ADR 0186 §10): every document a circle passes between people,
 * built by the real protocol, survives the trip as one line of text; and
 * what is pasted is never trusted past the strict schema it must match.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { toB64url, toHex, utf8Bytes } from "./bytes.js";
import { signCancellation } from "./cancellation.js";
import type { Json } from "./canonical.js";
import { createInvite } from "./enroll.js";
import {
  MAX_PACKET_BYTES,
  PACKET_KINDS,
  type Packet,
  PacketError,
  type PacketKind,
  decodePacket,
  encodePacket,
  expectPacket,
  packetKind,
} from "./packets.js";
import {
  approve,
  raise,
  release,
  threeOfFive,
} from "./protocol.test-support.js";
import { T0, person } from "./world.test-support.js";

/** A packet an attacker could make: any kind, any body, a correct check. */
function withCheck(kind: string, body: string): string {
  const sum = toHex(sha256(utf8Bytes(`osq1.${kind}.${body}`))).slice(0, 6);
  return `osq1.${kind}.${body}.${sum}`;
}

function forged(kind: string, body: Json): string {
  return withCheck(kind, toB64url(utf8Bytes(JSON.stringify(body))));
}

/** One real document of every kind, made by the protocol itself. */
async function everyKind(): Promise<Packet[]> {
  const world = await threeOfFive();
  const r = await raise(world);
  const first = await approve(world, "Ada", r);
  await approve(world, "Ben", r);
  await approve(world, "Cy", r);
  r.clock.advanceTo(3601);
  const released = await release(world, "Ada", r);
  const ada = person(world, "Ada");
  const delivery = world.created.deliveries[0];
  if (!delivery || !ada.receipt) throw new Error("no delivery or receipt");
  return [
    {
      kind: "invite",
      value: createInvite({
        circleId: world.circleId,
        label: "Family",
        rpId: "vault.example.test",
        origins: ["https://vault.example.test"],
        ownerKey: world.owner.publicKey,
        requireUserVerification: true,
        now: T0,
      }),
    },
    { kind: "enrollment", value: ada.enrollment },
    { kind: "policy", value: world.created.signedPolicy },
    { kind: "delivery", value: delivery },
    { kind: "receipt", value: ada.receipt },
    { kind: "request", value: r.pending.request },
    { kind: "approval", value: first.approval },
    { kind: "approvals", value: r.ledger.approvalList() },
    { kind: "release", value: released.rel },
    {
      kind: "cancellation",
      value: signCancellation({
        circleId: world.circleId,
        requestDigest: r.ledger.digest,
        ownerSecretKey: world.owner.secretKey,
        now: T0,
      }),
    },
  ];
}

describe("a packet is one line of text", () => {
  it("round-trips every kind of document the protocol makes", async () => {
    const packets = await everyKind();
    expect(packets.map((p) => p.kind).sort()).toEqual([...PACKET_KINDS].sort());
    // A kind added to the schema and left out of the list fails to compile.
    expectTypeOf<
      Exclude<PacketKind, (typeof PACKET_KINDS)[number]>
    >().toEqualTypeOf<never>();
    for (const packet of packets) {
      const text = encodePacket(packet);
      expect(text).toMatch(/^osq1\.[a-z]+\.[A-Za-z0-9_-]+\.[0-9a-f]{6}$/);
      expect(text).not.toMatch(/\s/);
      expect(decodePacket(text)).toEqual(packet);
      expect(packetKind(text)).toBe(packet.kind);
    }
  });

  it("survives being wrapped, indented and padded by whatever carried it", async () => {
    const [invite] = await everyKind();
    if (!invite) throw new Error("no packet");
    const text = encodePacket(invite);
    const wrapped = `  ${text.replace(/(.{40})/g, "$1\n  ")}\n\n`;
    expect(decodePacket(wrapped)).toEqual(invite);
  });

  it("carries no plaintext secret: the same shapes the protocol already publishes", async () => {
    for (const packet of await everyKind()) {
      const text = JSON.stringify(packet.value);
      // A mnemonic is words; none of the documents may contain a run of them.
      expect(text).not.toMatch(/academic|acid|acne|acquire/);
    }
  });
});

describe("what is pasted is not trusted", () => {
  it("says what is wrong, not just that something is", async () => {
    const [invite] = await everyKind();
    if (!invite) throw new Error("no packet");
    const text = encodePacket(invite);
    const code = (input: string) => {
      try {
        decodePacket(input);
      } catch (error) {
        return error instanceof PacketError ? error.code : "other";
      }
      return "accepted";
    };
    expect(code("")).toBe("format");
    expect(code("hello world")).toBe("format");
    expect(code(text.slice(0, -10))).toBe("format"); // cut inside the check
    expect(code(text.slice(0, 40))).toBe("format");
    const parts = text.split(".");
    // Cut off in the body, check still present.
    expect(
      code([parts[0], parts[1], parts[2]?.slice(0, 30), parts[3]].join(".")),
    ).toBe("checksum");
    // Changed in the body.
    const flipped = `${parts[2]?.slice(0, 20)}A${parts[2]?.slice(21)}`;
    expect(code([parts[0], parts[1], flipped, parts[3]].join("."))).toBe(
      "checksum",
    );
  });

  it("refuses a kind that is not one, and a document that is not its kind", async () => {
    const [invite, enrollment] = await everyKind();
    if (!invite || !enrollment) throw new Error("no packet");
    expect(() => decodePacket(forged("shell", invite.value))).toThrow(
      /not a kind of packet/,
    );
    // An enrollment dressed as an invite passes the check and fails the shape.
    expect(() => decodePacket(forged("invite", enrollment.value))).toThrow(
      /not a valid invite/,
    );
  });

  it("refuses an oversized document before it is decoded", () => {
    const huge = "x".repeat(MAX_PACKET_BYTES + 10);
    expect(() => decodePacket(forged("invite", huge))).toThrow(/too large/);
  });

  it("encodes only a packet, not one with something extra riding along", async () => {
    const [invite] = await everyKind();
    if (!invite) throw new Error("no packet");
    const withExtra = { ...invite, note: "extra" };
    expect(() => encodePacket(withExtra)).toThrow();
  });

  it("hands a screen exactly the kind it asked for", async () => {
    const [invite, enrollment] = await everyKind();
    if (!invite || !enrollment) throw new Error("no packet");
    const text = encodePacket(enrollment);
    expect(expectPacket(text, "enrollment").value).toEqual(enrollment.value);
    expect(() => expectPacket(text, "invite")).toThrow(
      /an enrollment, not an invite/,
    );
    expect(() => expectPacket("nonsense", "invite")).toThrow(PacketError);
  });

  it("does not let a document with an unknown or prototype key through", async () => {
    const [invite] = await everyKind();
    if (!invite) throw new Error("no packet");
    expect(() =>
      decodePacket(forged("invite", { ...invite.value, extra: true })),
    ).toThrow(/not a valid invite/);
    const body = toB64url(utf8Bytes('{"__proto__":{"polluted":true},"v":1}'));
    expect(() => decodePacket(withCheck("invite", body))).toThrow(PacketError);
    expect("polluted" in {}).toBe(false);
  });
});
