import type { AgencyChangeReason, PrivacyRequest, WorkspaceState } from '@/types/domain'
import { appendAudit, cloneState } from './requestService'
import { taskActionInternal } from './internalMutations'
import { agencyChange } from './agencyService'

export interface ConcurrentSettleInput {
  requestId: string
  taskId: string
  /** 两个窗口的实际到达顺序：先到动作先落盘，后到动作按最新代理关系判断。 */
  ordering: 'change-first' | 'complete-first'
  change: {
    reason: Exclude<AgencyChangeReason, 'backfill' | 'initial'>
    newAgentName?: string
    newAgentContact?: string
    scopeSystemIds?: string[]
    validUntil?: string
    note?: string
    operator: string
  }
  taskOperator: string
  expectedRevision?: number
}

export interface SettledAction {
  kind: 'agency-change' | 'task-complete'
  accepted: boolean
  detail: string
}

export interface ConcurrentSettleResult {
  state: WorkspaceState
  actions: SettledAction[]
}

/**
 * 两个窗口同时提交“授权变更”和“任务完成”：
 * - 先到动作正常落盘；
 * - 后到的任务完成按最新代理关系重新判断，不能覆盖已生成结果；
 * - 任务若绑定旧依据则被拒绝（冲突留痕），不产生新证据。
 */
export function settleConcurrent(
  state: WorkspaceState,
  input: ConcurrentSettleInput,
): ConcurrentSettleResult {
  const actions: SettledAction[] = []
  let draft = cloneState(state)

  const runChange = (s: WorkspaceState): WorkspaceState =>
    agencyChange(s, {
      requestId: input.requestId,
      reason: input.change.reason,
      newAgentName: input.change.newAgentName,
      newAgentContact: input.change.newAgentContact,
      scopeSystemIds: input.change.scopeSystemIds,
      validUntil: input.change.validUntil,
      note: input.change.note,
      operator: input.change.operator,
    })

  const runComplete = (s: WorkspaceState): WorkspaceState =>
    taskActionInternal(
      s,
      input.requestId,
      input.taskId,
      'complete',
      `并发窗口提交任务完成，按最新代理依据 v${
        s.requests.find((request: { id: string; agency?: { currentBasisVersion?: number } }) => request.id === input.requestId)
          ?.agency?.currentBasisVersion ?? 1
      } 判断。`,
      input.taskOperator,
    )

  const tryAction = (kind: SettledAction['kind'], run: (s: WorkspaceState) => WorkspaceState) => {
    try {
      draft = run(draft)
      actions.push({ kind, accepted: true, detail: '已落盘' })
    } catch (error) {
      actions.push({
        kind,
        accepted: false,
        detail: error instanceof Error ? error.message : '动作被拒绝',
      })
    }
  }

  if (input.ordering === 'change-first') {
    tryAction('agency-change', runChange)
    tryAction('task-complete', runComplete)
  } else {
    tryAction('task-complete', runComplete)
    tryAction('agency-change', runChange)
  }

  const request = draft.requests.find((item: PrivacyRequest) => item.id === input.requestId)
  if (request) {
    appendAudit(
      draft,
      request,
      '并发窗口裁决',
      input.taskOperator,
      `到达顺序：${input.ordering === 'change-first' ? '授权变更先到、任务完成后到' : '任务完成先到、授权变更后到'}。` +
        actions
          .map(
            (action) =>
              `${action.kind === 'agency-change' ? '授权变更' : '任务完成'}${action.accepted ? '已接受' : `被拒绝（${action.detail}）`}`,
          )
          .join('；') +
        '。后到动作按最新代理关系判断，已生成结果未被覆盖。',
    )
    draft.revision += 1
  }

  return { state: draft, actions }
}
