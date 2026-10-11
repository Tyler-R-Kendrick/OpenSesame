/** @vitest-environment jsdom */
/**
 * Settings › Capabilities as files against the REAL composition store
 * (personal-local, booted with the package fixtures) and the default ports.
 * The test double does not enforce the commit preflight's rule that a draft
 * may not reuse the committed revision (CONSENT-08), so the starter's fixed
 * revision and a hand-unbumped edit only fail here.
 */
import { FIXTURE_CATALOG } from "@opensesame/capability-composition";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bootPersonalLocal,
  durable,
  freshRealm,
} from "../../lib/capabilities/__tests__/harness.js";
import { PWA_DEFAULT_OPTIONALS } from "../../lib/capabilities/pwa-defaults.js";
import { compositionStore } from "../../lib/capabilities/store.js";
import { SELECTION_SOURCE_KV_KEY } from "../../lib/configuration/capabilities-keys.js";
import {
  type CapabilityConfigPorts,
  defaultCapabilityPorts,
} from "../../lib/configuration/capabilities-resources.js";
import { SELECTION_FILE, capabilityFiles } from "./capability-files.js";

const PASSKEYS = "vault.passkey-records";

function addPasskeysToSelectionYaml(yaml: string): string {
  if (yaml.includes(`- ${PASSKEYS}`)) return yaml;
  if (/selectedOptional:\s*\[\]/.test(yaml)) {
    return yaml.replace(
      /selectedOptional:\s*\[\]/,
      `selectedOptional:\n  - ${PASSKEYS}`,
    );
  }
  const block = yaml.match(/selectedOptional:\n(?: {2}- .+\n)+/);
  if (!block) throw new Error("unrecognized selectedOptional block");
  return yaml.replace(block[0], `${block[0]}  - ${PASSKEYS}\n`);
}

/** The real store and ports, with the catalog the store was booted with. */
function realPorts(): CapabilityConfigPorts {
  return {
    ...defaultCapabilityPorts(() => null),
    catalog: () => FIXTURE_CATALOG,
  };
}

const provider = () =>
  capabilityFiles({ ports: realPorts, operator: () => true });

const committed = () => compositionStore.getSnapshot().selection;

beforeEach(async () => {
  freshRealm();
  await bootPersonalLocal();
});

describe("the selection file against the real store", () => {
  it("commits the starter, then an edit that keeps the revision it was read at", async () => {
    const files = provider();
    const starter = await files.read(SELECTION_FILE);
    expect(committed()).toBeNull();

    const first = await files.write(SELECTION_FILE, starter);
    // jsdom has no OPFS, so the store reports session-only durability and the
    // write says so: applied, but kept for this session only.
    expect(first).toMatchObject({ ok: true, tone: "warn" });
    expect(first.ok && first.message).toContain("for this session only");
    expect(committed()?.revision).toBe("draft-initial");

    // The editor's text is whatever the store reads back; the person changes
    // one capability and leaves `revision:` alone.
    const stored = await files.read(SELECTION_FILE);
    const edited = addPasskeysToSelectionYaml(stored);
    expect(edited).not.toBe(stored);

    const second = await files.write(SELECTION_FILE, edited);
    expect(second).toMatchObject({ ok: true });
    expect(committed()?.selectedOptional).toEqual([
      ...PWA_DEFAULT_OPTIONALS,
      PASSKEYS,
    ]);
    expect(committed()?.revision).not.toBe("draft-initial");
    expect(committed()?.revision).toMatch(/^draft-.+-[0-9a-f]{8}$/);

    // The editor is handed the file as stored, with the new revision in it.
    if (!second.ok) throw new Error("unreachable");
    expect(second.text).toContain(committed()?.revision ?? "?");
    expect(await files.read(SELECTION_FILE)).toBe(second.text);
  });

  it("keeps comments and ordering when it gives an edit its own revision", async () => {
    const files = provider();
    await files.write(SELECTION_FILE, await files.read(SELECTION_FILE));
    const stored = await files.read(SELECTION_FILE);
    const edited = `# why\n${addPasskeysToSelectionYaml(stored)}`.replace(
      /^(kind:.*)$/m,
      "$1 # kept",
    );
    const outcome = await files.write(SELECTION_FILE, edited);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.text?.startsWith("# why\n")).toBe(true);
    expect(outcome.text).toContain("# kept");
    expect(outcome.text?.split("\n").length).toBe(edited.split("\n").length);
    expect(committed()?.selectedOptional).toEqual([
      ...PWA_DEFAULT_OPTIONALS,
      PASSKEYS,
    ]);
  });

  it("a comments-only edit after that commits nothing and keeps its bytes", async () => {
    const files = provider();
    await files.write(SELECTION_FILE, await files.read(SELECTION_FILE));
    const edited = addPasskeysToSelectionYaml(await files.read(SELECTION_FILE));
    await files.write(SELECTION_FILE, edited);
    const before = compositionStore.getSnapshot();

    const noted = `# a note\n${await files.read(SELECTION_FILE)}`;
    const outcome = await files.write(SELECTION_FILE, noted);

    expect(outcome).toMatchObject({
      ok: true,
      message: expect.stringContaining(
        "Saved source comments. Nothing else changed.",
      ),
      text: noted,
    });
    const after = compositionStore.getSnapshot();
    expect(after.generation).toBe(before.generation);
    expect(after.selection?.revision).toBe(before.selection?.revision);
    expect(durable.get(SELECTION_SOURCE_KV_KEY)).toBe(noted);
    expect(await files.read(SELECTION_FILE)).toBe(noted);
  });

  it("a second reader holding stale text meets the changed-in-another-session conflict", async () => {
    const mine = provider();
    const theirs = provider();
    const starter = await mine.read(SELECTION_FILE);
    await theirs.read(SELECTION_FILE);

    await mine.write(SELECTION_FILE, starter);
    const outcome = await theirs.write(
      SELECTION_FILE,
      addPasskeysToSelectionYaml(starter),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("another session");
    expect(committed()?.selectedOptional).toEqual([...PWA_DEFAULT_OPTIONALS]);
  });
});
