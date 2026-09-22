import type { LocalAgentChallenge } from "@opensesame/static-auth";
import { useEffect, useRef, useState } from "react";
import { IconCheck, IconX } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
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
      {error ? (
        <>
          <StatusMark tone="err" label={error} />
          <span role="alert" className="visually-hidden">
            {error}
          </span>
        </>
      ) : null}
      {!challenge && !error ? (
        <>
          <StatusMark tone="idle" label="Preparing agent challenge…" />
          <span className="visually-hidden">Preparing agent challenge…</span>
        </>
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
        <div className="go-row">
          <button
            type="submit"
            className="go"
            disabled={!challenge || !proof.trim() || disabled || busy}
            aria-busy={busy}
            aria-label="Verify agent"
            title="Verify agent"
          >
            <IconCheck size={18} />
          </button>
          <span className="go-verb" aria-hidden="true">
            Verify agent
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          disabled={busy}
          onClick={onClose}
          aria-label="Close challenge"
          title="Close challenge"
        >
          <IconX size={16} />
        </button>
      </div>
    </form>
  );
}
