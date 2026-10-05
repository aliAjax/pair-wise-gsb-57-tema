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
import { agencyBackfill, agencyChange, reviewPackage } from '@/services/agencyService'
import { runTaskBatch } from '@/services/taskBatchService'
import { settleConcurrent } from '@/services/concurrentService'
import { exportBlockedRequests } from '@/services/agencyChain'
import { createInitialState } from '@/services/mockData'
import {
  agencyBackfillInputSchema,
  agencyChangeInputSchema,
  assignTaskInputSchema,
  batchRunInputSchema,
  closeRequestInputSchema,
  commentInputSchema,
  concurrentSettleInputSchema,
  conflictInputSchema,
  createRequestInputSchema,
  evidenceInputSchema,
  extendRequestInputSchema,
  identityInputSchema,
  packageReviewInputSchema,
  recordExportInputSchema,
  resolveConflictInputSchema,
  saveRequestInputSchema,
  taskActionInputSchema,
} from '@/lib/schemas'
import type { WorkspaceState } from '@/types/domain'

const t = initTRPC.create()
const publicProcedure = t.procedure

function execute<T>(operation: () => T): T {
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
        execute(() =>
          createRequest(input.state, input.input, input.operator, {
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
    save: publicProcedure
      .input(saveRequestInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          saveRequest(input.state, input.requestId, input.patch, input.operator, {
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
    verifyIdentity: publicProcedure
      .input(identityInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          verifyIdentity(input.state, input.requestId, input.status, input.note, input.operator, {
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
    assignTask: publicProcedure
      .input(assignTaskInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          assignTask(input.state, input.requestId, input.taskId, input.assignee, input.operator, {
            expectedRevision: input.expectedRevision,
          }),
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
            { expectedRevision: input.expectedRevision },
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
            { expectedRevision: input.expectedRevision },
          ),
        ),
      ),
    addConflict: publicProcedure
      .input(conflictInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addConflict(input.state, input.requestId, input.conflict, input.operator, {
            expectedRevision: input.expectedRevision,
          }),
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
            { expectedRevision: input.expectedRevision },
          ),
        ),
      ),
    extend: publicProcedure
      .input(extendRequestInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          extendRequest(input.state, input.requestId, input.days, input.reason, input.operator, {
            expectedRevision: input.expectedRevision,
          }),
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
            { expectedRevision: input.expectedRevision },
          ),
        ),
      ),
    comment: publicProcedure
      .input(commentInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addComment(input.state, input.requestId, input.content, input.operator, {
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
    recordExport: publicProcedure
      .input(recordExportInputSchema)
      .mutation(({ input }) =>
        execute(() => {
          const blocked = exportBlockedRequests(input.state, input.requestIds)
          if (blocked.length) {
            throw new Error(
              `导出被代理关系门禁阻断：${blocked
                .map((request) => request.code)
                .join('、')} 缺少已确认代理关系（旧数据需先回填待确认），补全前不能导出处理包`,
            )
          }
          return recordExport(input.state, input.scope, input.count, input.operator, input.requestIds)
        }),
      ),
  }),
  agency: t.router({
    change: publicProcedure
      .input(agencyChangeInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          agencyChange(input.state, {
            requestId: input.requestId,
            reason: input.reason,
            newAgentName: input.newAgentName,
            newAgentContact: input.newAgentContact,
            scopeSystemIds: input.scopeSystemIds,
            validUntil: input.validUntil || undefined,
            note: input.note,
            operator: input.operator,
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
    backfill: publicProcedure
      .input(agencyBackfillInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          agencyBackfill(input.state, {
            requestId: input.requestId,
            representation: input.representation,
            agentName: input.agentName,
            agentContact: input.agentContact,
            scopeSystemIds: input.scopeSystemIds,
            validUntil: input.validUntil || undefined,
            note: input.note,
            operator: input.operator,
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
    reviewPackage: publicProcedure
      .input(packageReviewInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          reviewPackage(input.state, {
            requestId: input.requestId,
            packageId: input.packageId,
            resolution: input.resolution,
            note: input.note,
            operator: input.operator,
          }),
        ),
      ),
  }),
  batch: t.router({
    run: publicProcedure
      .input(batchRunInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          runTaskBatch(input.state, {
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            failAfterTasks: input.failAfterTasks,
            operator: input.operator,
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
  }),
  concurrency: t.router({
    settle: publicProcedure
      .input(concurrentSettleInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          settleConcurrent(input.state, {
            requestId: input.requestId,
            taskId: input.taskId,
            ordering: input.ordering,
            change: input.change,
            taskOperator: input.taskOperator,
            expectedRevision: input.expectedRevision,
          }),
        ),
      ),
  }),
})

export type AppRouter = typeof appRouter
