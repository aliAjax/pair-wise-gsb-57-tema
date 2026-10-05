import type {
  PrivacyRequest,
  Representative,
  WorkspaceState,
} from '@/types/domain'
import {
  appendRepHistory,
  assertActiveBasis,
  assertScope,
  buildRepresentative,
  ChainError,
  findRepresentative,
  freezeSnapshot,
  getSelfRepresentative,
  id,
  invalidateRequestBasis,
  now,
  type RepresentativeDraft,
} from './chain'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)

function appendAudit(
  state: WorkspaceState,
  request: PrivacyRequest | undefined,
  action: string,
  operator: string,
  detail: string,
) {
  const createdAt = now()
  state.audit.unshift({ id: id('audit'), requestId: request?.id, action, operator, detail, createdAt })
  request?.audit.unshift({
    id: id('audit'),
    action,
    operator,
    detail,
    createdAt,
  })
}

function assertRevision(state: WorkspaceState, baseRevision: number | undefined) {
  if (typeof baseRevision === 'number' && baseRevision !== state.revision) {
    // 两个窗口同时操作：后到动作必须在最新代理关系上判断，不能直接覆盖已生成结果
    throw new ChainError(
      `工作区已被另一个窗口更新（当前版本 ${state.revision}，您基于版本 ${baseRevision}），请刷新后按最新代理关系重试，已有结果不会被覆盖。`,
    )
  }
}

export interface RegisterRepInput extends RepresentativeDraft {}

export function registerRepresentative(
  state: WorkspaceState,
  input: RegisterRepInput,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  input.scopeSystemIds.forEach((systemId) => {
    if (!draft.systems.some((system) => system.id === systemId)) {
      throw new ChainError(`查看范围中的系统不存在：${systemId}`)
    }
  })
  const representative = buildRepresentative(input)
  draft.representatives.unshift(representative)
  appendAudit(
    draft,
    undefined,
    '登记代理授权',
    operator,
    `${input.kind === 'lawyer' ? '代理律师' : '代理人'} ${input.name}（${input.credentialRef}）登记，授权 ${input.scopeSystemIds.length} 个系统的查看范围，有效期 ${input.validDays} 天。`,
  )
  draft.revision += 1
  return draft
}

export function verifyRepresentative(
  state: WorkspaceState,
  representativeId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const representative = findRepresentative(draft, representativeId)
  if (!representative) throw new ChainError('代理关系不存在')
  representative.verification.status = status
  representative.verification.note = note
  representative.verification.verifiedAt = status === 'verified' ? now() : undefined
  appendAudit(
    draft,
    undefined,
    status === 'verified' ? '代理授权核验通过' : '代理授权材料不足',
    operator,
    `${representative.name}：${note}`,
  )
  draft.revision += 1
  return draft
}

export function changeRepresentation(
  state: WorkspaceState,
  representativeId: string,
  action: 'revoke' | 'expire' | 'replace',
  reason: string,
  successorDraft: RepresentativeDraft | undefined,
  baseRevision: number | undefined,
  operator: string,
): WorkspaceState {
  assertRevision(state, baseRevision)
  const draft = cloneState(state)
  const representative = findRepresentative(draft, representativeId)
  if (!representative) throw new ChainError('代理关系不存在')
  if (representative.kind === 'self') {
    throw new ChainError('数据主体本人关系不能撤回、到期或换人；被代理人应登记新的代理关系。')
  }
  assertActiveBasis(representative)

  const at = now()
  const actionText =
    action === 'revoke' ? '撤回代理授权' : action === 'expire' ? '代理授权到期' : '更换代理人'
  let successor: Representative | null = null
  if (action === 'replace') {
    if (!successorDraft) throw new ChainError('换人时必须登记新的代理关系。')
    successor = buildRepresentative(successorDraft, at)
    // 换人由隐私负责人凭新授权委托办理，视为当场核验通过，便于按新快照立即重算
    successor.verification = {
      status: 'verified',
      note: `随换人流程核验：${reason}`,
      verifiedAt: at,
    }
    draft.representatives.unshift(successor)
  }

  const nextStatus =
    action === 'revoke' ? 'revoked' : action === 'expire' ? 'expired' : 'superseded'
  appendRepHistory(representative, nextStatus, operator, reason, at)
  representative.status = nextStatus
  representative.revokedAt = action === 'revoke' ? at : representative.revokedAt
  if (successor) representative.supersededById = successor.id

  // 级联到所有仍按该代理关系推进的请求
  const affected = draft.requests.filter(
    (request) =>
      request.representativeId === representativeId ||
      request.intakeSnapshot?.representativeId === representativeId,
  )
  let voided = 0
  let reviewed = 0
  let reopened = 0
  affected.forEach((request) => {
    const successorSnapshot = successor ? freezeSnapshot(successor, at) : null
    const result = invalidateRequestBasis(request, reason, successorSnapshot, at)
    voided += result.voidedEvidence
    reviewed += result.reviewedPackages
    if (result.reopened) reopened += 1
    appendAudit(
      draft,
      request,
      actionText,
      operator,
      `${reason}｜未交付材料失效 ${result.voidedEvidence} 项，待交付包作废 ${result.voidedPackages} 个，已发出包进入复核 ${result.reviewedPackages} 个。`,
    )
  })

  if (successor) {
    appendAudit(
      draft,
      undefined,
      '登记新代理关系（换人）',
      operator,
      `新代理人 ${successor.name}（${successor.credentialRef}）承接 ${affected.length} 个在途请求，已按新关系冻结受理快照。`,
    )
  }
  appendAudit(
    draft,
    undefined,
    actionText,
    operator,
    `${representative.name} 的代理关系${action === 'replace' ? '已被替换' : action === 'revoke' ? '已撤回' : '已到期'}：影响 ${affected.length} 个请求，未交付材料失效 ${voided} 项，已发出处理包复核 ${reviewed} 个，重算请求 ${reopened} 个。`,
  )
  draft.revision += 1
  return draft
}

// 旧数据缺少代理关系：回填为本人或已核验代理，并冻结受理快照；补全前不能导出
export function backfillIntake(
  state: WorkspaceState,
  requestId: string,
  representativeId: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new ChainError('请求不存在')
  if (request.intakeSnapshot) throw new ChainError('该请求已有受理快照，无需回填。')

  let representative: Representative
  if (representativeId === 'self') {
    representative = getSelfRepresentative(
      draft,
      request.dataSubjectName,
      request.dataSubjectContact,
    )
  } else {
    representative = findRepresentative(draft, representativeId) ?? (() => {
      throw new ChainError('代理关系不存在，请先登记并核验代理授权。')
    })()
    assertScope(representative, request.affectedSystemIds, request.type)
    if (representative.verification.status !== 'verified') {
      throw new ChainError('代理授权尚未核验通过，不能冻结受理快照。')
    }
  }

  request.representativeId = representative.kind === 'self' ? null : representative.id
  request.intakeSnapshot = freezeSnapshot(representative)
  request.conflicts = request.conflicts.filter(
    (conflict) => !conflict.startsWith('旧数据缺少代理关系'),
  )
  if (!['completed', 'rejected'].includes(request.status) && request.status === 'review-required') {
    request.status =
      request.identity.status === 'verified' && request.conflicts.length === 0
        ? 'processing'
        : 'review-required'
  }
  appendAudit(
    draft,
    request,
    '回填代理关系与受理快照',
    operator,
    `旧数据补全：按 ${representative.name} 冻结代理关系与查看范围（${representative.scopeSystemIds.length} 个系统），补全后恢复证据产出与导出。`,
  )
  draft.revision += 1
  return draft
}
