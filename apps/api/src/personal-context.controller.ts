import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { PersonalApiGuard } from "./personal-api.guard";
import {
  PersonalContextError,
  PersonalContextService,
} from "./personal-context.service";
import { PersonalKernelStoppedError } from "./personal-runtime.service";

@Controller("v1/me/context")
@UseGuards(PersonalApiGuard)
export class PersonalContextController {
  constructor(
    @Inject(PersonalContextService)
    private readonly context: PersonalContextService,
  ) {}

  @Post("assemble")
  assemble(@Body() body: unknown) {
    return this.guard(() => this.context.assemble(body));
  }

  @Get("snapshots/:snapshotId")
  getSnapshot(@Param("snapshotId") snapshotId: string) {
    return this.guard(() => this.context.getSnapshot(snapshotId));
  }

  @Get("artifacts")
  listArtifacts() {
    return this.guard(() => this.context.listArtifacts());
  }

  @Post("daily-digests/project")
  projectDailyDigest(@Body() body: unknown) {
    return this.guard(() => this.context.projectDailyDigest(body));
  }

  @Get("daily-digests/jobs")
  listDailyDigestJobs() {
    return this.guard(() => this.context.listDailyDigestJobs());
  }

  @Get("daily-digests/policy")
  getDailyDigestPolicy() {
    return this.guard(() => this.context.getDailyDigestPolicy());
  }

  @Post("daily-digests/policy")
  putDailyDigestPolicy(@Body() body: unknown) {
    return this.guard(() => this.context.putDailyDigestPolicy(body));
  }

  @Get("daily-digests/coverage-alerts")
  listDailyDigestCoverageAlerts() {
    return this.guard(() => this.context.listDailyDigestCoverageAlerts());
  }

  @Post("daily-digests/coverage-alerts/:alertId/resolve")
  resolveDailyDigestCoverageAlert(@Param("alertId") alertId: string) {
    return this.guard(() => this.context.resolveDailyDigestCoverageAlert(alertId));
  }

  @Post("daily-digests/:artifactId/proposals")
  createProposalFromDailyDigest(@Param("artifactId") artifactId: string, @Body() body: unknown) {
    return this.guard(() => this.context.createProposalFromDailyDigest(artifactId, body));
  }

  @Get("daily-digests/:utcDate")
  listDailyDigests(@Param("utcDate") utcDate: string) {
    return this.guard(() => this.context.listDailyDigests(utcDate));
  }

  @Get("proposals")
  listProposals() {
    return this.guard(() => this.context.listProposals());
  }

  @Post("proposals")
  createProposal(@Body() body: unknown) {
    return this.guard(() => this.context.createProposal(body));
  }

  @Get("proposals/:proposalId")
  getProposal(@Param("proposalId") proposalId: string) {
    return this.guard(() => this.context.getProposal(proposalId));
  }

  @Post("proposals/:proposalId/submit")
  submitProposal(@Param("proposalId") proposalId: string) {
    return this.guard(() => this.context.transitionProposal(proposalId, "submitted"));
  }

  @Post("proposals/:proposalId/review")
  reviewProposal(@Param("proposalId") proposalId: string) {
    return this.guard(() => this.context.transitionProposal(proposalId, "in_review"));
  }

  @Post("proposals/:proposalId/reject")
  rejectProposal(@Param("proposalId") proposalId: string) {
    return this.guard(() => this.context.transitionProposal(proposalId, "rejected"));
  }

  @Post("proposals/:proposalId/decision")
  commitProposalDecision(@Param("proposalId") proposalId: string, @Body() body: unknown) {
    return this.guard(() => this.context.commitProposalDecision(proposalId, body));
  }

  @Post("proposals/:proposalId/standard-version")
  commitProposalStandardVersion(@Param("proposalId") proposalId: string, @Body() body: unknown) {
    return this.guard(() => this.context.commitProposalStandardVersion(proposalId, body));
  }

  @Post("proposals/:proposalId/withdraw")
  withdrawProposal(@Param("proposalId") proposalId: string) {
    return this.guard(() => this.context.transitionProposal(proposalId, "withdrawn"));
  }

  @Get("decisions")
  listDecisions() {
    return this.guard(() => this.context.listDecisions());
  }

  @Get("decisions/:decisionId")
  getDecision(@Param("decisionId") decisionId: string) {
    return this.guard(() => this.context.getDecision(decisionId));
  }

  @Get("standards")
  listStandards() {
    return this.guard(() => this.context.listStandards());
  }

  @Get("standards/:standardId")
  getStandard(@Param("standardId") standardId: string) {
    return this.guard(() => this.context.getStandard(standardId));
  }

  @Get("standards/:standardId/versions")
  listStandardVersions(@Param("standardId") standardId: string) {
    return this.guard(() => this.context.listStandardVersions(standardId));
  }

  @Get("standard-versions/:versionId")
  getStandardVersion(@Param("versionId") versionId: string) {
    return this.guard(() => this.context.getStandardVersion(versionId));
  }

  @Post("standard-versions/:versionId/publish-trial")
  publishStandardVersionTrial(@Param("versionId") versionId: string, @Body() body: unknown) {
    return this.guard(() => this.context.transitionStandardVersion(versionId, "trial", body));
  }

  @Post("standard-versions/:versionId/publish-active")
  publishStandardVersionActive(@Param("versionId") versionId: string, @Body() body: unknown) {
    return this.guard(() => this.context.transitionStandardVersion(versionId, "active", body));
  }

  @Post("standard-versions/:versionId/promote")
  promoteStandardVersion(@Param("versionId") versionId: string, @Body() body: unknown) {
    return this.guard(() => this.context.transitionStandardVersion(versionId, "active", body));
  }

  @Post("standard-versions/:versionId/deprecate")
  deprecateStandardVersion(@Param("versionId") versionId: string, @Body() body: unknown) {
    return this.guard(() => this.context.transitionStandardVersion(versionId, "deprecated", body));
  }

  @Post("decisions/:decisionId/reviews")
  createDecisionReview(@Param("decisionId") decisionId: string, @Body() body: unknown) {
    return this.guard(() => this.context.createDecisionReview(decisionId, body));
  }

  @Get("decisions/:decisionId/reviews")
  listDecisionReviews(@Param("decisionId") decisionId: string) {
    return this.guard(() => this.context.listDecisionReviews(decisionId));
  }

  @Get("reviews/:reviewId")
  getReview(@Param("reviewId") reviewId: string) {
    return this.guard(() => this.context.getReview(reviewId));
  }

  @Post("reviews/:reviewId/standard-gap")
  createStandardGapFromReview(@Param("reviewId") reviewId: string, @Body() body: unknown) {
    return this.guard(() => this.context.createStandardGapFromReview(reviewId, body));
  }

  @Post("standard-gaps")
  createManualStandardGap(@Body() body: unknown) {
    return this.guard(() => this.context.createManualStandardGap(body));
  }

  @Get("standard-gaps")
  listStandardGaps(@Query("status") status?: string) {
    return this.guard(() => this.context.listStandardGaps(status));
  }

  @Get("standard-gaps/:gapId")
  getStandardGap(@Param("gapId") gapId: string) {
    return this.guard(() => this.context.getStandardGap(gapId));
  }

  @Post("standard-gaps/:gapId/proposal")
  convertStandardGap(@Param("gapId") gapId: string, @Body() body: unknown) {
    return this.guard(() => this.context.convertStandardGap(gapId, body));
  }

  @Post("standard-gaps/:gapId/dismiss")
  dismissStandardGap(@Param("gapId") gapId: string) {
    return this.guard(() => this.context.dismissStandardGap(gapId));
  }

  @Post("handoffs")
  createHandoff(@Body() body: unknown) {
    return this.guard(() => this.context.createHandoff(body));
  }

  @Get("handoffs")
  listHandoffs(@Query("status") status?: string, @Query("direction") direction?: string) {
    return this.guard(() => this.context.listHandoffs(status, direction));
  }

  @Get("handoffs/:handoffId")
  getHandoff(@Param("handoffId") handoffId: string) {
    return this.guard(() => this.context.getHandoff(handoffId));
  }

  @Post("handoffs/:handoffId/ack")
  acknowledgeHandoff(@Param("handoffId") handoffId: string) {
    return this.guard(() => this.context.transitionHandoff(handoffId, "acked"));
  }

  @Post("handoffs/:handoffId/resolve")
  resolveHandoff(@Param("handoffId") handoffId: string) {
    return this.guard(() => this.context.transitionHandoff(handoffId, "resolved"));
  }

  @Post("handoffs/:handoffId/cancel")
  cancelHandoff(@Param("handoffId") handoffId: string) {
    return this.guard(() => this.context.transitionHandoff(handoffId, "cancelled"));
  }

  @Post("runs")
  @HttpCode(HttpStatus.ACCEPTED)
  createAgentRun(@Body() body: unknown) {
    return this.guard(() => this.context.createAgentRun(body));
  }

  @Get("runs")
  listAgentRuns(@Query("status") status?: string) {
    return this.guard(() => this.context.listAgentRuns(status));
  }

  @Get("runs/:runId")
  getAgentRun(@Param("runId") runId: string) {
    return this.guard(() => this.context.getAgentRun(runId));
  }

  @Post("runs/:runId/start")
  startAgentRun(@Param("runId") runId: string) {
    return this.guard(() => this.context.startAgentRun(runId));
  }

  @Post("runs/:runId/complete")
  settleAgentRun(@Param("runId") runId: string, @Body() body: unknown) {
    return this.guard(() => this.context.settleAgentRun(runId, body));
  }

  @Post("runs/:runId/handoff")
  handoffAgentRun(@Param("runId") runId: string, @Body() body: unknown) {
    return this.guard(() => this.context.handoffAgentRun(runId, body));
  }

  @Post("runs/:runId/cancel")
  cancelAgentRun(@Param("runId") runId: string) {
    return this.guard(() => this.context.cancelAgentRun(runId));
  }

  @Post("runs/:runId/reviews")
  createAgentRunReview(@Param("runId") runId: string, @Body() body: unknown) {
    return this.guard(() => this.context.createAgentRunReview(runId, body));
  }

  @Get("runs/:runId/reviews")
  listAgentRunReviews(@Param("runId") runId: string) {
    return this.guard(() => this.context.listAgentRunReviews(runId));
  }

  @Post("artifacts/:artifactId/decision")
  decideArtifact(@Param("artifactId") artifactId: string, @Body() body: unknown) {
    return this.guard(() => this.context.decideArtifact(artifactId, body));
  }

  @Post("artifacts/:artifactId/supersede")
  supersedeArtifact(@Param("artifactId") artifactId: string, @Body() body: unknown) {
    return this.guard(() => this.context.supersedeArtifact(artifactId, body));
  }

  @Post("replay")
  replay(@Body() body: unknown) {
    return this.guard(() => this.context.replay(body));
  }

  @Post("ask")
  ask(@Body() body: unknown) {
    return this.guard(() => this.context.ask(body));
  }

  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PersonalKernelStoppedError) {
        throw new HttpException(
          {
            error: {
              code: "not_configured",
              message: "REGENIC_DATABASE and REGENIC_BLOB_ROOT are required",
            },
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (error instanceof PersonalContextError) {
        throw new HttpException(
          { error: { code: error.code, message: error.message } },
          error.httpStatus,
        );
      }
      throw error;
    }
  }
}
