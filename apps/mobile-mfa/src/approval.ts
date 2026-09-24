/**
 * The approval screen's decisions — what counts as settled, which
 * authenticator is strong enough, which rendered line is the one to compare —
 * are `@opensesame/ceremony-kit`'s (`interaction-outcome.ts`, ADR 0140 plan
 * step 5), shared with Pages. Re-exported here so this app's screens keep
 * their imports until the app is deleted (plan step 14).
 */
export {
  type ApprovalView,
  chooseMechanism,
  type Mechanism,
  type Outcome,
  OUTCOME_IS_REFUSAL,
  OUTCOME_MARK,
  OUTCOME_TEXT,
  outcomeOfErrorCode,
  outcomeOfStatus,
  viewOf,
} from "@opensesame/ceremony-kit";
