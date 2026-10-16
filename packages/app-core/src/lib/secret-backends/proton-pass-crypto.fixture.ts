import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import type { ProtonItemRevision } from "./proton-pass-items.js";

export function shareKey(rotation: number): Uint8Array {
  return new Uint8Array(32).fill(rotation + 50);
}
export function envelope(
  plain: Uint8Array,
  key: Uint8Array,
  tag: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(tag));
  return Buffer.concat([
    iv,
    cipher.update(plain),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function open(
  encrypted: string,
  key: Uint8Array,
  tag: string,
): Uint8Array {
  const bytes = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(tag));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    decipher.update(bytes.subarray(12, -16)),
    decipher.final(),
  ]);
}
function message(field: number, bytes: Uint8Array): Uint8Array {
  return new BinaryWriter().tag(field, 2).bytes(bytes).finish();
}
export function itemBytes(
  name: string,
  kind: "note" | "login" = "note",
): Uint8Array {
  const metadata = new BinaryWriter()
    .tag(1, 2)
    .string(name)
    .tag(2, 2)
    .string("fixture note")
    .tag(3, 2)
    .string("public-uuid")
    .finish();
  const login = new BinaryWriter()
    .tag(1, 2)
    .string("retain@email.test")
    .tag(2, 2)
    .string("fixture password")
    .tag(6, 2)
    .string("fixture user")
    .tag(100, 2)
    .string("unknown-preserved")
    .finish();
  return new BinaryWriter()
    .raw(message(1, metadata))
    .raw(
      message(
        2,
        message(
          kind === "note" ? 2 : 3,
          kind === "note" ? new Uint8Array() : login,
        ),
      ),
    )
    .tag(101, 2)
    .string("root-preserved")
    .finish();
}
export function seeded(
  id: string,
  name: string,
  rotation = 0,
  kind: "note" | "login" = "note",
): ProtonItemRevision {
  const itemKey = new Uint8Array(32).fill(90);
  return {
    ItemID: id,
    Revision: 4,
    ContentFormatVersion: 7,
    KeyRotation: rotation,
    Content: envelope(itemBytes(name, kind), itemKey, "itemcontent"),
    ItemKey: envelope(itemKey, shareKey(rotation), "itemkey"),
    State: 1,
    FolderID: null,
  };
}
export function openStored(item: ProtonItemRevision): Uint8Array {
  if (!item.ItemKey) throw new Error("Fixture has no item key");
  return open(
    item.Content,
    open(item.ItemKey, shareKey(item.KeyRotation), "itemkey"),
    "itemcontent",
  );
}
