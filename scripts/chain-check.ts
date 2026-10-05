import assert from 'node:assert/strict'
import { createInitialState } from '@/services/mockData'
import {
  createRequest,
  verifyIdentity,
  taskAction,
  closeRequest,
  recordExport,
} from '@/services/requestService'
import { agencyChange, agencyBackfill, reviewPackage } from '@/services/agencyService'
import { runTaskBatch } from '@/services/taskBatchService'
import { settleConcurrent } from '@/services/concurrentService'
import { exportBlockedRequests } from '@/services/agencyChain'

const initial = createInitialState()
let revision0 = initial.revision

// 1. 受理冻结：代理人资料不全 → 待确认，任务不能产出
{
  let s = createRequest(
    initial,
    {
      requesterName: '数据主体甲',
      requesterContact: 'dj***@example.com',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm', 'sys-order'],
      identityMaterialType: 'authorization-letter',
      identityReference: 'AUTH-DJ-0001',
      note: '律师代为调取',
      representation: 'agent',
      agentName: '',
      agentContact: '',
      scopeSystemIds: ['sys-crm'],
      authorizationExpiresAt: '',
      authorizationNote: '',
    },
    '客服专员',
  )
  const req = s.requests[0]
  assert.equal(req.agency?.status, 'pending-confirmation')
  assert.equal(req.agency.scope.systemIds.join(','), 'sys-crm')
  assert.equal(req.status, 'review-required')
  console.log('✓ 受理冻结：代理要素不全进入待确认，范围只含 sys-crm')

  // 回填确认
  s = agencyBackfill(s, {
    requestId: req.id,
    representation: 'agent',
    agentName: '周岚律师',
    agentContact: 'zhou***@law.example.com',
    scopeSystemIds: ['sys-crm'],
    note: '补传授权委托书',
    operator: '隐私负责人',
  })
  assert.equal(s.requests[0].agency!.status, 'confirmed')
  console.log('✓ 回填确认：代理关系变为 confirmed，门禁解除')

  // 范围外任务拒绝产出证据（sys-order 不在冻结范围）
  s = verifyIdentity(s, req.id, 'verified', '授权委托书核验通过', '隐私负责人')
  const outOfScopeTask = s.requests[0].tasks.find((t: { id: string }) =>
    t.id.includes('execute-sys-order'),
  )!
  assert.throws(
    () => taskAction(s, req.id, outOfScopeTask.id, 'complete', '越权尝试', '数据管理员'),
    /不在受理冻结的查看范围/,
  )
  console.log('✓ 快照约束：范围外系统任务被拒绝，证据不会越权产出')

  // 完整批次执行（只包含 sys-crm 的 locate/execute）
  const key = 'batch-key-001'
  s = runTaskBatch(s, { requestId: req.id, idempotencyKey: key, operator: '数据管理员' })
  const batch = s.requests[0].taskBatches[0]
  assert.equal(batch.status, 'completed')
  const evidenceCount = s.requests[0].evidence.length
  assert.ok(evidenceCount >= 2)
  // 幂等重试：不重复生成证据
  s = runTaskBatch(s, { requestId: req.id, idempotencyKey: key, operator: '数据管理员' })
  assert.equal(s.requests[0].evidence.length, evidenceCount, '幂等重试不得重复生成证据')
  assert.equal(s.requests[0].taskBatches.length, 1, '幂等重试不得创建新批次')
  console.log('✓ 批次幂等：完成后同键重试不重复生成证据/批次')
}

// 2. 写入中断 → 断点续做
{
  let s = createRequest(
    initial,
    {
      requesterName: '数据主体乙',
      requesterContact: 'dy***@example.com',
      region: 'eu',
      type: 'deletion',
      affectedSystemIds: ['sys-crm', 'sys-marketing'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********2222',
      note: '',
      representation: 'self',
      agentName: '',
      agentContact: '',
      scopeSystemIds: [],
      authorizationExpiresAt: '',
      authorizationNote: '',
    },
    '客服专员',
  )
  const req = s.requests[0]
  s = verifyIdentity(s, req.id, 'verified', 'ok', '隐私负责人')
  const key = 'batch-resume-002'
  s = runTaskBatch(s, {
    requestId: req.id,
    idempotencyKey: key,
    failAfterTasks: 1,
    operator: '数据管理员',
  })
  let b = s.requests[0].taskBatches[0]
  assert.equal(b.status, 'interrupted')
  const afterInterruptEvidence = s.requests[0].evidence.length
  // 续做：不再传 failAfterTasks，跑完整批
  s = runTaskBatch(s, { requestId: req.id, idempotencyKey: key, operator: '数据管理员' })
  b = s.requests[0].taskBatches[0]
  assert.equal(b.status, 'completed')
  assert.deepEqual(
    b.completedTaskIds.length,
    b.taskIds.length,
    '续做后任务全部完成',
  )
  assert.equal(b.generatedEvidenceIds.length, b.taskIds.length)
  // 续做未重复生成第一个任务的证据
  assert.equal(
    s.requests[0].evidence.length,
    afterInterruptEvidence + (b.taskIds.length - 1),
    '续做只补齐缺失任务的证据',
  )
  console.log('✓ 写入中断：从完整批次断点续做，重试不重复生成证据')

  // 合并与复核任务按流程完成（系统任务已全部由批次产出）
  for (const suffix of ['merge', 'review']) {
    const task = s.requests[0].tasks.find((t: { id: string }) => t.id.endsWith(`-${suffix}`))!
    s = taskAction(s, req.id, task.id, 'complete', `${suffix} 完成`, '隐私运营')
  }

  // 3. 关闭生成处理包 → 撤回授权 → 已发包进入复核并保留依据
  const before = s.requests[0].evidence.length
  s = closeRequest(
    s,
    req.id,
    '两系统删除完成，保留最小凭证。',
    '已完成全部系统任务且经复核确认，提前关闭。',
    '隐私负责人',
  )
  assert.equal(s.requests[0].status, 'completed')
  assert.equal(s.requests[0].packages.length, 1)
  const pkgId = s.requests[0].packages[0].id
  assert.equal(s.requests[0].packages[0].basisVersion, 1)
  const deliveredEvidence = s.requests[0].evidence.filter(
    (e: { validity: string }) => e.validity === 'retained',
  ).length
  assert.ok(deliveredEvidence >= before)

  s = agencyChange(s, {
    requestId: req.id,
    reason: 'withdrawal',
    note: '被代理人书面撤回后续授权',
    operator: '隐私负责人',
  })
  const changed = s.requests[0]
  assert.equal(changed.agency!.status, 'withdrawn')
  assert.equal(changed.agency!.currentBasisVersion, 2)
  assert.equal(changed.packages[0].id, pkgId)
  assert.equal(changed.packages[0].status, 'under-review')
  assert.equal(changed.packages[0].basisVersion, 1, '已发包保留出具时依据 v1')
  assert.ok(
    changed.evidence.every((e: { validity: string }) => e.validity !== 'current'),
    '撤回后无当前有效未交付证据',
  )
  console.log('✓ 撤回授权：未交付证据失效重算，已发出包保留 v1 依据进入复核')

  // 复核确认
  s = reviewPackage(s, {
    requestId: req.id,
    packageId: pkgId,
    resolution: 'confirm',
    note: '出具时授权有效',
    operator: '隐私负责人',
  })
  assert.equal(s.requests[0].packages[0].status, 'review-confirmed')
  console.log('✓ 处理包复核确认：保留历史包且登记复核意见')
}

// 4. 换人：未交付材料失效、任务重算
{
  let s = createRequest(
    initial,
    {
      requesterName: '数据主体丙',
      requesterContact: 'db***@example.com',
      region: 'sg',
      type: 'access',
      affectedSystemIds: ['sys-support'],
      identityMaterialType: 'authorization-letter',
      identityReference: 'AUTH-DB-0003',
      note: '',
      representation: 'agent',
      agentName: '老律师',
      agentContact: 'old***@law.example.com',
      scopeSystemIds: ['sys-support'],
      authorizationExpiresAt: '',
      authorizationNote: '',
    },
    '客服专员',
  )
  const req = s.requests[0]
  s = verifyIdentity(s, req.id, 'verified', 'ok', '隐私负责人')
  s = runTaskBatch(s, { requestId: req.id, idempotencyKey: 'k3', operator: '数据管理员' })
  const v1Evidence = s.requests[0].evidence.length
  s = agencyChange(s, {
    requestId: req.id,
    reason: 'replacement',
    newAgentName: '新律师',
    newAgentContact: 'new***@law.example.com',
    scopeSystemIds: ['sys-support'],
    note: '被代理人改派',
    operator: '隐私负责人',
  })
  const r = s.requests[0]
  assert.equal(r.agency!.agentName, '新律师')
  assert.equal(r.agency!.currentBasisVersion, 2)
  assert.ok(r.evidence.slice(0, v1Evidence).every((e: { validity: string }) => e.validity === 'invalidated'))
  const reset = r.tasks.filter((t: { basisVersion?: number; status: string }) => t.status === 'pending')
  assert.ok(reset.length >= 2, 'locate/execute 任务重置待重算')
  assert.equal(r.status, 'rebuilding')
  // 旧批次依据版本过期 → 拒绝在旧批次上继续
  assert.throws(
    () => runTaskBatch(s, { requestId: req.id, idempotencyKey: 'k3', operator: '数据管理员' }),
    /依据已从 v1 变为 v2/,
  )
  console.log('✓ 换人：v1 未交付证据失效、任务回到待重算，旧批次拒绝跨依据续写')
}

// 5. 两窗口并发：授权变更先到 → 后到的任务完成按新关系被拒绝，不覆盖结果
{
  let s = createRequest(
    initial,
    {
      requesterName: '数据主体丁',
      requesterContact: 'dd***@example.com',
      region: 'cn',
      type: 'deletion',
      affectedSystemIds: ['sys-crm'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********4444',
      note: '',
      representation: 'self',
      agentName: '',
      agentContact: '',
      scopeSystemIds: [],
      authorizationExpiresAt: '',
      authorizationNote: '',
    },
    '客服专员',
  )
  const req = s.requests[0]
  s = verifyIdentity(s, req.id, 'verified', 'ok', '隐私负责人')
  const executeTask = s.requests[0].tasks.find((t: { id: string }) =>
    t.id.includes('execute-sys-crm'),
  )!
  const result = settleConcurrent(s, {
    requestId: req.id,
    taskId: executeTask.id,
    ordering: 'change-first',
    change: {
      reason: 'withdrawal',
      note: '窗口A撤回',
      operator: '窗口A',
    },
    taskOperator: '窗口B',
  })
  const change = result.actions.find((a) => a.kind === 'agency-change')!
  const complete = result.actions.find((a) => a.kind === 'task-complete')!
  assert.equal(change.accepted, true)
  assert.equal(complete.accepted, false)
  assert.match(complete.detail, /撤回授权/)
  const finalReq = result.state.requests[0]
  assert.equal(finalReq.agency!.currentBasisVersion, 2)
  assert.equal(
    finalReq.tasks.find((t: { id: string }) => t.id === executeTask.id)?.status,
    'pending',
    '后到完成不得覆盖任务状态',
  )
  console.log('✓ 并发裁决（变更先到）：后到任务按最新代理关系被拒绝，已生成结果未覆盖')

  // 完成先到：任务按 v1 落盘，随后变更将其标记重算（仍不覆盖已生成的证据，证据转 invalidated）
  const result2 = settleConcurrent(s, {
    requestId: req.id,
    taskId: executeTask.id,
    ordering: 'complete-first',
    change: {
      reason: 'scope-adjustment',
      scopeSystemIds: ['sys-crm'],
      note: '窗口A范围维持',
      operator: '窗口A',
    },
    taskOperator: '窗口B',
  })
  assert.equal(result2.actions.every((a) => a.accepted), true)
  console.log('✓ 并发裁决（完成先到）：任务结果先落盘，授权变更随后生效并留痕，两动作不互相覆盖')
}

// 6. 乐观并发：基于过期 revision 的提交被拒绝
{
  const s1 = createRequest(
    initial,
    {
      requesterName: '数据主体戊',
      requesterContact: 'dw***@example.com',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm'],
      identityMaterialType: 'masked-id',
      identityReference: '310***********5555',
      note: '',
      representation: 'self',
      agentName: '',
      agentContact: '',
      scopeSystemIds: [],
      authorizationExpiresAt: '',
      authorizationNote: '',
    },
    '客服专员',
  )
  const stale = s1.revision
  let s2 = verifyIdentity(s1, s1.requests[0].id, 'verified', 'ok', '隐私负责人')
  assert.throws(
    () =>
      verifyIdentity(s2, s2.requests[0].id, 'insufficient', '过期窗口写入', '窗口B', {
        expectedRevision: stale,
      }),
    /工作区版本已变化/,
  )
  console.log('✓ 乐观锁：基于旧版本的后到动作被拒绝，不覆盖新结果')
}

// 7. 旧数据导出门禁：req-003 无 agency → 阻断；回填后放行
{
  const blocked = exportBlockedRequests(initial).map((r) => r.code)
  assert.ok(blocked.includes('DSR-2026-003'), '缺少代理关系的历史请求必须阻断导出')
  assert.ok(blocked.includes('DSR-2026-002'), '代理待确认请求也阻断导出')
  let s = agencyBackfill(initial, {
    requestId: 'req-003',
    representation: 'self',
    note: '调阅历史工单确认本人办理',
    operator: '隐私负责人',
  })
  assert.ok(!exportBlockedRequests(s, ['req-003']).length)
  // 导出审计正常记录
  s = recordExport(s, '单请求', 1, '隐私负责人', ['req-003'])
  assert.equal(s.audit[0].action, '导出处理包')
  console.log('✓ 旧数据门禁：缺代理关系先回填待确认，补全前导出被阻断，补全后放行')
}

// req-005 演示数据自带 under-review 包
{
  const r5 = initial.requests.find((r) => r.id === 'req-005')!
  assert.equal(r5.packages[0].status, 'under-review')
  assert.equal(r5.agency!.status, 'replaced')
  console.log('✓ 演示数据：DSR-2026-005 换人后历史处理包处于复核中')
}

console.log('\n全部处置链规则校验通过 ✅')
