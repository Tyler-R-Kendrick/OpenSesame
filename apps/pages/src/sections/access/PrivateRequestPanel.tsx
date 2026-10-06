import {
  type NativeRequestHandoff,
  nativeRequestCommands,
} from "@opensesame/app-core/lib/password-agent/native-handoff.js";
import { useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { PrivateRequestCommands } from "./PrivateRequestCommands.js";
import { PrivateRequestForm } from "./PrivateRequestForm.js";

/** Native custody requires an interactive desktop ceremony; this form hands off its exact contract. */
export function PrivateRequestPanel() {
  const target = useGuideTarget<HTMLDetailsElement>("access.private-request");
  const [commands, setCommands] =
    useState<ReturnType<typeof nativeRequestCommands>>();
  const [error, setError] = useState("");
  const [failure, setFailure] = useState(0);
  function prepare(data: FormData) {
    setCommands(undefined);
    setError("");
    const text = (name: string) => String(data.get(name) ?? "");
    const executable: NativeRequestHandoff["executable"] =
      text("executable") === "opensesame-id" ? "opensesame-id" : "opensesame";
    const shell: NativeRequestHandoff["shell"] =
      text("shell") === "powershell" ? "powershell" : "posix";
    try {
      const leaseId = text("leaseId").trim();
      const options: NativeRequestHandoff = {
        executable,
        shell,
        url: text("url"),
        reference: text("reference"),
        header: text("header"),
        prefix: text("prefix"),
        expiresIn: text("expiresIn"),
        uses: Number(text("uses")),
      };
      if (leaseId) options.leaseId = leaseId;
      setCommands(nativeRequestCommands(options));
    } catch (caught) {
      setFailure((previous) => previous + 1);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not prepare this request.",
      );
    }
  }
  return (
    <section
      className="panel"
      id="private-requests"
      aria-label="Private credential requests"
    >
      <div className="panel__head">
        <h2>Private credential requests</h2>
      </div>
      <div className="panel__body">
        <p>
          Authorize a credential for one exact HTTPS GET. The native executor
          keeps the credential and response body private and returns a receipt.
          Approval binds the credential version, destination, lifetime and use
          budget.
        </p>
        <details ref={target}>
          <summary>Prepare a native request</summary>
          <p>
            Complete approval in your own interactive terminal with 1Password
            desktop authentication. This form prepares commands; the native CLI
            stores and enforces the lease.
          </p>
          <PrivateRequestForm onPrepare={prepare} />
          <FailureNotice
            id="access:private-request"
            title="Private credential requests"
            occurrence={failure}
            message={error}
          />
          <PrivateRequestCommands commands={commands} />
        </details>
      </div>
    </section>
  );
}
