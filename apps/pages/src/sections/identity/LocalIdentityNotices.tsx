import { kvDurability } from "@opensesame/app-core/lib/kv.js";
import { FailureNotice } from "../../components/FailureNotice.js";

export function LocalIdentityNotices({
  id,
  title,
  error,
}: { id: string; title: string; error: string }) {
  return (
    <>
      <FailureNotice id={id} title={title} message={error} />
      <FailureNotice
        id={`${id}:durability`}
        title="Browser storage"
        tone="warn"
        message={
          kvDurability() === "memory"
            ? "Browser storage is unavailable. Changes last only until this tab closes."
            : null
        }
      />
    </>
  );
}
