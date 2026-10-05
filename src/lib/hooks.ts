'use client'

import { useEffect } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { trpc } from './trpc'
import { loadWorkspace, saveWorkspace } from './localStore'
import type { PrivacyRequest, WorkspaceState } from '@/types/domain'

export const workspaceQueryKey = ['privacy-workspace'] as const

export function useWorkspaceQuery() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: workspaceQueryKey,
    queryFn: () => trpc.workspace.defaults.query(),
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    const cached = loadWorkspace()
    if (cached) queryClient.setQueryData(workspaceQueryKey, cached)
  }, [queryClient])

  useEffect(() => {
    if (query.data) saveWorkspace(query.data)
  }, [query.data])

  return query
}

interface WorkspaceMutationOptions {
  onStale?: () => void
}

function useWorkspaceMutation<TInput extends { expectedRevision?: number }>(
  perform: (input: TInput, state: WorkspaceState) => Promise<unknown>,
  options: WorkspaceMutationOptions = {},
): UseMutationResult<unknown, Error, TInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TInput) => {
      const state =
        queryClient.getQueryData<WorkspaceState>(workspaceQueryKey) ?? loadWorkspace()
      if (!state) throw new Error('本地工作区尚未加载')
      return perform({ ...input, expectedRevision: state.revision }, state)
    },
    onSuccess: (result) => {
      const next = result as WorkspaceState
      saveWorkspace(next)
      queryClient.setQueryData(workspaceQueryKey, next)
    },
    onError: (error) => {
      if (error.message.includes('工作区版本已变化')) options.onStale?.()
    },
  })
}

export function useCreateRequestMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.create.mutate>[0], 'state'>, state) =>
      trpc.request.create.mutate({ ...input, state }),
  )
}

export function useSaveRequestMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.save.mutate>[0], 'state'>, state) =>
      trpc.request.save.mutate({ ...input, state }),
  )
}

export function useVerifyIdentityMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.verifyIdentity.mutate>[0], 'state'>, state) =>
      trpc.request.verifyIdentity.mutate({ ...input, state }),
  )
}

export function useAssignTaskMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.assignTask.mutate>[0], 'state'>, state) =>
      trpc.request.assignTask.mutate({ ...input, state }),
  )
}

export function useTaskActionMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.taskAction.mutate>[0], 'state'>, state) =>
      trpc.request.taskAction.mutate({ ...input, state }),
  )
}

export function useAddEvidenceMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.addEvidence.mutate>[0], 'state'>, state) =>
      trpc.request.addEvidence.mutate({ ...input, state }),
  )
}

export function useAddConflictMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.addConflict.mutate>[0], 'state'>, state) =>
      trpc.request.addConflict.mutate({ ...input, state }),
  )
}

export function useResolveConflictMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.resolveConflict.mutate>[0], 'state'>, state) =>
      trpc.request.resolveConflict.mutate({ ...input, state }),
  )
}

export function useExtendRequestMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.extend.mutate>[0], 'state'>, state) =>
      trpc.request.extend.mutate({ ...input, state }),
  )
}

export function useCloseRequestMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.close.mutate>[0], 'state'>, state) =>
      trpc.request.close.mutate({ ...input, state }),
  )
}

export function useAddCommentMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.request.comment.mutate>[0], 'state'>, state) =>
      trpc.request.comment.mutate({ ...input, state }),
  )
}

export function useRecordExportMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      input: Omit<Parameters<typeof trpc.request.recordExport.mutate>[0], 'state'>,
    ) => {
      const state =
        queryClient.getQueryData<WorkspaceState>(workspaceQueryKey) ?? loadWorkspace()
      if (!state) throw new Error('本地工作区尚未加载')
      return trpc.request.recordExport.mutate({ ...input, state })
    },
    onSuccess: (next) => {
      saveWorkspace(next)
      queryClient.setQueryData(workspaceQueryKey, next)
    },
  })
}

export function useAgencyChangeMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.agency.change.mutate>[0], 'state'>, state) =>
      trpc.agency.change.mutate({ ...input, state }),
  )
}

export function useAgencyBackfillMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.agency.backfill.mutate>[0], 'state'>, state) =>
      trpc.agency.backfill.mutate({ ...input, state }),
  )
}

export function useReviewPackageMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      input: Omit<Parameters<typeof trpc.agency.reviewPackage.mutate>[0], 'state'>,
    ) => {
      const state =
        queryClient.getQueryData<WorkspaceState>(workspaceQueryKey) ?? loadWorkspace()
      if (!state) throw new Error('本地工作区尚未加载')
      return trpc.agency.reviewPackage.mutate({ ...input, state })
    },
    onSuccess: (next) => {
      saveWorkspace(next)
      queryClient.setQueryData(workspaceQueryKey, next)
    },
  })
}

export function useBatchRunMutation() {
  return useWorkspaceMutation(
    (input: Omit<Parameters<typeof trpc.batch.run.mutate>[0], 'state'>, state) =>
      trpc.batch.run.mutate({ ...input, state }),
  )
}

export interface ConcurrentSettleOutcome {
  state: WorkspaceState
  actions: { kind: 'agency-change' | 'task-complete'; accepted: boolean; detail: string }[]
}

export function useConcurrentSettleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      input: Omit<Parameters<typeof trpc.concurrency.settle.mutate>[0], 'state'>,
    ): Promise<ConcurrentSettleOutcome> => {
      const state =
        queryClient.getQueryData<WorkspaceState>(workspaceQueryKey) ?? loadWorkspace()
      if (!state) throw new Error('本地工作区尚未加载')
      return trpc.concurrency.settle.mutate({
        ...input,
        expectedRevision: state.revision,
        state,
      }) as Promise<ConcurrentSettleOutcome>
    },
    onSuccess: (result) => {
      saveWorkspace(result.state)
      queryClient.setQueryData(workspaceQueryKey, result.state)
    },
  })
}

export type { PrivacyRequest }
