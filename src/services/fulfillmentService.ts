import type { EvidenceBatchItem, PrivacyRequest, WorkspaceState } from '@/types/domain'
import type { WriteBatch } from '@/types/domain'
import {
  assertEvidenceBasis,
  assertExportable,
  batchPlannedKey,
  buildEvidence,
  buildPackage,
  ChainError,
  evidenceKey,
  findRepresentative,
  id,
  newWriteBatch,
  now,
} from './chain'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)

function appendAudit(
  state: WorkspaceState,
  request: PrivacyRequest,
  action: string,
  operator: string,
  detail: string,
) {
  const createdAt = now()
  state.audit.unshift({ id: id('audit'), requestId: request.id, action, operator, detail, createdAt })
  request.audit.unshift({ id: id('audit'), action, operator, detail, createdAt })
}

function assertRevision(state: WorkspaceState, baseRevision: number | undefined) {
  if (typeof baseRevision === 'number' && baseRevision !== state.revision) {
    throw new ChainError(
      `工作区已被另一个窗口更新（当前版本 ${state.revision}，您基于版本 ${baseRevision}），请刷新后重试；已生成的证据与处理包不会被覆盖。`,
    )
  }
}

function getRequest(state: WorkspaceState, requestId: string): PrivacyRequest {
  const request = state.requests.find((item) => item.id === requestId)
  if (!request) throw new ChainError('请求不存在')
  return request
}

// 执行批次写入。failAfterItem 用于模拟写入中断：
// 已提交到批次账本的条目在重试/续做时按稳定键跳过，绝不重复生成
function runEvidenceBatch(
  state: WorkspaceState,
  request: PrivacyRequest,
  batch: WriteBatch,
  items: EvidenceBatchItem[],
  operator: string,
  failAfterItem?: number,
) {
  items.forEach((item, index) => {
    const key = evidenceKey(item.taskId, item.name)
    const plannedKey = batchPlannedKey('evidence', key)
    // 幂等：重试不重复生成证据
    if (batch.producedKeys.includes(plannedKey)) return
    const task = request.tasks.find((candidate) => candidate.id === item.taskId)
    if (!task) throw new ChainError(`任务不存在：${item.taskId}`)
    assertEvidenceBasis(request, state.representatives, task.systemId)
    // 全局幂等：同一受理快照下同一任务同一证据只允许存在一份有效证据
    const duplicated = request.evidence.some(
      (existing) =>
        !existing.voidedAt &&
        existing.stepId === item.taskId &&
        existing.name === item.name.trim() &&
        existing.basisSnapshotId === request.intakeSnapshot?.id,
    )
    if (duplicated) {
      throw new ChainError(`证据「${item.name}」已按当前受理快照生成，重试不会重复产出。`)
    }

    const evidence = buildEvidence(request, batch.id, item, operator)
    request.evidence.push(evidence)
    batch.evidenceIds.push(evidence.id)
    batch.producedKeys.push(plannedKey)

    if (typeof failAfterItem === 'number' && index === failAfterItem) {
      throw new ChainError(`写入中断：批次 ${batch.id} 在第 ${index + 1} 项后中断，可从完整批次续做。`)
    }
  })
}

export interface EvidenceBatchInput {
  items: EvidenceBatchItem[]
  failAfterItem?: number
  baseRevision?: number
}

// 按受理快照批量产出证据
export function produceEvidenceBatch(
  state: WorkspaceState,
  requestId: string,
  items: EvidenceBatchItem[],
  operator: string,
  failAfterItem?: number,
  baseRevision?: number,
): WorkspaceState {
  assertRevision(state, baseRevision)
  const draft = cloneState(state)
  const request = getRequest(draft, requestId)
  if (!request.intakeSnapshot) {
    throw new ChainError('受理快照缺失（旧数据代理关系待确认），补全前不能产出证据。')
  }
  if (request.identity.status !== 'verified') {
    throw new ChainError('身份未核验通过，不能按受理快照产出证据。')
  }

  // 入参先整体校验，避免部分写入
  items.forEach((item) => {
    const task = request.tasks.find((candidate) => candidate.id === item.taskId)
    if (!task) throw new ChainError(`任务不存在：${item.taskId}`)
    assertEvidenceBasis(request, draft.representatives, task.systemId)
  })

  const plannedKeys = items.map((item) => batchPlannedKey('evidence', evidenceKey(item.taskId, item.name)))
  const duplicateKeys = plannedKeys.filter((key, index) => plannedKeys.indexOf(key) !== index)
  if (duplicateKeys.length) throw new ChainError('批次内存在重复条目，已拒绝整批写入。')

  const batch = newWriteBatch(requestId, 'evidence', plannedKeys)
  draft.writeBatches.unshift(batch)
  try {
    runEvidenceBatch(draft, request, batch, items, operator, failAfterItem)
  } catch (error) {
    batch.attempts += 1
    draft.revision += 1
    if (!(error instanceof ChainError && error.message.includes('写入中断'))) {
      draft.revision -= 1
      throw error
    }
    appendAudit(
      draft,
      request,
      '证据批次写入中断',
      operator,
      `批次 ${batch.id} 已写入 ${batch.producedKeys.length}/${items.length} 项，保留完整批次账本，等待续做。`,
    )
    return draft
  }
  batch.status = 'completed'
  batch.completedAt = now()
  if (request.status === 'recalculating') request.status = 'processing'
  appendAudit(
    draft,
    request,
    '按受理快照批量产出证据',
    operator,
    `批次 ${batch.id} 完成：依据快照 ${request.intakeSnapshot.id}（${request.intakeSnapshot.representativeName} 的查看范围）产出 ${batch.producedKeys.length} 项证据。`,
  )
  draft.revision += 1
  return draft
}

// 写入中断后从完整批次续做
export function resumeEvidenceBatch(
  state: WorkspaceState,
  batchId: string,
  operator: string,
  failAfterItem?: number,
): WorkspaceState {
  const draft = cloneState(state)
  const batch = draft.writeBatches.find((item) => item.id === batchId)
  if (!batch) throw new ChainError('写入批次不存在')
  if (batch.status === 'completed') {
    // 重试不重复生成：已完成批次直接返回当前状态
    return draft
  }
  const request = getRequest(draft, batch.requestId)
  // 由 produced/planned 键重建剩余条目
  const items = batch.plannedKeys
    .filter((planned) => !batch.producedKeys.includes(planned))
    .map((planned) => {
      const raw = planned.slice('evidence:'.length)
      const separator = raw.indexOf('::')
      const taskId = raw.slice(0, separator)
      const name = raw.slice(separator + 2)
      const known = request.evidence.find(
        (evidence) => batch.evidenceIds.includes(evidence.id) && evidence.stepId === taskId,
      )
      return {
        taskId,
        name,
        evidenceType: known?.evidenceType ?? 'execution-log',
      } satisfies EvidenceBatchItem
    })

  batch.attempts += 1
  try {
    runEvidenceBatch(draft, request, batch, items, operator, failAfterItem)
  } catch (error) {
    if (error instanceof ChainError && error.message.includes('写入中断')) {
      draft.revision += 1
      appendAudit(
        draft,
        request,
        '证据批次续做中断',
        operator,
        `批次 ${batch.id} 续做后已写入 ${batch.producedKeys.length}/${batch.plannedKeys.length} 项。`,
      )
      return draft
    }
    throw error
  }
  batch.status = 'completed'
  batch.completedAt = now()
  if (request.status === 'recalculating') request.status = 'processing'
  appendAudit(
    draft,
    request,
    '证据批次续做完成',
    operator,
    `批次 ${batch.id} 从第 ${batch.producedKeys.length - items.length + 1} 项续做，共 ${batch.producedKeys.length} 项，未重复生成证据。`,
  )
  draft.revision += 1
  return draft
}

// 生成处理包（关闭时一并调用）：只收当前依据有效、未失效的证据
export function preparePackage(
  state: WorkspaceState,
  requestId: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = getRequest(draft, requestId)
  if (!request.intakeSnapshot) {
    throw new ChainError('受理快照缺失，补全代理关系前不能生成处理包。')
  }
  const representative = findRepresentative(draft, request.intakeSnapshot.representativeId)
  if (request.intakeSnapshot.representativeId) {
    if (!representative || representative.verification.status !== 'verified') {
      throw new ChainError('代理授权未核验通过，不能生成处理包。')
    }
  }
  if (request.intakeSnapshot.invalidatedReason) {
    throw new ChainError('受理快照已失效，需要按最新代理关系重算后再生成处理包。')
  }
  const usableEvidence = request.evidence.filter(
    (evidence) => !evidence.voidedAt && evidence.basisState === 'current',
  )
  if (!usableEvidence.length) {
    throw new ChainError('没有可纳入处理包的有效证据，不能生成空包。')
  }

  const batch = newWriteBatch(
    requestId,
    'package',
    [batchPlannedKey('package', `pkg-${request.id}-${request.deliveryPackages.length}`)],
  )
  const pkg = buildPackage(request, batch.id)
  batch.packageIds.push(pkg.id)
  batch.producedKeys.push(batch.plannedKeys[0])
  batch.status = 'completed'
  batch.completedAt = now()
  request.deliveryPackages.unshift(pkg)
  draft.writeBatches.unshift(batch)
  appendAudit(
    draft,
    request,
    '生成处理包',
    operator,
    `处理包 ${pkg.code} 已生成：锁定受理快照 ${pkg.basisSnapshotId}，纳入 ${pkg.evidenceIds.length} 项有效证据，摘要 ${pkg.digest}。`,
  )
  draft.revision += 1
  return draft
}

// 交付处理包给请求方
export function deliverPackage(
  state: WorkspaceState,
  packageId: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) =>
    item.deliveryPackages.some((pkg) => pkg.id === packageId),
  )
  if (!request) throw new ChainError('处理包不存在')
  const pkg = request.deliveryPackages.find((item) => item.id === packageId)
  if (!pkg) throw new ChainError('处理包不存在')
  if (pkg.status === 'voided') throw new ChainError('处理包已作废，不能交付，请重算后重新生成。')
  if (pkg.status === 'delivered') {
    throw new ChainError('处理包已发出，不能重复交付。')
  }
  if (pkg.status === 'under-review') throw new ChainError('处理包处于复核中。')
  pkg.status = 'delivered'
  pkg.deliveredAt = now()
  appendAudit(
    draft,
    request,
    '发出处理包',
    operator,
    `处理包 ${pkg.code} 已交付 ${pkg.basisRepresentativeName || '数据主体本人'}，交付时依据快照 ${pkg.basisSnapshotId}。`,
  )
  draft.revision += 1
  return draft
}

// 已发出处理包在授权依据变化后进入复核：记录复核意见
export function reviewPackage(
  state: WorkspaceState,
  packageId: string,
  reviewNote: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) =>
    item.deliveryPackages.some((pkg) => pkg.id === packageId),
  )
  if (!request) throw new ChainError('处理包不存在')
  const pkg = request.deliveryPackages.find((item) => item.id === packageId)
  if (!pkg) throw new ChainError('处理包不存在')
  if (pkg.status !== 'under-review') {
    throw new ChainError('只有依据变更后进入复核的已发出处理包可以登记复核意见。')
  }
  pkg.reviewNote = reviewNote
  appendAudit(
    draft,
    request,
    '处理包依据复核',
    operator,
    `处理包 ${pkg.code} 保留发出时依据（快照 ${pkg.basisSnapshotId}、摘要 ${pkg.digest}），复核意见：${reviewNote}`,
  )
  draft.revision += 1
  return draft
}

// 导出处理包前校验：旧数据未回填代理关系一律拒绝
export function assertWorkspaceExportable(state: WorkspaceState): void {
  assertExportable(state)
}
