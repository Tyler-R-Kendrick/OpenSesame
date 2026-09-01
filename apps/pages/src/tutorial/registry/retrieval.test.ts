import { describe, expect, it } from "vitest";
import { HELP_TOPICS, rankHelpTopics, searchHelpTopics } from "./goals.js";

/**
 * The question that started this: asked on the Identity screen, the on-device
 * model invented a tab and a button. The written help had the answer under a
 * title no substring of "add a user" reaches, which is what the authored
 * keywords are for.
 */
describe("rankHelpTopics", () => {
  it("finds the account topic for a question phrased with 'user'", () => {
    const ranked = rankHelpTopics("how do I add a user?", "/identity");
    expect(ranked[0]?.topic.id).toBe("help.identity.account.add");
    expect(ranked[0]?.strong).toBe(true);
    const ids = ranked.map((entry) => entry.topic.id);
    expect(ids).toContain("help.account.register");
    // The vault topic shares the word "add" and nothing else; it ranks below.
    const vault = ids.indexOf("help.vault.item.create");
    expect(vault === -1 || vault > ids.indexOf("help.account.register")).toBe(
      true,
    );
  });

  it("is confident only on a keyword or a title word plus more", () => {
    const weak = rankHelpTopics("where is the thing", "/vault");
    expect(weak.every((entry) => !entry.strong)).toBe(true);
    const strong = rankHelpTopics("weak or reused passwords", "/vault");
    expect(strong[0]?.topic.id).toBe("help.vault.health.review");
    expect(strong[0]?.strong).toBe(true);
  });

  it("returns nothing for a question made of stopwords", () => {
    expect(rankHelpTopics("how do I?", "/vault")).toEqual([]);
    expect(rankHelpTopics("", "/vault")).toEqual([]);
  });

  it("respects the route a topic is scoped to", () => {
    const onVault = rankHelpTopics("unlock the vault", "/vault");
    expect(onVault.map((entry) => entry.topic.id)).not.toContain("help.unlock");
    const onUnlock = rankHelpTopics("unlock the vault", "/unlock");
    expect(onUnlock[0]?.topic.id).toBe("help.unlock");
    const anywhere = rankHelpTopics("unlock the vault");
    expect(anywhere.map((entry) => entry.topic.id)).toContain("help.unlock");
  });

  it("is deterministic and keeps authored order among equals", () => {
    const first = rankHelpTopics("add", "/identity");
    const second = rankHelpTopics("add", "/identity");
    expect(first).toEqual(second);
    const tied = first.filter((entry) => entry.score === first[0]?.score);
    const authored = HELP_TOPICS.map((topic) => topic.id);
    for (let index = 1; index < tied.length; index += 1) {
      expect(authored.indexOf(tied[index]?.topic.id ?? "")).toBeGreaterThan(
        authored.indexOf(tied[index - 1]?.topic.id ?? ""),
      );
    }
  });
});

describe("searchHelpTopics", () => {
  it("ranks by words and falls back to a substring of the prose", () => {
    expect(searchHelpTopics("add a user")[0]?.id).toBe(
      "help.identity.account.add",
    );
    // "kdbx" is a keyword; ".1pux" only ever appears inside an answer.
    expect(searchHelpTopics("kdbx")[0]?.id).toBe("help.vault.import");
    expect(searchHelpTopics(".1pux").map((topic) => topic.id)).toEqual([
      "help.vault.import",
    ]);
    expect(searchHelpTopics("   ")).toBe(HELP_TOPICS);
  });

  it("every topic declares at least three keywords", () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.keywords.length, topic.id).toBeGreaterThanOrEqual(3);
    }
  });
});
