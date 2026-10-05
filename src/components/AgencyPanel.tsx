'use client'

import { useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
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
  Select,
  Text,
  Textarea,
  VStack,
  useDisclosure,
  useToast,
} from '@chakra-ui/react'
import { KeyRound, RefreshCw, Users } from 'lucide-react'
import {
  agencyChangeReasonLabels,
  agencyStatusLabels,
  type PrivacyRequest,
  type WorkspaceState,
} from '@/lib/schemas'
import {
  useAgencyBackfillMutation,
  useAgencyChangeMutation,
  useBatchRunMutation,
  useConcurrentSettleMutation,
  useReviewPackageMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'

type AgencyDialog =
  | 'change'
  | 'backfill'
  | 'batch'
  | 'race'
  | null

const statusColor: Record<string, string> = {
  confirmed: 'green',
  'pending-confirmation': 'orange',
  withdrawn: 'red',
  expired: 'red',
  replaced: 'purple',
}

export function AgencyPanel({ request }: { request: PrivacyRequest }) {
  const toast = useToast()
  const { data } = useWorkspaceQuery()
  const changeMutation = useAgencyChangeMutation()
  const backfillMutation = useAgencyBackfillMutation()
  const batchMutation = useBatchRunMutation()
  const raceMutation = useConcurrentSettleMutation()
  const reviewMutation = useReviewPackageMutation()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [dialog, setDialog] = useState<AgencyDialog>(null)
  const [reason, setReason] = useState<'withdrawal' | 'expiry' | 'replacement' | 'scope-adjustment'>(
    'withdrawal',
  )
  const [newAgentName, setNewAgentName] = useState('')
  const [newAgentContact, setNewAgentContact] = useState('')
  const [scopeSystemIds, setScopeSystemIds] = useState<string[]>([])
  const [validUntil, setValidUntil] = useState('')
  const [note, setNote] = useState('')
  const [representation, setRepresentation] = useState<'self' | 'agent'>('agent')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [simulateInterrupt, setSimulateInterrupt] = useState(false)
  const [failAfterTasks, setFailAfterTasks] = useState(1)
  const [raceOrder, setRaceOrder] = useState<'change-first' | 'complete-first'>('change-first')

  const agency = request.agency
  const currentScope = agency?.scope.systemIds ?? request.affectedSystemIds
  const systemName = (systemId: string) =>
    data?.systems.find((system) => system.id === systemId)?.name ?? systemId
  const activeTasks = request.tasks.filter(
    (task) =>
      !task.id.endsWith('-identity') &&
      !task.id.endsWith('-close') &&
      !task.id.endsWith('-merge') &&
      !task.id.endsWith('-review'),
  )
  const runningBatches = request.taskBatches.filter((batch) => batch.status !== 'completed')

  function open(type: AgencyDialog) {
    setDialog(type)
    setNote('')
    setNewAgentName('')
    setNewAgentContact('')
    setScopeSystemIds(agency?.scope.systemIds ?? request.affectedSystemIds)
    setValidUntil('')
    if (type === 'batch' && !idempotencyKey) {
      setIdempotencyKey(`batch-${request.code.toLowerCase()}-${Date.now().toString(36)}`)
    }
    onOpen()
  }

  async function submitChange() {
    try {
      await changeMutation.mutateAsync({
        requestId: request.id,
        reason,
        newAgentName: reason === 'replacement' ? newAgentName : '',
        newAgentContact: reason === 'replacement' ? newAgentContact : '',
        scopeSystemIds,
        validUntil,
        note,
        operator: '隐私负责人',
      })
      toast({
        title: '授权变更已冻结新依据',
        description: '未交付材料已失效重算；已发出处理包保留原依据并进入复核。',
        status: 'success',
      })
      onClose()
    } catch (error) {
      toast({
        title: '授权变更被拒绝',
        description: error instanceof Error ? error.message : '请检查当前代理关系状态',
        status: 'error',
      })
    }
  }

  async function submitBackfill() {
    try {
      await backfillMutation.mutateAsync({
        requestId: request.id,
        representation,
        agentName: newAgentName,
        agentContact: newAgentContact,
        scopeSystemIds,
        validUntil,
        note: note || '人工补全历史请求的代理关系。',
        operator: '隐私负责人',
      })
      toast({ title: '代理关系已回填确认，导出门禁解除', status: 'success' })
      onClose()
    } catch (error) {
      toast({
        title: '回填失败',
        description: error instanceof Error ? error.message : '请补全必填项',
        status: 'error',
      })
    }
  }

  async function submitBatch() {
    try {
      const result = (await batchMutation.mutateAsync({
        requestId: request.id,
        idempotencyKey,
        failAfterTasks: simulateInterrupt ? failAfterTasks : undefined,
        operator: '数据管理员',
      })) as WorkspaceState
      const batch = result.requests.find((item) => item.id === request.id)?.taskBatches[0]
      toast({
        title: batch?.status === 'interrupted' ? '批次已中断，状态已落盘' : '批次执行完成',
        description:
          batch?.status === 'interrupted'
            ? '使用相同幂等键重试将从断点续做，不重复生成证据。'
            : '完整批次按当前受理快照产出证据。',
        status: batch?.status === 'interrupted' ? 'warning' : 'success',
      })
      onClose()
    } catch (error) {
      toast({
        title: '批次未执行',
        description: error instanceof Error ? error.message : '请检查依据与范围',
        status: 'error',
      })
    }
  }

  async function submitRace() {
    const task = activeTasks.find((item) => item.status !== 'completed') ?? activeTasks[0]
    if (!task) {
      toast({ title: '没有可演示并发裁决的任务', status: 'warning' })
      return
    }
    try {
      const result = await raceMutation.mutateAsync({
        requestId: request.id,
        taskId: task.id,
        ordering: raceOrder,
        change: {
          reason,
          newAgentName: reason === 'replacement' ? newAgentName || '高源代理律师' : '',
          newAgentContact: reason === 'replacement' ? newAgentContact || 'gao***@law.example.com' : '',
          scopeSystemIds,
          validUntil,
          note: note || '并发窗口演示：授权变更窗口提交。',
          operator: '窗口A·隐私负责人',
        },
        taskOperator: '窗口B·数据管理员',
      })
      const rejected = result.actions.filter((item) => !item.accepted)
      toast({
        title: rejected.length ? '并发已裁决：后到动作被拒绝' : '并发已裁决：两个动作均落盘',
        description: result.actions
          .map(
            (item) =>
              `${item.kind === 'agency-change' ? '授权变更' : '任务完成'}：${item.accepted ? '接受' : `拒绝（${item.detail}）`}`,
          )
          .join(' / '),
        status: rejected.length ? 'warning' : 'success',
        duration: 9000,
      })
      onClose()
    } catch (error) {
      toast({
        title: '并发裁决失败',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  async function reviewPackage(packageId: string, resolution: 'confirm' | 'revoke') {
    try {
      await reviewMutation.mutateAsync({
        requestId: request.id,
        packageId,
        resolution,
        note:
          resolution === 'confirm'
            ? '复核确认：出具时授权有效，处理包保留当时依据继续有效。'
            : '复核撤销：出具依据存在瑕疵，通知接收方并启动补救。',
        operator: '隐私负责人',
      })
      toast({ title: resolution === 'confirm' ? '处理包已确认保留' : '处理包已撤销', status: 'success' })
    } catch (error) {
      toast({
        title: '复核失败',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  const title = dialog === 'change'
    ? '登记代理授权变更'
    : dialog === 'backfill'
      ? '回填历史代理关系'
      : dialog === 'batch'
        ? '按完整批次执行（可模拟写入中断）'
        : '两窗口并发：授权变更 × 任务完成'

  return (
    <Box className="panel">
      <Flex className="panel-title">
        <Heading size="sm">代理授权处置链</Heading>
        <Badge colorScheme={agency ? statusColor[agency.status] : 'red'}>
          {agency ? agencyStatusLabels[agency.status] : '旧数据待回填'}
        </Badge>
      </Flex>

      {!agency ? (
        <Alert status="error" borderRadius="5px" flexDirection="column" alignItems="flex-start">
          <Text fontWeight="600">旧数据缺少代理关系，已标记为待确认</Text>
          <Text mt="1" fontSize="sm">
            补全前系统任务不得产出证据，处理包导出也会被门禁阻断。
          </Text>
          <Button mt="3" size="xs" colorScheme="red" leftIcon={<KeyRound size={14} />} onClick={() => open('backfill')}>
            立即回填代理关系
          </Button>
        </Alert>
      ) : (
        <VStack align="stretch" spacing="3">
          <HStack justify="space-between">
            <Text fontSize="sm" color="gray.600">
              {agency.kind === 'agent' ? '代理人' : '本人办理'}
            </Text>
            <Text fontWeight="600">{agency.agentName}</Text>
          </HStack>
          {agency.kind === 'agent' && agency.agentContact ? (
            <HStack justify="space-between">
              <Text fontSize="sm" color="gray.600">代理联系方式</Text>
              <Text fontSize="sm">{agency.agentContact}</Text>
            </HStack>
          ) : null}
          <HStack justify="space-between">
            <Text fontSize="sm" color="gray.600">数据主体</Text>
            <Text fontSize="sm">{agency.subjectName}</Text>
          </HStack>
          <HStack justify="space-between">
            <Text fontSize="sm" color="gray.600">当前受理快照依据</Text>
            <Badge colorScheme="teal">v{agency.currentBasisVersion}</Badge>
          </HStack>
          <Box p="3" bg="gray.50" borderRadius="5px">
            <HStack mb="1">
              <Users size={14} color="#237b78" />
              <Text fontWeight="600" fontSize="sm">冻结的查看范围</Text>
            </HStack>
            <Text fontSize="sm" color="gray.600">
              {currentScope.map(systemName).join('、') || '（空，任务禁止产出）'}
            </Text>
            <Text mt="1" fontSize="xs" color="gray.500">
              冻结于 {new Date(agency.scope.frozenAt).toLocaleString('zh-CN')}，任务仅按此快照产出证据。
            </Text>
          </Box>

          {agency.status !== 'confirmed' ? (
            <Alert status="warning" borderRadius="5px">
              {agencyStatusLabels[agency.status]}：未交付材料已失效，需登记有效授权后按新快照重算。
            </Alert>
          ) : null}

          <VStack align="stretch">
            <Heading size="xs" mt="1">授权变更（生成新依据版本）</Heading>
            <HStack wrap="wrap">
              <Button size="xs" colorScheme="red" variant="outline" onClick={() => { setReason('withdrawal'); open('change') }}>
                被代理人撤回
              </Button>
              <Button size="xs" colorScheme="orange" variant="outline" onClick={() => { setReason('expiry'); open('change') }}>
                授权到期
              </Button>
              <Button size="xs" colorScheme="purple" variant="outline" onClick={() => { setReason('replacement'); open('change') }}>
                更换代理人
              </Button>
              <Button size="xs" variant="outline" onClick={() => { setReason('scope-adjustment'); open('change') }}>
                调整查看范围
              </Button>
            </HStack>
          </VStack>

          <VStack align="stretch">
            <Heading size="xs">系统任务批次（幂等续做）</Heading>
            <HStack wrap="wrap">
              <Button size="xs" colorScheme="brand" leftIcon={<RefreshCw size={13} />} onClick={() => open('batch')}>
                {runningBatches.length ? '从断点续做批次' : '执行完整批次'}
              </Button>
              <Button size="xs" variant="outline" onClick={() => open('race')}>
                模拟两窗口并发
              </Button>
            </HStack>
            {runningBatches.map((batch) => (
              <Box key={batch.id} p="2" bg="orange.50" borderRadius="5px">
                <Text fontSize="xs" fontWeight="600">
                  中断批次 {batch.idempotencyKey.slice(0, 22)}…
                </Text>
                <Text fontSize="xs" color="gray.600">
                  已完成 {batch.completedTaskIds.length}/{batch.taskIds.length}，依据 v{batch.basisVersion}。同键重试不重复生成证据。
                </Text>
              </Box>
            ))}
          </VStack>

          {request.packages.length ? (
            <VStack align="stretch">
              <Heading size="xs">已发出处理包（保留当时依据）</Heading>
              {request.packages.map((pkg) => (
                <Box key={pkg.id} p="3" bg={pkg.status === 'under-review' ? 'red.50' : 'green.50'} borderRadius="5px">
                  <HStack justify="space-between">
                    <Text fontWeight="600" fontSize="sm">{pkg.digest}</Text>
                    <Badge colorScheme={pkg.status === 'under-review' ? 'red' : 'green'}>
                      {pkg.status === 'under-review'
                        ? '复核中'
                        : pkg.status === 'review-confirmed'
                          ? '复核确认'
                          : pkg.status === 'review-revoked'
                            ? '复核撤销'
                            : '留存'}
                    </Badge>
                  </HStack>
                  <Text mt="1" fontSize="xs" color="gray.600">
                    交付 {pkg.deliveredTo} · 依据 v{pkg.basisVersion} · {new Date(pkg.deliveredAt).toLocaleDateString('zh-CN')}
                  </Text>
                  {pkg.reviewReason ? (
                    <Text mt="1" fontSize="xs" color="red.700">{pkg.reviewReason}</Text>
                  ) : null}
                  {pkg.reviewNote ? (
                    <Text mt="1" fontSize="xs" color="gray.600">复核意见：{pkg.reviewNote}</Text>
                  ) : null}
                  {pkg.status === 'under-review' ? (
                    <HStack mt="2">
                      <Button size="xs" colorScheme="green" onClick={() => void reviewPackage(pkg.id, 'confirm')}>
                        复核确认保留
                      </Button>
                      <Button size="xs" colorScheme="red" variant="outline" onClick={() => void reviewPackage(pkg.id, 'revoke')}>
                        复核撤销
                      </Button>
                    </HStack>
                  ) : null}
                </Box>
              ))}
            </VStack>
          ) : null}
        </VStack>
      )}

      <Modal isOpen={isOpen} onClose={onClose} size="lg">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{title}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {dialog === 'change' || dialog === 'race' ? (
              <VStack align="stretch" spacing="4">
                {dialog === 'race' ? (
                  <FormControl>
                    <FormLabel>窗口到达顺序</FormLabel>
                    <Select
                      value={raceOrder}
                      onChange={(event) => setRaceOrder(event.target.value as typeof raceOrder)}
                    >
                      <option value="change-first">授权变更先到，任务完成后到</option>
                      <option value="complete-first">任务完成先到，授权变更后到</option>
                    </Select>
                  </FormControl>
                ) : null}
                <FormControl>
                  <FormLabel>变更类型</FormLabel>
                  <Select value={reason} onChange={(event) => setReason(event.target.value as typeof reason)}>
                    {(['withdrawal', 'expiry', 'replacement', 'scope-adjustment'] as const).map((value) => (
                      <option key={value} value={value}>{agencyChangeReasonLabels[value]}</option>
                    ))}
                  </Select>
                </FormControl>
                {reason === 'replacement' ? (
                  <>
                    <FormControl isRequired>
                      <FormLabel>新代理人姓名</FormLabel>
                      <Input value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} placeholder="例如 高源代理律师" />
                    </FormControl>
                    <FormControl isRequired>
                      <FormLabel>新代理人联系方式</FormLabel>
                      <Input value={newAgentContact} onChange={(event) => setNewAgentContact(event.target.value)} placeholder="掩码后的执业邮箱或电话" />
                    </FormControl>
                  </>
                ) : null}
                <FormControl>
                  <FormLabel>新快照查看范围（系统）</FormLabel>
                  <VStack align="stretch">
                    {(data?.systems ?? []).map((system) => (
                      <Flex key={system.id} gap="2" align="center">
                        <input
                          type="checkbox"
                          checked={scopeSystemIds.includes(system.id)}
                          onChange={(event) =>
                            setScopeSystemIds(
                              event.target.checked
                                ? [...scopeSystemIds, system.id]
                                : scopeSystemIds.filter((id) => id !== system.id),
                            )
                          }
                        />
                        <Text fontSize="sm">{system.name}</Text>
                      </Flex>
                    ))}
                  </VStack>
                </FormControl>
                {reason === 'expiry' ? (
                  <FormControl>
                    <FormLabel>实际到期时间（可选）</FormLabel>
                    <Input type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
                  </FormControl>
                ) : null}
                <FormControl>
                  <FormLabel>说明</FormLabel>
                  <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录撤回/到期/换人依据，例如被代理人书面通知编号" />
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'backfill' ? (
              <VStack align="stretch" spacing="4">
                <Alert status="warning" borderRadius="5px">
                  仅历史请求缺少代理关系时使用。补全前导出与证据产出均被阻断。
                </Alert>
                <FormControl>
                  <FormLabel>办理方式</FormLabel>
                  <Select value={representation} onChange={(event) => setRepresentation(event.target.value as 'self' | 'agent')}>
                    <option value="self">数据主体本人办理</option>
                    <option value="agent">委托代理人办理</option>
                  </Select>
                </FormControl>
                {representation === 'agent' ? (
                  <>
                    <FormControl isRequired>
                      <FormLabel>代理人姓名</FormLabel>
                      <Input value={newAgentName} onChange={(event) => setNewAgentName(event.target.value)} />
                    </FormControl>
                    <FormControl isRequired>
                      <FormLabel>代理人联系方式</FormLabel>
                      <Input value={newAgentContact} onChange={(event) => setNewAgentContact(event.target.value)} />
                    </FormControl>
                  </>
                ) : null}
                <FormControl>
                  <FormLabel>受理时查看范围</FormLabel>
                  <VStack align="stretch">
                    {(data?.systems ?? []).map((system) => (
                      <Flex key={system.id} gap="2" align="center">
                        <input
                          type="checkbox"
                          checked={scopeSystemIds.includes(system.id)}
                          onChange={(event) =>
                            setScopeSystemIds(
                              event.target.checked
                                ? [...scopeSystemIds, system.id]
                                : scopeSystemIds.filter((id) => id !== system.id),
                            )
                          }
                        />
                        <Text fontSize="sm">{system.name}</Text>
                      </Flex>
                    ))}
                  </VStack>
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>回填依据说明</FormLabel>
                  <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如 已调阅 2026-09 受理工单与授权委托书扫描件" />
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'batch' ? (
              <VStack align="stretch" spacing="4">
                <Alert status="info" borderRadius="5px">
                  批次按当前受理快照依据逐任务产出证据；写入中断后用相同幂等键重试，从断点续做且不重复生成证据或处理包。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>幂等键</FormLabel>
                  <Input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} />
                </FormControl>
                <FormControl>
                  <FormLabel>模拟写入中断</FormLabel>
                  <HStack>
                    <input
                      type="checkbox"
                      checked={simulateInterrupt}
                      onChange={(event) => setSimulateInterrupt(event.target.checked)}
                    />
                    <Text fontSize="sm">完成前 N 个任务后中断（N=0 表示立即中断）</Text>
                  </HStack>
                  {simulateInterrupt ? (
                    <Input
                      mt="2"
                      type="number"
                      min={0}
                      value={failAfterTasks}
                      onChange={(event) => setFailAfterTasks(Number(event.target.value))}
                    />
                  ) : null}
                </FormControl>
              </VStack>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onClose}>取消</Button>
            <Button
              colorScheme="brand"
              isLoading={changeMutation.isPending || backfillMutation.isPending || batchMutation.isPending || raceMutation.isPending}
              onClick={() => {
                if (dialog === 'change') void submitChange()
                if (dialog === 'backfill') void submitBackfill()
                if (dialog === 'batch') void submitBatch()
                if (dialog === 'race') void submitRace()
              }}
            >
              确认提交
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
