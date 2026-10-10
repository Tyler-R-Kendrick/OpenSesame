/**
 * The shapes of an authored walkthrough and of the written help beside it —
 * kept apart from `goals.ts`, which holds the core corpus, so the descriptor
 * a contribution imports is not a reason to load all of it.
 */

import type { GuideGoalId } from "@opensesame/guide-lang";
import type { GuideRouteId } from "./routes.js";

export type GuideGoalDescriptor = {
  readonly id: GuideGoalId;
  readonly title: string;
  /** Routes where offering this goal makes sense; empty means everywhere. */
  readonly routes: readonly GuideRouteId[];
  /**
   * Listed in the tutorial library only. A model is told the goals that fit
   * the screen it is answering about, within a fixed budget; a goal that is
   * only ever started from the library is not one it should be choosing.
   */
  readonly libraryOnly?: true;
  /**
   * State predicates that must hold for the library to offer this goal: a
   * tutorial about a row that is only drawn for a signed-in account is not
   * offered to a device with no session, because it would point at nothing.
   */
  readonly requires?: readonly string[];
  /**
   * Optional capabilities of which at least one must be approved before this
   * goal is offered. Omitted, the goal does not depend on an optional
   * capability. A caller that omits `installed` treats every capability as
   * installed.
   */
  readonly capabilities?: readonly string[];
  /**
   * A checked-in GuideLang program. Runs verbatim when no model can answer,
   * and is parsed and validated by exactly the same pipeline model output
   * goes through — an authored guide gets no privileged path.
   */
  readonly guide: string;
};

export type HelpTopic = {
  readonly id: string;
  readonly title: string;
  /** Authored answer shown when there is no model to ask. */
  readonly answer: string;
  readonly routes: readonly GuideRouteId[];
  /**
   * Authored walkthrough that answers this question in tutorial mode, or
   * null for written help only. A gate draws a help key of its own (ADR 0166),
   * so a topic for a gate names the tour that screen can start; one whose
   * tour belongs to another screen shows its answer and no Show me there.
   */
  readonly goal: GuideGoalId | null;
  /**
   * The words a person uses for this that the title and answer do not: "user"
   * for an account, "reset" for a master password. Retrieval is lexical and
   * offline, so synonyms are authored here rather than inferred anywhere.
   */
  readonly keywords: readonly string[];
};
