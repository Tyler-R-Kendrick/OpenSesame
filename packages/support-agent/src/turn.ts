/**
 * Model-output handling: prose out of one channel, a candidate GuideLang
 * program out of another, and a single bounded repair when the program does
 * not compile.
 *
 * Two rules run through this file. The first is that a failed walkthrough must
 * never swallow a good answer — a person who asked a question and got one
 * keeps it even if the guide the model attached is garbage. The second is that
 * repair is bounded and never echoes model text back at the model: the retry
 * carries error *codes* the compiler produced, not the payload that failed.
 */

import {
  GUIDE_LANG_HEADER,
  type GuideProgram,
  compileGuide,
  hasForbiddenTextCharacter,
  isGuideRouteId,
  isGuideSemanticId,
} from "@opensesame/guide-lang";
import { isString } from "@opensesame/os-domain";
import {
  SUPPORT_LIMITS,
  type SupportAgentPort,
  type SupportComputerStep,
  type SupportGrounding,
  type SupportHelpEntry,
  type SupportPageContext,
  type SupportRequest,
  type SupportTurn,
} from "./contract.js";
import { sanitizeSupportRequest } from "./egress.js";

/**
 * Derived from `compileGuide` itself rather than imported by name, so this
 * package tracks the compiler's contract without restating it.
 */
export type SupportGuideVocabulary = Parameters<typeof compileGuide>[1];
export type SupportGuideCompileResult = ReturnType<typeof compileGuide>;

/**
 * The vocabulary a program is validated against, derived from the very context
 * the model was shown. Deriving it here rather than assembling it separately is
 * what makes "you may name only what is listed" true by construction: there is
 * no second list that could drift ahead of the one in the prompt.
 */
export function supportVocabulary(
  context: SupportPageContext,
): SupportGuideVocabulary {
  return {
    goals: context.goals.map((goal) => goal.id),
    targets: context.targets.map((target) => target.id),
    routes: context.routes.map((route) => route.id),
    predicates: context.state.map((fact) => fact.id),
  };
}

export type GuideCompileIssue = {
  readonly code: string;
  readonly line: number;
  readonly column: number;
  /** The compiler's own fixed sentence. Never the text that failed. */
  readonly detail: string;
};

export type GuideCompileFailureSummary = {
  readonly stage: "parse" | "validate";
  readonly codes: readonly string[];
  readonly issues: readonly GuideCompileIssue[];
  /** Repair calls actually spent before giving up. */
  readonly attempts: number;
};

export type SupportTurnOptions = {
  readonly signal: AbortSignal;
};

export type SupportTurnOutcome = {
  readonly answer: string;
  /** What the answer's procedure rests on, from its `sources:` line. */
  readonly grounding: SupportGrounding;
  readonly program: GuideProgram | null;
  readonly guideError: GuideCompileFailureSummary | null;
  readonly suggestedQuestions: readonly string[];
  readonly thoughts: string | null;
  readonly computer: readonly SupportComputerStep[];
};

export type SupportTurnSeams = {
  compile: (
    source: string,
    vocabulary: SupportGuideVocabulary,
  ) => SupportGuideCompileResult;
};

/**
 * The compiler seam. A test that needs a deterministic compile failure swaps
 * this rather than mocking the module; the default is the real compiler, so
 * nothing in production runs against a stand-in.
 */
export const supportTurnSeams: SupportTurnSeams = {
  compile: compileGuide,
};

/** A ceiling on how much model output is even looked at. */
const MAX_RAW_CHARS = 65_536;
const MAX_SUGGESTION_CHARS = 200;
const MAX_REPAIR_CODES = 6;
const MAX_REPAIR_DETAILS = 4;
const MAX_REPAIR_DETAIL_CHARS = 160;
const GUIDE_FENCE_TAGS: readonly string[] = ["guide", "guidelang"];

function clampText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** The info string of a fence line, `""` for a bare fence, `null` for prose. */
function fenceInfo(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("```")) return null;
  return trimmed.slice(3).trim().toLowerCase();
}

function firstNonBlank(lines: readonly string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

type GuideExtraction = {
  readonly answerLines: readonly string[];
  readonly guide: string;
};

function extractFencedGuide(lines: readonly string[]): GuideExtraction | null {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const info = fenceInfo(line);
    if (info === null) {
      index += 1;
      continue;
    }
    let close = index + 1;
    while (close < lines.length) {
      const candidate = lines[close];
      if (candidate !== undefined && fenceInfo(candidate) === "") break;
      close += 1;
    }
    const body = lines.slice(index + 1, Math.min(close, lines.length));
    const tagged = GUIDE_FENCE_TAGS.includes(info);
    const headed = info === "" && firstNonBlank(body) === GUIDE_LANG_HEADER;
    if (tagged || headed) {
      return {
        answerLines: [...lines.slice(0, index), ...lines.slice(close + 1)],
        guide: body.join("\n"),
      };
    }
    index = close + 1;
  }
  return null;
}

function extractAnchoredGuide(
  lines: readonly string[],
): GuideExtraction | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() !== GUIDE_LANG_HEADER) continue;
    return {
      answerLines: lines.slice(0, index),
      guide: lines.slice(index).join("\n"),
    };
  }
  return null;
}

function finishAnswer(lines: readonly string[]): string {
  const joined = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clampText(joined, SUPPORT_LIMITS.maxAnswerChars);
}

function clampThoughts(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return clampText(trimmed, SUPPORT_LIMITS.maxAnswerChars);
}

const MAX_COMPUTER_STEPS = 8;
const MAX_COMPUTER_TITLE_CHARS = 80;
const MAX_COMPUTER_DETAIL_CHARS = 500;

function clampComputer(
  steps: readonly SupportComputerStep[] | undefined,
): readonly SupportComputerStep[] {
  if (steps === undefined || steps.length === 0) return [];
  const out: SupportComputerStep[] = [];
  for (const step of steps) {
    if (out.length >= MAX_COMPUTER_STEPS) break;
    const title = clampText(step.title.trim(), MAX_COMPUTER_TITLE_CHARS);
    if (title.length === 0) continue;
    const detail =
      step.detail === null || step.detail.trim().length === 0
        ? null
        : clampText(step.detail.trim(), MAX_COMPUTER_DETAIL_CHARS);
    out.push({ title, detail });
  }
  return out;
}

/**
 * Split one raw completion into prose and an optional guide program. Never
 * throws: garbage in yields an answer and no program, which is a state the
 * rest of the system already handles.
 */
export function parseSupportTurn(raw: string): SupportTurn {
  const lines = clampText(raw, MAX_RAW_CHARS).split(/\r?\n/);
  const fenced = extractFencedGuide(lines);
  const extraction = fenced ?? extractAnchoredGuide(lines);
  if (extraction === null) {
    return { answer: finishAnswer(lines), guide: null, suggestedQuestions: [] };
  }
  return {
    answer: finishAnswer(extraction.answerLines),
    guide: extraction.guide,
    // Suggestions are a structured field on the port's turn, not something we
    // mine out of prose. Inventing a prose syntax for them would give a model
    // a second, unvalidated channel into the UI.
    suggestedQuestions: [],
  };
}

const SOURCES_LINE = /^\s*sources?\s*:\s*(.*)$/iu;
const NONE_SOURCES = new Set(["", "none", "n/a", "-", "—"]);

export type SupportSourcesExtraction = {
  /** The answer with its `sources:` line removed. */
  readonly answer: string;
  /** `null` when the answer carried no `sources:` line at all. */
  readonly cited: readonly string[] | null;
};

/**
 * Splits the trailing `sources:` line off an answer. Only the last non-blank
 * line counts: a model that mentions "sources" mid-answer has said a word, not
 * made a citation. Identifiers are taken as written, minus the quoting a
 * model tends to add, and are matched against the context by the caller — the
 * text here is still model output and proves nothing by itself.
 */
export function extractSupportSources(
  answer: string,
): SupportSourcesExtraction {
  const lines = answer.split(/\r?\n/);
  let last = lines.length - 1;
  while (last >= 0 && (lines[last] ?? "").trim().length === 0) last -= 1;
  if (last < 0) return { answer: answer.trim(), cited: null };
  const match = SOURCES_LINE.exec(lines[last] ?? "");
  if (match === null) return { answer: answer.trim(), cited: null };
  const cited = (match[1] ?? "")
    .split(/[,;\s]+/u)
    .map((token) =>
      token
        .replace(/[`'"\[\]()<>*.]+$/gu, "")
        .replace(/^[`'"\[\]()<>*]+/gu, ""),
    )
    .map((token) => token.trim().toLowerCase())
    .filter((token) => !NONE_SOURCES.has(token));
  return {
    answer: lines.slice(0, last).join("\n").trim(),
    cited,
  };
}

/**
 * Decides what an answer rests on. A citation counts only when it names an
 * entry the model was actually shown, in the order the context listed them;
 * naming something else is the same as naming nothing.
 */
export type SupportGroundedAnswer = {
  readonly answer: string;
  readonly grounding: SupportGrounding;
};

export function groundSupportAnswer(
  answer: string,
  help: readonly SupportHelpEntry[],
): SupportGroundedAnswer {
  const extracted = extractSupportSources(answer);
  if (extracted.cited === null) {
    return { answer: extracted.answer, grounding: { kind: "uncited" } };
  }
  if (extracted.cited.length === 0) {
    return { answer: extracted.answer, grounding: { kind: "none" } };
  }
  const named = new Set(extracted.cited);
  const matched = help.filter((entry) => named.has(entry.id.toLowerCase()));
  if (matched.length === 0) {
    return { answer: extracted.answer, grounding: { kind: "uncited" } };
  }
  return {
    answer: extracted.answer,
    grounding: { kind: "cited", help: matched },
  };
}

/**
 * The parse and validation diagnostics share only a code, so this is the
 * intersection both branches satisfy. Reading them structurally keeps the
 * repair path working when the compiler grows a third failure stage.
 */
type CompileErrorLike = {
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
  readonly message?: string;
  readonly id?: string;
};

function safeDetail(message: string): string {
  if (hasForbiddenTextCharacter(message)) return "";
  return clampText(message, MAX_REPAIR_DETAIL_CHARS);
}

/**
 * A validation failure names the identifier the application does not declare.
 * Echoing it is safe and it is the one detail that makes the retry useful: the
 * parser has already proved it is a dotted semantic id, so it cannot be a
 * selector, a URL or a sentence.
 */
function detailOf(error: CompileErrorLike): string {
  const message = error.message;
  if (message !== undefined) return safeDetail(message);
  const id = error.id;
  if (id === undefined) return "";
  if (!isGuideSemanticId(id) && !isGuideRouteId(id)) return "";
  return `The application does not declare "${id}".`;
}

function toIssue(error: CompileErrorLike): GuideCompileIssue {
  return {
    code: error.code,
    line: error.line ?? 0,
    column: error.column ?? 0,
    detail: detailOf(error),
  };
}

function uniqueCodes(issues: readonly GuideCompileIssue[]): readonly string[] {
  const out: string[] = [];
  for (const issue of issues) {
    if (!out.includes(issue.code)) out.push(issue.code);
  }
  return out;
}

/**
 * The re-ask. It names what the compiler rejected and restates the closed set
 * of directives; it does not carry the rejected program, so a model that
 * produced injected text cannot get that text read back to it as instructions.
 */
export function guideRepairInstruction(
  errors: readonly GuideCompileIssue[],
): string {
  const codes = uniqueCodes(errors).slice(0, MAX_REPAIR_CODES);
  const details: string[] = [];
  for (const issue of errors) {
    if (details.length >= MAX_REPAIR_DETAILS) break;
    if (issue.detail.length === 0 || details.includes(issue.detail)) continue;
    details.push(issue.detail);
  }
  const parts: string[] = [
    "The guide program you emitted was rejected by the parser and was not run.",
    codes.length > 0
      ? `It failed with: ${codes.join(", ")}.`
      : "It failed to parse.",
  ];
  if (details.length > 0) parts.push(details.join(" "));
  parts.push(
    "Emit one corrected program inside a fenced `guide` block, naming only identifiers from the page context.",
    "Do not add a directive the grammar does not list, and do not repeat the rejected program back to me.",
    "If the step cannot be expressed in GuideLang, answer in prose and emit no program at all.",
  );
  return parts.join(" ");
}

function clampSuggestions(suggestions: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const suggestion of suggestions) {
    if (out.length >= SUPPORT_LIMITS.maxSuggestedQuestions) break;
    if (!isString(suggestion) || hasForbiddenTextCharacter(suggestion))
      continue;
    const trimmed = suggestion.trim();
    if (trimmed.length === 0) continue;
    out.push(clampText(trimmed, MAX_SUGGESTION_CHARS));
  }
  return out;
}

/**
 * A port may hand back the program still wrapped in the fence the model wrote.
 * Unwrapping here means every adapter can be naive and still be correct.
 */
function unfence(source: string): string {
  const extraction = extractFencedGuide(source.split(/\r?\n/));
  return extraction === null ? source : extraction.guide;
}

function guideSourceOf(turn: SupportTurn): string | null {
  if (turn.guide !== null) return unfence(turn.guide);
  return parseSupportTurn(turn.answer).guide;
}

async function runRepair(
  port: SupportAgentPort,
  sanitized: SupportRequest,
  issues: readonly GuideCompileIssue[],
  signal: AbortSignal,
): Promise<string | null> {
  const repairRequest = sanitizeSupportRequest({
    question: guideRepairInstruction(issues),
    history: sanitized.history,
    context: sanitized.context,
  });
  try {
    return guideSourceOf(await port.run(repairRequest, { signal }));
  } catch {
    // A repair that fails is a repair not made. The answer from the first turn
    // already stands, and losing it to a retry failure would be the worse bug.
    return null;
  }
}

/**
 * One support turn end to end: sanitize, ask, split, compile, and at most
 * `SUPPORT_LIMITS.maxGuideRepairAttempts` bounded repairs.
 */
export async function runSupportTurn(
  port: SupportAgentPort,
  request: SupportRequest,
  vocabulary: SupportGuideVocabulary,
  options: SupportTurnOptions,
): Promise<SupportTurnOutcome> {
  const sanitized = sanitizeSupportRequest(request);
  const first = await port.run(sanitized, { signal: options.signal });
  const { answer, grounding } = groundSupportAnswer(
    parseSupportTurn(first.answer).answer,
    sanitized.context.help,
  );
  const suggestedQuestions = clampSuggestions(first.suggestedQuestions);
  const thoughts = clampThoughts(first.thoughts);
  const computer = clampComputer(first.computer);
  let source = guideSourceOf(first);
  if (source === null) {
    return {
      answer,
      grounding,
      program: null,
      guideError: null,
      suggestedQuestions,
      thoughts,
      computer,
    };
  }

  let attempts = 0;
  let issues: readonly GuideCompileIssue[] = [];
  let stage: "parse" | "validate" = "parse";
  for (;;) {
    const result = supportTurnSeams.compile(source, vocabulary);
    if (result.ok) {
      return {
        answer,
        grounding,
        program: result.program,
        guideError: null,
        suggestedQuestions,
        thoughts,
        computer,
      };
    }
    const reported: readonly CompileErrorLike[] = result.errors;
    issues = reported.map(toIssue);
    stage = result.stage;
    if (attempts >= SUPPORT_LIMITS.maxGuideRepairAttempts) break;
    if (options.signal.aborted) break;
    attempts += 1;
    const repaired = await runRepair(port, sanitized, issues, options.signal);
    if (repaired === null) break;
    source = repaired;
  }

  return {
    answer,
    grounding,
    program: null,
    guideError: { stage, codes: uniqueCodes(issues), issues, attempts },
    suggestedQuestions,
    thoughts,
    computer,
  };
}
