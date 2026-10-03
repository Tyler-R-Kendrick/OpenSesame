import { StatusMark } from "../../../components/StatusMark.js";
import type { Refusal } from "./useBindFlow.js";

/**
 * A refusal, drawn as the mark and said once to assistive technology. The
 * mark is a static image, so it alone is silent when it appears; the alert
 * beside it is keyed by the refusal's count, so the same message refused
 * twice is announced twice.
 */
export function Refused({ message, n }: Refusal) {
  return (
    <>
      <StatusMark tone="err" label={message} />
      <span key={n} className="visually-hidden" role="alert">
        {message}
      </span>
    </>
  );
}
