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
  'rebuilding',
  'pending-close',
  'completed',
  'rejected',
  'extended',
])

export const regionSchema = z.enum(['cn', 'eu', 'us', 'sg'])

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
  basisVersion: z.number().optional(),
})

export const evidenceSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  systemId: z.string().optional(),
  name: z.string(),
  evidenceType: z.enum(['execution-log', 'screenshot', 'signed-record', 'system-response']),
  digest: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  protected: z.literal(true),
  basisVersion: z.number().default(1),
  validity: z.enum(['current', 'invalidated', 'retained']).default('current'),
  invalidReason: z.string().optional(),
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

export const agencyRelationKindSchema = z.enum(['self', 'agent'])
export const agencyRelationStatusSchema = z.enum([
  'confirmed',
  'pending-confirmation',
  'withdrawn',
  'expired',
  'replaced',
])
export const agencyChangeReasonSchema = z.enum([
  'withdrawal',
  'expiry',
  'replacement',
  'scope-adjustment',
  'backfill',
  'initial',
])

export const scopeSnapshotSchema = z.object({
  basisVersion: z.number(),
  systemIds: z.array(z.string()),
  requestTypes: z.array(requestTypeSchema),
  frozenAt: z.string(),
  note: z.string(),
})

export const agencyHistoryEntrySchema = z.object({
  basisVersion: z.number(),
  reason: agencyChangeReasonSchema,
  status: agencyRelationStatusSchema,
  agentName: z.string(),
  agentContact: z.string(),
  scope: scopeSnapshotSchema,
  validFrom: z.string(),
  validUntil: z.string().optional(),
  changedAt: z.string(),
  operator: z.string(),
  note: z.string(),
})

export const agencyChainSchema = z.object({
  kind: agencyRelationKindSchema,
  status: agencyRelationStatusSchema,
  subjectName: z.string(),
  agentName: z.string(),
  agentContact: z.string(),
  materialType: identitySchema.shape.materialType,
  maskedReference: z.string(),
  protectedDigest: z.string(),
  currentBasisVersion: z.number(),
  scope: scopeSnapshotSchema,
  history: z.array(agencyHistoryEntrySchema),
  legacyBackfill: z.boolean().default(false),
})

export const packageReviewStatusSchema = z.enum([
  'retained',
  'under-review',
  'review-confirmed',
  'review-revoked',
])

export const deliveryPackageSchema = z.object({
  id: z.string(),
  requestCode: z.string(),
  basisVersion: z.number(),
  status: packageReviewStatusSchema,
  reviewReason: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewer: z.string().optional(),
  reviewNote: z.string().optional(),
  evidenceIds: z.array(z.string()),
  scopeSystemIds: z.array(z.string()),
  digest: z.string(),
  deliveredAt: z.string(),
  deliveredTo: z.string(),
})

export const taskBatchSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  basisVersion: z.number(),
  taskIds: z.array(z.string()),
  completedTaskIds: z.array(z.string()),
  generatedEvidenceIds: z.array(z.string()),
  status: z.enum(['running', 'interrupted', 'completed']),
  failureNote: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
})

export const privacyRequestSchema = z.object({
  id: z.string(),
  code: z.string(),
  requesterName: z.string(),
  requesterContact: z.string(),
  region: regionSchema,
  type: requestTypeSchema,
  status: requestStatusSchema,
  identity: identitySchema,
  agency: agencyChainSchema.optional(),
  requestedAt: z.string(),
  dueAt: z.string(),
  extendedDays: z.number(),
  duplicateOf: z.string().optional(),
  affectedSystemIds: z.array(z.string()),
  tasks: z.array(workflowStepSchema),
  evidence: z.array(evidenceSchema),
  packages: z.array(deliveryPackageSchema).default([]),
  taskBatches: z.array(taskBatchSchema).default([]),
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
  comments: z.array(commentSchema),
  audit: z.array(auditEntrySchema),
  revision: z.number(),
})

const expectedRevision = z.number().int().nonnegative().optional()

export const saveRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  patch: privacyRequestSchema.partial(),
  operator: z.string().default('当前用户'),
  expectedRevision,
})

export const createRequestInputSchema = z.object({
  state: workspaceStateSchema,
  input: z.object({
    requesterName: z.string().min(2),
    requesterContact: z.string().min(5),
    region: regionSchema,
    type: requestTypeSchema,
    affectedSystemIds: z.array(z.string()).min(1),
    identityMaterialType: identitySchema.shape.materialType,
    identityReference: z.string(),
    note: z.string(),
    representation: z.enum(['self', 'agent']).default('self'),
    agentName: z.string().default(''),
    agentContact: z.string().default(''),
    scopeSystemIds: z.array(z.string()).default([]),
    authorizationExpiresAt: z.string().default(''),
    authorizationNote: z.string().default(''),
  }),
  operator: z.string().default('客服专员'),
  expectedRevision,
})

export const identityInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  status: z.enum(['verified', 'insufficient']),
  note: z.string(),
  operator: z.string(),
  expectedRevision,
})

export const assignTaskInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  assignee: z.string().min(2),
  operator: z.string(),
  expectedRevision,
})

export const taskActionInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  action: z.enum(['start', 'complete', 'block']),
  note: z.string(),
  operator: z.string(),
  expectedRevision,
})

export const evidenceInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  name: z.string().min(2),
  evidenceType: evidenceSchema.shape.evidenceType,
  operator: z.string(),
  expectedRevision,
})

export const conflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  conflict: z.string().min(4),
  operator: z.string(),
  expectedRevision,
})

export const resolveConflictInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  conflictIndex: z.number().int().nonnegative(),
  resolution: z.string().min(4),
  operator: z.string(),
  expectedRevision,
})

export const closeRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  resultSummary: z.string().min(4),
  closureReason: z.string(),
  operator: z.string(),
  expectedRevision,
})

export const extendRequestInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  days: z.number().int().min(1).max(90),
  reason: z.string().min(4),
  operator: z.string(),
  expectedRevision,
})

export const commentInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  content: z.string().min(2),
  operator: z.string(),
  expectedRevision,
})

export const recordExportInputSchema = z.object({
  state: workspaceStateSchema,
  scope: z.string(),
  count: z.number().int().nonnegative(),
  operator: z.string(),
  requestIds: z.array(z.string()).optional(),
})

export const agencyChangeInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  reason: agencyChangeReasonSchema.exclude(['backfill', 'initial']),
  newAgentName: z.string().default(''),
  newAgentContact: z.string().default(''),
  scopeSystemIds: z.array(z.string()).default([]),
  validUntil: z.string().default(''),
  note: z.string().default(''),
  operator: z.string(),
  expectedRevision,
})

export const agencyBackfillInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  representation: z.enum(['self', 'agent']),
  agentName: z.string().default(''),
  agentContact: z.string().default(''),
  scopeSystemIds: z.array(z.string()).default([]),
  validUntil: z.string().default(''),
  note: z.string(),
  operator: z.string(),
  expectedRevision,
})

export const batchRunInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  idempotencyKey: z.string().min(4),
  failAfterTasks: z.number().int().nonnegative().optional(),
  operator: z.string(),
  expectedRevision,
})

export const packageReviewInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  packageId: z.string(),
  resolution: z.enum(['confirm', 'revoke']),
  note: z.string().min(2),
  operator: z.string(),
})

export const concurrentSettleInputSchema = z.object({
  state: workspaceStateSchema,
  requestId: z.string(),
  taskId: z.string(),
  ordering: z.enum(['change-first', 'complete-first']),
  change: z.object({
    reason: agencyChangeReasonSchema.exclude(['backfill', 'initial']),
    newAgentName: z.string().default(''),
    newAgentContact: z.string().default(''),
    scopeSystemIds: z.array(z.string()).default([]),
    validUntil: z.string().default(''),
    note: z.string().default(''),
    operator: z.string(),
  }),
  taskOperator: z.string(),
  expectedRevision,
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
export type AgencyChain = z.infer<typeof agencyChainSchema>
export type AgencyRelationStatus = z.infer<typeof agencyRelationStatusSchema>
export type AgencyChangeReason = z.infer<typeof agencyChangeReasonSchema>
export type ScopeSnapshot = z.infer<typeof scopeSnapshotSchema>
export type AgencyHistoryEntry = z.infer<typeof agencyHistoryEntrySchema>
export type DeliveryPackage = z.infer<typeof deliveryPackageSchema>
export type TaskBatch = z.infer<typeof taskBatchSchema>

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
  rebuilding: '依据失效重算中',
  'pending-close': '待关闭',
  completed: '已完成',
  rejected: '已拒绝',
  extended: '已延期',
}

export const regionLabels: Record<Region, string> = {
  cn: '中国大陆',
  eu: '欧盟',
  us: '美国加州',
  sg: '新加坡',
}

export const systemStatusLabels: Record<DataSystem['status'], string> = {
  active: '在用',
  maintenance: '维护中',
  retired: '退役',
}

export const agencyStatusLabels: Record<AgencyRelationStatus, string> = {
  confirmed: '已确认',
  'pending-confirmation': '待确认',
  withdrawn: '已撤回',
  expired: '已到期',
  replaced: '已换人',
}

export const agencyChangeReasonLabels: Record<AgencyChangeReason, string> = {
  withdrawal: '被代理人撤回授权',
  expiry: '授权到期',
  replacement: '更换代理人',
  'scope-adjustment': '查看范围调整',
  backfill: '旧数据回填',
  initial: '受理冻结',
}
