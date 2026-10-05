import { TRPCError, initTRPC } from '@trpc/server'
import {
  addComment,
  addConflict,
  addEvidence,
  assignTask,
  closeRequest,
  createRequest,
  extendRequest,
  recordExport,
  resolveConflict,
  saveRequest,
  taskAction,
  verifyIdentity,
} from '@/services/requestService'
import {
  backfillIntake,
  changeRepresentation,
  registerRepresentative,
  verifyRepresentative,
} from '@/services/representationService'
import {
  deliverPackage,
  preparePackage,
  produceEvidenceBatch,
  resumeEvidenceBatch,
  reviewPackage,
} from '@/services/fulfillmentService'
import { createInitialState } from '@/services/mockData'
import {
  assignTaskInputSchema,
  backfillIntakeInputSchema,
  changeRepresentationInputSchema,
  closeRequestInputSchema,
  commentInputSchema,
  conflictInputSchema,
  createRequestInputSchema,
  deliverPackageInputSchema,
  evidenceBatchInputSchema,
  evidenceInputSchema,
  extendRequestInputSchema,
  identityInputSchema,
  preparePackageInputSchema,
  recordExportInputSchema,
  registerRepresentativeInputSchema,
  resolveConflictInputSchema,
  resumeBatchInputSchema,
  reviewPackageInputSchema,
  saveRequestInputSchema,
  taskActionInputSchema,
  verifyRepresentativeInputSchema,
} from '@/lib/schemas'
import type { WorkspaceState } from '@/types/domain'

const t = initTRPC.create()
const publicProcedure = t.procedure

function execute(operation: () => WorkspaceState): WorkspaceState {
  try {
    return operation()
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error instanceof Error ? error.message : '请求处理失败',
    })
  }
}

export const appRouter = t.router({
  workspace: t.router({
    defaults: publicProcedure.query(() => createInitialState()),
  }),
  request: t.router({
    create: publicProcedure
      .input(createRequestInputSchema)
      .mutation(({ input }) =>
        execute(() => createRequest(input.state, input.input, input.operator)),
      ),
    save: publicProcedure
      .input(saveRequestInputSchema)
      .mutation(({ input }) =>
        execute(() => saveRequest(input.state, input.requestId, input.patch, input.operator)),
      ),
    verifyIdentity: publicProcedure
      .input(identityInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          verifyIdentity(input.state, input.requestId, input.status, input.note, input.operator),
        ),
      ),
    assignTask: publicProcedure
      .input(assignTaskInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          assignTask(
            input.state,
            input.requestId,
            input.taskId,
            input.assignee,
            input.operator,
          ),
        ),
      ),
    taskAction: publicProcedure
      .input(taskActionInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          taskAction(
            input.state,
            input.requestId,
            input.taskId,
            input.action,
            input.note,
            input.operator,
            input.baseRevision,
          ),
        ),
      ),
    addEvidence: publicProcedure
      .input(evidenceInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addEvidence(
            input.state,
            input.requestId,
            input.taskId,
            input.name,
            input.evidenceType,
            input.operator,
          ),
        ),
      ),
    addConflict: publicProcedure
      .input(conflictInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addConflict(input.state, input.requestId, input.conflict, input.operator),
        ),
      ),
    resolveConflict: publicProcedure
      .input(resolveConflictInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          resolveConflict(
            input.state,
            input.requestId,
            input.conflictIndex,
            input.resolution,
            input.operator,
          ),
        ),
      ),
    extend: publicProcedure
      .input(extendRequestInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          extendRequest(
            input.state,
            input.requestId,
            input.days,
            input.reason,
            input.operator,
          ),
        ),
      ),
    close: publicProcedure
      .input(closeRequestInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          closeRequest(
            input.state,
            input.requestId,
            input.resultSummary,
            input.closureReason,
            input.operator,
          ),
        ),
      ),
    comment: publicProcedure
      .input(commentInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addComment(input.state, input.requestId, input.content, input.operator),
        ),
      ),
    recordExport: publicProcedure
      .input(recordExportInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          recordExport(input.state, input.scope, input.count, input.operator),
        ),
      ),
  }),
  representation: t.router({
    register: publicProcedure
      .input(registerRepresentativeInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          registerRepresentative(
            input.state,
            {
              kind: input.kind,
              name: input.name,
              contact: input.contact,
              credentialRef: input.credentialRef,
              scopeSystemIds: input.scopeSystemIds,
              scopeRequestTypes: input.scopeRequestTypes,
              validDays: input.validDays,
            },
            input.operator,
          ),
        ),
      ),
    verify: publicProcedure
      .input(verifyRepresentativeInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          verifyRepresentative(
            input.state,
            input.representativeId,
            input.status,
            input.note,
            input.operator,
          ),
        ),
      ),
    change: publicProcedure
      .input(changeRepresentationInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          changeRepresentation(
            input.state,
            input.representativeId,
            input.action,
            input.reason,
            input.successor,
            input.baseRevision,
            input.operator,
          ),
        ),
      ),
    backfill: publicProcedure
      .input(backfillIntakeInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          backfillIntake(input.state, input.requestId, input.representativeId, input.operator),
        ),
      ),
  }),
  fulfillment: t.router({
    evidenceBatch: publicProcedure
      .input(evidenceBatchInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          produceEvidenceBatch(
            input.state,
            input.requestId,
            input.items,
            input.operator,
            input.failAfterItem,
            input.baseRevision,
          ),
        ),
      ),
    resumeBatch: publicProcedure
      .input(resumeBatchInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          resumeEvidenceBatch(input.state, input.batchId, input.operator, input.failAfterItem),
        ),
      ),
    preparePackage: publicProcedure
      .input(preparePackageInputSchema)
      .mutation(({ input }) =>
        execute(() => preparePackage(input.state, input.requestId, input.operator)),
      ),
    deliverPackage: publicProcedure
      .input(deliverPackageInputSchema)
      .mutation(({ input }) =>
        execute(() => deliverPackage(input.state, input.packageId, input.operator)),
      ),
    reviewPackage: publicProcedure
      .input(reviewPackageInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          reviewPackage(input.state, input.packageId, input.reviewNote, input.operator),
        ),
      ),
  }),
})

export type AppRouter = typeof appRouter
