import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import type { ProtonPassAccess } from "./proton-pass-session.js";
import { SecretBackendError } from "./types.js";

const Text = z.string().min(1).max(4096);
const Rotation = z.number().int().min(0).max(255);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Ciphertext = z.string().min(40).max(1400000);
const Item = z.object({
  ItemID: Text,
  Revision,
  ContentFormatVersion: z.number().int().min(1).max(7),
  KeyRotation: Rotation,
  Content: Ciphertext,
  ItemKey: Ciphertext.nullish(),
  State: z.union([z.literal(1), z.literal(2)]),
  FolderID: Text.nullish(),
});
const ItemReply = z.object({ Code: z.literal(1000), Item });
const Page = z.object({
  Code: z.literal(1000),
  Items: z.object({
    RevisionsData: z.array(Item).max(100),
    LastToken: Text.nullish(),
  }),
});
const Code = z.object({ Code: z.literal(1000) });
export type ProtonItemRevision = z.infer<typeof Item>;

function invalid(): never {
  throw new SecretBackendError(
    "response",
    "Proton Pass returned invalid item revisions.",
  );
}
export function canBeProtonItemId(id: string): boolean {
  return Boolean(id) && id.length <= 4096 && id !== "." && id !== "..";
}
export function protonItemId(id: string): string {
  if (!canBeProtonItemId(id))
    throw new SecretBackendError(
      "configuration",
      "Enter a valid Proton Pass item ID.",
    );
  return encodeURIComponent(id);
}
export function protonItemReply(reply: BoundaryValue): ProtonItemRevision {
  const parsed = ItemReply.safeParse(reply);
  if (!parsed.success) invalid();
  return parsed.data.Item;
}
export function protonSuccess(reply: BoundaryValue): void {
  if (!Code.safeParse(reply).success) invalid();
}
export function activeProtonItem(
  item: ProtonItemRevision,
): asserts item is ProtonItemRevision & { ItemKey: string } {
  if (item.State !== 1)
    throw new SecretBackendError(
      "not-found",
      "The Proton Pass item is in trash.",
    );
  if (!item.ItemKey)
    throw new SecretBackendError(
      "response",
      "The whole-vault item is missing its encrypted item key.",
    );
}

/** A bounded, complete page traversal; never report a silently truncated list. */
export async function protonItemRevisions(
  access: ProtonPassAccess,
): Promise<ProtonItemRevision[]> {
  const items: ProtonItemRevision[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let since: string | null = null;
  let characters = 0;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ PageSize: "100" });
    if (since !== null) query.set("Since", since);
    const parsed = Page.safeParse(await access.request(`item?${query}`));
    if (!parsed.success) invalid();
    for (const item of parsed.data.Items.RevisionsData) {
      if (ids.has(item.ItemID)) invalid();
      characters += item.Content.length + (item.ItemKey?.length ?? 0);
      if (characters > 32 * 1024 * 1024) invalid();
      ids.add(item.ItemID);
      items.push(item);
    }
    const next = parsed.data.Items.LastToken;
    if (!next) return items;
    if (cursors.has(next) || parsed.data.Items.RevisionsData.length === 0)
      invalid();
    cursors.add(next);
    since = next;
  }
  throw new SecretBackendError(
    "response",
    "The Proton Pass item list exceeds this operation's bounded page limit.",
  );
}
