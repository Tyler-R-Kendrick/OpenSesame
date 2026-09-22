/**
 * Guidance tools — open in-product support on an authored topic, or start a
 * named walkthrough. Owned by `support.guided-help`. Guidance only: each
 * opens a panel for the person and returns nothing but the id it acted on;
 * a GuideLang program is never accepted here (ADR 0087/0088).
 */

import { HELP_TOPICS, guideGoalIds } from "../tutorial/registry/goals.js";
import {
  type PagesWebMcpTool,
  optStr,
  str,
  webmcpSupportSeam,
} from "./tool-shared.js";

/** Authored help topic ids — checked-in prose keys, never a person's words. */
const HELP_TOPIC_IDS: readonly string[] = HELP_TOPICS.map((topic) => topic.id);

function isHelpTopicId(value: string): boolean {
  return HELP_TOPIC_IDS.some((id) => id === value);
}

function isNamedGuideGoal(value: string): boolean {
  return guideGoalIds().some((id) => id === value);
}

export const HELP_TOOL: PagesWebMcpTool = {
  name: "opensesame_help",
  capabilityIds: ["client.support"],
  scope: "session",
  disposition: "tutorial_safe",
  description:
    "Open in-product support in this tab, optionally on one of the authored help topics. Guidance only: it opens a panel for the person and returns nothing but the topic it opened on — no vault contents, no answer text, no state the caller could not already read.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: [...HELP_TOPIC_IDS],
        description: "Authored help topic to open on.",
      },
    },
    additionalProperties: false,
  },
  execute: (args) => {
    const topic = optStr(args, "topic");
    if (topic !== null && !isHelpTopicId(topic)) {
      throw new Error(
        `unknown_help_topic:${topic} — topics are ${HELP_TOPIC_IDS.join(", ")}`,
      );
    }
    webmcpSupportSeam.openSupport(topic);
    return { status: "support_opened", topic };
  },
};

export const GUIDE_START_TOOL: PagesWebMcpTool = {
  name: "opensesame_guide_start",
  capabilityIds: ["client.tutorial"],
  scope: "session",
  disposition: "tutorial_safe",
  description:
    "Start one of the named in-product walkthroughs by goal id. Guidance only: the walkthrough points at controls and waits for the person to act on them; it never acts for them and returns nothing but the goal it started.",
  inputSchema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        enum: [...guideGoalIds()],
        description: "Named goal to walk through.",
      },
    },
    required: ["goal"],
    additionalProperties: false,
  },
  // A goal id, and nothing else. Accepting a GuideLang program here is the
  // surface ADR 0087 declines: a walkthrough handed in by an external
  // browser agent would be model-authored instruction reaching the person
  // through our own UI. Walkthroughs are authored in this repository, so
  // membership in `guideGoalIds()` is the whole of what a caller may say.
  execute: (args) => {
    const goal = str(args, "goal");
    if (!isNamedGuideGoal(goal)) {
      throw new Error(
        `unknown_guide_goal:${goal} — goals are ${guideGoalIds().join(", ")}`,
      );
    }
    webmcpSupportSeam.startGuide(goal);
    return { status: "guide_started", goal };
  },
};

export const SUPPORT_TOOLS: readonly PagesWebMcpTool[] = [
  HELP_TOOL,
  GUIDE_START_TOOL,
];
