import { z } from 'zod'

export const requestTypeSchema = z.enum([
  'access',
  'rectification',
  'deletion',
  'withdraw-consent',
  'restriction',
])

export const requestStatusSchema = z.enum([
  'registered',
  'identity-review',
  'processing',
  'review-required',
  'recalculating',
  'pending-close',
  'completed',
  'rejected',
  'extended',
])

export const regionSchema = z.enum(['cn', 'eu', 'us', 'sg'])

// 代理身份类型：本人申请，或代理律师/其他代理人代为申请
export const representativeKindSchema = z.enum(['self', 'lawyer', 'agent'])

// 代理授权生命周期
export const representationStatusSchema = z.enum([
  'active', // 授权有效
  'revoked', // 被代理人撤回
  'expired', // 授权到期
  'superseded', // 已被新代理关系替换
  'pending-confirmation', // 旧数据缺代理关系，回填待确认
])

// 受理快照冻结的代理关系状态（受理时点，不可变）
export const snapshotStatusSchema = z.enum(['active', 'revoked', 'expired', 'superseded'])

// 证据依据快照是否仍是当前授权
export const basisStateSchema = z.enum([
  'current', // 与最新代理关系一致
  'superseded', // 代理已换人或关系变更
  'undelivered-voided', // 未交付材料，因撤回/到期/换人已失效，需要重算
])

// 处理包生命周期
export const packageStatusSchema = z.enum([
  'prepared', // 已生成，尚未交付
  'delivered', // 已发出
  'under-review', // 发出后授权依据变化，保留当时依据，进入复核
  'voided', // 未交付，授权依据变化后作废，等待按新依据重算
])

// 批量写入生命周期（写入中断后从完整批次续做）
export const batchStatusSchema = z.enum(['in-progress', 'completed'])
export const batchKindSchema = z.enum(['evidence', 'package'])

export const representativeSchema = z.object({
  id: z.string(),
  kind: representativeKindSchema,
  name: z.string(),
  contact: z.string(),
  // 代理资质：律师执业证号 / 授权书编号 / 关系证明编号；本人申请为空
  credentialRef: z.string(),
  credentialDigest: z.string(),
  status: representationStatusSchema,
  // 授权范围（按系统 id 划定查看范围）
  scopeSystemIds: z.array(z.string()),
  // 授权的请求类型；空数组代表与数据主体全部权利请求一致
  scopeRequestTypes: z.array(requestTypeSchema),
  grantedAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  // 换人时指向接替的新代理关系
  supersededById: z.string().optional(),
  verification: z.object({
    status: z.enum(['verified', 'pending', 'insufficient']),
    note: z.string(),
    verifiedAt: z.string().optional(),
  }),
  history: z.array(
    z.object({
      changedAt: z.string(),
      fromStatus: representationStatusSchema,
      toStatus: representationStatusSchema,
      operator: z.string(),
      reason: z.string(),
    }),
  ),
})

// 受理时冻结的代理关系与查看范围快照（任务只按这份快照产出证据）
export const intakeSnapshotSchema = z.object({
  id: z.string(),
  representativeId: z.string().nullable(), // 本人申请时为空
  representativeName: z.string(),
  kind: representativeKindSchema,
  scopeSystemIds: z.array(z.string()),
  scopeRequestTypes: z.array(requestTypeSchema),
  statusAtIntake: snapshotStatusSchema,
  frozenAt: z.string(),
  expiresAt: z.string().nullable(),
  // 快照失效原因（撤回/到期/换人），未失效为空
  invalidatedReason: z.string(),
})

export const identitySchema = z.object({
  status: z.enum(['pending', 'verified', 'insufficient']),
  materialType: z.enum(['masked-id', 'account-ownership', 'authorization-letter', 'none']),
  maskedReference: z.string(),
  protectedDigest: z.string(),
  note: z.string(),
  reviewedAt: z.string().optional(),
})

export const workflowStepSchema = z.object({
  id: z.string(),
  order: z.number(),
  name: z.string(),
  role: z.string(),
  systemId: z.string().optional(),
  status: z.enum(['pending', 'active', 'completed', 'blocked']),
  assignee: z.string(),
  dueAt: z.string(),
  completedAt: z.string().optional(),
  exceptionReason: z.string(),
})

export const evidenceSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  name: z.string(),
  evidenceType: z.enum(['execution-log', 'screenshot', 'signed-record', 'system-response']),
  digest: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  protected: z.literal(true),
  // 证据只按受理快照产出：记录冻结时的代理关系与查看范围
  basisSnapshotId: z.string().nullable(),
  basisRepresentativeId: z.string().nullable(),
  basisRepresentativeName: z.string(),
  basisSystemId: z.string().nullable(),
  basisState: basisStateSchema,
  // 未交付材料失效后，重算产生的新证据指向旧证据
  recalculatedFromEvidenceId: z.string().optional(),
  voidedAt: z.string().optional(),
  voidReason: z.string().optional(),
})

// 已发出处理包：保留当时依据；授权依据变化后进入复核
export const deliveryPackageSchema = z.object({
  id: z.string(),
  code: z.string(),
  batchId: z.string(),
  basisSnapshotId: z.string(),
  basisRepresentativeId: z.string().nullable(),
  basisRepresentativeName: z.string(),
  scopeSystemIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  digest: z.string(),
  preparedAt: z.string(),
  deliveredAt: z.string().nullable(),
  status: packageStatusSchema,
  reviewNote: z.string(),
})

// 批量写入：一次批次内生成证据或处理包，中断后从完整批次续做、不重复生成
export const writeBatchSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  kind: batchKindSchema,
  status: batchStatusSchema,
  // 计划产出的稳定键（任务id+证据名 / 处理包code），重试时据此跳过已生成项
  plannedKeys: z.array(z.string()),
  producedKeys: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  packageIds: z.array(z.string()),
  attempts: z.number(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
})

export const commentSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  author: z.string(),
  content: z.string(),
  createdAt: z.string(),
})

export const auditEntrySchema = z.object({
  id: z.string(),
  requestId: z.string().optional(),
  action: z.string(),
  operator: z.string(),
  detail: z.string(),
  createdAt: z.string(),
})

export const dataSystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  dataDomain: z.string(),
  transferMethod: z.string(),
  slaDays: z.number(),
  requestTypes: z.array(requestTypeSchema),
  status: z.enum(['active', 'maintenance', 'retired']),
})

export const privacyRequestSchema = z.object({
  id: z.string(),
  code: z.string(),
  // 数据主体（被代理人）；requester 可能是代理律师
  dataSubjectName: z.string(),
  dataSubjectContact: z.string(),
  requesterName: z.string(),
  requesterContact: z.string(),
  // 当前代理关系 id；本人申请或旧数据待确认时为空
  representativeId: z.string().nullable(),
  // 受理时冻结的代理关系与查看范围；旧数据补全前为空（禁止导出）
  intakeSnapshot: intakeSnapshotSchema.nullable(),
  region: regionSchema,
  type: requestTypeSchema,
  status: requestStatusSchema,
  identity: identitySchema,
  requestedAt: z.string(),
  dueAt: z.string(),
  extendedDays: z.number(),
  duplicateOf: z.string().optional(),
  affectedSystemIds: z.array(z.string()),
  tasks: z.array(workflowStepSchema),
  evidence: z.array(evidenceSchema),
  deliveryPackages: z.array(deliveryPackageSchema),
  conflicts: z.array(z.string()),
  resultSummary: z.string(),
  closureReason: z.string(),
  audit: z.array(
    auditEntrySchema.omit({ requestId: true }),
  ),
})

export const workspaceStateSchema = z.object({
  requests: z.array(privacyRequestSchema),
  systems: z.array(dataSystemSchema),
  // 代理关系簿：授权、核验、撤回/到期/换人历史
  representatives: z.array(representativeSchema),
  // 批量写入账本：中断续做、幂等重试
  writeBatches: z.array(writeBatchSchema),
  comments: z.array(commentSchema),
  audit: z.array(auditEntrySchema),
  revision: z.number(),
})

export const saveRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  patch: privacyRequestSchema.partial(),
  operator: z.string().default('当前用户'),
})

export const createRequestInputSchema = z.object({
  state: workspaceStateSchema,
  input: z.object({
    dataSubjectName: z.string().min(2),
    dataSubjectContact: z.string().min(5),
    // 为空表示数据主体本人申请
    representativeId: z.string().nullable(),
    requesterName: z.string().min(2),
    requesterContact: z.string().min(5),
    region: regionSchema,
    type: requestTypeSchema,
    affectedSystemIds: z.array(z.string()).min(1),
    identityMaterialType: identitySchema.shape.materialType,
    identityReference: z.string(),
    note: z.string(),
  }),
  operator: z.string().default('客服专员'),
})

export const identityInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  status: z.enum(['verified', 'insufficient']),
  note: z.string(),
  operator: z.string(),
})

export const assignTaskInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  assignee: z.string().min(2),
  operator: z.string(),
})

export const taskActionInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  action: z.enum(['start', 'complete', 'block']),
  note: z.string(),
  baseRevision: z.number().optional(),
  operator: z.string(),
})

export const evidenceInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  name: z.string().min(2),
  evidenceType: evidenceSchema.shape.evidenceType,
  operator: z.string(),
})

export const conflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  conflict: z.string().min(4),
  operator: z.string(),
})

export const resolveConflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  conflictIndex: z.number().int().nonnegative(),
  resolution: z.string().min(4),
  operator: z.string(),
})

export const closeRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  resultSummary: z.string().min(4),
  closureReason: z.string(),
  operator: z.string(),
})

export const extendRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  days: z.number().int().min(1).max(90),
  reason: z.string().min(4),
  operator: z.string(),
})

export const commentInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  content: z.string().min(2),
  operator: z.string(),
})

export const recordExportInputSchema = z.object({
  state: workspaceStateSchema,
  scope: z.string(),
  count: z.number().int().nonnegative(),
  operator: z.string(),
})

export const registerRepresentativeInputSchema = z.object({
  state: workspaceStateSchema,
  kind: representativeKindSchema,
  name: z.string().min(2),
  contact: z.string().min(5),
  credentialRef: z.string().min(4),
  scopeSystemIds: z.array(z.string()).min(1),
  scopeRequestTypes: z.array(requestTypeSchema),
  validDays: z.number().int().min(1).max(3650),
  operator: z.string().default('客服专员'),
})

export const verifyRepresentativeInputSchema = z.object({
  state: workspaceStateSchema,
  representativeId: z.string(),
  status: z.enum(['verified', 'insufficient']),
  note: z.string().min(2),
  operator: z.string(),
})

export const changeRepresentationInputSchema = z.object({
  state: workspaceStateSchema,
  representativeId: z.string(),
  action: z.enum(['revoke', 'expire', 'replace']),
  reason: z.string().min(2),
  successor: registerRepresentativeInputSchema
    .omit({ state: true, operator: true })
    .optional(),
  baseRevision: z.number().optional(),
  operator: z.string(),
})

export const backfillIntakeInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  representativeId: z.string(),
  operator: z.string(),
})

export const evidenceBatchItemSchema = z.object({
  taskId: z.string(),
  name: z.string().min(2),
  evidenceType: evidenceSchema.shape.evidenceType,
})

export const evidenceBatchInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  items: z.array(evidenceBatchItemSchema).min(1),
  failAfterItem: z.number().int().nonnegative().optional(),
  baseRevision: z.number().optional(),
  operator: z.string(),
})

export const resumeBatchInputSchema = z.object({
  state: workspaceStateSchema,
  batchId: z.string(),
  failAfterItem: z.number().int().nonnegative().optional(),
  operator: z.string(),
})

export const preparePackageInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  operator: z.string(),
})

export const deliverPackageInputSchema = z.object({
  state: workspaceStateSchema,
  packageId: z.string(),
  operator: z.string(),
})

export const reviewPackageInputSchema = z.object({
  state: workspaceStateSchema,
  packageId: z.string(),
  reviewNote: z.string().min(2),
  operator: z.string(),
})

export type RequestType = z.infer<typeof requestTypeSchema>
export type RequestStatus = z.infer<typeof requestStatusSchema>
export type Region = z.infer<typeof regionSchema>
export type IdentityCheck = z.infer<typeof identitySchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type ExecutionEvidence = z.infer<typeof evidenceSchema>
export type ReviewComment = z.infer<typeof commentSchema>
export type AuditEntry = z.infer<typeof auditEntrySchema>
export type DataSystem = z.infer<typeof dataSystemSchema>
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>
export type WorkspaceState = z.infer<typeof workspaceStateSchema>
export type Representative = z.infer<typeof representativeSchema>
export type RepresentationStatus = z.infer<typeof representationStatusSchema>
export type RepresentativeKind = z.infer<typeof representativeKindSchema>
export type IntakeSnapshot = z.infer<typeof intakeSnapshotSchema>
export type DeliveryPackage = z.infer<typeof deliveryPackageSchema>
export type WriteBatch = z.infer<typeof writeBatchSchema>
export type EvidenceBatchItem = z.infer<typeof evidenceBatchItemSchema>

export const requestTypeLabels: Record<RequestType, string> = {
  access: '访问',
  rectification: '更正',
  deletion: '删除',
  'withdraw-consent': '撤回同意',
  restriction: '限制处理',
}

export const requestStatusLabels: Record<RequestStatus, string> = {
  registered: '已登记',
  'identity-review': '身份核验中',
  processing: '履约处理中',
  'review-required': '复核队列',
  recalculating: '依据失效重算中',
  'pending-close': '待关闭',
  completed: '已完成',
  rejected: '已拒绝',
  extended: '已延期',
}

export const representativeKindLabels: Record<RepresentativeKind, string> = {
  self: '本人申请',
  lawyer: '代理律师',
  agent: '其他代理人',
}

export const representationStatusLabels: Record<RepresentationStatus, string> = {
  active: '授权有效',
  revoked: '已撤回',
  expired: '已到期',
  superseded: '已换人',
  'pending-confirmation': '待确认',
}

export const basisStateLabels = {
  current: '依据现行有效',
  superseded: '代理关系已变更',
  'undelivered-voided': '未交付材料已失效，待重算',
} as const

export const packageStatusLabels = {
  prepared: '已生成待交付',
  delivered: '已发出',
  'under-review': '依据变更复核中',
  voided: '未交付已作废',
} as const

export const batchStatusLabels = {
  'in-progress': '写入中断，可续做',
  completed: '批次完成',
} as const

export const regionLabels: Record<Region, string> = {
  cn: '中国大陆',
  eu: '欧盟',
  us: '美国加州',
  sg: '新加坡',
}

export const systemStatusLabels: Record<DataSystem['status'], string> = {
  active: '在用',
  maintenance: '维护中',
  retired: '已退役',
}
