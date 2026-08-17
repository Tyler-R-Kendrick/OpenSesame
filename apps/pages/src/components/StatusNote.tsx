export interface StatusMessage {
  tone: "ok" | "err";
  text: string;
}

/** Inline outcome of the nearest action — success stays quiet, errors alert. */
export function StatusNote({ message }: { message: StatusMessage | null }) {
  if (!message) return null;
  return (
    <p
      className={`note note--${message.tone}`}
      role={message.tone === "err" ? "alert" : "status"}
    >
      <span>{message.text}</span>
    </p>
  );
}
