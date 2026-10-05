import type {
  DeliveryPackage,
  EvidenceBatchItem,
  IntakeSnapshot,
  PrivacyRequest,
  Representative,
  RepresentativeKind,
  WorkspaceState,
  WriteBatch,
} from '@/types/domain'
import type { RequestType } from '@/lib/schemas'

export const now = () => new Date().toISOString()
export const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

export function digest(value: string, prefix = 'PD'): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

// 确定性 id：同一批次、同一条目在重试时生成完全相同的证据，绝不重复产出
export function deterministicId(prefix: string, seed: string): string {
  return `${prefix}-${digest(seed, 'ID').slice(3)}`
}

export const SELF_REPRESENTATIVE_PREFIX = 'rep-self'

export class ChainError extends Error {}

export function findRepresentative(
  state: WorkspaceState,
  representativeId: string | null,
): Representative | undefined {
  if (!representativeId) return undefined
  return state.representatives.find((item) => item.id === representativeId)
}

// 代理关系是否仍可作为任务依据：有效状态且未超过授权期限
export function assertActiveBasis(
  representative: Representative | undefined,
  at: string = now(),
): asserts representative is Representative {
  if (!representative) throw new ChainError('代理关系缺失：请先登记或回填代理关系后再继续。')
  if (representative.status === 'revoked') {
    throw new ChainError('代理授权已被数据主体撤回，不能再按原授权产出材料。')
  }
  if (representative.status === 'expired') {
    throw new ChainError('代理授权已到期，不能再按原授权产出材料。')
  }
  if (representative.status === 'superseded') {
    throw new ChainError('代理关系已换人，原授权不能再作为任务依据。')
  }
  if (representative.status === 'pending-confirmation') {
    throw new ChainError('代理关系待确认，补全受理快照前不能导出或产出材料。')
  }
  if (representative.expiresAt && new Date(representative.expiresAt).getTime() <= new Date(at).getTime()) {
    throw new ChainError('代理授权已超过有效期，需要办理续期或换人。')
  }
  if (representative.verification.status !== 'verified') {
    throw new ChainError('代理授权尚未核验通过，不能据此推进任务或导出材料。')
  }
}

export function scopeCovers(
  representative: Representative,
  systemIds: string[],
  type: RequestType,
): boolean {
  const systemCovered = systemIds.every((systemId) =>
    representative.scopeSystemIds.includes(systemId),
  )
  const typeCovered =
    representative.scopeRequestTypes.length === 0 ||
    representative.scopeRequestTypes.includes(type)
  return systemCovered && typeCovered
}

export function assertScope(
  representative: Representative,
  systemIds: string[],
  type: RequestType,
) {
  const missingSystems = systemIds.filter(
    (systemId) => !representative.scopeSystemIds.includes(systemId),
  )
  if (missingSystems.length) {
    throw new ChainError(`查看范围不包含系统：${missingSystems.join('、')}，受理不能超出授权范围。`)
  }
  if (
    representative.scopeRequestTypes.length > 0 &&
    !representative.scopeRequestTypes.includes(type)
  ) {
    throw new ChainError('授权范围不包含本次权利请求类型。')
  }
}

// 受理时冻结代理关系与查看范围：此后任务只按这份快照产出证据
export function freezeSnapshot(
  representative: Representative,
  frozenAt: string = now(),
): IntakeSnapshot {
  return {
    id: deterministicId('snapshot', `${representative.id}-${frozenAt}`),
    representativeId: representative.kind === 'self' ? null : representative.id,
    representativeName: representative.name,
    kind: representative.kind,
    scopeSystemIds: [...representative.scopeSystemIds],
    scopeRequestTypes: [...representative.scopeRequestTypes],
    statusAtIntake: 'active',
    frozenAt,
    expiresAt: representative.expiresAt,
    invalidatedReason: '',
  }
}

export function getSelfRepresentative(
  state: WorkspaceState,
  dataSubjectName: string,
  dataSubjectContact: string,
): Representative {
  const existing = state.representatives.find(
    (item) => item.kind === 'self' && item.contact === dataSubjectContact,
  )
  if (existing) return existing
  const self: Representative = {
    id: deterministicId(SELF_REPRESENTATIVE_PREFIX, dataSubjectContact),
    kind: 'self',
    name: dataSubjectName,
    contact: dataSubjectContact,
    credentialRef: '',
    credentialDigest: '',
    status: 'active',
    scopeSystemIds: state.systems.map((system) => system.id),
    scopeRequestTypes: [],
    grantedAt: now(),
    expiresAt: null,
    revokedAt: null,
    verification: { status: 'verified', note: '数据主体本人申请，查看范围与其权利请求一致。' },
    history: [],
  }
  state.representatives.push(self)
  return self
}

export interface RepresentativeDraft {
  kind: RepresentativeKind
  name: string
  contact: string
  credentialRef: string
  scopeSystemIds: string[]
  scopeRequestTypes: RequestType[]
  validDays: number
}

export function buildRepresentative(draft: RepresentativeDraft, grantedAt = now()): Representative {
  const expiresAt = new Date(grantedAt)
  expiresAt.setDate(expiresAt.getDate() + draft.validDays)
  return {
    id: id('rep'),
    kind: draft.kind,
    name: draft.name.trim(),
    contact: draft.contact.trim(),
    credentialRef: draft.credentialRef.trim(),
    credentialDigest: digest(draft.credentialRef, 'CRED'),
    status: 'active',
    scopeSystemIds: [...draft.scopeSystemIds],
    scopeRequestTypes: [...draft.scopeRequestTypes],
    grantedAt,
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
    verification: { status: 'pending', note: '授权材料已登记，等待授权关系核验。' },
    history: [],
  }
}

export function appendRepHistory(
  representative: Representative,
  toStatus: Representative['status'],
  operator: string,
  reason: string,
  at: string = now(),
) {
  representative.history.unshift({
    changedAt: at,
    fromStatus: representative.status,
    toStatus,
    operator,
    reason,
  })
}

export function deliveredEvidenceIds(request: PrivacyRequest): Set<string> {
  const ids = new Set<string>()
  request.deliveryPackages.forEach((pkg) => {
    if (pkg.status === 'delivered' || pkg.status === 'under-review') {
      pkg.evidenceIds.forEach((evidenceId) => ids.add(evidenceId))
    }
  })
  return ids
}

export interface InvalidationResult {
  voidedEvidence: number
  reviewedPackages: number
  voidedPackages: number
  reopened: boolean
}

// 撤回 / 到期 / 换人后的级联处置：
// 未交付材料立即失效重算；已发出处理包保留当时依据并进入复核
export function invalidateRequestBasis(
  request: PrivacyRequest,
  reason: string,
  successorSnapshot: IntakeSnapshot | null,
  at: string = now(),
): InvalidationResult {
  const result: InvalidationResult = {
    voidedEvidence: 0,
    reviewedPackages: 0,
    voidedPackages: 0,
    reopened: false,
  }
  const protectedEvidenceIds = deliveredEvidenceIds(request)

  request.evidence.forEach((evidence) => {
    if (evidence.voidedAt) return
    if (protectedEvidenceIds.has(evidence.id)) {
      evidence.basisState = 'superseded'
    } else {
      evidence.basisState = 'undelivered-voided'
      evidence.voidedAt = at
      evidence.voidReason = reason
      result.voidedEvidence += 1
    }
  })

  request.deliveryPackages.forEach((pkg) => {
    if (pkg.status === 'prepared') {
      pkg.status = 'voided'
      pkg.reviewNote = reason
      result.voidedPackages += 1
    } else if (pkg.status === 'delivered') {
      pkg.status = 'under-review'
      pkg.reviewNote = reason
      result.reviewedPackages += 1
    }
  })

  if (successorSnapshot) {
    request.representativeId = successorSnapshot.representativeId
    request.intakeSnapshot = successorSnapshot
  } else if (request.intakeSnapshot) {
    request.intakeSnapshot.invalidatedReason = reason
  }

  // 未交付材料失效：未完成/已完成的执行类任务全部回到待重算（身份核验步骤保留）
  if (result.voidedEvidence > 0 || result.voidedPackages > 0) {
    request.tasks.forEach((task) => {
      if (task.id.endsWith('-identity')) return
      task.status = 'pending'
      task.completedAt = undefined
      task.exceptionReason = successorSnapshot
        ? `代理关系已变更，按 ${successorSnapshot.representativeName} 的受理快照重算。`
        : '授权依据失效，等待补全代理关系后重算。'
    })
    request.status = 'recalculating'
    result.reopened = true
  } else if (request.status === 'completed') {
    // 已发出处理包：保留当时依据，维持完成态并进入复核
    request.status = 'completed'
  }

  if (!request.conflicts.some((conflict) => conflict.startsWith('代理授权依据变更'))) {
    request.conflicts.push(`代理授权依据变更：${reason}`)
  }
  return result
}

// 任务/证据必须落在受理快照冻结的查看范围内，且授权依据当前仍有效
export function assertEvidenceBasis(
  request: PrivacyRequest,
  representatives: Representative[],
  systemId: string | undefined,
) {
  const snapshot = request.intakeSnapshot
  if (!snapshot) {
    throw new ChainError('受理快照缺失（旧数据代理关系待确认），补全前不能产出证据或导出。')
  }
  if (snapshot.invalidatedReason) {
    throw new ChainError('受理快照已因代理关系变更失效，需要按最新代理关系重算。')
  }
  if (systemId && !snapshot.scopeSystemIds.includes(systemId)) {
    throw new ChainError('任务所属系统不在受理时冻结的查看范围内。')
  }
  if (snapshot.representativeId) {
    const representative = representatives.find(
      (item) => item.id === snapshot.representativeId,
    )
    assertActiveBasis(representative)
  }
}

export function evidenceKey(taskId: string, name: string): string {
  return `${taskId}::${name.trim()}`
}

export function batchPlannedKey(kind: 'evidence' | 'package', key: string): string {
  return `${kind}:${key}`
}

export function buildEvidence(
  request: PrivacyRequest,
  batchId: string,
  item: EvidenceBatchItem,
  uploadedBy: string,
  at: string = now(),
) {
  const key = evidenceKey(item.taskId, item.name)
  const snapshot = request.intakeSnapshot!
  const evidenceId = deterministicId('evidence', `${batchId}-${key}`)
  return {
    id: evidenceId,
    stepId: item.taskId,
    name: item.name.trim(),
    evidenceType: item.evidenceType,
    digest: digest(`${snapshot.id}-${key}`, 'EV'),
    uploadedBy,
    uploadedAt: at,
    protected: true as const,
    basisSnapshotId: snapshot.id,
    basisRepresentativeId: snapshot.representativeId,
    basisRepresentativeName: snapshot.representativeName,
    basisSystemId: request.tasks.find((task) => task.id === item.taskId)?.systemId ?? null,
    basisState: 'current' as const,
  }
}

export function nextPackageCode(request: PrivacyRequest): string {
  const version = request.deliveryPackages.length + 1
  return version === 1 ? `PKG-${request.code.slice(4)}` : `PKG-${request.code.slice(4)}-R${version}`
}

export function buildPackage(
  request: PrivacyRequest,
  batchId: string,
  at: string = now(),
): DeliveryPackage {
  const snapshot = request.intakeSnapshot!
  const validEvidence = request.evidence.filter(
    (evidence) => !evidence.voidedAt && evidence.basisState === 'current',
  )
  return {
    id: deterministicId('pkg', `${request.id}-${at}-${request.deliveryPackages.length}`),
    code: nextPackageCode(request),
    batchId,
    basisSnapshotId: snapshot.id,
    basisRepresentativeId: snapshot.representativeId,
    basisRepresentativeName: snapshot.representativeName,
    scopeSystemIds: [...snapshot.scopeSystemIds],
    evidenceIds: validEvidence.map((evidence) => evidence.id),
    digest: digest(
      `${snapshot.id}-${validEvidence.map((evidence) => evidence.digest).join('|')}`,
      'PKG',
    ),
    preparedAt: at,
    deliveredAt: null,
    status: 'prepared',
    reviewNote: '',
  }
}

export function newWriteBatch(
  requestId: string,
  kind: WriteBatch['kind'],
  plannedKeys: string[],
  at: string = now(),
): WriteBatch {
  return {
    id: id('batch'),
    requestId,
    kind,
    status: 'in-progress',
    plannedKeys,
    producedKeys: [],
    evidenceIds: [],
    packageIds: [],
    attempts: 1,
    createdAt: at,
  }
}

// 旧数据缺少代理关系：补全前禁止导出
export function requestsMissingBasis(state: WorkspaceState): PrivacyRequest[] {
  return state.requests.filter((request) => !request.intakeSnapshot)
}

export function assertExportable(state: WorkspaceState) {
  const missing = requestsMissingBasis(state)
  if (missing.length) {
    throw new ChainError(
      `以下请求缺少受理代理关系快照，补全前不能导出：${missing
        .map((request) => request.code)
        .join('、')}。`,
    )
  }
}
