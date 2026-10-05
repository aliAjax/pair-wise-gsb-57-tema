import type { AgencyChangeReason, WorkspaceState } from '@/types/domain'
import { appendAudit, assertRevision, cloneState, now } from './requestService'
import {
  agencyBlockReason,
  buildInitialAgency,
  effectiveScopeSystemIds,
  ensureAgency,
  reasonLabel,
  applyAgencyChange,
} from './agencyChain'

interface AgencyChangeInput {
  requestId: string
  reason: Exclude<AgencyChangeReason, 'backfill' | 'initial'>
  newAgentName?: string
  newAgentContact?: string
  scopeSystemIds?: string[]
  validUntil?: string
  note?: string
  operator: string
  expectedRevision?: number
}

/**
 * 被代理人撤回、授权到期或换人：
 * 冻结新快照依据，未交付材料立即失效重算，已发出处理包保留原依据进入复核。
 */
export function agencyChange(state: WorkspaceState, input: AgencyChangeInput): WorkspaceState {
  assertRevision(state, input.expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === input.requestId)
  if (!request) throw new Error('请求不存在')
  const beforeVersion = request.agency?.currentBasisVersion ?? 1

  const result = applyAgencyChange({
    request,
    reason: input.reason,
    newAgentName: input.newAgentName,
    newAgentContact: input.newAgentContact,
    scopeSystemIds: input.scopeSystemIds,
    validUntil: input.validUntil,
    note: input.note,
    operator: input.operator,
  })

  appendAudit(
    draft,
    request,
    '代理授权变更',
    input.operator,
    `${reasonLabel(input.reason)}：受理快照依据 v${beforeVersion} → v${result.newVersion}；` +
      `未交付证据失效 ${result.invalidatedEvidence.length} 份、任务重算 ${result.resetTasks.length} 个；` +
      (result.reviewedPackages.length
        ? `已发出处理包 ${result.reviewedPackages.join('、')} 保留当时依据并转入复核，不覆盖已生成结果。`
        : '当前无已发出处理包。'),
  )
  draft.revision += 1
  return draft
}

export interface AgencyBackfillInput {
  requestId: string
  representation: 'self' | 'agent'
  agentName?: string
  agentContact?: string
  scopeSystemIds?: string[]
  validUntil?: string
  note: string
  operator: string
  expectedRevision?: number
}

/** 旧数据回填：补全代理关系并确认受理快照；补全前不能导出。 */
export function agencyBackfill(state: WorkspaceState, input: AgencyBackfillInput): WorkspaceState {
  assertRevision(state, input.expectedRevision)
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === input.requestId)
  if (!request) throw new Error('请求不存在')
  const existing = ensureAgency(request)
  if (existing.status !== 'pending-confirmation') {
    throw new Error('仅待确认的代理关系需要回填，当前请求已具备确认的代理依据')
  }
  if (input.representation === 'agent') {
    if (!input.agentName?.trim() || (input.agentContact ?? '').trim().length < 4) {
      throw new Error('代理回填必须填写代理人姓名和可核验联系方式')
    }
  }
  const scopeSystemIds = input.scopeSystemIds?.length
    ? input.scopeSystemIds
    : effectiveScopeSystemIds(request)

  const rebuilt = buildInitialAgency(
    {
      representation: input.representation,
      subjectName: request.requesterName,
      agentName: input.agentName ?? '',
      agentContact: input.agentContact ?? '',
      materialType: existing.materialType,
      materialReference: existing.maskedReference,
      scopeSystemIds,
      validUntil: input.validUntil || undefined,
      note: input.note,
    },
    request.requestedAt,
  )
  rebuilt.legacyBackfill = false
  rebuilt.history[0].reason = 'backfill'
  rebuilt.history[0].changedAt = now()
  rebuilt.history[0].operator = input.operator
  rebuilt.history[0].note = `旧数据回填确认：${input.note}`
  request.agency = rebuilt

  request.conflicts = request.conflicts.filter(
    (conflict) =>
      !conflict.startsWith('代理关系待确认') &&
      !conflict.startsWith('旧数据缺少代理关系'),
  )
  const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
  if (identityTask && identityTask.status === 'blocked' && request.identity.status !== 'insufficient') {
    identityTask.status = request.identity.status === 'verified' ? 'completed' : 'active'
    identityTask.exceptionReason = ''
    if (request.identity.status === 'verified') identityTask.completedAt = now()
  }
  if (
    !request.conflicts.length &&
    request.identity.status === 'verified' &&
    !['completed', 'pending-close'].includes(request.status)
  ) {
    request.status = 'processing'
  }

  appendAudit(
    draft,
    request,
    '回填并确认代理关系',
    input.operator,
    `历史请求缺少代理关系，已按受理时点回填${input.representation === 'agent' ? `代理人为 ${input.agentName}` : '本人办理'}并确认查看范围（${scopeSystemIds.length} 个系统）；补全后解除导出门禁。`,
  )
  draft.revision += 1
  return draft
}

export interface PackageReviewInput {
  requestId: string
  packageId: string
  resolution: 'confirm' | 'revoke'
  note: string
  operator: string
}

/** 已发出处理包复核：保留当时依据，登记复核结论。 */
export function reviewPackage(
  state: WorkspaceState,
  input: PackageReviewInput,
): WorkspaceState {
  const draft = cloneState(state)
  const request = draft.requests.find((item) => item.id === input.requestId)
  if (!request) throw new Error('请求不存在')
  const pkg = request.packages.find((item) => item.id === input.packageId)
  if (!pkg) throw new Error('处理包不存在')
  if (pkg.status !== 'under-review') throw new Error('仅复核中的处理包可登记结论')
  pkg.status = input.resolution === 'confirm' ? 'review-confirmed' : 'review-revoked'
  pkg.reviewNote = input.note
  pkg.reviewedAt = now()
  pkg.reviewer = input.operator
  if (input.resolution === 'revoke') {
    for (const evidence of request.evidence) {
      if (pkg.evidenceIds.includes(evidence.id)) {
        evidence.validity = 'invalidated'
        evidence.invalidReason = `所属处理包 ${pkg.id} 复核撤销`
      }
    }
    if (!request.conflicts.some((item) => item.includes('处理包复核撤销'))) {
      request.conflicts.push(
        `处理包复核撤销：${pkg.digest}（依据 v${pkg.basisVersion}）已判定不再有效，需告知接收方并评估补救。`,
      )
      request.status = 'review-required'
    }
  }
  appendAudit(
    draft,
    request,
    input.resolution === 'confirm' ? '确认历史处理包' : '撤销历史处理包',
    input.operator,
    `处理包 ${pkg.digest} 保留出具时依据 v${pkg.basisVersion}；复核结论：${input.note}`,
  )
  draft.revision += 1

  return draft
}

export { agencyBlockReason }
