import type {
  AgencyChain,
  AgencyChangeReason,
  AgencyHistoryEntry,
  DeliveryPackage,
  PrivacyRequest,
  ScopeSnapshot,
  TaskBatch,
  WorkflowStep,
  WorkspaceState,
} from '@/types/domain'

export const now = () => new Date().toISOString()
export const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function materialDigest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `PD-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export function packageDigest(parts: string[]): string {
  let hash = 5381
  const joined = parts.join('|')
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 33) ^ joined.charCodeAt(index)
  }
  return `PKG-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export interface InitialAgencyInput {
  representation: 'self' | 'agent'
  subjectName: string
  agentName: string
  agentContact: string
  materialType: AgencyChain['materialType']
  materialReference: string
  scopeSystemIds: string[]
  validUntil?: string
  note: string
}

export function buildInitialAgency(input: InitialAgencyInput, frozenAt = now()): AgencyChain {
  const hasAgent = input.representation === 'agent'
  const agentName = hasAgent ? input.agentName.trim() : input.subjectName
  const agentContact = hasAgent ? input.agentContact.trim() : ''
  const complete =
    !hasAgent || (agentName.length >= 2 && agentContact.trim().length >= 4)
  const scope: ScopeSnapshot = {
    basisVersion: 1,
    systemIds: input.scopeSystemIds,
    requestTypes: [],
    frozenAt,
    note: input.note,
  }
  const entry: AgencyHistoryEntry = {
    basisVersion: 1,
    reason: 'initial',
    status: complete ? 'confirmed' : 'pending-confirmation',
    agentName,
    agentContact,
    scope,
    validFrom: frozenAt,
    validUntil: input.validUntil || undefined,
    changedAt: frozenAt,
    operator: '客服专员',
    note: input.note,
  }
  return {
    kind: hasAgent ? 'agent' : 'self',
    status: complete ? 'confirmed' : 'pending-confirmation',
    subjectName: input.subjectName,
    agentName,
    agentContact,
    materialType: input.materialType,
    maskedReference: input.materialReference,
    protectedDigest: materialDigest(input.materialReference || input.subjectName),
    currentBasisVersion: 1,
    scope,
    history: [entry],
    legacyBackfill: false,
  }
}

/** 旧数据缺少代理关系：受理时回填为“待确认”，补全前禁止导出/产出。 */
export function buildLegacyBackfillAgency(request: PrivacyRequest): AgencyChain {
  const frozenAt = request.requestedAt
  const scope: ScopeSnapshot = {
    basisVersion: 1,
    systemIds: [...request.affectedSystemIds],
    requestTypes: [request.type],
    frozenAt,
    note: '旧数据迁移：受理快照待人工补全确认。',
  }
  const entry: AgencyHistoryEntry = {
    basisVersion: 1,
    reason: 'backfill',
    status: 'pending-confirmation',
    agentName: request.requesterName,
    agentContact: request.requesterContact,
    scope,
    validFrom: frozenAt,
    changedAt: now(),
    operator: '系统迁移',
    note: '历史请求缺少代理关系记录，先回填待确认。',
  }
  return {
    kind: 'self',
    status: 'pending-confirmation',
    subjectName: request.requesterName,
    agentName: request.requesterName,
    agentContact: request.requesterContact,
    materialType: request.identity.materialType,
    maskedReference: request.identity.maskedReference,
    protectedDigest: request.identity.protectedDigest,
    currentBasisVersion: 1,
    scope,
    history: [entry],
    legacyBackfill: true,
  }
}

export function ensureAgency(request: PrivacyRequest): AgencyChain {
  if (!request.agency) {
    request.agency = buildLegacyBackfillAgency(request)
  }
  return request.agency
}

export function effectiveScopeSystemIds(request: PrivacyRequest): string[] {
  const scope = request.agency?.scope.systemIds ?? []
  return scope.length ? scope : request.affectedSystemIds
}

export function isAgencyUsable(agency: AgencyChain | undefined): boolean {
  return agency?.status === 'confirmed'
}

export function agencyBlockReason(request: PrivacyRequest): string | null {
  if (!request.agency) return '缺少代理关系记录（旧数据待回填）'
  switch (request.agency.status) {
    case 'pending-confirmation':
      return '代理关系待确认：补全授权前不能产出证据或导出处理包'
    case 'withdrawn':
      return '被代理人已撤回授权：未交付材料失效，需登记新的有效授权后重算'
    case 'expired':
      return '代理授权已到期：未交付材料失效，需续期或换人后重算'
    case 'replaced':
      return '代理人已更换：需确认新代理授权后按新快照重算'
    default:
      return null
  }
}

export function assertAgencyReady(request: PrivacyRequest): AgencyChain {
  const agency = ensureAgency(request)
  const reason = agencyBlockReason(request)
  if (reason) throw new Error(reason)
  return agency
}

export function deliveredEvidenceIds(request: PrivacyRequest): Set<string> {
  return new Set(request.packages.flatMap((pkg) => pkg.evidenceIds))
}

/**
 * 授权变更（撤回/到期/换人/范围调整）：
 * 冻结出新的受理快照依据（basis version +1）。
 * - 未交付材料立即失效，相关任务按新快照重算；
 * - 已发出的处理包保留当时依据，进入复核，不覆盖已生成结果。
 */
export function applyAgencyChange(params: {
  request: PrivacyRequest
  reason: Exclude<AgencyChangeReason, 'backfill' | 'initial'>
  newAgentName?: string
  newAgentContact?: string
  scopeSystemIds?: string[]
  validUntil?: string
  note?: string
  operator: string
  changedAt?: string
}): { newVersion: number; invalidatedEvidence: string[]; resetTasks: string[]; reviewedPackages: string[] } {
  const { request } = params
  const agency = assertChangeable(request)
  assertScopeAdjustmentAllowed(params.reason, agency)
  const changedAt = params.changedAt ?? now()
  const previousVersion = agency.currentBasisVersion

  let nextStatus = agency.status
  let nextKind = agency.kind
  let agentName = agency.agentName
  let agentContact = agency.agentContact
  let nextValidUntil = params.validUntil || agency.history[0]?.validUntil
  if (params.reason === 'withdrawal') nextStatus = 'withdrawn'
  else if (params.reason === 'expiry') nextStatus = 'expired'
  else if (params.reason === 'replacement') {
    agentName = params.newAgentName?.trim() || agentName
    agentContact = params.newAgentContact?.trim() || agentContact
    // 换人时新代理要素齐全则新依据立即生效、可直接重算；否则停在待确认。
    nextStatus = agentName.trim().length >= 2 && agentContact.trim().length >= 4
      ? 'confirmed'
      : 'replaced'
  } else if (params.reason === 'scope-adjustment') {
    nextStatus = 'confirmed'
  }
  if (params.reason === 'replacement' && agentName.trim().length < 2) {
    throw new Error('更换代理人必须填写新代理人姓名')
  }

  const newVersion = previousVersion + 1
  const scope: ScopeSnapshot = {
    basisVersion: newVersion,
    systemIds: params.scopeSystemIds && params.scopeSystemIds.length
      ? [...params.scopeSystemIds]
      : effectiveScopeSystemIds(request),
    requestTypes: [request.type],
    frozenAt: changedAt,
    note: params.note ?? '',
  }
  const entry: AgencyHistoryEntry = {
    basisVersion: newVersion,
    reason: params.reason,
    status: nextStatus,
    agentName,
    agentContact,
    scope,
    validFrom: changedAt,
    validUntil: nextValidUntil || undefined,
    changedAt,
    operator: params.operator,
    note: params.note ?? '',
  }
  agency.kind = nextKind
  agency.status = nextStatus
  agency.agentName = agentName
  agency.agentContact = agentContact
  agency.currentBasisVersion = newVersion
  agency.scope = scope
  agency.history.unshift(entry)

  const delivered = deliveredEvidenceIds(request)
  const reviewedPackages: string[] = []
  for (const pkg of request.packages) {
    if (pkg.status === 'retained' || pkg.status === 'review-confirmed') {
      pkg.status = 'under-review'
      pkg.reviewReason = `授权依据 v${previousVersion} 发生变更（${params.reason}），保留原包并转入复核`
      reviewedPackages.push(pkg.id)
    }
  }

  const invalidatedEvidence: string[] = []
  for (const evidence of request.evidence) {
    if (delivered.has(evidence.id)) {
      evidence.validity = 'retained'
    } else if (evidence.basisVersion < newVersion) {
      evidence.validity = 'invalidated'
      evidence.invalidReason = `授权依据 v${evidence.basisVersion} 已被 v${newVersion} 取代（${params.reason}），未交付材料失效重算`
      invalidatedEvidence.push(evidence.id)
    }
  }

  const resetTasks: string[] = []
  for (const task of request.tasks) {
    if (task.id.endsWith('-identity')) continue
    if (task.status === 'completed' && (task.basisVersion ?? 1) < newVersion) {
      task.status = 'pending'
      task.completedAt = undefined
      task.exceptionReason = `依据 v${task.basisVersion ?? 1} 失效，按 v${newVersion} 快照重算`
      task.basisVersion = undefined
      resetTasks.push(task.id)
    } else if (task.status === 'active') {
      task.status = 'pending'
      task.exceptionReason = `授权依据变更（${params.reason}），暂停并等待按新快照重开`
    }
  }

  if (invalidatedEvidence.length || resetTasks.length || params.reason !== 'scope-adjustment') {
    request.status = reviewedPackages.length ? 'review-required' : 'rebuilding'
    request.conflicts.push(
      `代理授权变更：${reasonLabel(params.reason)}，依据 v${previousVersion} → v${newVersion}。` +
        (reviewedPackages.length
          ? `已发出处理包 ${reviewedPackages.join('、')} 保留原依据并进入复核。`
          : `未交付证据 ${invalidatedEvidence.length} 份失效，${resetTasks.length} 个任务按新快照重算。`),
    )
  }

  return { newVersion, invalidatedEvidence, resetTasks, reviewedPackages }
}

function assertChangeable(request: PrivacyRequest): AgencyChain {
  const agency = ensureAgency(request)
  if (agency.status === 'pending-confirmation') {
    throw new Error('代理关系尚待确认，请先回填并确认授权，再登记变更')
  }
  return agency
}

export function assertScopeAdjustmentAllowed(reason: string, agency: AgencyChain) {
  if (
    reason === 'scope-adjustment' &&
    agency.status !== 'confirmed'
  ) {
    throw new Error(
      '撤回、到期或换人状态下不能仅调整查看范围：请先登记新的有效授权（换人/回填）后再按新快照执行',
    )
  }
}

export function reasonLabel(reason: AgencyChangeReason): string {
  const labels: Record<AgencyChangeReason, string> = {
    withdrawal: '被代理人撤回授权',
    expiry: '授权到期',
    replacement: '更换代理人',
    'scope-adjustment': '查看范围调整',
    backfill: '旧数据回填',
    initial: '受理冻结',
  }
  return labels[reason]
}

export function assertTaskAllowedForBasis(request: PrivacyRequest, task: WorkflowStep): AgencyChain {
  const agency = assertAgencyReady(request)
  if (task.systemId && !effectiveScopeSystemIds(request).includes(task.systemId)) {
    throw new Error(`任务系统 ${task.systemId} 不在受理冻结的查看范围内，禁止产出证据`)
  }
  return agency
}

export function stampTaskBasis(task: WorkflowStep, agency: AgencyChain, completedAt = now()) {
  task.status = 'completed'
  task.completedAt = completedAt
  task.exceptionReason = ''
  task.basisVersion = agency.currentBasisVersion
}

/** 关闭前：所有非关闭任务必须按当前依据完成；证据必须处于当前有效状态。 */
export function closureBasisCheck(request: PrivacyRequest): string[] {
  const problems: string[] = []
  const agency = request.agency
  if (!agency) {
    problems.push('缺少代理关系，需先回填待确认并补全')
    return problems
  }
  if (agency.status !== 'confirmed') problems.push(`代理关系状态为 ${agency.status}，不能关闭`)
  const current = agency.currentBasisVersion
  for (const task of request.tasks) {
    if (task.id.endsWith('-close')) continue
    if (task.status === 'completed' && (task.basisVersion ?? 1) !== current) {
      problems.push(`任务「${task.name}」依据版本过期，需按 v${current} 重算`)
    }
  }
  for (const evidence of request.evidence) {
    if (evidence.validity === 'invalidated') {
      problems.push(`证据「${evidence.name}」已随旧依据失效`)
    }
  }
  return problems
}

export function buildDeliveryPackage(
  request: PrivacyRequest,
  deliveredTo: string,
  at = now(),
): DeliveryPackage {
  const agency = assertAgencyReady(request)
  const current = agency.currentBasisVersion
  const evidenceIds = request.evidence
    .filter(
      (evidence) => evidence.validity === 'current' && evidence.basisVersion === current,
    )
    .map((evidence) => evidence.id)
  return {
    id: id('pkg'),
    requestCode: request.code,
    basisVersion: current,
    status: 'retained',
    evidenceIds,
    scopeSystemIds: effectiveScopeSystemIds(request),
    digest: packageDigest([request.code, String(current), ...evidenceIds]),
    deliveredAt: at,
    deliveredTo,
  }
}

export function findBatch(
  request: PrivacyRequest,
  idempotencyKey: string,
): TaskBatch | undefined {
  return request.taskBatches.find((batch) => batch.idempotencyKey === idempotencyKey)
}

/** 旧数据缺少代理关系的请求不允许导出。 */
export function exportBlockedRequests(state: WorkspaceState, requestIds?: string[]): PrivacyRequest[] {
  const targets = requestIds
    ? state.requests.filter((request) => requestIds.includes(request.id))
    : state.requests
  return targets.filter((request) => {
    if (!request.agency) return true
    if (request.agency.status === 'pending-confirmation') return true
    if (request.agency.legacyBackfill) return true
    return false
  })
}
