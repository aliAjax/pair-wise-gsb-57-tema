/* eslint-disable no-console */
// 处置链端到端验证：授权 -> 受理快照 -> 任务证据批次 -> 处理包 -> 撤回/到期/换人 -> 失效重算/复核
import assert from 'node:assert/strict'
import { createInitialState } from '../src/services/mockData'
import {
  registerRepresentative,
  verifyRepresentative,
  changeRepresentation,
  backfillIntake,
} from '../src/services/representationService'
import {
  deliverPackage,
  produceEvidenceBatch,
  resumeEvidenceBatch,
  reviewPackage,
} from '../src/services/fulfillmentService'
import {
  closeRequest,
  createRequest,
  recordExport,
  taskAction,
  verifyIdentity,
} from '../src/services/requestService'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(error instanceof Error ? `    ${error.message}` : error)
    process.exitCode = 1
  }
}

function assertThrow(name: string, fn: () => unknown, includes?: string) {
  check(name, () => {
    assert.throws(fn, (error: unknown) => {
      if (!(error instanceof Error)) return false
      return includes ? error.message.includes(includes) : true
    })
  })
}

// ---------- 场景 1：完整处置链 + 撤回 ----------
function scenarioWithdraw() {
  console.log('\n[场景1] 受理冻结 -> 证据批次 -> 出包交付 -> 撤回：未交付失效、已交付复核')
  let state = createInitialState()

  state = registerRepresentative(
    state,
    {
      kind: 'lawyer',
      name: '周律师',
      contact: 'zh**@law.example.com',
      credentialRef: 'LAW-0001',
      scopeSystemIds: ['sys-crm', 'sys-support'],
      scopeRequestTypes: [],
      validDays: 30,
    },
    '客服',
  )
  const repId = state.representatives[0].id
  state = verifyRepresentative(state, repId, 'verified', '授权委托核验通过', '负责人')

  // 受理范围超出授权系统 -> 拒绝
  assertThrow(
    '受理范围超出查看范围被拒绝',
    () =>
      createRequest(
        state,
        {
          dataSubjectName: '测试主体',
          dataSubjectContact: 'ds1@example.com',
          representativeId: repId,
          requesterName: '',
          requesterContact: '',
          region: 'cn',
          type: 'access',
          affectedSystemIds: ['sys-crm', 'sys-order'],
          identityMaterialType: 'masked-id',
          identityReference: 'REF-123456',
          note: '',
        },
        '客服',
      ),
    '查看范围不包含',
  )

  state = createRequest(
    state,
    {
      dataSubjectName: '测试主体',
      dataSubjectContact: 'ds1@example.com',
      representativeId: repId,
      requesterName: '',
      requesterContact: '',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm', 'sys-support'],
      identityMaterialType: 'masked-id',
      identityReference: 'REF-123456',
      note: '',
    },
    '客服',
  )
  const request = state.requests[0]
  const snapshotId = request.intakeSnapshot!.id

  check('受理时冻结代理关系快照', () => {
    assert.ok(request.intakeSnapshot)
    assert.equal(request.intakeSnapshot.representativeId, repId)
    assert.deepEqual(request.intakeSnapshot.scopeSystemIds, ['sys-crm', 'sys-support'])
  })

  // 未核验身份不能推进
  assertThrow(
    '身份未核验不能开始任务',
    () => taskAction(state, request.id, request.tasks[0].id, 'start', '', 'op'),
    '身份未核验',
  )

  state = verifyIdentity(state, request.id, 'verified', '通过', '运营')

  // 完成全部执行任务（除 close）
  const execTasks = state.requests[0].tasks.filter((task) => !task.id.endsWith('-close'))
  for (const task of execTasks) {
    if (task.status !== 'completed') {
      state = taskAction(state, request.id, task.id, 'start', '', 'op')
      state = taskAction(state, request.id, task.id, 'complete', '', 'op')
    }
  }

  // 批次写入：模拟第 1 项后中断
  const locateCrm = request.tasks.find((task) => task.id.endsWith('-locate-sys-crm'))!.id
  const locateSupport = request.tasks.find((task) => task.id.endsWith('-locate-sys-support'))!.id
  state = produceEvidenceBatch(
    state,
    request.id,
    [
      { taskId: locateCrm, name: '定位回执A', evidenceType: 'system-response' },
      { taskId: locateSupport, name: '定位回执B', evidenceType: 'system-response' },
    ],
    '管理员',
    0, // 第 1 项后中断
  )
  const batch = state.writeBatches[0]
  check('写入中断后批次账本保留 1/2', () => {
    assert.equal(batch.status, 'in-progress')
    assert.equal(batch.producedKeys.length, 1)
    assert.equal(batch.plannedKeys.length, 2)
    assert.equal(state.requests[0].evidence.length, 1)
  })

  const evidenceIdAfterCrash = state.requests[0].evidence[0].id

  // 续做
  state = resumeEvidenceBatch(state, batch.id, '管理员')
  check('从完整批次续做完成且不重复生成', () => {
    const completed = state.writeBatches.find((b) => b.id === batch.id)!
    assert.equal(completed.status, 'completed')
    assert.equal(completed.producedKeys.length, 2)
    assert.equal(state.requests[0].evidence.length, 2)
    assert.ok(state.requests[0].evidence.some((e) => e.id === evidenceIdAfterCrash))
  })

  // 重试已完成批次 -> 无变化
  const revisionBefore = state.revision
  state = resumeEvidenceBatch(state, batch.id, '管理员')
  check('重试已完成批次不重复生成、不新增审计', () => {
    assert.equal(state.revision, revisionBefore)
    assert.equal(state.requests[0].evidence.length, 2)
  })

  // 重复提交同名证据 -> 拒绝
  assertThrow(
    '同快照同任务同名证据重复提交被拒绝',
    () =>
      produceEvidenceBatch(
        state,
        request.id,
        [{ taskId: locateCrm, name: '定位回执A', evidenceType: 'system-response' }],
        '管理员',
      ),
    '已按当前受理快照生成',
  )

  // 关闭 -> 生成处理包 -> 交付（当前日期早于截止日，需填提前关闭理由）
  state = closeRequest(state, request.id, '全部完成', '任务已全部完成，经复核提前关闭。', '负责人')
  const deliveredPkg = state.requests[0].deliveryPackages[0]
  check('关闭时生成处理包并锁定快照', () => {
    assert.equal(deliveredPkg.status, 'prepared')
    assert.equal(deliveredPkg.basisSnapshotId, snapshotId)
    assert.equal(deliveredPkg.evidenceIds.length, 2)
  })
  state = deliverPackage(state, deliveredPkg.id, '负责人')
  check('处理包发出', () => {
    assert.equal(state.requests[0].deliveryPackages[0].status, 'delivered')
  })

  // 撤回授权
  state = changeRepresentation(state, repId, 'revoke', '数据主体电话撤回', undefined, undefined, '负责人')
  const reqAfter = state.requests.find((r) => r.id === request.id)!
  check('撤回后已发出包保留依据并进入复核', () => {
    assert.equal(reqAfter.deliveryPackages[0].status, 'under-review')
    assert.equal(reqAfter.deliveryPackages[0].basisSnapshotId, snapshotId, '保留当时快照依据')
  })
  check('已随包发出的证据标记为 superseded 但不删除', () => {
    const deliveredIds = new Set(reqAfter.deliveryPackages[0].evidenceIds)
    reqAfter.evidence.forEach((evidence) => {
      if (deliveredIds.has(evidence.id)) {
        assert.equal(evidence.basisState, 'superseded')
        assert.ok(!evidence.voidedAt)
      }
    })
  })

  // 登记复核意见
  state = reviewPackage(state, deliveredPkg.id, '通知律师，历史处理留痕不撤回', '负责人')
  check('复核意见登记成功', () => {
    assert.match(
      state.requests.find((r) => r.id === request.id)!.deliveryPackages[0].reviewNote,
      /历史处理留痕/,
    )
  })
}

// ---------- 场景 2：换人，未交付材料失效重算 ----------
function scenarioReplace() {
  console.log('\n[场景2] 未交付处理包遇换人：立即作废、证据失效、按新快照重算')
  let state = createInitialState()
  state = registerRepresentative(
    state,
    {
      kind: 'lawyer',
      name: '旧律师',
      contact: 'old@law.example.com',
      credentialRef: 'LAW-OLD',
      scopeSystemIds: ['sys-crm', 'sys-support'],
      scopeRequestTypes: [],
      validDays: 30,
    },
    '客服',
  )
  const oldId = state.representatives[0].id
  state = verifyRepresentative(state, oldId, 'verified', 'ok', '负责人')
  state = createRequest(
    state,
    {
      dataSubjectName: '主体乙',
      dataSubjectContact: 'ds2@example.com',
      representativeId: oldId,
      requesterName: '',
      requesterContact: '',
      region: 'eu',
      type: 'deletion',
      affectedSystemIds: ['sys-crm'],
      identityMaterialType: 'masked-id',
      identityReference: 'REF-654321',
      note: '',
    },
    '客服',
  )
  const reqId = state.requests[0].id
  state = verifyIdentity(state, reqId, 'verified', 'ok', '运营')
  const task = state.requests[0].tasks.find((t) => t.id.endsWith('-locate-sys-crm'))!.id
  // 直接为任务产证据（不要求完成任务）
  state = produceEvidenceBatch(
    state,
    reqId,
    [{ taskId: task, name: '旧证据', evidenceType: 'execution-log' }],
    '管理员',
  )
  const voidedEvidenceId = state.requests[0].evidence[0].id

  // 换人
  state = changeRepresentation(
    state,
    oldId,
    'replace',
    '被代理人委托新律所',
    {
      kind: 'lawyer',
      name: '新律师',
      contact: 'new@law.example.com',
      credentialRef: 'LAW-NEW',
      scopeSystemIds: ['sys-crm', 'sys-support'],
      scopeRequestTypes: [],
      validDays: 60,
    },
    undefined,
    '负责人',
  )
  const req = state.requests.find((r) => r.id === reqId)!
  const newRep = state.representatives.find((r) => r.name === '新律师')!

  check('旧代理标记为 superseded，新代理已登记', () => {
    assert.equal(state.representatives.find((r) => r.id === oldId)!.status, 'superseded')
    assert.equal(state.representatives.find((r) => r.id === oldId)!.supersededById, newRep.id)
    assert.equal(newRep.status, 'active')
  })
  check('请求受理快照已替换为新代理快照', () => {
    assert.equal(req.intakeSnapshot!.representativeId, newRep.id)
    assert.equal(req.intakeSnapshot!.representativeName, '新律师')
    assert.equal(req.representativeId, newRep.id)
  })
  check('未交付材料立即失效，状态进入重算', () => {
    assert.equal(req.status, 'recalculating')
    const evidence = req.evidence.find((e) => e.id === voidedEvidenceId)!
    assert.equal(evidence.basisState, 'undelivered-voided')
    assert.ok(evidence.voidedAt)
  })
  check('执行任务回到待重算，身份核验步骤保留', () => {
    const identity = req.tasks.find((t) => t.id.endsWith('-identity'))!
    assert.equal(identity.status, 'completed')
    assert.ok(req.tasks.some((t) => t.status === 'pending' && !t.id.endsWith('-identity')))
  })
  check('重算证据不能使用旧证据名走旧快照（新快照下可重新产出）', () => {
    // 同名证据在新快照下可以重新生成
    const next = produceEvidenceBatch(
      state,
      reqId,
      [{ taskId: task, name: '旧证据', evidenceType: 'execution-log' }],
      '管理员',
    )
    const target = next.requests.find((r) => r.id === reqId)!
    assert.equal(target.evidence.length, 2)
    assert.notEqual(target.evidence[1].basisSnapshotId, req.evidence[0].basisSnapshotId)
    assert.equal(target.status, 'processing')
  })
}

// ---------- 场景 3：旧数据回填前禁止导出 ----------
function scenarioBackfill() {
  console.log('\n[场景3] 旧数据缺代理关系：回填前阻断任务与导出，回填后恢复')
  let state = createInitialState()
  const legacy = state.requests.find((r) => r.id === 'req-006')!

  check('演示数据中存在缺快照旧请求', () => {
    assert.equal(legacy.intakeSnapshot, null)
  })
  assertThrow(
    '旧数据未回填不能产出证据',
    () =>
      produceEvidenceBatch(
        state,
        'req-006',
        [{ taskId: legacy.tasks[1].id, name: '证据X', evidenceType: 'execution-log' }],
        '管理员',
      ),
    '受理快照缺失',
  )
  assertThrow(
    '旧数据未回填不能导出',
    () => recordExport(state, '全量', 6, '负责人'),
    '补全前不能导出',
  )

  state = backfillIntake(state, 'req-006', 'self', '负责人')
  state = verifyIdentity(state, 'req-006', 'verified', '历史材料核验通过', '运营')
  check('回填后冻结受理快照', () => {
    const target = state.requests.find((r) => r.id === 'req-006')!
    assert.ok(target.intakeSnapshot)
    assert.equal(target.intakeSnapshot.kind, 'self')
  })
  check('回填后可以产出证据', () => {
    const target = state.requests.find((r) => r.id === 'req-006')!
    const next = produceEvidenceBatch(
      state,
      'req-006',
      [{ taskId: target.tasks[1].id, name: '证据X', evidenceType: 'execution-log' }],
      '管理员',
    )
    assert.equal(next.requests.find((r) => r.id === 'req-006')!.evidence.length, 1)
  })
}

// ---------- 场景 4：两个窗口并发 ----------
function scenarioConcurrency() {
  console.log('\n[场景4] 两个窗口同时提交授权变更与任务完成：后到动作按最新关系判断、不覆盖结果')
  let state = createInitialState()
  // req-001 是本人请求；新建一个律师请求用于并发
  state = registerRepresentative(
    state,
    {
      kind: 'lawyer',
      name: '并发律师',
      contact: 'race@law.example.com',
      credentialRef: 'LAW-RACE',
      scopeSystemIds: ['sys-crm'],
      scopeRequestTypes: [],
      validDays: 30,
    },
    '客服',
  )
  const repId = state.representatives[0].id
  state = verifyRepresentative(state, repId, 'verified', 'ok', '负责人')
  state = createRequest(
    state,
    {
      dataSubjectName: '主体丁',
      dataSubjectContact: 'ds4@example.com',
      representativeId: repId,
      requesterName: '',
      requesterContact: '',
      region: 'cn',
      type: 'access',
      affectedSystemIds: ['sys-crm'],
      identityMaterialType: 'masked-id',
      identityReference: 'REF-112233',
      note: '',
    },
    '客服',
  )
  const reqId = state.requests[0].id
  state = verifyIdentity(state, reqId, 'verified', 'ok', '运营')
  const taskId = state.requests[0].tasks.find((t) => t.id.endsWith('-locate-sys-crm'))!.id
  state = taskAction(state, reqId, taskId, 'start', '', '管理员')

  // 窗口B 持有的版本（授权变更前）
  const windowBRevision = state.revision

  // 窗口A 先完成撤回（成功）
  state = changeRepresentation(state, repId, 'revoke', '窗口A撤回', undefined, windowBRevision, '负责人')

  // 窗口B 带着旧版本号试图完成任务 -> 拒绝且不覆盖任何结果
  assertThrow(
    '后到的旧版本任务完成请求被拒绝（不覆盖已生成结果）',
    () => taskAction(state, reqId, taskId, 'complete', '', '管理员', windowBRevision),
    '另一个窗口',
  )

  // 即使不带版本号，依据当前关系也必须被拒绝
  assertThrow(
    '撤回后按最新代理关系推进任务被拒绝',
    () => taskAction(state, reqId, taskId, 'complete', '', '管理员'),
    '快照已失效',
  )

  // 重复完成已完成任务幂等校验（用 req-004 已完成任务）
  const completedTask = state.requests
    .find((r) => r.id === 'req-004')!
    .tasks.find((t) => t.status === 'completed')!
  assertThrow(
    '重复完成任务不覆盖结果',
    () => taskAction(state, 'req-004', completedTask.id, 'complete', '', '管理员'),
    '重复提交不会覆盖',
  )
}

// ---------- 场景 5：到期 ----------
function scenarioExpire() {
  console.log('\n[场景5] 授权到期登记触发同一处置链')
  let state = createInitialState()
  const lawyer = state.representatives.find((r) => r.id === 'rep-lawyer-001')!
  // req-005 已完成且包已交付
  state = changeRepresentation(state, lawyer.id, 'expire', '授权期限届满未续期', undefined, undefined, '负责人')
  const req = state.requests.find((r) => r.id === 'req-005')!
  check('到期后已发出包进入复核、请求保持完成态', () => {
    assert.equal(req.deliveryPackages[0].status, 'under-review')
    assert.equal(req.status, 'completed')
  })
  check('到期后代理关系不可再用', () => {
    assert.throws(
      () =>
        createRequest(
          state,
          {
            dataSubjectName: '王宁',
            dataSubjectContact: 'wa***@example.com',
            representativeId: lawyer.id,
            requesterName: '',
            requesterContact: '',
            region: 'eu',
            type: 'access',
            affectedSystemIds: ['sys-crm'],
            identityMaterialType: 'masked-id',
            identityReference: 'REF-999999',
            note: '',
          },
          '客服',
        ),
      /已到期/,
    )
  })
}

scenarioWithdraw()
scenarioReplace()
scenarioBackfill()
scenarioConcurrency()
scenarioExpire()

console.log(`\n全部通过：${passed} 项断言`)
