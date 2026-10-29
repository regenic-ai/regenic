import { randomUUID } from "node:crypto";
import type { DshFetch, DshSpawn } from "@regenic/dsh-connector";
import { parseOptions, type CliOutput } from "./cli-runtime";
import { embeddingCommand } from "./commands/embedding";
import {
  cancelAgentRunCommand,
  createAgentRun,
  getAgentRun,
  handoffAgentRunCommand,
  listAgentRuns,
  settleAgentRunCommand,
  startAgentRunCommand,
} from "./commands/agent-runs";
import {
  installDsh,
  resetConnectorCursor,
  sendDsh,
  setConnectorStatus,
  showQuarantines,
  showStatus,
  syncDsh,
} from "./commands/connectors";
import {
  askContext,
  assembleContext,
  searchContext,
  diffContextSnapshots,
  evaluateContext,
  listContextSnapshotHistory,
  publishContextEvidenceBundle,
  publishEvidenceBundle,
  replayContext,
  showContextSnapshot,
} from "./commands/context";
import {
  getDailyDigestCoverageAlerts,
  getDailyDigestJobs,
  getDailyDigests,
  projectDailyDigest,
  resolveDailyDigestCoverageAlert,
} from "./commands/daily-digest";
import {
  commitDecision,
  getDecision,
  listDecisions,
} from "./commands/decisions";
import {
  createHandoff,
  getHandoff,
  listHandoffs,
  transitionHandoff,
} from "./commands/handoffs";
import {
  exportJsonl,
  importFile,
  renderDigest,
} from "./commands/import-export";
import {
  acknowledgeInboxEvent,
  getPersonalDispatchPolicy,
  getPersonalFollowUpPolicy,
  putPersonalDispatchPolicy,
  putPersonalFollowUpPolicy,
  reapplyInboxDispatchPolicy,
  resetInboxTriage,
  setInboxEventHidden,
  setInboxEventPinned,
  showFollowUps,
  showInbox,
  showPendingInbox,
  snoozeFollowUp,
  triageInbox,
  unsnoozeFollowUp,
} from "./commands/inbox";
import {
  createDecisionProposal,
  createProposalFromDigest,
  createStandardProposal,
  getProposal,
  listProposals,
  transitionProposal,
} from "./commands/proposals";
import {
  createAgentRunReview,
  createDecisionReview,
  getReview,
  listAgentRunReviews,
  listDecisionReviews,
  scanStandardDriftCommand,
} from "./commands/reviews";
import {
  commitStandardVersion,
  convertStandardGap,
  createManualStandardGap,
  createReviewStandardGap,
  dismissStandardGap,
  getStandard,
  getStandardGap,
  getStandardVersion,
  listStandardGaps,
  listStandardHealthCommand,
  listStandardUsageCommand,
  listStandardVersions,
  listStandards,
  projectStandardUsageCommand,
  transitionCliStandardVersion,
} from "./commands/standards";
import { runCustomerServiceMcp } from "./commands/customer-service-mcp";
import { runContextSearchMcp } from "./commands/context-search-mcp";

export interface LocalCliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: CliOutput;
  fetch?: DshFetch;
  spawn?: DshSpawn;
  now?: () => string;
  createId?: () => string;
}

export async function runLocalCli(
  args: string[],
  options: LocalCliOptions = {},
): Promise<void> {
  const [command, ...rest] = args;
  const commandOptions = parseOptions(rest);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;

  switch (command) {
    case "context-search-mcp":
      await runContextSearchMcp(commandOptions, env, stdout);
      return;
    case "customer-service-mcp":
      await runCustomerServiceMcp(commandOptions, env, stdout);
      return;
    case "context-embedding-index":
    case "context-embedding-status":
    case "context-embedding-retry":
    case "context-embedding-backfill":
    case "context-embedding-activate":
    case "context-embedding-rollback":
    case "context-embedding-gc":
      await embeddingCommand(command, commandOptions, env, stdout);
      return;
    case "dsh-install":
      await installDsh(commandOptions, stdout, now, createId);
      return;
    case "dsh-sync":
      await syncDsh(commandOptions, env, stdout, now, createId, options.spawn, options.fetch as DshFetch | undefined);
      return;
    case "dsh-send":
      await sendDsh(commandOptions, env, stdout, now, createId, options.spawn, options.fetch as DshFetch | undefined);
      return;
    case "status":
      await showStatus(commandOptions, stdout);
      return;
    case "quarantines":
      await showQuarantines(commandOptions, stdout);
      return;
    case "import-file":
      await importFile(commandOptions, stdout, now);
      return;
    case "export-jsonl":
      await exportJsonl(commandOptions, stdout);
      return;
    case "render-digest":
      await renderDigest(commandOptions, stdout);
      return;
    case "connector-enable":
      await setConnectorStatus(commandOptions, stdout, now, "enabled");
      return;
    case "connector-disable":
      await setConnectorStatus(commandOptions, stdout, now, "disabled");
      return;
    case "reset-cursor":
      await resetConnectorCursor(commandOptions, stdout, now);
      return;
    case "publish-evidence-bundle":
      await publishEvidenceBundle(commandOptions, stdout, now, createId);
      return;
    case "inbox":
      await showInbox(commandOptions, stdout);
      return;
    case "inbox-pending":
      await showPendingInbox(commandOptions, stdout);
      return;
    case "follow-ups":
      await showFollowUps(commandOptions, stdout, now);
      return;
    case "follow-up-snooze":
      await snoozeFollowUp(commandOptions, stdout, now);
      return;
    case "follow-up-unsnooze":
      await unsnoozeFollowUp(commandOptions, stdout, now);
      return;
    case "inbox-triage":
      await triageInbox(commandOptions, stdout, now);
      return;
    case "inbox-ack":
      await acknowledgeInboxEvent(commandOptions, stdout, now);
      return;
    case "inbox-fold":
      await setInboxEventHidden(commandOptions, stdout, now, true);
      return;
    case "inbox-unfold":
      await setInboxEventHidden(commandOptions, stdout, now, false);
      return;
    case "inbox-pin":
      await setInboxEventPinned(commandOptions, stdout, now, true);
      return;
    case "inbox-unpin":
      await setInboxEventPinned(commandOptions, stdout, now, false);
      return;
    case "inbox-triage-reset":
      await resetInboxTriage(commandOptions, stdout, now);
      return;
    case "dispatch-policy-get":
      await getPersonalDispatchPolicy(commandOptions, stdout);
      return;
    case "dispatch-policy-set":
      await putPersonalDispatchPolicy(commandOptions, stdout, now);
      return;
    case "follow-up-policy-get":
      await getPersonalFollowUpPolicy(commandOptions, stdout);
      return;
    case "follow-up-policy-set":
      await putPersonalFollowUpPolicy(commandOptions, stdout, now);
      return;
    case "inbox-dispatch-reapply":
      await reapplyInboxDispatchPolicy(commandOptions, stdout, now);
      return;
    case "context-assemble":
      await assembleContext(commandOptions, env, stdout, createId);
      return;
    case "context-search":
      await searchContext(commandOptions, env, stdout, createId);
      return;
    case "context-snapshot":
      await showContextSnapshot(commandOptions, stdout);
      return;
    case "context-snapshot-history":
      await listContextSnapshotHistory(commandOptions, stdout);
      return;
    case "context-snapshot-diff":
      await diffContextSnapshots(commandOptions, stdout);
      return;
    case "context-replay":
      await replayContext(commandOptions, stdout);
      return;
    case "context-publish-evidence-bundle":
      await publishContextEvidenceBundle(commandOptions, stdout, now);
      return;
    case "context-ask":
      await askContext(commandOptions, env, stdout, createId);
      return;
    case "context-evaluate":
      await evaluateContext(commandOptions, stdout);
      return;
    case "context-daily-digest-project":
      await projectDailyDigest(commandOptions, stdout);
      return;
    case "context-daily-digest-get":
      await getDailyDigests(commandOptions, stdout);
      return;
    case "context-daily-digest-jobs":
      await getDailyDigestJobs(commandOptions, stdout);
      return;
    case "context-daily-digest-alerts":
      await getDailyDigestCoverageAlerts(commandOptions, stdout);
      return;
    case "context-daily-digest-alert-resolve":
      await resolveDailyDigestCoverageAlert(commandOptions, stdout, now);
      return;
    case "context-proposal-create":
      await createProposalFromDigest(commandOptions, stdout, now);
      return;
    case "context-proposals":
      await listProposals(commandOptions, stdout);
      return;
    case "context-proposal-get":
      await getProposal(commandOptions, stdout);
      return;
    case "context-proposal-submit":
      await transitionProposal(commandOptions, stdout, now, "submitted");
      return;
    case "context-proposal-new-decision":
      await createDecisionProposal(commandOptions, stdout, now);
      return;
    case "context-proposal-review":
      await transitionProposal(commandOptions, stdout, now, "in_review");
      return;
    case "context-proposal-reject":
      await transitionProposal(commandOptions, stdout, now, "rejected");
      return;
    case "context-proposal-withdraw":
      await transitionProposal(commandOptions, stdout, now, "withdrawn");
      return;
    case "context-decision-commit":
      await commitDecision(commandOptions, stdout, now);
      return;
    case "context-decisions":
      await listDecisions(commandOptions, stdout);
      return;
    case "context-decision-get":
      await getDecision(commandOptions, stdout);
      return;
    case "context-review-new-decision":
      await createDecisionReview(commandOptions, stdout, now);
      return;
    case "context-decision-reviews":
      await listDecisionReviews(commandOptions, stdout);
      return;
    case "context-review-get":
      await getReview(commandOptions, stdout);
      return;
    case "context-handoff-create":
      await createHandoff(commandOptions, stdout, now);
      return;
    case "context-handoffs":
      await listHandoffs(commandOptions, stdout);
      return;
    case "context-handoff-get":
      await getHandoff(commandOptions, stdout);
      return;
    case "context-handoff-ack":
      await transitionHandoff(commandOptions, stdout, now, "acked");
      return;
    case "context-handoff-resolve":
      await transitionHandoff(commandOptions, stdout, now, "resolved");
      return;
    case "context-handoff-cancel":
      await transitionHandoff(commandOptions, stdout, now, "cancelled");
      return;
    case "context-proposal-new-standard":
      await createStandardProposal(commandOptions, stdout, now, "new_standard");
      return;
    case "context-proposal-revise-standard":
      await createStandardProposal(commandOptions, stdout, now, "revise_standard");
      return;
    case "context-standard-version-commit":
      await commitStandardVersion(commandOptions, stdout, now);
      return;
    case "context-standards":
      await listStandards(commandOptions, stdout);
      return;
    case "context-standard-get":
      await getStandard(commandOptions, stdout);
      return;
    case "context-standard-versions":
      await listStandardVersions(commandOptions, stdout);
      return;
    case "context-standard-version-get":
      await getStandardVersion(commandOptions, stdout);
      return;
    case "context-standard-version-publish-trial":
      await transitionCliStandardVersion(commandOptions, stdout, now, "trial");
      return;
    case "context-standard-version-publish-active":
    case "context-standard-version-promote":
      await transitionCliStandardVersion(commandOptions, stdout, now, "active");
      return;
    case "context-standard-version-deprecate":
      await transitionCliStandardVersion(commandOptions, stdout, now, "deprecated");
      return;
    case "context-standard-gap-new":
      await createManualStandardGap(commandOptions, stdout, now);
      return;
    case "context-standard-gap-from-review":
      await createReviewStandardGap(commandOptions, stdout, now);
      return;
    case "context-standard-gaps":
      await listStandardGaps(commandOptions, stdout);
      return;
    case "context-standard-gap-get":
      await getStandardGap(commandOptions, stdout);
      return;
    case "context-standard-gap-convert":
      await convertStandardGap(commandOptions, stdout, now);
      return;
    case "context-standard-gap-dismiss":
      await dismissStandardGap(commandOptions, stdout, now);
      return;
    case "context-run-new":
      await createAgentRun(commandOptions, stdout, now);
      return;
    case "context-runs":
      await listAgentRuns(commandOptions, stdout);
      return;
    case "context-run-get":
      await getAgentRun(commandOptions, stdout);
      return;
    case "context-run-start":
      await startAgentRunCommand(commandOptions, stdout, now);
      return;
    case "context-run-complete":
      await settleAgentRunCommand(commandOptions, stdout, now);
      return;
    case "context-run-handoff":
      await handoffAgentRunCommand(commandOptions, stdout, now);
      return;
    case "context-run-cancel":
      await cancelAgentRunCommand(commandOptions, stdout, now);
      return;
    case "context-review-new-run":
      await createAgentRunReview(commandOptions, stdout, now);
      return;
    case "context-run-reviews":
      await listAgentRunReviews(commandOptions, stdout);
      return;
    case "context-run-drift-scan":
      await scanStandardDriftCommand(commandOptions, stdout);
      return;
    case "context-standard-usage-project":
      await projectStandardUsageCommand(commandOptions, stdout);
      return;
    case "context-standard-usage":
      await listStandardUsageCommand(commandOptions, stdout);
      return;
    case "context-standard-health":
      await listStandardHealthCommand(commandOptions, stdout, now);
      return;
    default:
      throw new Error("Command must be one of: dsh-install, dsh-sync, dsh-send, status, quarantines, import-file, export-jsonl, render-digest, connector-enable, connector-disable, reset-cursor, publish-evidence-bundle, inbox, inbox-triage, inbox-triage-reset, context-assemble, context-search, context-snapshot, context-snapshot-history, context-snapshot-diff, context-replay, context-publish-evidence-bundle, context-ask, context-evaluate, context-daily-digest-project, context-daily-digest-get, context-daily-digest-alerts, context-daily-digest-alert-resolve, context-proposal-create, context-proposal-new-decision, context-proposal-new-standard, context-proposal-revise-standard, context-proposals, context-proposal-get, context-proposal-submit, context-proposal-review, context-proposal-reject, context-proposal-withdraw, context-decision-commit, context-decisions, context-decision-get, context-review-new-decision, context-review-new-run, context-decision-reviews, context-run-reviews, context-review-get, context-handoff-create, context-handoffs, context-handoff-get, context-handoff-ack, context-handoff-resolve, context-handoff-cancel, context-standard-version-commit, context-standards, context-standard-get, context-standard-versions, context-standard-version-get, context-standard-version-publish-trial, context-standard-version-publish-active, context-standard-version-promote, context-standard-version-deprecate, context-standard-gap-new, context-standard-gap-from-review, context-standard-gaps, context-standard-gap-get, context-standard-gap-convert, context-standard-gap-dismiss, context-run-new, context-runs, context-run-get, context-run-start, context-run-complete, context-run-handoff, context-run-cancel, context-run-drift-scan, context-standard-usage-project, context-standard-usage, context-standard-health, context-embedding-index, context-embedding-status, context-embedding-retry, context-embedding-backfill, context-embedding-activate, context-embedding-rollback, context-embedding-gc");
  }
}

if (require.main === module) {
  runLocalCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
