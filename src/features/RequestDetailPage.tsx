'use client'

import { useMemo, useState } from 'react'
import NextLink from 'next/link'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Heading,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Progress,
  Select,
  SimpleGrid,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  VStack,
  useDisclosure,
  useToast,
} from '@chakra-ui/react'
import { ArrowLeft, FileCheck2, Link2Off, PackageCheck, RotateCw, ShieldAlert } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge, TypeBadge } from '@/components/StatusBadge'
import {
  useAddCommentMutation,
  useAddConflictMutation,
  useAssignTaskMutation,
  useBackfillIntakeMutation,
  useCloseRequestMutation,
  useDeliverPackageMutation,
  useEvidenceBatchMutation,
  useExtendRequestMutation,
  useResolveConflictMutation,
  useResumeBatchMutation,
  useReviewPackageMutation,
  useSaveRequestMutation,
  useTaskActionMutation,
  useVerifyIdentityMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import {
  basisStateLabels,
  packageStatusLabels,
  regionLabels,
  requestTypeLabels,
  type Region,
  type RequestType,
  type WorkflowStep,
} from '@/lib/schemas'
import { deadlineState } from '@/services/workflow'

type DialogType =
  | 'edit'
  | 'identity'
  | 'assign'
  | 'evidence'
  | 'batch'
  | 'block'
  | 'conflict'
  | 'resolve'
  | 'extend'
  | 'close'
  | 'backfill'
  | 'review-package'
  | null

export function RequestDetailPage({ requestId }: { requestId: string }) {
  const { data, isLoading } = useWorkspaceQuery()
  const toast = useToast()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const request = data?.requests.find((item) => item.id === requestId)
  const [dialog, setDialog] = useState<DialogType>(null)
  const [selectedTask, setSelectedTask] = useState<WorkflowStep>()
  const [conflictIndex, setConflictIndex] = useState(0)
  const [content, setContent] = useState('')
  const [assignee, setAssignee] = useState('')
  const [identityStatus, setIdentityStatus] = useState<'verified' | 'insufficient'>('verified')
  const [extendDays, setExtendDays] = useState(15)
  const [editForm, setEditForm] = useState({
    requesterName: '',
    requesterContact: '',
    region: 'cn' as Region,
    type: 'access' as RequestType,
    affectedSystemIds: [] as string[],
  })

  const saveRequest = useSaveRequestMutation()
  const verifyIdentity = useVerifyIdentityMutation()
  const assignTask = useAssignTaskMutation()
  const taskAction = useTaskActionMutation()
  const evidenceBatch = useEvidenceBatchMutation()
  const resumeBatch = useResumeBatchMutation()
  const deliverPackage = useDeliverPackageMutation()
  const reviewPackage = useReviewPackageMutation()
  const backfillIntake = useBackfillIntakeMutation()
  const addConflict = useAddConflictMutation()
  const resolveConflict = useResolveConflictMutation()
  const extendRequest = useExtendRequestMutation()
  const closeRequest = useCloseRequestMutation()
  const addComment = useAddCommentMutation()
  const [batchItems, setBatchItems] = useState<{ taskId: string; name: string }[]>([])
  const [simulateCrash, setSimulateCrash] = useState(false)
  const [selectedPackageId, setSelectedPackageId] = useState('')

  const comments = useMemo(
    () => data?.comments.filter((comment) => comment.requestId === requestId) ?? [],
    [data, requestId],
  )

  if (isLoading || !data) return <Box className="panel">正在加载请求详情...</Box>
  if (!request) return <Box className="panel">请求不存在或已从工作区移除。</Box>

  const deadline = deadlineState(request.dueAt)
  const completedTasks = request.tasks.filter((task) => task.status === 'completed').length
  const currentTask = request.tasks.find((task) => task.status === 'active')
  const systems = data.systems.filter((system) => request.affectedSystemIds.includes(system.id))
  const systemName = (systemId?: string | null) =>
    data.systems.find((system) => system.id === systemId)?.name ?? systemId ?? '—'
  const snapshot = request.intakeSnapshot
  const snapshotRepresentative = snapshot?.representativeId
    ? data.representatives.find((rep) => rep.id === snapshot.representativeId)
    : undefined
  const interruptedBatches = data.writeBatches.filter(
    (batch) => batch.requestId === requestId && batch.status === 'in-progress',
  )
  const basisBlocked =
    !snapshot || !!snapshot.invalidatedReason || request.status === 'recalculating'

  function openDialog(type: DialogType, task?: WorkflowStep, index = 0) {
    if (!request) return
    setSelectedTask(task)
    setConflictIndex(index)
    setDialog(type)
    setContent('')
    if (type === 'assign') setAssignee(task?.assignee ?? '')
    if (type === 'batch') {
      setBatchItems(
        task ? [{ taskId: task.id, name: '' }] : [{ taskId: '', name: '' }],
      )
      setSimulateCrash(false)
    }
    if (type === 'review-package') setSelectedPackageId(task?.id ?? '')
    if (type === 'edit') {
      setEditForm({
        requesterName: request.requesterName,
        requesterContact: request.requesterContact,
        region: request.region,
        type: request.type,
        affectedSystemIds: [...request.affectedSystemIds],
      })
    }
    onOpen()
  }

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      toast({ title: success, status: 'success' })
      onClose()
    } catch (error) {
      toast({
        title: '操作未完成',
        description: error instanceof Error ? error.message : '请检查输入和流程状态',
        status: 'error',
      })
    }
  }

  async function submitDialog() {
    if (!dialog) return
    if (dialog === 'edit') {
      await run(
        () =>
          saveRequest.mutateAsync({
            requestId,
            patch: editForm,
            operator: '隐私运营',
          }),
        '请求信息已保存',
      )
    } else if (dialog === 'identity') {
      await run(
        () =>
          verifyIdentity.mutateAsync({
            requestId,
            status: identityStatus,
            note: content,
            operator: '隐私运营',
          }),
        identityStatus === 'verified' ? '身份核验已通过' : '身份材料已退回复核',
      )
    } else if (dialog === 'assign' && selectedTask) {
      await run(
        () =>
          assignTask.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            assignee,
            operator: '隐私运营',
          }),
        '任务已分派',
      )
    } else if (dialog === 'batch') {
      const items = batchItems
        .map((item) => ({
          taskId: item.taskId,
          name: item.name.trim(),
          evidenceType: 'execution-log' as const,
        }))
        .filter((item) => item.taskId && item.name.length >= 2)
      if (!items.length) {
        toast({ title: '请至少填写一项证据（任务 + 名称）', status: 'warning' })
        return
      }
      await run(
        () =>
          evidenceBatch.mutateAsync({
            requestId,
            items,
            failAfterItem: simulateCrash ? 0 : undefined,
            baseRevision: data!.revision,
            operator: '数据管理员',
          }),
        simulateCrash
          ? '已模拟写入中断：批次账本保留，可从完整批次续做'
          : `已按受理快照批量产出 ${items.length} 项证据`,
      )
    } else if (dialog === 'backfill') {
      await run(
        () =>
          backfillIntake.mutateAsync({
            requestId,
            representativeId: content.trim() || 'self',
            operator: '隐私负责人',
          }),
        '受理快照已补全，恢复证据产出与导出',
      )
    } else if (dialog === 'review-package') {
      await run(
        () =>
          reviewPackage.mutateAsync({
            packageId: selectedPackageId,
            reviewNote: content,
            operator: '隐私负责人',
          }),
        '复核意见已记录，处理包保留发出时依据',
      )
    } else if (dialog === 'block' && selectedTask) {
      await run(
        () =>
          taskAction.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            action: 'block',
            note: content,
            operator: '数据管理员',
          }),
        '任务已阻断并进入复核',
      )
    } else if (dialog === 'conflict') {
      await run(
        () =>
          addConflict.mutateAsync({
            requestId,
            conflict: content,
            operator: '数据管理员',
          }),
        '冲突或例外已进入复核队列',
      )
    } else if (dialog === 'resolve') {
      await run(
        () =>
          resolveConflict.mutateAsync({
            requestId,
            conflictIndex,
            resolution: content,
            operator: '隐私负责人',
          }),
        '复核结论已记录',
      )
    } else if (dialog === 'extend') {
      await run(
        () =>
          extendRequest.mutateAsync({
            requestId,
            days: extendDays,
            reason: content,
            operator: '隐私负责人',
          }),
        `已延期 ${extendDays} 天`,
      )
    } else if (dialog === 'close') {
      await run(
        () =>
          closeRequest.mutateAsync({
            requestId,
            resultSummary: content,
            closureReason: deadline.overdue ? '' : '已完成全部系统任务，经复核后提前关闭。',
            operator: '隐私负责人',
          }),
        '请求已完成并关闭',
      )
    }
  }

  async function taskMutation(task: WorkflowStep, action: 'start' | 'complete') {
    try {
      await taskAction.mutateAsync({
        requestId,
        taskId: task.id,
        action,
        note: action === 'start' ? '开始执行任务。' : '任务结果已提交。',
        baseRevision: data!.revision,
        operator: task.assignee || '数据管理员',
      })
      toast({ title: action === 'start' ? '任务已开始' : '任务已完成', status: 'success' })
    } catch (error) {
      toast({
        title: '任务状态未更新',
        description: error instanceof Error ? error.message : '请检查前置条件',
        status: 'error',
      })
    }
  }

  async function resumeInterruptedBatch(batchId: string) {
    try {
      const next = await resumeBatch.mutateAsync({ batchId, operator: '数据管理员' })
      const batch = next.writeBatches.find((item) => item.id === batchId)
      toast({
        title: batch?.status === 'completed' ? '批次已从完整批次续做完成' : '批次仍未完成',
        description: `已产出 ${batch?.producedKeys.length ?? 0}/${batch?.plannedKeys.length ?? 0} 项，未重复生成证据。`,
        status: batch?.status === 'completed' ? 'success' : 'warning',
      })
    } catch (error) {
      toast({
        title: '续做失败',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  async function deliver(packageId: string) {
    try {
      await deliverPackage.mutateAsync({ packageId, operator: '隐私负责人' })
      toast({ title: '处理包已发出，交付时依据已锁定', status: 'success' })
    } catch (error) {
      toast({
        title: '交付失败',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  const dialogTitle: Record<Exclude<DialogType, null>, string> = {
    edit: '编辑请求基本信息',
    identity: '身份核验结论',
    assign: '分派履约任务',
    evidence: '登记执行证据',
    batch: '按受理快照批量产出证据',
    block: '阻断任务并说明原因',
    conflict: '新增冲突或例外',
    resolve: '记录冲突复核结论',
    extend: '延期处理请求',
    close: '关闭请求并生成处理包',
    backfill: '回填代理关系与受理快照',
    'review-package': '已发出处理包依据复核',
  }

  return (
    <Box>
      <PageHeader
        title={`${request.code} · ${request.requesterName}`}
        description="身份核验、跨系统任务、证据、冲突复核、期限控制和结果合并均在当前工作区完成。"
        actions={
          <>
            <NextLink href="/requests">
              <Button variant="outline" leftIcon={<ArrowLeft size={16} />}>
                返回列表
              </Button>
            </NextLink>
            <Button variant="outline" onClick={() => openDialog('edit')}>
              编辑信息
            </Button>
            <Button colorScheme="brand" onClick={() => openDialog('close')}>
              完成并关闭
            </Button>
          </>
        }
      />

      <SimpleGrid columns={4} spacing="4" mb="5">
        <Box className="metric">
          <Text color="gray.600" fontSize="sm">
            当前状态
          </Text>
          <Box mt="2">
            <StatusBadge status={request.status} />
          </Box>
          <Text mt="2" color="gray.500" fontSize="xs">
            第 {request.extendedDays ? `延期 ${request.extendedDays} 天` : '原期限'}
          </Text>
        </Box>
        <Box className="metric warning">
          <Text color="gray.600" fontSize="sm">
            剩余期限
          </Text>
          <Heading mt="2" color={deadline.color} size="md">
            {deadline.label}
          </Heading>
          <Text mt="1" color="gray.500" fontSize="xs">
            {new Date(request.dueAt).toLocaleString('zh-CN')}
          </Text>
        </Box>
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">
            任务完成
          </Text>
          <Heading mt="2" size="md">
            {completedTasks} / {request.tasks.length}
          </Heading>
          <Progress
            mt="2"
            size="sm"
            value={(completedTasks / request.tasks.length) * 100}
            colorScheme="brand"
          />
        </Box>
        <Box className={`metric ${request.conflicts.length ? 'danger' : ''}`}>
          <Text color="gray.600" fontSize="sm">
            冲突与例外
          </Text>
          <Heading mt="2" size="md">
            {request.conflicts.length}
          </Heading>
          <Text mt="1" color="gray.500" fontSize="xs">
            未解决时禁止关闭
          </Text>
        </Box>
      </SimpleGrid>

      {request.conflicts.length ? (
        <Alert status="error" mb="4" borderRadius="5px">
          当前请求处于复核状态：{request.conflicts.join('；')}
        </Alert>
      ) : null}
      {!snapshot ? (
        <Alert status="warning" mb="4" borderRadius="5px">
          <Flex w="100%" justify="space-between" align="center">
            <Text>
              旧数据缺少代理关系与受理快照：已标记待确认，补全前不能产出证据或导出处理包。
            </Text>
            <Button
              size="sm"
              colorScheme="orange"
              onClick={() => openDialog('backfill')}
              leftIcon={<RotateCw size={14} />}
            >
              回填代理关系
            </Button>
          </Flex>
        </Alert>
      ) : null}
      {snapshot?.invalidatedReason ? (
        <Alert status="error" mb="4" borderRadius="5px">
          <Flex w="100%" justify="space-between" align="center">
            <Text>
              受理快照已失效（{snapshot.invalidatedReason}）：未交付材料已作废，请按最新代理关系重算任务后重新出包。
            </Text>
            <Badge colorScheme="red">依据失效重算中</Badge>
          </Flex>
        </Alert>
      ) : null}
      {interruptedBatches.length ? (
        <Alert status="warning" mb="4" borderRadius="5px">
          <VStack align="stretch" spacing="2" w="100%">
            {interruptedBatches.map((batch) => (
              <Flex key={batch.id} w="100%" justify="space-between" align="center">
                <Text>
                  写入批次 {batch.id.slice(0, 18)}… 中断：{batch.producedKeys.length}/
                  {batch.plannedKeys.length} 项已落账，续做不会重复生成。
                </Text>
                <Button
                  size="sm"
                  colorScheme="orange"
                  leftIcon={<RotateCw size={14} />}
                  isLoading={resumeBatch.isPending}
                  onClick={() => void resumeInterruptedBatch(batch.id)}
                >
                  从完整批次续做
                </Button>
              </Flex>
            ))}
          </VStack>
        </Alert>
      ) : null}
      {request.duplicateOf ? (
        <Alert status="warning" mb="4" borderRadius="5px">
          系统检测到与 {request.duplicateOf} 疑似重复，已保留原请求证据并要求人工复核。
        </Alert>
      ) : null}

      <div className="two-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">请求与身份核验</Heading>
            <HStack>
              <TypeBadge type={request.type} />
              <Button size="xs" onClick={() => openDialog('identity')}>
                身份结论
              </Button>
            </HStack>
          </Flex>
          <SimpleGrid columns={2} spacing="4">
            <Box>
              <Text color="gray.500" fontSize="xs">
                数据主体
              </Text>
              <Text mt="1" fontWeight="600">
                {request.dataSubjectName}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                代为提交人
              </Text>
              <Text mt="1">
                {snapshot && snapshot.kind !== 'self' ? request.requesterName : '本人提交'}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                主体联系方式
              </Text>
              <Text mt="1">{request.dataSubjectContact}</Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                地区与模板
              </Text>
              <Text mt="1">
                {regionLabels[request.region]} · {requestTypeLabels[request.type]}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                身份核验状态
              </Text>
              <Box mt="1">
                <Badge
                  colorScheme={
                    request.identity.status === 'verified'
                      ? 'green'
                      : request.identity.status === 'insufficient'
                        ? 'red'
                        : 'orange'
                  }
                >
                  {request.identity.status === 'verified'
                    ? '已通过'
                    : request.identity.status === 'insufficient'
                      ? '材料不足'
                      : '待核验'}
                </Badge>
              </Box>
            </Box>
          </SimpleGrid>
          <Divider my="4" />
          <HStack align="flex-start" spacing="3">
            <FileCheck2 size={19} color="#237b78" />
            <Box>
              <Text fontWeight="600">受保护身份摘要</Text>
              <Text mt="1" color="gray.600" fontSize="sm">
                {request.identity.maskedReference || '未提供引用'} ·{' '}
                <span className="mono">{request.identity.protectedDigest}</span>
              </Text>
              <Text mt="2" color="gray.600" fontSize="sm">
                {request.identity.note || '暂无核验说明'}
              </Text>
            </Box>
          </HStack>
          <Divider my="4" />
          <HStack align="flex-start" spacing="3">
            <PackageCheck size={19} color={snapshot?.invalidatedReason ? '#c74d4d' : '#237b78'} />
            <Box w="100%">
              <Flex justify="space-between">
                <Text fontWeight="600">受理快照（代理关系与查看范围冻结）</Text>
                {snapshot ? (
                  <Badge colorScheme={snapshot.invalidatedReason ? 'red' : 'green'}>
                    {snapshot.invalidatedReason ? '已失效' : '冻结有效'}
                  </Badge>
                ) : (
                  <Badge colorScheme="yellow">待回填</Badge>
                )}
              </Flex>
              {snapshot ? (
                <>
                  <Text mt="1" color="gray.600" fontSize="sm">
                    {snapshot.kind === 'self' ? '数据主体本人' : `${snapshot.kind === 'lawyer' ? '代理律师' : '代理人'}：${snapshot.representativeName}`}
                    {' · '}快照 <span className="mono">{snapshot.id.slice(0, 18)}</span>
                  </Text>
                  <Text mt="1" color="gray.600" fontSize="sm">
                    查看范围：{snapshot.scopeSystemIds.map((id) => systemName(id)).join('、')}
                    {snapshot.expiresAt
                      ? ` · 授权至 ${new Date(snapshot.expiresAt).toLocaleDateString('zh-CN')}`
                      : ''}
                  </Text>
                  <Text mt="1" color="gray.600" fontSize="sm">
                    冻结于 {new Date(snapshot.frozenAt).toLocaleString('zh-CN')}
                    {snapshotRepresentative
                      ? ` · 授权核验：${snapshotRepresentative.verification.status === 'verified' ? '已通过' : '未通过'}`
                      : ''}
                  </Text>
                  {snapshot.invalidatedReason ? (
                    <Text mt="1" color="red.600" fontSize="sm">
                      失效原因：{snapshot.invalidatedReason}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Text mt="1" color="orange.700" fontSize="sm">
                  旧数据缺少代理关系，补全前任务证据与处理包导出一律阻断。
                </Text>
              )}
            </Box>
          </HStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">涉及系统与流程模板</Heading>
            <Badge colorScheme="blue">{systems.length} 个系统</Badge>
          </Flex>
          <VStack align="stretch" spacing="3">
            {systems.map((system) => (
              <Box key={system.id} p="3" bg="gray.50" borderRadius="5px">
                <Flex justify="space-between">
                  <Text fontWeight="600">{system.name}</Text>
                  <Badge>{system.owner}</Badge>
                </Flex>
                <Text mt="1" color="gray.600" fontSize="sm">
                  {system.dataDomain} · {system.transferMethod}
                </Text>
              </Box>
            ))}
          </VStack>
          <Alert status="info" mt="4" borderRadius="5px">
            每个系统分别执行并登记证据，合并结果时不得覆盖原始时间点。
          </Alert>
        </Box>
      </div>

      <div className="three-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">当前动作</Heading>
            <Badge colorScheme={request.identity.status === 'verified' && !basisBlocked ? 'green' : 'red'}>
              {basisBlocked ? '授权依据阻断' : request.identity.status === 'verified' ? '可执行' : '身份阻断'}
            </Badge>
          </Flex>
          {currentTask ? (
            <VStack align="stretch" spacing="3">
              <Text fontWeight="600">{currentTask.name}</Text>
              <Text color="gray.600" fontSize="sm">
                责任人：{currentTask.assignee}
              </Text>
              {currentTask.exceptionReason ? (
                <Text color="red.600" fontSize="sm">{currentTask.exceptionReason}</Text>
              ) : null}
              <Button
                size="sm"
                colorScheme="brand"
                isDisabled={request.identity.status !== 'verified' || basisBlocked}
                onClick={() => void taskMutation(currentTask, 'start')}
              >
                开始任务
              </Button>
              <Button
                size="sm"
                colorScheme="green"
                isDisabled={request.identity.status !== 'verified' || basisBlocked}
                onClick={() => void taskMutation(currentTask, 'complete')}
              >
                完成任务
              </Button>
              <Button
                size="sm"
                colorScheme="red"
                variant="outline"
                isDisabled={basisBlocked}
                onClick={() => openDialog('block', currentTask)}
              >
                阻断并复核
              </Button>
            </VStack>
          ) : (
            <Alert status={basisBlocked ? 'error' : 'success'} borderRadius="5px">
              {basisBlocked
                ? '授权依据失效或快照缺失，任务暂停，等待重算或回填。'
                : '当前没有活动任务，可检查冲突并生成处理包。'}
            </Alert>
          )}
          <Divider my="4" />
          <VStack align="stretch" spacing="2">
            <Button
              size="sm"
              colorScheme="teal"
              isDisabled={basisBlocked}
              onClick={() => openDialog('batch')}
            >
              批量产出证据（按快照）
            </Button>
            <Button size="sm" onClick={() => openDialog('conflict')} leftIcon={<Link2Off size={15} />}>
              标记冲突或例外
            </Button>
            <Button size="sm" onClick={() => openDialog('extend')} leftIcon={<ShieldAlert size={15} />}>
              申请延期
            </Button>
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">履约任务</Heading>
            <Text color="gray.500" fontSize="sm">
              {request.tasks.length} 项
            </Text>
          </Flex>
          <VStack align="stretch" spacing="0">
            {request.tasks.map((task) => (
              <Box
                key={task.id}
                className={`timeline-item ${task.status === 'active' ? 'active' : ''} ${task.status === 'blocked' ? 'blocked' : ''}`}
              >
                <Flex justify="space-between" gap="4">
                  <Box>
                    <HStack>
                      <Badge>{task.order}</Badge>
                      <Text fontWeight="600">{task.name}</Text>
                    </HStack>
                    <Text mt="1" color="gray.600" fontSize="sm">
                      {task.role} · {task.assignee}
                    </Text>
                    {task.exceptionReason ? (
                      <Text mt="1" color="red.600" fontSize="sm">
                        {task.exceptionReason}
                      </Text>
                    ) : null}
                  </Box>
                  <VStack align="flex-end" spacing="2">
                    <Badge
                      colorScheme={
                        task.status === 'completed'
                          ? 'green'
                          : task.status === 'active'
                            ? 'blue'
                            : task.status === 'blocked'
                              ? 'red'
                              : 'gray'
                      }
                    >
                      {task.status === 'completed'
                        ? '已完成'
                        : task.status === 'active'
                          ? '执行中'
                          : task.status === 'blocked'
                            ? '已阻断'
                            : '未开始'}
                    </Badge>
                    <HStack spacing="1">
                      <Button size="xs" variant="ghost" onClick={() => openDialog('assign', task)}>
                        分派
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        isDisabled={basisBlocked}
                        onClick={() => openDialog('batch', task)}
                      >
                        证据
                      </Button>
                    </HStack>
                  </VStack>
                </Flex>
              </Box>
            ))}
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">冲突复核与证据</Heading>
            <Badge colorScheme={request.conflicts.length ? 'red' : 'green'}>
              {request.conflicts.length} 项冲突
            </Badge>
          </Flex>
          <VStack align="stretch" spacing="3">
            {request.conflicts.map((conflict, index) => (
              <Alert key={`${conflict}-${index}`} status="error" borderRadius="5px">
                <Text fontSize="sm">{conflict}</Text>
                <Button
                  mt="2"
                  size="xs"
                  variant="outline"
                  colorScheme="red"
                  onClick={() => openDialog('resolve', undefined, index)}
                >
                  记录复核结论
                </Button>
              </Alert>
            ))}
            {!request.conflicts.length ? (
              <Alert status="success" borderRadius="5px">
                当前没有未解决冲突。
              </Alert>
            ) : null}
          </VStack>
          <Divider my="4" />
          <Heading size="xs" mb="3">
            执行证据
          </Heading>
          <VStack align="stretch" spacing="2">
            {request.evidence.map((evidence) => (
              <Box
                key={evidence.id}
                className="timeline-item"
                opacity={evidence.voidedAt ? 0.55 : 1}
                borderLeft={evidence.voidedAt ? '3px solid #c74d4d' : undefined}
              >
                <Flex justify="space-between">
                  <Text fontWeight="600">
                    {evidence.name}
                    {evidence.voidedAt ? '（已失效）' : ''}
                  </Text>
                  <Badge
                    colorScheme={
                      evidence.basisState === 'current'
                        ? 'green'
                        : evidence.basisState === 'superseded'
                          ? 'orange'
                          : 'red'
                    }
                  >
                    {basisStateLabels[evidence.basisState]}
                  </Badge>
                </Flex>
                <Text mt="1" color="gray.600" fontSize="xs">
                  {evidence.evidenceType} · {evidence.digest} · {systemName(evidence.basisSystemId)}
                </Text>
                <Text mt="1" color="gray.500" fontSize="xs">
                  依据：{evidence.basisRepresentativeName || '本人'} ·{' '}
                  <span className="mono">{evidence.basisSnapshotId?.slice(0, 16)}</span>
                </Text>
                <Text mt="1" color="gray.500" fontSize="xs">
                  {evidence.uploadedBy} · {new Date(evidence.uploadedAt).toLocaleString('zh-CN')}
                </Text>
                {evidence.voidReason ? (
                  <Text mt="1" color="red.600" fontSize="xs">失效原因：{evidence.voidReason}</Text>
                ) : null}
              </Box>
            ))}
            {!request.evidence.length ? (
              <Text color="gray.500" fontSize="sm">
                暂无执行证据。
              </Text>
            ) : null}
          </VStack>
        </Box>
      </div>

      <Box className="panel" mb="4">
        <Flex className="panel-title">
          <Heading size="sm">处理包（锁定当时受理快照与证据）</Heading>
          <Badge colorScheme="brand">{request.deliveryPackages.length} 个</Badge>
        </Flex>
        {request.deliveryPackages.length ? (
          <VStack align="stretch" spacing="3">
            {request.deliveryPackages.map((pkg) => (
              <Box key={pkg.id} p="3" bg="gray.50" borderRadius="5px">
                <Flex justify="space-between" align="center">
                  <Box>
                    <HStack>
                      <Text fontWeight="700">{pkg.code}</Text>
                      <Badge
                        colorScheme={
                          pkg.status === 'delivered'
                            ? 'green'
                            : pkg.status === 'under-review'
                              ? 'orange'
                              : pkg.status === 'voided'
                                ? 'red'
                                : 'blue'
                        }
                      >
                        {packageStatusLabels[pkg.status]}
                      </Badge>
                    </HStack>
                    <Text mt="1" color="gray.600" fontSize="xs">
                      依据：{pkg.basisRepresentativeName || '数据主体本人'} · 快照{' '}
                      <span className="mono">{pkg.basisSnapshotId.slice(0, 16)}</span> · 摘要{' '}
                      <span className="mono">{pkg.digest}</span>
                    </Text>
                    <Text mt="1" color="gray.600" fontSize="xs">
                      {pkg.evidenceIds.length} 项证据 · 范围：
                      {pkg.scopeSystemIds.map((id) => systemName(id)).join('、')}
                    </Text>
                    {pkg.deliveredAt ? (
                      <Text mt="1" color="gray.500" fontSize="xs">
                        发出时间：{new Date(pkg.deliveredAt).toLocaleString('zh-CN')}
                      </Text>
                    ) : null}
                    {pkg.reviewNote ? (
                      <Text mt="1" color={pkg.status === 'voided' ? 'red.600' : 'orange.700'} fontSize="xs">
                        {pkg.status === 'voided' ? '作废原因：' : '复核说明：'}
                        {pkg.reviewNote}
                      </Text>
                    ) : null}
                  </Box>
                  <HStack>
                    {pkg.status === 'prepared' ? (
                      <Button
                        size="xs"
                        colorScheme="green"
                        isLoading={deliverPackage.isPending}
                        onClick={() => void deliver(pkg.id)}
                      >
                        交付给请求方
                      </Button>
                    ) : null}
                    {pkg.status === 'under-review' ? (
                      <Button
                        size="xs"
                        colorScheme="orange"
                        onClick={() => {
                          setSelectedPackageId(pkg.id)
                          setContent('')
                          setDialog('review-package')
                          onOpen()
                        }}
                      >
                        登记复核意见
                      </Button>
                    ) : null}
                  </HStack>
                </Flex>
              </Box>
            ))}
          </VStack>
        ) : (
          <Alert status="info" borderRadius="5px">
            关闭请求时按当前受理快照生成处理包；未交付包遇授权变更立即作废，已发出包保留依据并进入复核。
          </Alert>
        )}
      </Box>

      <div className="two-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">处理意见</Heading>
          </Flex>
          <HStack align="flex-start" mb="3">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="填写跨系统处理说明、例外分析或补充要求"
            />
            <Button
              colorScheme="brand"
              isDisabled={!content.trim()}
              isLoading={addComment.isPending}
              onClick={async () => {
                try {
                  await addComment.mutateAsync({
                    requestId,
                    content: content.trim(),
                    operator: '隐私运营',
                  })
                  setContent('')
                  toast({ title: '处理意见已记录', status: 'success' })
                } catch (error) {
                  toast({
                    title: '意见提交失败',
                    description: error instanceof Error ? error.message : '请重试',
                    status: 'error',
                  })
                }
              }}
            >
              提交意见
            </Button>
          </HStack>
          <VStack align="stretch" spacing="2">
            {comments.map((comment) => (
              <Box key={comment.id} className="summary-box">
                <Text>{comment.content}</Text>
                <Text mt="2" color="gray.500" fontSize="xs">
                  {comment.author} · {new Date(comment.createdAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">操作审计</Heading>
            <Badge>{request.audit.length} 条</Badge>
          </Flex>
          <VStack align="stretch" spacing="2" maxH="360px" overflowY="auto">
            {request.audit.map((entry) => (
              <Box key={entry.id} className="timeline-item">
                <Text fontWeight="600">{entry.action}</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  {entry.detail}
                </Text>
                <Text mt="1" color="gray.500" fontSize="xs">
                  {entry.operator} · {new Date(entry.createdAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
          </VStack>
        </Box>
      </div>

      <Modal isOpen={isOpen} onClose={onClose} size={dialog === 'edit' ? 'xl' : 'lg'}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{dialog ? dialogTitle[dialog] : ''}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {dialog === 'edit' ? (
              <VStack align="stretch" spacing="4">
                <FormControl isRequired>
                  <FormLabel>请求人</FormLabel>
                  <Input
                    value={editForm.requesterName}
                    onChange={(event) =>
                      setEditForm({ ...editForm, requesterName: event.target.value })
                    }
                  />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>联系方式</FormLabel>
                  <Input
                    value={editForm.requesterContact}
                    onChange={(event) =>
                      setEditForm({ ...editForm, requesterContact: event.target.value })
                    }
                  />
                </FormControl>
                <Flex gap="4">
                  <FormControl>
                    <FormLabel>地区</FormLabel>
                    <Select
                      value={editForm.region}
                      onChange={(event) =>
                        setEditForm({ ...editForm, region: event.target.value as Region })
                      }
                    >
                      {Object.entries(regionLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl>
                    <FormLabel>请求类型</FormLabel>
                    <Select
                      value={editForm.type}
                      onChange={(event) =>
                        setEditForm({ ...editForm, type: event.target.value as RequestType })
                      }
                    >
                      {Object.entries(requestTypeLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                </Flex>
                <FormControl>
                  <FormLabel>相关系统</FormLabel>
                  <HStack wrap="wrap">
                    {data.systems.map((system) => (
                      <Checkbox
                        key={system.id}
                        isChecked={editForm.affectedSystemIds.includes(system.id)}
                        onChange={(event) =>
                          setEditForm({
                            ...editForm,
                            affectedSystemIds: event.target.checked
                              ? [...editForm.affectedSystemIds, system.id]
                              : editForm.affectedSystemIds.filter((id) => id !== system.id),
                          })
                        }
                      >
                        {system.name}
                      </Checkbox>
                    ))}
                  </HStack>
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'identity' ? (
              <VStack align="stretch" spacing="4">
                <FormControl>
                  <FormLabel>核验结论</FormLabel>
                  <Select
                    value={identityStatus}
                    onChange={(event) =>
                      setIdentityStatus(event.target.value as 'verified' | 'insufficient')
                    }
                  >
                    <option value="verified">核验通过</option>
                    <option value="insufficient">材料不足，进入复核</option>
                  </Select>
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>核验说明</FormLabel>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="说明核验依据、材料保护方式或不足项"
                  />
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'assign' && selectedTask ? (
              <FormControl isRequired>
                <FormLabel>责任人或团队</FormLabel>
                <Input value={assignee} onChange={(event) => setAssignee(event.target.value)} />
              </FormControl>
            ) : null}

            {dialog === 'batch' ? (
              <VStack align="stretch" spacing="4">
                <Alert status="info" borderRadius="5px">
                  证据只按受理快照冻结的查看范围产出；整批先校验再写入，中断后从完整批次续做，重试不重复生成。
                </Alert>
                {batchItems.map((item, index) => (
                  <Flex key={index} gap="3" align="center">
                    <Select
                      width="260px"
                      value={item.taskId}
                      onChange={(event) =>
                        setBatchItems(
                          batchItems.map((entry, entryIndex) =>
                            entryIndex === index ? { ...entry, taskId: event.target.value } : entry,
                          ),
                        )
                      }
                    >
                      <option value="">选择任务</option>
                      {request.tasks
                        .filter((task) => !task.id.endsWith('-identity') && !task.id.endsWith('-close'))
                        .map((task) => (
                          <option key={task.id} value={task.id}>
                            {task.order}. {task.name}
                          </option>
                        ))}
                    </Select>
                    <Input
                      flex="1"
                      placeholder="证据名称，例如 删除执行回执"
                      value={item.name}
                      onChange={(event) =>
                        setBatchItems(
                          batchItems.map((entry, entryIndex) =>
                            entryIndex === index ? { ...entry, name: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                    {batchItems.length > 1 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        colorScheme="red"
                        onClick={() =>
                          setBatchItems(batchItems.filter((_, entryIndex) => entryIndex !== index))
                        }
                      >
                        移除
                      </Button>
                    ) : null}
                  </Flex>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setBatchItems([...batchItems, { taskId: '', name: '' }])
                  }
                >
                  增加一项证据
                </Button>
                <Checkbox isChecked={simulateCrash} onChange={(event) => setSimulateCrash(event.target.checked)}>
                  模拟写入中断（第 1 项落账后中断，用于演示完整批次续做）
                </Checkbox>
              </VStack>
            ) : null}

            {dialog === 'backfill' ? (
              <VStack align="stretch" spacing="4">
                <Alert status="warning" borderRadius="5px">
                  旧数据缺少代理关系。回填后会立即冻结受理快照；补全前不能产出证据或导出处理包。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>代理关系（留空或输入 self 表示数据主体本人）</FormLabel>
                  <Select
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="数据主体本人"
                  >
                    {data.representatives
                      .filter(
                        (rep) =>
                          rep.kind !== 'self' &&
                          rep.status === 'active' &&
                          rep.verification.status === 'verified',
                      )
                      .map((rep) => (
                        <option key={rep.id} value={rep.id}>
                          {rep.kind === 'lawyer' ? '代理律师' : '代理人'} · {rep.name}
                        </option>
                      ))}
                  </Select>
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'review-package' ? (
              <FormControl isRequired>
                <FormLabel>已发出处理包的复核意见</FormLabel>
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="处理包保留发出时依据；说明是否需要通知接收方、作废重发或仅留痕"
                />
              </FormControl>
            ) : null}

            {['block', 'conflict', 'resolve', 'close'].includes(dialog ?? '') ? (
              <FormControl isRequired>
                <FormLabel>{dialog === 'close' ? '结果合并说明' : '原因与说明'}</FormLabel>
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={
                    dialog === 'close'
                      ? '说明各系统处理结果、保留的例外和最终结论'
                      : '填写可审计的原因和处理依据'
                  }
                />
              </FormControl>
            ) : null}

            {dialog === 'extend' ? (
              <VStack align="stretch" spacing="4">
                <FormControl isRequired>
                  <FormLabel>延期天数</FormLabel>
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    value={extendDays}
                    onChange={(event) => setExtendDays(Number(event.target.value))}
                  />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>延期原因</FormLabel>
                  <Textarea value={content} onChange={(event) => setContent(event.target.value)} />
                </FormControl>
              </VStack>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onClose}>
              取消
            </Button>
            <Button colorScheme="brand" onClick={submitDialog}>
              确认提交
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
