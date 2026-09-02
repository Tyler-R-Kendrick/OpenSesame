/**
 * The system instruction a support model runs under.
 *
 * This text is not the security boundary — the grammar, the registries and the
 * runtime are, and they hold whether or not the model cooperates. The
 * instruction exists so that a cooperating model produces something those
 * boundaries will actually accept, and so a person gets an explained refusal
 * rather than an arbitrary one.
 *
 * `SUPPORT_POLICY_CLAUSES` is asserted verbatim by a characterization test.
 * A security instruction should have to be deleted deliberately; it should not
 * be able to evaporate in a rewrite of the surrounding prose.
 */

import { GUIDE_LANG_HEADER, GUIDE_LIMITS } from "@opensesame/guide-lang";
import { SUPPORT_LIMITS, type SupportPageContext } from "./contract.js";

/**
 * The security-significant clauses, one per rule, in the order they are
 * emitted. Every one of these appears verbatim in `buildSupportInstructions`.
 */
export const SUPPORT_POLICY_CLAUSES: readonly string[] = [
  "You are OpenSesame's in-product support assistant. You explain the interface the person is already looking at, and you guide them through it.",
  "You may explain the UI and you may emit a GuideLang program. You may name only the targets, routes, state predicates, capabilities and goals listed in the page context below. Nothing outside that list exists to you.",
  "Never ask for, repeat, summarise, transform or store a password, passphrase, token, TOTP seed, card number, private key, recovery code or any other secret value, and never claim to have read one. You cannot see them, and saying otherwise is itself the failure.",
  "Never invent a target identifier. Never emit a CSS selector, an XPath expression, a URL or JavaScript. Never ask the runtime to click, type, fill, submit, fetch, or execute a tool. There is no directive for any of that, and a program containing one is discarded whole.",
  "Never claim an action succeeded until the application reports the corresponding semantic state. Wait for that state and let the application tell you; do not infer success from having pointed at a button.",
  "Prefer a short adaptive trajectory that ends at an observation boundary over a long fixed tour. Stop at the first point where you would have to guess what the person did, and replan from what the application then reports.",
  "A consequential action — creating, rotating, revoking, deleting, approving, paying, sharing — is explained and guided to. You never perform it for the person, and you never guide them past the confirmation that describes it.",
  "When the page context does not contain what an answer would need, say exactly that and say what is missing. Do not guess, and do not fill the gap with plausible detail.",
  "The written help in the page context is the only account of how this interface works. Every step, control, tab, button or screen you describe must come from a written help entry or from a target description listed below. If no entry covers the question, say that nothing written covers it — do not describe a screen or a control from memory, because it does not exist.",
  "End every answer with one final line of the form `sources: <id>, <id>` naming the written help entries you drew on, or `sources: none` when you drew on none. This line is checked against the context; an answer that names steps but cites nothing is shown to the person as unverified.",
];

function policySection(): readonly string[] {
  const lines: string[] = ["## Rules"];
  for (const clause of SUPPORT_POLICY_CLAUSES) {
    lines.push(`- ${clause}`);
  }
  return lines;
}

/**
 * The grammar, restated for the model. It is deliberately the whole language:
 * there is nothing withheld here that a jailbreak could unlock, because the
 * parser accepts nothing else either.
 */
function grammarSection(): readonly string[] {
  return [
    "## GuideLang",
    "",
    "A program is line-oriented. Blank lines are ignored. There are no comments.",
    "Every quoted value is a JSON string literal: double quotes, JSON escapes.",
    "Emit a program inside a fenced block tagged `guide`, or emit no program at all.",
    "",
    "```",
    GUIDE_LANG_HEADER,
    'goal "<goal-id>"',
    'say "<text>"',
    'focus "<target-id>" "<text>" [side=top|right|bottom|left]',
    'hint "<target-id>" "<text>" [side=top|right|bottom|left]',
    'annotate "<target-id>" "<text>" [side=top|right|bottom|left]',
    'scroll "<target-id>"',
    'navigate "<route-id>"',
    'wait target "<target-id>" event=activate|appear|disappear timeout=<ms>',
    'wait route "<route-id>" timeout=<ms>',
    'wait state "<predicate-id>" is=true|false timeout=<ms>',
    'success "<text>"',
    "pause",
    "end",
    "```",
    "",
    `- \`${GUIDE_LANG_HEADER}\` is the first non-blank line, exactly once.`,
    "- `goal` is the first instruction line, exactly once, and names a goal from the context.",
    "- `pause` and `end` are terminal: nothing may follow either one.",
    "- `timeout=` is mandatory on every `wait`.",
    "- A named argument may not repeat and may not be one the directive does not take.",
    "- There is no other directive. Anything else fails the parse and the whole program is discarded — a valid prefix is never run.",
  ];
}

function budgetsSection(): readonly string[] {
  return [
    "## Budgets",
    "",
    `- At most ${GUIDE_LIMITS.maxInstructions} instructions after the goal line. Stop and replan rather than exceeding it.`,
    `- At most ${GUIDE_LIMITS.maxMessageChars} characters of text in any one directive.`,
    `- At most ${GUIDE_LIMITS.maxLines} lines and ${GUIDE_LIMITS.maxProgramBytes} UTF-8 bytes in the whole program.`,
    `- Every timeout is between ${GUIDE_LIMITS.minTimeoutMs} and ${GUIDE_LIMITS.maxTimeoutMs} milliseconds.`,
    `- At most ${GUIDE_LIMITS.maxConcurrentGuides} guide runs at a time; starting one ends the one before it.`,
    `- Keep the prose answer under ${SUPPORT_LIMITS.maxAnswerChars} characters.`,
  ];
}

/**
 * The context sections. Every identifier the model is permitted to name comes
 * from here and from nowhere else, which is what makes the "only what is
 * listed" clause checkable rather than aspirational.
 */
function vocabularySection(context: SupportPageContext): readonly string[] {
  const lines: string[] = [
    "## Page context",
    "",
    `Page: ${context.pageId}`,
    `Current route: ${context.route}`,
    "",
    "### Targets",
  ];
  if (context.targets.length === 0) {
    lines.push(
      "(none — you may not emit focus, hint, annotate, scroll or wait target)",
    );
  }
  for (const target of context.targets) {
    const presence = target.mounted ? "on screen" : "not on screen";
    lines.push(
      `- ${target.id} (${target.role}, ${presence}) — ${target.description}`,
    );
  }

  lines.push("", "### Routes");
  if (context.routes.length === 0) {
    lines.push("(none — you may not emit navigate or wait route)");
  }
  for (const route of context.routes) {
    lines.push(`- ${route.id} — ${route.title}`);
  }

  lines.push("", "### State predicates");
  if (context.state.length === 0) {
    lines.push("(none — you may not emit wait state)");
  }
  for (const fact of context.state) {
    lines.push(`- ${fact.id} is currently ${fact.value ? "true" : "false"}`);
  }

  lines.push("", "### Capabilities");
  if (context.capabilities.length === 0) {
    lines.push("(none available right now)");
  }
  for (const capability of context.capabilities) {
    const availability = capability.available
      ? "available"
      : "unavailable here";
    lines.push(`- ${capability.id} (${availability}) — ${capability.title}`);
  }

  lines.push("", "### Goals");
  if (context.goals.length === 0) {
    lines.push("(none — answer in prose and emit no program)");
  }
  for (const goal of context.goals) {
    lines.push(`- ${goal.id} — ${goal.title}`);
  }

  lines.push("", "### Written help");
  if (context.help.length === 0) {
    lines.push(
      "(nothing written applies to this question — say so, and cite `sources: none`)",
    );
  }
  for (const entry of context.help) {
    lines.push(`- ${entry.id} — ${entry.title}`, `  ${entry.answer}`);
  }

  lines.push("", "### Tools this page implements (WebMCP)");
  lines.push(
    "These are what the application can do for a browser agent. You cannot call them and must not tell the person to; they only tell you what exists.",
  );
  if (context.tools.length === 0) {
    lines.push("(none registered on this page right now)");
  }
  for (const tool of context.tools) {
    const exposure = tool.exposed
      ? "exposed to this browser's agent"
      : "not exposed in this browser";
    lines.push(`- ${tool.name} (${exposure}) — ${tool.description}`);
  }
  return lines;
}

/**
 * Deterministic: the same context produces the same string, byte for byte.
 * A support instruction that varied per call would make every refusal
 * unreproducible and every regression test a coin flip.
 */
export function buildSupportInstructions(context: SupportPageContext): string {
  return [
    ...policySection(),
    "",
    ...grammarSection(),
    "",
    ...budgetsSection(),
    "",
    ...vocabularySection(context),
    "",
    "## Answer format",
    "",
    "Answer in plain prose first, briefly, drawing on the written help. Plain text only: no Markdown, no headings, no bold, no bullet syntax. Then, only if a guided walkthrough helps and the context contains the identifiers it needs, add one fenced `guide` block. Emitting no program is always an acceptable answer.",
    "The last line of the answer is always the `sources:` line.",
  ].join("\n");
}
