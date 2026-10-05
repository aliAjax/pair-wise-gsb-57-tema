import type { WorkspaceState } from '@/types/domain'
import { appendAudit, cloneState } from './requestService'
import {
  assertTaskAllowedForBasis,
  ensureAgency,
  stampTaskBasis,
} from './agencyChain'

/** 供并发裁决复用：单步任务状态写入（不带独立审计，由调用方统一记录）。 */
export function taskActionInternal(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.identity.status !== 'verified') {
    throw new Error('身份未核验通过，不能推进履约任务')
  }
  const task = request.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error('任务不存在')
  const agency = ensureAgency(request)
  if (action === 'start') {
    assertTaskAllowedForBasis(request, task)
    task.status = 'active'
    task.exceptionReason = ''
  } else if (action === 'complete') {
    assertTaskAllowedForBasis(request, task)
    stampTaskBasis(task, agency)
    const nextTask = request.tasks.find((item) => item.status === 'pending')
    if (nextTask) nextTask.status = 'active'
  } else {
    task.status = 'blocked'
    task.exceptionReason = note
    request.status = 'review-required'
    request.conflicts.push(`任务阻塞：${task.name}，${note}`)
  }
  const executableTasks = request.tasks.filter((item) => !item.id.endsWith('-close'))
  if (executableTasks.every((item) => item.status === 'completed')) {
    request.status = 'pending-close'
  } else if (action !== 'block' && agency.status === 'confirmed') {
    request.status = 'processing'
  }
  appendAudit(draft, request, '并发窗口：完成履约任务', operator, `${note}（依据 v${agency.currentBasisVersion}）`)
  draft.revision += 1
  return draft
}
