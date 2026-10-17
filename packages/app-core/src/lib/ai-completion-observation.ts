type CompletionOwner = () => void;

export type AiCompletionObservation =
  | {
      phase: "request";
      response: Response;
      owner: CompletionOwner;
      httpSignal: AbortSignal;
      transportSignal: AbortSignal;
    }
  | {
      phase: "body";
      response: Response;
      owner: CompletionOwner;
      bytes: number;
      format: "json" | "sse";
    }
  | { phase: "operation"; owner: CompletionOwner }
  | { phase: "signal"; httpSignal: AbortSignal; fetchSignal: AbortSignal };

type AiCompletionObserver = {
  observe?: (event: AiCompletionObservation) => void;
};

/** Internal verification seam; observers must not retain or expose secret data. */
export const aiCompletionSeams: AiCompletionObserver = {};
