import type {
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  WorkspaceState,
} from '@/types/domain'
import { addDays, buildWorkflowSteps, responseDays } from './workflow'
import {
  assertAgencyReady,
  assertTaskAllowedForBasis,
  buildDeliveryPackage,
  buildInitialAgency,
  closureBasisCheck,
  deliveredEvidenceIds,
  ensureAgency,
  id,
  materialDigest,
  now,
  stampTaskBasis,
} from './agencyChain'

export const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)

export function appendAudit(
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

export interface MutationOptions {
  expectedRevision?: number
}

function mutateRequest(
  state: WorkspaceState,
  requestId: string,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => void,
  audit: { action: string; operator: string; detail: string },
  options: MutationOptions = {},
): WorkspaceState {
  assertRevision(state, options.expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  appendAudit(draft, request, audit.action, audit.operator, audit.detail)
  draft.revision += 1
  return draft
}

export function assertRevision(state: WorkspaceState, expected?: number): void {
  if (expected !== undefined && expected !== state.revision) {
    throw new Error(
      `工作区版本已变化（当前 v${state.revision}，提交基于 v${expected}）：后到动作按最新代理关系重新判断，本次提交未覆盖已有结果`,
    )
  }
}

export interface CreateRequestInput {
  requesterName: string
  requesterContact: string
  region: keyof typeof responseDays
  type: RequestType
  affectedSystemIds: string[]
  identityMaterialType: IdentityCheck['materialType']
  identityReference: string
  note: string
  representation: 'self' | 'agent'
  agentName: string
  agentContact: string
  scopeSystemIds: string[]
  authorizationExpiresAt: string
  authorizationNote: string
}

export function createRequest(
  state: WorkspaceState,
  input: CreateRequestInput,
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  assertRevision(state, options.expectedRevision)
  const draft = cloneState(state)
  const requestedAt = now()
  const dueAt = addDays(new Date(requestedAt), responseDays[input.region]).toISOString()
  const duplicate = draft.requests.find(
    (request) =>
      request.requesterContact === input.requesterContact &&
      request.type === input.type &&
      !['completed', 'rejected'].includes(request.status),
  )
  const identityInsufficient =
    input.identityMaterialType === 'none' || input.identityReference.trim().length < 6
  const hasAgent = input.representation === 'agent'
  const scopeSystemIds = input.scopeSystemIds.length ? input.scopeSystemIds : input.affectedSystemIds
  const agencyIncomplete =
    hasAgent && (input.agentName.trim().length < 2 || input.agentContact.trim().length < 4)
  const status: RequestStatus =
    identityInsufficient || duplicate || agencyIncomplete ? 'review-required' : 'identity-review'
  const nextNumber =
    Math.max(
      0,
      ...draft.requests.map((request) => Number(request.code.split('-').at(-1)) || 0),
    ) + 1
  const requestId = id('request')
  const request: PrivacyRequest = {
    id: requestId,
    code: `DSR-2026-${String(nextNumber).padStart(3, '0')}`,
    requesterName: input.requesterName.trim(),
    requesterContact: input.requesterContact.trim(),
    region: input.region,
    type: input.type,
    status,
    identity: {
      status: identityInsufficient ? 'insufficient' : 'pending',
      materialType: input.identityMaterialType,
      maskedReference: input.identityReference.trim(),
      protectedDigest: materialDigest(input.identityReference),
      note: input.note.trim(),
    },
    agency: buildInitialAgency(
      {
        representation: input.representation,
        subjectName: input.requesterName.trim(),
        agentName: input.agentName,
        agentContact: input.agentContact,
        materialType: input.identityMaterialType,
        materialReference: input.identityReference.trim(),
        scopeSystemIds,
        validUntil: input.authorizationExpiresAt || undefined,
        note:
          input.authorizationNote ||
          `受理时冻结代理关系与查看范围：${scopeSystemIds.length} 个系统。`,
      },
      requestedAt,
    ),
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
    packages: [],
    taskBatches: [],
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
  if (agencyIncomplete) {
    request.conflicts.push(
      '代理关系待确认：代理人姓名或联系方式缺失，补全授权前系统任务不得产出证据、不能导出。',
    )
    const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
    if (identityTask && identityTask.status !== 'blocked') {
      identityTask.status = 'blocked'
      identityTask.exceptionReason = '代理授权要素不全，受理快照待确认。'
    }
  }
  if (duplicate) {
    request.conflicts.push(`疑似重复请求：与 ${duplicate.code} 的请求人和请求类型相同。`)
  }
  draft.requests.unshift(request)
  appendAudit(
    draft,
    request,
    '登记隐私请求并冻结代理快照',
    operator,
    `按 ${responseDays[input.region]} 日模板登记；受理时冻结 ${hasAgent ? '代理' : '本人'}关系与查看范围（依据 v1，${scopeSystemIds.length} 个系统），后续任务仅按此快照产出证据。`,
  )
  draft.revision += 1
  return draft
}

export function saveRequest(
  state: WorkspaceState,
  requestId: string,
  patch: Partial<PrivacyRequest>,
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      Object.assign(request, patch)
      request.audit = request.audit
    },
    { action: '更新请求信息', operator, detail: '更新申请人、地区、请求类型或涉及系统。' },
    options,
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  requestId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
  options: MutationOptions = {},
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
        const agency = ensureAgency(request)
        if (agency.status !== 'confirmed') {
          request.status = 'review-required'
          if (!request.conflicts.some((item) => item.startsWith('代理关系待确认'))) {
            request.conflicts.push(
              agency.legacyBackfill
                ? '旧数据缺少代理关系：已回填待确认，补全前不能推进任务或导出。'
                : '代理关系待确认：身份已核验，但授权快照需补全确认。',
            )
          }
          if (identityTask) {
            identityTask.exceptionReason = '身份已通过，但代理授权关系待确认。'
          }
        } else {
          const nextTask = request.tasks.find((task) => task.status === 'pending')
          if (nextTask) nextTask.status = 'active'
          request.status = request.conflicts.length ? 'review-required' : 'processing'
        }
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
    options,
  )
}

export function assignTask(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  assignee: string,
  operator: string,
  options: MutationOptions = {},
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
    options,
  )
}

export function taskAction(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
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
    },
    {
      action:
        action === 'start' ? '开始履约任务' : action === 'complete' ? '完成履约任务' : '阻断履约任务',
      operator,
      detail:
        (note || `${taskId} 状态更新为 ${action}。`) +
        (action === 'complete' ? '（按当前受理快照依据产出）' : ''),
    },
    options,
  )
}

export function addEvidence(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      const agency = assertTaskAllowedForBasis(request, task)
      request.evidence.push({
        id: id('evidence'),
        stepId: taskId,
        systemId: task.systemId,
        name,
        evidenceType,
        digest: materialDigest(`${name}-${now()}`),
        uploadedBy: operator,
        uploadedAt: now(),
        protected: true,
        basisVersion: agency.currentBasisVersion,
        validity: 'current',
      })
    },
    {
      action: '上传执行证据',
      operator,
      detail: `${name} 已按受保护附件登记并绑定当前受理快照依据，保存摘要而非明文材料。`,
    },
    options,
  )
}

export function addConflict(
  state: WorkspaceState,
  requestId: string,
  conflict: string,
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.conflicts.push(conflict)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
    options,
  )
}

export function resolveConflict(
  state: WorkspaceState,
  requestId: string,
  conflictIndex: number,
  resolution: string,
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      if (!request.conflicts.length && request.identity.status === 'verified') {
        const agency = ensureAgency(request)
        request.status =
          agency.status === 'confirmed' && request.status !== 'rebuilding'
            ? 'processing'
            : 'review-required'
      } else {
        request.status = 'review-required'
      }
    },
    { action: '复核处理冲突', operator, detail: resolution },
    options,
  )
}

export function extendRequest(
  state: WorkspaceState,
  requestId: string,
  days: number,
  reason: string,
  operator: string,
  options: MutationOptions = {},
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
    options,
  )
}

export function closeRequest(
  state: WorkspaceState,
  requestId: string,
  resultSummary: string,
  closureReason: string,
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份核验尚未通过，不能关闭请求')
      }
      const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
      if (requiredTasks.some((task) => task.status !== 'completed')) {
        throw new Error('仍有未完成任务，不能关闭请求')
      }
      if (request.conflicts.length) {
        throw new Error('仍有未解决冲突，不能关闭请求')
      }
      const basisProblems = closureBasisCheck(request)
      if (basisProblems.length) {
        throw new Error(`受理快照依据校验未通过：${basisProblems.join('；')}`)
      }
      if (new Date(request.dueAt) > new Date() && !closureReason.trim()) {
        throw new Error('截止时间前关闭必须填写提前关闭理由')
      }
      const agency = assertAgencyReady(request)
      request.resultSummary = resultSummary
      request.closureReason = closureReason
      request.status = 'completed'
      const closeTask = request.tasks.find((task) => task.id.endsWith('-close'))
      if (closeTask) {
        stampTaskBasis(closeTask, agency)
      }
      const delivered = deliveredEvidenceIds(request)
      for (const evidence of request.evidence) {
        if (!delivered.has(evidence.id) && evidence.validity === 'current') {
          evidence.validity = 'retained'
        }
      }
      const pkg = buildDeliveryPackage(request, agency.agentName)
      request.packages.push(pkg)
    },
    {
      action: '完成并关闭请求、生成处理包',
      operator,
      detail:
        (closureReason ? `提前关闭理由：${closureReason}。` : '截止时间后完成关闭。') +
        '处理包按当前受理快照依据冻结并交付给受理时记录的代理人/请求人。',
    },
    options,
  )
}

export function addComment(
  state: WorkspaceState,
  requestId: string,
  content: string,
  operator: string,
  options: MutationOptions = {},
): WorkspaceState {
  assertRevision(state, options.expectedRevision)
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
  requestIds?: string[],
): WorkspaceState {
  const draft = cloneState(state)
  draft.audit.unshift({
    id: id('audit'),
    action: '导出处理包',
    operator,
    detail: `导出范围：${scope}，包含 ${count} 条请求。`,
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}

export { assertAgencyReady, ensureAgency }
export { now }
