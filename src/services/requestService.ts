import type {
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  WorkspaceState,
} from '@/types/domain'
import { addDays, buildWorkflowSteps, responseDays } from './workflow'
import { preparePackage, produceEvidenceBatch } from './fulfillmentService'
import {
  assertActiveBasis,
  assertExportable,
  assertScope,
  ChainError,
  digest,
  findRepresentative,
  freezeSnapshot,
  getSelfRepresentative,
  id,
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
  const entry = {
    id: id('audit'),
    requestId: request.id,
    action,
    operator,
    detail,
    createdAt: now(),
  }
  state.audit.unshift(entry)
  request.audit.unshift({
    id: entry.id,
    action,
    operator,
    detail,
    createdAt: entry.createdAt,
  })
}

function mutateRequest(
  state: WorkspaceState,
  requestId: string,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => void,
  audit: { action: string; operator: string; detail: string },
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  appendAudit(draft, request, audit.action, audit.operator, audit.detail)
  draft.revision += 1
  return draft
}

// 任务推进前确认授权依据：后到动作按最新代理关系判断，不能覆盖已生成结果
function assertTaskBasis(draft: WorkspaceState, request: PrivacyRequest, baseRevision?: number) {
  if (typeof baseRevision === 'number' && baseRevision !== draft.revision) {
    throw new ChainError(
      `另一个窗口已经提交授权或任务变更（当前版本 ${draft.revision}，您基于版本 ${baseRevision}）。本动作按最新代理关系判断，已生成的证据和处理包不会被覆盖，请刷新后重试。`,
    )
  }
  const snapshot = request.intakeSnapshot
  if (!snapshot) {
    throw new ChainError('受理快照缺失（旧数据代理关系待确认），回填前不能推进任务。')
  }
  if (snapshot.invalidatedReason) {
    throw new ChainError('受理快照已失效，请按最新代理关系重算任务。')
  }
  if (snapshot.representativeId) {
    const representative = findRepresentative(draft, snapshot.representativeId)
    assertActiveBasis(representative)
  }
}

export interface CreateRequestInput {
  dataSubjectName: string
  dataSubjectContact: string
  representativeId: string | null
  requesterName: string
  requesterContact: string
  region: keyof typeof responseDays
  type: RequestType
  affectedSystemIds: string[]
  identityMaterialType: IdentityCheck['materialType']
  identityReference: string
  note: string
}

export function createRequest(
  state: WorkspaceState,
  input: CreateRequestInput,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const requestedAt = now()
  const dueAt = addDays(new Date(requestedAt), responseDays[input.region]).toISOString()
  const duplicate = draft.requests.find(
    (request) =>
      request.dataSubjectContact === input.dataSubjectContact &&
      request.type === input.type &&
      !['completed', 'rejected'].includes(request.status),
  )

  // 受理时冻结代理关系与查看范围：任务此后只按这份快照产出证据
  let snapshot = null
  let representativeId: string | null = null
  let requesterName = input.requesterName.trim()
  let requesterContact = input.requesterContact.trim()
  if (input.representativeId) {
    const representative = findRepresentative(draft, input.representativeId)
    if (!representative) throw new ChainError('代理关系不存在，请先登记代理授权。')
    assertScope(representative, input.affectedSystemIds, input.type)
    assertActiveBasis(representative)
    requesterName = requesterName || representative.name
    requesterContact = requesterContact || representative.contact
    representativeId = representative.id
    snapshot = freezeSnapshot(representative, requestedAt)
  } else {
    const self = getSelfRepresentative(
      draft,
      input.dataSubjectName.trim(),
      input.dataSubjectContact.trim(),
    )
    requesterName = requesterName || self.name
    requesterContact = requesterContact || self.contact
    snapshot = freezeSnapshot(self, requestedAt)
  }

  const identityInsufficient =
    input.identityMaterialType === 'none' || input.identityReference.trim().length < 6
  const status: RequestStatus = identityInsufficient || duplicate ? 'review-required' : 'identity-review'
  const nextNumber =
    Math.max(
      0,
      ...draft.requests.map((request) => Number(request.code.split('-').at(-1)) || 0),
    ) + 1
  const requestId = id('request')
  const request: PrivacyRequest = {
    id: requestId,
    code: `DSR-2026-${String(nextNumber).padStart(3, '0')}`,
    dataSubjectName: input.dataSubjectName.trim(),
    dataSubjectContact: input.dataSubjectContact.trim(),
    requesterName,
    requesterContact,
    representativeId,
    intakeSnapshot: snapshot,
    region: input.region,
    type: input.type,
    status,
    identity: {
      status: identityInsufficient ? 'insufficient' : 'pending',
      materialType: input.identityMaterialType,
      maskedReference: input.identityReference.trim(),
      protectedDigest: digest(input.identityReference, 'ID'),
      note: input.note.trim(),
    },
    requestedAt,
    dueAt,
    extendedDays: 0,
    duplicateOf: duplicate?.code,
    affectedSystemIds: [...input.affectedSystemIds],
    tasks: buildWorkflowSteps({
      requestId,
      type: input.type,
      systemIds: input.affectedSystemIds,
      requestedAt,
      dueAt,
      initialStatus: 'identity-review',
      systems: draft.systems,
    }),
    evidence: [],
    deliveryPackages: [],
    conflicts: [],
    resultSummary: '',
    closureReason: '',
    audit: [],
  }
  if (identityInsufficient) {
    request.conflicts.push('身份材料不足：需要补充可核验的身份或授权关系证明。')
    const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
    if (identityTask) {
      identityTask.status = 'blocked'
      identityTask.exceptionReason = '身份材料不足，等待复核。'
    }
  }
  if (duplicate) {
    request.conflicts.push(`疑似重复请求：与 ${duplicate.code} 的数据主体和请求类型相同。`)
  }
  draft.requests.unshift(request)
  appendAudit(
    draft,
    request,
    '登记隐私请求并冻结受理快照',
    operator,
    `按 ${responseDays[input.region]} 日模板登记，涉及 ${input.affectedSystemIds.length} 个系统；受理时冻结代理关系「${snapshot.representativeName}」与查看范围（快照 ${snapshot.id}），任务只按该快照产出证据。`,
  )
  draft.revision += 1
  return draft
}

export function saveRequest(
  state: WorkspaceState,
  requestId: string,
  patch: Partial<PrivacyRequest>,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      // 受理快照、代理关系、证据和处理包只能通过处置链操作变更，禁止在编辑中覆盖
      const {
        intakeSnapshot: _snapshot,
        representativeId: _representativeId,
        evidence: _evidence,
        deliveryPackages: _packages,
        ...safePatch
      } = patch
      Object.assign(request, safePatch)
    },
    { action: '更新请求信息', operator, detail: '更新申请人、地区、请求类型或涉及系统（受理快照不可改写）。' },
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  requestId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.identity.status = status
      request.identity.note = note
      request.identity.reviewedAt = now()
      const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
      if (status === 'verified') {
        if (identityTask) {
          identityTask.status = 'completed'
          identityTask.completedAt = now()
          identityTask.exceptionReason = ''
        }
        request.conflicts = request.conflicts.filter(
          (conflict) => !conflict.startsWith('身份材料不足'),
        )
        const nextTask = request.tasks.find((task) => task.status === 'pending')
        if (nextTask) nextTask.status = 'active'
        request.status = request.conflicts.length ? 'review-required' : 'processing'
      } else {
        if (identityTask) {
          identityTask.status = 'blocked'
          identityTask.exceptionReason = note
        }
        request.status = 'review-required'
        if (!request.conflicts.some((conflict) => conflict.startsWith('身份材料不足'))) {
          request.conflicts.push(`身份材料不足：${note}`)
        }
      }
    },
    {
      action: status === 'verified' ? '身份核验通过' : '身份材料退回',
      operator,
      detail: note,
    },
  )
}

export function assignTask(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  assignee: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      task.assignee = assignee
    },
    { action: '分派履约任务', operator, detail: `任务 ${taskId} 分派给 ${assignee}。` },
  )
}

export function taskAction(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
  baseRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      if (request.identity.status !== 'verified') {
        throw new ChainError('身份未核验通过，不能推进履约任务')
      }
      assertTaskBasis(draft, request, baseRevision)
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (task.status === 'completed' && action === 'complete') {
        throw new ChainError('任务已完成，重复提交不会覆盖已生成的结果。')
      }
      if (action === 'start') {
        task.status = 'active'
        task.exceptionReason = ''
      } else if (action === 'complete') {
        task.status = 'completed'
        task.completedAt = now()
        task.exceptionReason = ''
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
      } else if (action !== 'block') {
        request.status = 'processing'
      }
    },
    {
      action:
        action === 'start' ? '开始履约任务' : action === 'complete' ? '完成履约任务' : '阻断履约任务',
      operator,
      detail: note || `${taskId} 状态更新为 ${action}。`,
    },
  )
}

export function addEvidence(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
): WorkspaceState {
  // 单条证据同样走批次账本，保证重试不重复生成
  return produceEvidenceBatch(state, requestId, [{ taskId, name, evidenceType }], operator)
}

export function addConflict(
  state: WorkspaceState,
  requestId: string,
  conflict: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.conflicts.push(conflict)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
  )
}

export function resolveConflict(
  state: WorkspaceState,
  requestId: string,
  conflictIndex: number,
  resolution: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      if (!request.conflicts.length && request.identity.status === 'verified') {
        request.status = request.status === 'recalculating' ? 'recalculating' : 'processing'
      } else {
        request.status = 'review-required'
      }
    },
    { action: '复核处理冲突', operator, detail: resolution },
  )
}

export function extendRequest(
  state: WorkspaceState,
  requestId: string,
  days: number,
  reason: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const base = new Date(request.dueAt) > new Date() ? new Date(request.dueAt) : new Date()
      request.dueAt = addDays(base, days).toISOString()
      request.extendedDays += days
      request.status = 'extended'
    },
    { action: '延期请求处理', operator, detail: `延期 ${days} 天：${reason}` },
  )
}

export function closeRequest(
  state: WorkspaceState,
  requestId: string,
  resultSummary: string,
  closureReason: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new ChainError('请求不存在')

  // 关闭即生成处理包：先执行全部前置校验，再按受理快照出包，一次原子提交
  if (!request.intakeSnapshot) {
    throw new ChainError('受理快照缺失（代理关系待确认），补全前不能关闭并生成处理包。')
  }
  if (request.identity.status !== 'verified') {
    throw new ChainError('身份核验尚未通过，不能关闭请求')
  }
  if (request.intakeSnapshot.invalidatedReason) {
    throw new ChainError('代理受理快照已失效，未交付材料需要重算后才能关闭。')
  }
  if (request.evidence.some((evidence) => evidence.voidedAt)) {
    throw new ChainError('存在失效待重算的未交付材料，请按最新代理关系重算后再关闭。')
  }
  const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
  if (requiredTasks.some((task) => task.status !== 'completed')) {
    throw new ChainError('仍有未完成任务，不能关闭请求')
  }
  if (request.conflicts.length) {
    throw new ChainError('仍有未解决冲突，不能关闭请求')
  }
  if (new Date(request.dueAt) > new Date() && !closureReason.trim()) {
    throw new ChainError('截止时间前关闭必须填写提前关闭理由')
  }

  request.resultSummary = resultSummary
  request.closureReason = closureReason

  // 按受理快照生成处理包（内部自带校验并写入审计）
  const withPackage = preparePackage(draft, requestId, operator)
  const target = withPackage.requests.find((item) => item.id === requestId)!
  target.status = 'completed'
  const closeTask = target.tasks.find((task) => task.id.endsWith('-close'))
  if (closeTask) {
    closeTask.status = 'completed'
    closeTask.completedAt = now()
  }
  appendAudit(
    withPackage,
    target,
    '完成并关闭请求',
    operator,
    closureReason
      ? `提前关闭理由：${closureReason}；处理包已随关闭生成。`
      : '期限届满后完成关闭，处理包已随关闭生成。',
  )
  withPackage.revision += 1
  return withPackage
}

export function addComment(
  state: WorkspaceState,
  requestId: string,
  content: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  draft.comments.unshift({
    id: id('comment'),
    requestId,
    author: operator,
    content,
    createdAt: now(),
  })
  appendAudit(draft, request, '提交处理意见', operator, content)
  draft.revision += 1
  return draft
}

export function recordExport(
  state: WorkspaceState,
  scope: string,
  count: number,
  operator: string,
): WorkspaceState {
  // 旧数据缺少代理关系时一律拒绝导出
  assertExportable(state)
  const draft = cloneState(state)
  draft.audit.unshift({
    id: id('audit'),
    action: '导出处理包',
    operator,
    detail: `导出范围：${scope}，包含 ${count} 条请求；全部请求均已冻结受理代理关系快照。`,
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}
