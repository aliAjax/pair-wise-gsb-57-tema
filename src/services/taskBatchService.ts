import type { TaskBatch, WorkspaceState } from '@/types/domain'
import { appendAudit, assertRevision, cloneState, now } from './requestService'
import {
  assertTaskAllowedForBasis,
  effectiveScopeSystemIds,
  ensureAgency,
  findBatch,
  id,
  materialDigest,
  stampTaskBasis,
} from './agencyChain'

export interface BatchRunInput {
  requestId: string
  idempotencyKey: string
  /** 模拟写入中断：完成前 N 个任务后中断；不提供或 >= 任务数表示跑完整批。 */
  failAfterTasks?: number
  operator: string
  expectedRevision?: number
}

const EVIDENCE_KIND: Record<string, string> = {
  locate: '数据定位回执',
  execute: '系统执行回执',
}

function deterministicEvidenceDigest(idempotencyKey: string, taskId: string): string {
  return materialDigest(`batch|${idempotencyKey}|${taskId}`)
}

/**
 * 按完整批次续做：
 * - 同一 idempotencyKey 的重试复用既有批次，不重复生成证据与处理包；
 * - 中断后仅续做尚未完成的任务，已生成证据不重发；
 * - 批次内每个任务都按当前受理快照依据产出，范围外系统拒绝写入。
 */
export function runTaskBatch(state: WorkspaceState, input: BatchRunInput): WorkspaceState {
  assertRevision(state, input.expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === input.requestId)
  if (!request) throw new Error('请求不存在')
  if (request.identity.status !== 'verified') {
    throw new Error('身份未核验通过，不能启动系统任务批次')
  }
  const agency = ensureAgency(request)
  if (agency.status !== 'confirmed') {
    throw new Error('代理关系未确认，批次不能按当前快照产出证据')
  }

  const scopeSystemIds = effectiveScopeSystemIds(request)
  const runnableTasks = request.tasks.filter(
    (task) =>
      !task.id.endsWith('-identity') &&
      !task.id.endsWith('-close') &&
      !task.id.endsWith('-merge') &&
      !task.id.endsWith('-review') &&
      (!task.systemId || scopeSystemIds.includes(task.systemId)),
  )
  if (!runnableTasks.length) throw new Error('当前快照范围内没有可执行任务')

  const existing = findBatch(request, input.idempotencyKey)
  if (existing && existing.basisVersion !== agency.currentBasisVersion) {
    throw new Error(
      `受理快照依据已从 v${existing.basisVersion} 变为 v${agency.currentBasisVersion}，` +
        `批次 ${existing.id} 不跨依据续做，请按新依据重开批次（已有证据不覆盖、不重复生成）`,
    )
  }
  if (existing && existing.status === 'completed') {
    // 幂等重试：直接返回既有批次结果，不重复生成任何证据。
    appendAudit(
      draft,
      request,
      '任务批次幂等重试',
      input.operator,
      `批次 ${existing.id}（幂等键 ${input.idempotencyKey}）此前已完成，本次重试未重复生成证据或处理包。`,
    )
    draft.revision += 1
    return draft
  }

  const newBatch: TaskBatch = {
    id: id('batch'),
    idempotencyKey: input.idempotencyKey,
    basisVersion: agency.currentBasisVersion,
    taskIds: runnableTasks.map((task) => task.id),
    completedTaskIds: [],
    generatedEvidenceIds: [],
    status: 'running',
    startedAt: now(),
  }
  const batch: TaskBatch = existing ?? newBatch
  if (!existing) request.taskBatches.unshift(batch)

  const targetCompleted =
    input.failAfterTasks === undefined
      ? runnableTasks.length
      : Math.min(Math.max(input.failAfterTasks, 0), runnableTasks.length)
  let interrupted = false
  let processedNow = 0

  for (const task of runnableTasks) {
    if (batch.completedTaskIds.includes(task.id)) continue // 续做：跳过已完成任务
    if (processedNow >= targetCompleted) {
      interrupted = true
      break
    }
    assertTaskAllowedForBasis(request, task)
    const evidenceId = id('evidence')
    const kind = task.id.includes('-execute-') ? 'execute' : 'locate'
    request.evidence.push({
      id: evidenceId,
      stepId: task.id,
      systemId: task.systemId,
      name: `${task.name} · ${EVIDENCE_KIND[kind] ?? '批次回执'}`,
      evidenceType: task.id.includes('-execute-') ? 'system-response' : 'execution-log',
      digest: deterministicEvidenceDigest(input.idempotencyKey, task.id),
      uploadedBy: input.operator,
      uploadedAt: now(),
      protected: true,
      basisVersion: agency.currentBasisVersion,
      validity: 'current',
    })
    stampTaskBasis(task, agency)
    batch.completedTaskIds.push(task.id)
    batch.generatedEvidenceIds.push(evidenceId)
    processedNow += 1
  }

  if (interrupted || (input.failAfterTasks !== undefined && input.failAfterTasks < runnableTasks.length)) {
    batch.status = 'interrupted'
    batch.failureNote = `写入中断：已完成 ${batch.completedTaskIds.length}/${runnableTasks.length}，下一次按相同幂等键从断点续做`
    request.status = 'processing'
    appendAudit(
      draft,
      request,
      '任务批次写入中断',
      input.operator,
      `批次 ${batch.id} 在 ${batch.completedTaskIds.length}/${runnableTasks.length} 处中断；批次状态已完整落盘，重试将从断点续做且不重复生成证据。`,
    )
  } else {
    batch.status = 'completed'
    batch.finishedAt = now()
    batch.failureNote = undefined
    const executableTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
    if (executableTasks.every((task) => task.status === 'completed')) {
      request.status = 'pending-close'
    }
    appendAudit(
      draft,
      request,
      '任务批次完成',
      input.operator,
      `批次 ${batch.id} 按依据 v${agency.currentBasisVersion} 完成 ${batch.taskIds.length} 个任务，共生成 ${batch.generatedEvidenceIds.length} 份证据；结果不覆盖历史。`,
    )
  }

  draft.revision += 1
  return draft
}
