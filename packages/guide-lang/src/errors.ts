/**
 * Parse diagnostics for GuideLang v1.
 *
 * Every message is a fixed sentence. A diagnostic is derived from
 * model-authored text and is shown to a person, so echoing the payload back
 * would turn the error channel into the injection channel the grammar exists
 * to close. The line and column are enough to find the offending text in the
 * source the caller already holds.
 */

export const GUIDE_PARSE_ERROR_CODES = [
  "empty_program",
  "missing_version_header",
  "unsupported_version",
  "duplicate_version_header",
  "missing_goal",
  "duplicate_goal",
  "goal_not_first",
  "unknown_instruction",
  "malformed_arguments",
  "unknown_named_argument",
  "duplicate_named_argument",
  "unterminated_string",
  "invalid_string_escape",
  "invalid_identifier",
  "invalid_route",
  "invalid_side",
  "invalid_wait_subject",
  "invalid_wait_event",
  "invalid_boolean",
  "timeout_not_an_integer",
  "timeout_out_of_range",
  "message_too_long",
  "program_too_large",
  "too_many_instructions",
  "too_many_lines",
  "forbidden_character",
  "instruction_after_terminal",
  "trailing_content",
] as const;

export type GuideParseErrorCode = (typeof GUIDE_PARSE_ERROR_CODES)[number];

export type GuideParseError = {
  readonly code: GuideParseErrorCode;
  readonly line: number;
  readonly column: number;
  readonly message: string;
};

/**
 * The switch is deliberate: a missing arm stops compiling, so a new code can
 * never ship with an empty diagnostic.
 */
export function guideParseErrorMessage(code: GuideParseErrorCode): string {
  switch (code) {
    case "empty_program":
      return "A guide program has no content.";
    case "missing_version_header":
      return "A guide program must begin with the line guide/1.";
    case "unsupported_version":
      return "This guide declares a language version this parser does not support.";
    case "duplicate_version_header":
      return "The guide/1 header may appear only once.";
    case "missing_goal":
      return "A guide program must declare a goal.";
    case "duplicate_goal":
      return "A guide program may declare only one goal.";
    case "goal_not_first":
      return "The goal must be the first instruction, directly after the header.";
    case "unknown_instruction":
      return "This directive is not part of the guide language.";
    case "malformed_arguments":
      return "This directive does not have the arguments the guide language requires.";
    case "unknown_named_argument":
      return "This directive does not accept a named argument by that name.";
    case "duplicate_named_argument":
      return "A named argument may be given only once per directive.";
    case "unterminated_string":
      return "A quoted string is missing its closing quotation mark.";
    case "invalid_string_escape":
      return "A quoted string contains an escape sequence the guide language does not allow.";
    case "invalid_identifier":
      return "An identifier must be dotted lower-case words, never a selector or a path.";
    case "invalid_route":
      return "A route must be an absolute in-app path, never an external or scripted location.";
    case "invalid_side":
      return "A side must be one of top, right, bottom or left.";
    case "invalid_wait_subject":
      return "A wait must name target, route or state.";
    case "invalid_wait_event":
      return "A target wait must name the event activate, appear or disappear.";
    case "invalid_boolean":
      return "A state wait expects is=true or is=false.";
    case "timeout_not_an_integer":
      return "A timeout must be a whole number of milliseconds.";
    case "timeout_out_of_range":
      return "A timeout is outside the range the guide language permits.";
    case "message_too_long":
      return "A message is longer than the guide language permits.";
    case "program_too_large":
      return "This guide program is larger than the guide language permits.";
    case "too_many_instructions":
      return "This guide program has more instructions than the guide language permits.";
    case "too_many_lines":
      return "This guide program has more lines than the guide language permits.";
    case "forbidden_character":
      return "Text contains a character that must never reach a rendered guide.";
    case "instruction_after_terminal":
      return "Nothing may follow a pause or an end.";
    case "trailing_content":
      return "This directive is followed by content the guide language cannot read.";
  }
}

export function guideParseError(
  code: GuideParseErrorCode,
  line: number,
  column: number,
): GuideParseError {
  return { code, line, column, message: guideParseErrorMessage(code) };
}
