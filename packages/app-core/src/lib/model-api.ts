/** How a hosted model row is spoken to (ADR 0190): a closed protocol and, unless the endpoint is the person's own, its base URL. */
export type ModelApi = {
  protocol:
    | "openai_chat"
    | "anthropic_messages"
    | "gemini_generate_content"
    | "rest_json";
  /** Absent when the endpoint is the person's own. */
  baseUrl?: string;
};
