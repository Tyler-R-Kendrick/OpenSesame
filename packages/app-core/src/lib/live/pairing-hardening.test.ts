/**
 * What a link holder can put in front of the owner (ADR 0150 §3): one
 * spelling of each key in a link, and a name and note that cannot dress up as
 * something they are not.
 */
import { describe, expect, it } from "vitest";
import { fromB64url, toB64url } from "./b64.js";
import { LiveGuest } from "./guest.js";
import { LiveHost } from "./host.js";
import { liveValue, parseLiveLink, readLiveValue } from "./link.js";
import { FakeNet, fakeSdp } from "./live-fakes.js";
import { NAME_MAX, NOTE_MAX, readJoinRequest } from "./messages.js";
import { DIRECT_ONLY } from "./peer.js";
import { newKeypair, newLinkSecret } from "./seal.js";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The same bytes, spelled with different unused bits in the last character. */
function alias(value: string): string {
  const last = ALPHABET.indexOf(value.slice(-1));
  return value.slice(0, -1) + (ALPHABET[last | 1] ?? "");
}

describe("base64url", () => {
  it("reads only the spelling that encodes back to itself", () => {
    for (const length of [0, 1, 2, 3, 32, 65]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(fromB64url(toB64url(bytes))).toEqual(bytes);
    }
    // One byte is two characters, and the last one's low four bits are unused.
    expect(fromB64url("AA")).toEqual(new Uint8Array([0]));
    expect(fromB64url("AB")).toBeNull();
    expect(fromB64url("AA=")).toBeNull();
    expect(fromB64url("A")).toBeNull();
  });
});

describe("a link's keys", () => {
  async function link() {
    const owner = await newKeypair();
    return { owner: owner.pub, secret: newLinkSecret() };
  }

  it("reads one spelling of the owner's key and the secret, and no alias of either", async () => {
    const { owner, secret } = await link();
    const value = `v1.i.${owner}.${secret}`;
    expect(readLiveValue(value)).toEqual({
      admission: "invite",
      owner,
      secret,
      routes: null,
    });
    // The alias decodes to the same bytes, but the owner's seal binds the
    // spelling: it would parse, and then the owner would drop every request.
    const bytesOf = (text: string) =>
      atob(`${text.replace(/-/g, "+").replace(/_/g, "/")}=`);
    expect(bytesOf(alias(owner))).toBe(bytesOf(owner));
    expect(alias(owner)).not.toBe(owner);
    expect(readLiveValue(`v1.i.${alias(owner)}.${secret}`)).toBeNull();
    expect(readLiveValue(`v1.o.${owner}.${alias(secret)}`)).toBeNull();
    const url = `https://example.test/OpenSesame/#live=v1.o.${alias(owner)}.${secret}`;
    expect(parseLiveLink(url)).toBeNull();
    const parsed = readLiveValue(value);
    expect(parsed && liveValue(parsed)).toBe(value);
  });
});

describe("a joiner's name and note", () => {
  function read(name: string, note = "") {
    return readJoinRequest(
      JSON.stringify({
        id: "abcdefghijklmnopqrstuv",
        name,
        note,
        offer: fakeSdp(),
      }),
    );
  }

  it("shows nothing that hides or reorders the text around it", () => {
    // Right-to-left override: the rest of the line would read backwards.
    expect(read("‮evil‬")?.name).toBe("evil");
    expect(read("a⁦b⁩c")?.name).toBe("abc");
    expect(read("Admin​")?.name).toBe("Admin");
    expect(read("Ad‍min﻿")?.name).toBe("Admin");
    expect(read("Ada\u0000\u0007")?.name).toBe("Ada");
    expect(read("Ada­m")?.name).toBe("Adam");
    expect(read("Aㅤ⠀B")?.name).toBe("AB");
    expect(read("Ada\u{E0041}\u{E0042}")?.name).toBe("Ada");
    expect(read("Ada", "no‮ise\u0085here")?.note).toBe("noise here");
  });

  it("turns line breaks and runs of space into one space, and trims", () => {
    expect(read("  Ada \t  Lovelace\n")?.name).toBe("Ada Lovelace");
    expect(read("Ada Lovelace x")?.name).toBe("Ada Lovelace x");
    expect(read("Ada  Lovelace")?.name).toBe("Ada Lovelace");
    expect(read("Ada", "one\r\ntwo\n\n\nthree")?.note).toBe("one two three");
  });

  it("wants a name that shows something, and caps the cleaned text", () => {
    expect(read("")).toBeNull();
    expect(read("​‮ ⠀")).toBeNull();
    expect(read("x".repeat(NAME_MAX))?.name).toHaveLength(NAME_MAX);
    expect(read("x".repeat(NAME_MAX + 1))).toBeNull();
    // Invisible characters do not count against what is shown.
    expect(read(`${"x".repeat(NAME_MAX)}${"​".repeat(20)}`)?.name).toBe(
      "x".repeat(NAME_MAX),
    );
    expect(read("Ada", "n".repeat(NOTE_MAX + 1))).toBeNull();
    expect(read("Ada", "")?.note).toBe("");
    // An emoji is one character.
    expect(read("😀".repeat(NAME_MAX))?.name).toBe("😀".repeat(NAME_MAX));
  });

  it("is what the owner sees, whoever's page sent it", async () => {
    const net = new FakeNet();
    const host = await LiveHost.start({
      admission: "open",
      ice: DIRECT_ONLY,
      expiresAt: Date.now() + 60_000,
      catalog: () => ({ title: "T", policy: "read", expiresAt: 1, items: [] }),
      readField: async () => null,
      peers: net.factory(),
    });
    const guest = new LiveGuest({
      link: host.link,
      code: null,
      name: "‮gnorw‬ Ada​",
      note: "hi\u0000",
      ice: DIRECT_ONLY,
      peers: net.factory(),
    });
    expect((await host.receive(await guest.start())).kind).toBe("guest");
    expect(host.state.guests[0]).toMatchObject({
      name: "gnorw Ada",
      note: "hi",
    });
    const blank = new LiveGuest({
      link: host.link,
      code: null,
      name: "​",
      note: "",
      ice: DIRECT_ONLY,
      peers: net.factory(),
    });
    await expect(blank.start()).rejects.toThrow("join_name_required");
    host.end();
    guest.leave();
    blank.leave();
  });
});
