import type { LocalAgentChallenge } from "@opensesame/static-auth";
import { useEffect, useRef, useState } from "react";
import {
  beginLocalAgentAuthentication,
  cancelLocalAgentAuthentication,
} from "../../lib/local-agent-auth.js";
import type { LocalAgentKey } from "../../lib/local-agent-keys.js";
import { LocalDirectoryError } from "../../lib/local-directory.js";
import { signInLocalAgent } from "../../lib/local-sessions.js";

type Props = {
  tomb: string;
  agentKey: LocalAgentKey;
  disabled: boolean;
  onClose: () => void;
};

function useAgentChallenge({ tomb, agentKey, disabled, onClose }: Props) {
  const [challenge, setChallenge] = useState<LocalAgentChallenge | null>(null);
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const source = useRef<HTMLTextAreaElement>(null);
  const initiator = useRef(document.activeElement);
  useEffect(() => {
    let active = true;
    let nonce: string | undefined;
    void beginLocalAgentAuthentication(
      tomb,
      agentKey.principalId,
      agentKey.credentialId,
    )
      .then((next) => {
        nonce = next.nonce;
        if (active) setChallenge(next);
        else cancelLocalAgentAuthentication(tomb, next.nonce);
      })
      .catch(() => {
        if (active)
          setError(
            "Could not start this challenge. Close it, reload keys, and retry.",
          );
      });
    return () => {
      active = false;
      if (nonce) cancelLocalAgentAuthentication(tomb, nonce);
    };
  }, [tomb, agentKey.principalId, agentKey.credentialId]);
  useEffect(() => {
    if (
      challenge &&
      (document.activeElement === initiator.current ||
        document.activeElement === document.body)
    )
      source.current?.focus();
  }, [challenge]);

  async function verify() {
    if (!challenge || busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      await signInLocalAgent(tomb, challenge.nonce, proof.trim());
      setProof("");
      onClose();
    } catch (failure) {
      setProof("");
      setError(
        failure instanceof LocalDirectoryError
          ? failure.message
          : "Agent verification failed. Close this challenge and start again.",
      );
      setChallenge(null);
    } finally {
      setBusy(false);
    }
  }

  return { challenge, proof, setProof, busy, error, source, verify };
}

export function LocalAgentAuthentication(props: Props) {
  const { agentKey, disabled, onClose } = props;
  const { challenge, proof, setProof, busy, error, source, verify } =
    useAgentChallenge(props);
  return (
    <form
      aria-label="Agent authentication"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void verify();
      }}
    >
      <p className="hint">
        Send this challenge to the agent holding the enrolled private key. Sign
        it with the local-agent SDK and return only the signed response. The
        challenge expires after two minutes.
      </p>
      {error ? (
        <p className="note note--err" role="alert">
          {error}
        </p>
      ) : null}
      {!challenge && !error ? (
        <output>Preparing agent challenge…</output>
      ) : null}
      {challenge ? (
        <>
          <div className="field">
            <label
              className="label"
              htmlFor={`agent-challenge-${agentKey.credentialId}`}
            >
              Agent challenge
            </label>
            <textarea
              ref={source}
              id={`agent-challenge-${agentKey.credentialId}`}
              rows={6}
              readOnly
              value={JSON.stringify(challenge, null, 2)}
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label
              className="label"
              htmlFor={`agent-proof-${agentKey.credentialId}`}
            >
              Signed challenge
            </label>
            <textarea
              id={`agent-proof-${agentKey.credentialId}`}
              rows={3}
              maxLength={8192}
              value={proof}
              onChange={(event) => setProof(event.target.value)}
              disabled={busy || disabled}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </div>
        </>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={!challenge || !proof.trim() || disabled || busy}
        >
          {busy ? "Verifying…" : "Verify agent"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Close challenge
        </button>
      </div>
    </form>
  );
}
