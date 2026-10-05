'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Alert,
  Badge,
  Box,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
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
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge } from '@/components/StatusBadge'
import {
  useExtendRequestMutation,
  useResolveConflictMutation,
  useVerifyIdentityMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import { deadlineState } from '@/services/workflow'

export function ReviewPage() {
  const router = useRouter()
  const toast = useToast()
  const { data, isLoading } = useWorkspaceQuery()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const verifyIdentity = useVerifyIdentityMutation()
  const resolveConflict = useResolveConflictMutation()
  const extendRequest = useExtendRequestMutation()
  const [selectedId, setSelectedId] = useState('')
  const [action, setAction] = useState<'identity-pass' | 'identity-return' | 'resolve' | 'extend'>(
    'identity-pass',
  )
  const [conflictIndex, setConflictIndex] = useState(0)
  const [content, setContent] = useState('')
  const [days, setDays] = useState(15)

  const queue = useMemo(
    () =>
      data?.requests.filter(
        (request) =>
          request.status === 'review-required' ||
          request.status === 'recalculating' ||
          request.identity.status === 'insufficient' ||
          !request.intakeSnapshot ||
          request.duplicateOf ||
          request.conflicts.length > 0 ||
          request.deliveryPackages.some((pkg) => pkg.status === 'under-review') ||
          new Date(request.dueAt).getTime() < Date.now(),
      ) ?? [],
    [data],
  )

  if (isLoading || !data) return <Box className="panel">正在加载复核队列...</Box>

  const selected = data.requests.find((request) => request.id === selectedId)

  function openAction(
    requestId: string,
    nextAction: 'identity-pass' | 'identity-return' | 'resolve' | 'extend',
    index = 0,
  ) {
    setSelectedId(requestId)
    setAction(nextAction)
    setConflictIndex(index)
    setContent('')
    onOpen()
  }

  async function submit() {
    if (!selected) return
    try {
      if (action === 'identity-pass') {
        await verifyIdentity.mutateAsync({
          requestId: selected.id,
          status: 'verified',
          note: content || '补充材料经人工核验通过。',
          operator: '隐私负责人',
        })
      } else if (action === 'identity-return') {
        await verifyIdentity.mutateAsync({
          requestId: selected.id,
          status: 'insufficient',
          note: content,
          operator: '隐私负责人',
        })
      } else if (action === 'resolve') {
        await resolveConflict.mutateAsync({
          requestId: selected.id,
          conflictIndex,
          resolution: content,
          operator: '隐私负责人',
        })
      } else {
        await extendRequest.mutateAsync({
          requestId: selected.id,
          days,
          reason: content,
          operator: '隐私负责人',
        })
      }
      toast({ title: '复核动作已记录', status: 'success' })
      onClose()
    } catch (error) {
      toast({
        title: '复核操作失败',
        description: error instanceof Error ? error.message : '请检查输入',
        status: 'error',
      })
    }
  }

  return (
    <Box>
      <PageHeader
        title="复核队列"
        description="集中处理重复请求、身份材料不足、跨系统结果冲突和逾期请求；不得静默关闭。"
      />

      <Alert status="warning" mb="4" borderRadius="5px">
        截止时间前关闭必须填写理由；代理撤回/到期/换人后，未交付材料失效重算、已发出处理包保留依据复核，均在本队列处理。
      </Alert>

      <SimpleGrid columns={4} spacing="4" mb="5">
        <Box className="metric danger">
          <Text color="gray.600" fontSize="sm">
            队列总数
          </Text>
          <Heading mt="2" size="md">
            {queue.length}
          </Heading>
        </Box>
        <Box className="metric warning">
          <Text color="gray.600" fontSize="sm">
            身份材料不足
          </Text>
          <Heading mt="2" size="md">
            {queue.filter((request) => request.identity.status === 'insufficient').length}
          </Heading>
        </Box>
        <Box className="metric danger">
          <Text color="gray.600" fontSize="sm">
            结果冲突
          </Text>
          <Heading mt="2" size="md">
            {queue.reduce((total, request) => total + request.conflicts.length, 0)}
          </Heading>
        </Box>
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">
            代理依据异常
          </Text>
          <Heading mt="2" size="md">
            {queue.filter(
              (request) =>
                !request.intakeSnapshot ||
                request.status === 'recalculating' ||
                request.deliveryPackages.some((pkg) => pkg.status === 'under-review'),
            ).length}
          </Heading>
        </Box>
      </SimpleGrid>

      <Box className="panel">
        <TableContainer>
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>请求</Th>
                <Th>状态</Th>
                <Th>复核原因</Th>
                <Th>身份状态</Th>
                <Th>期限</Th>
                <Th>操作</Th>
              </Tr>
            </Thead>
            <Tbody>
              {queue.map((request) => {
                const deadline = deadlineState(request.dueAt)
                return (
                  <Tr key={request.id}>
                    <Td>
                      <Text fontWeight="600">{request.code}</Text>
                      <Text color="gray.500" fontSize="xs">
                        {request.requesterName}
                      </Text>
                    </Td>
                    <Td>
                      <StatusBadge status={request.status} />
                    </Td>
                    <Td maxW="360px">
                      <VStack align="stretch" spacing="1">
                        {!request.intakeSnapshot ? (
                          <Badge colorScheme="yellow" w="fit-content">
                            旧数据缺少代理关系：待回填，补全前禁止导出
                          </Badge>
                        ) : null}
                        {request.status === 'recalculating' ? (
                          <Badge colorScheme="orange" w="fit-content">
                            授权依据失效：未交付材料已作废，任务重算中
                          </Badge>
                        ) : null}
                        {request.intakeSnapshot?.invalidatedReason ? (
                          <Text fontSize="sm" color="red.600">
                            快照失效：{request.intakeSnapshot.invalidatedReason}
                          </Text>
                        ) : null}
                        {request.deliveryPackages
                          .filter((pkg) => pkg.status === 'under-review')
                          .map((pkg) => (
                            <Badge key={pkg.id} colorScheme="orange" w="fit-content">
                              已发出包 {pkg.code} 依据变更复核中
                            </Badge>
                          ))}
                        {request.duplicateOf ? (
                          <Badge colorScheme="orange">疑似重复 {request.duplicateOf}</Badge>
                        ) : null}
                        {request.conflicts.map((conflict, index) => (
                          <Text key={`${conflict}-${index}`} fontSize="sm">
                            {conflict}
                          </Text>
                        ))}
                      </VStack>
                    </Td>
                    <Td>
                      <Badge
                        colorScheme={
                          request.identity.status === 'verified'
                            ? 'green'
                            : request.identity.status === 'insufficient'
                              ? 'red'
                              : 'orange'
                        }
                      >
                        {request.identity.status}
                      </Badge>
                    </Td>
                    <Td color={deadline.color} fontWeight="600">
                      {deadline.label}
                    </Td>
                    <Td>
                      <HStack wrap="wrap">
                        <Button
                          size="xs"
                          variant="link"
                          onClick={() => router.push(`/requests/${request.id}`)}
                        >
                          打开
                        </Button>
                        {request.identity.status !== 'verified' ? (
                          <Button
                            size="xs"
                            variant="link"
                            colorScheme="green"
                            onClick={() => openAction(request.id, 'identity-pass')}
                          >
                            通过身份
                          </Button>
                        ) : null}
                        {request.conflicts.length ? (
                          <Button
                            size="xs"
                            variant="link"
                            colorScheme="red"
                            onClick={() => openAction(request.id, 'resolve', 0)}
                          >
                            处理冲突
                          </Button>
                        ) : null}
                        <Button
                          size="xs"
                          variant="link"
                          colorScheme="orange"
                          onClick={() => openAction(request.id, 'extend')}
                        >
                          延期
                        </Button>
                      </HStack>
                    </Td>
                  </Tr>
                )
              })}
            </Tbody>
          </Table>
        </TableContainer>
      </Box>

      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{selected ? `${selected.code} · 复核处理` : '复核处理'}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack align="stretch" spacing="4">
              {action === 'resolve' && selected?.conflicts[conflictIndex] ? (
                <Alert status="warning" borderRadius="5px">
                  {selected.conflicts[conflictIndex]}
                </Alert>
              ) : null}
              {action === 'extend' ? (
                <FormControl isRequired>
                  <FormLabel>延期天数</FormLabel>
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    value={days}
                    onChange={(event) => setDays(Number(event.target.value))}
                  />
                </FormControl>
              ) : null}
              <FormControl isRequired>
                <FormLabel>
                  {action === 'resolve' ? '复核结论' : action === 'extend' ? '延期原因' : '核验说明'}
                </FormLabel>
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="填写可审计的依据和处理结论"
                />
              </FormControl>
              <Select
                value={action}
                display="none"
                onChange={(event) => setAction(event.target.value as typeof action)}
              />
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onClose}>
              取消
            </Button>
            <Button colorScheme="brand" isDisabled={!content.trim()} onClick={submit}>
              提交复核
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
