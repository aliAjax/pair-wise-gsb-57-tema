'use client'

import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
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
import { FileSignature, Scale, UserRound } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import {
  useChangeRepresentationMutation,
  useRegisterRepresentativeMutation,
  useVerifyRepresentativeMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import {
  representationStatusLabels,
  representativeKindLabels,
  type Representative,
  type RepresentativeKind,
  type RequestType,
} from '@/lib/schemas'

const statusColor: Record<Representative['status'], string> = {
  active: 'green',
  revoked: 'red',
  expired: 'gray',
  superseded: 'orange',
  'pending-confirmation': 'yellow',
}

const initialForm = {
  kind: 'lawyer' as RepresentativeKind,
  name: '',
  contact: '',
  credentialRef: '',
  scopeSystemIds: [] as string[],
  scopeRequestTypes: [] as RequestType[],
  validDays: 90,
}

export function RepresentativesPage() {
  const toast = useToast()
  const { data, isLoading } = useWorkspaceQuery()
  const register = useRegisterRepresentativeMutation()
  const verify = useVerifyRepresentativeMutation()
  const change = useChangeRepresentationMutation()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [form, setForm] = useState(initialForm)
  const [target, setTarget] = useState<Representative>()
  const [action, setAction] = useState<'verify-pass' | 'verify-fail' | 'revoke' | 'expire' | 'replace'>('revoke')
  const [reason, setReason] = useState('')

  const linkedCount = useMemo(() => {
    const map = new Map<string, number>()
    data?.requests.forEach((request) => {
      const id = request.intakeSnapshot?.representativeId
      if (id) map.set(id, (map.get(id) ?? 0) + 1)
    })
    return map
  }, [data])

  if (isLoading || !data) return <Box className="panel">正在加载代理授权...</Box>

  function openRegister() {
    setForm(initialForm)
    setAction('revoke')
    onOpen()
  }

  function openAction(
    representative: Representative,
    next: 'verify-pass' | 'verify-fail' | 'revoke' | 'expire' | 'replace',
  ) {
    setTarget(representative)
    setAction(next)
    setReason('')
    if (next === 'replace') {
      setForm({
        ...initialForm,
        scopeSystemIds: [...representative.scopeSystemIds],
        scopeRequestTypes: [...representative.scopeRequestTypes],
      })
    }
    onOpen()
  }

  async function submit() {
    try {
      if (action === 'verify-pass' && target) {
        await verify.mutateAsync({
          representativeId: target.id,
          status: 'verified',
          note: reason || '授权委托书与执业/身份资质复核通过。',
          operator: '隐私负责人',
        })
        toast({ title: '代理授权已核验通过', status: 'success' })
      } else if (action === 'verify-fail' && target) {
        if (!reason.trim()) throw new Error('请填写材料不足说明')
        await verify.mutateAsync({
          representativeId: target.id,
          status: 'insufficient',
          note: reason,
          operator: '隐私负责人',
        })
        toast({ title: '已标记授权材料不足', status: 'warning' })
      } else if ((action === 'revoke' || action === 'expire') && target) {
        if (!reason.trim()) throw new Error('请填写撤回/到期原因')
        await change.mutateAsync({
          representativeId: target.id,
          action,
          reason,
          baseRevision: data!.revision,
          operator: '隐私负责人',
        })
        toast({
          title: action === 'revoke' ? '撤回已生效' : '到期已登记',
          description: '未交付材料已失效重算，已发出处理包保留依据并进入复核。',
          status: 'success',
        })
      } else if (action === 'replace' && target) {
        if (!reason.trim()) throw new Error('请填写换人原因')
        if (!form.name.trim() || !form.contact.trim() || !form.credentialRef.trim()) {
          throw new Error('请补全新代理人信息')
        }
        if (!form.scopeSystemIds.length) throw new Error('请至少勾选一个查看范围系统')
        await change.mutateAsync({
          representativeId: target.id,
          action: 'replace',
          reason,
          successor: form,
          baseRevision: data!.revision,
          operator: '隐私负责人',
        })
        toast({
          title: '已完成换人',
          description: '在途请求已按新代理关系冻结新快照，旧材料失效并触发重算。',
          status: 'success',
        })
      } else {
        if (!form.name.trim() || !form.contact.trim() || !form.credentialRef.trim()) {
          throw new Error('请补全代理人信息与资质编号')
        }
        if (!form.scopeSystemIds.length) throw new Error('请至少勾选一个查看范围系统')
        await register.mutateAsync({ ...form, operator: '客服专员' })
        toast({ title: '代理授权已登记，等待核验', status: 'success' })
      }
      onClose()
    } catch (error) {
      toast({
        title: '操作未完成',
        description: error instanceof Error ? error.message : '请检查输入',
        status: 'error',
      })
    }
  }

  const requestTypes: RequestType[] = ['access', 'rectification', 'deletion', 'withdraw-consent', 'restriction']
  const showForm = isRegisterMode()

  function isRegisterMode() {
    return !['verify-pass', 'verify-fail', 'revoke', 'expire', 'replace'].includes(action) || !target
  }

  const modalTitle =
    action === 'verify-pass'
      ? `核验通过 · ${target?.name ?? ''}`
      : action === 'verify-fail'
        ? `材料不足 · ${target?.name ?? ''}`
        : action === 'revoke'
          ? `撤回授权 · ${target?.name ?? ''}`
          : action === 'expire'
            ? `授权到期 · ${target?.name ?? ''}`
            : action === 'replace'
              ? `更换代理人 · 原代理人 ${target?.name ?? ''}`
              : '登记代理授权'

  return (
    <Box>
      <PageHeader
        title="代理授权与查看范围"
        description="登记代理律师/代理人资质并核验；撤回、到期、换人一条处置链接入在途请求：未交付材料失效重算，已发出包保留依据复核。"
        actions={
          <Button colorScheme="brand" leftIcon={<Scale size={16} />} onClick={openRegister}>
            登记代理授权
          </Button>
        }
      />

      <Alert status="info" mb="4" borderRadius="5px">
        受理时会冻结代理关系与查看范围快照，任务证据只按该快照产出；授权变更不会改写已生成的证据与已发出的处理包。
      </Alert>

      <SimpleGrid columns={4} spacing="4" mb="5">
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">代理关系总数</Text>
          <Heading mt="2" size="md">{data.representatives.filter((rep) => rep.kind !== 'self').length}</Heading>
          <Text mt="1" color="gray.500" fontSize="xs">本人关系不计入</Text>
        </Box>
        <Box className="metric">
          <Text color="gray.600" fontSize="sm">授权有效</Text>
          <Heading mt="2" size="md">
            {data.representatives.filter((rep) => rep.kind !== 'self' && rep.status === 'active').length}
          </Heading>
        </Box>
        <Box className="metric warning">
          <Text color="gray.600" fontSize="sm">待核验</Text>
          <Heading mt="2" size="md">
            {data.representatives.filter((rep) => rep.verification.status === 'pending').length}
          </Heading>
        </Box>
        <Box className="metric danger">
          <Text color="gray.600" fontSize="sm">已撤回/到期/换人</Text>
          <Heading mt="2" size="md">
            {data.representatives.filter((rep) => rep.status !== 'active').length}
          </Heading>
        </Box>
      </SimpleGrid>

      <Box className="panel">
        <TableContainer>
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>代理人</Th>
                <Th>资质摘要</Th>
                <Th>查看范围</Th>
                <Th>有效期</Th>
                <Th>状态/核验</Th>
                <Th>在途请求</Th>
                <Th>操作</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.representatives.filter((rep) => rep.kind !== 'self').map((rep) => (
                <Tr key={rep.id}>
                  <Td>
                    <HStack>
                      {rep.kind === 'lawyer' ? <Scale size={15} color="#237b78" /> : <UserRound size={15} />}
                      <Box>
                        <Text fontWeight="600">{rep.name}</Text>
                        <Text color="gray.500" fontSize="xs">{rep.contact}</Text>
                      </Box>
                    </HStack>
                  </Td>
                  <Td>
                    <Text className="mono" fontSize="xs">{rep.credentialRef}</Text>
                    <Text color="gray.500" fontSize="xs">{rep.credentialDigest}</Text>
                  </Td>
                  <Td>
                    <Text>{rep.scopeSystemIds.length} 个系统</Text>
                    <Text color="gray.500" fontSize="xs">
                      {rep.scopeRequestTypes.length
                        ? rep.scopeRequestTypes.length + ' 类请求'
                        : '全部权利类型'}
                    </Text>
                  </Td>
                  <Td>
                    <Text fontSize="xs">{new Date(rep.grantedAt).toLocaleDateString('zh-CN')}</Text>
                    <Text fontSize="xs" color="gray.500">
                      {rep.expiresAt ? `至 ${new Date(rep.expiresAt).toLocaleDateString('zh-CN')}` : '长期'}
                    </Text>
                  </Td>
                  <Td>
                    <VStack align="flex-start" spacing="1">
                      <Badge colorScheme={statusColor[rep.status]}>
                        {representationStatusLabels[rep.status]}
                      </Badge>
                      <Badge
                        colorScheme={
                          rep.verification.status === 'verified'
                            ? 'green'
                            : rep.verification.status === 'insufficient'
                              ? 'red'
                              : 'orange'
                        }
                        variant="outline"
                      >
                        核验{rep.verification.status === 'verified' ? '通过' : rep.verification.status === 'insufficient' ? '不足' : '待办'}
                      </Badge>
                    </VStack>
                  </Td>
                  <Td>{linkedCount.get(rep.id) ?? 0} 个</Td>
                  <Td>
                    <VStack align="flex-start" spacing="1">
                      {rep.verification.status !== 'verified' && rep.status === 'active' ? (
                        <HStack>
                          <Button size="xs" variant="link" colorScheme="green" onClick={() => openAction(rep, 'verify-pass')}>
                            核验通过
                          </Button>
                          <Button size="xs" variant="link" colorScheme="red" onClick={() => openAction(rep, 'verify-fail')}>
                            材料不足
                          </Button>
                        </HStack>
                      ) : null}
                      {rep.status === 'active' ? (
                        <HStack>
                          <Button size="xs" variant="link" colorScheme="red" onClick={() => openAction(rep, 'revoke')}>
                            撤回
                          </Button>
                          <Button size="xs" variant="link" colorScheme="gray" onClick={() => openAction(rep, 'expire')}>
                            到期
                          </Button>
                          <Button size="xs" variant="link" colorScheme="orange" onClick={() => openAction(rep, 'replace')}>
                            换人
                          </Button>
                        </HStack>
                      ) : (
                        <Text color="gray.400" fontSize="xs">
                          {rep.history[0]?.reason ?? '关系已终结'}
                        </Text>
                      )}
                    </VStack>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </TableContainer>
      </Box>

      <Box className="panel" mt="4">
        <Flex className="panel-title">
          <Heading size="sm">处置链规则</Heading>
          <FileSignature size={16} color="#237b78" />
        </Flex>
        <VStack align="stretch" spacing="2" color="gray.600" fontSize="sm">
          <Text>1. 受理时冻结代理关系与查看范围，后续证据只按该快照产出。</Text>
          <Text>2. 被代理人撤回、授权到期或换人：未交付材料立即失效并回到任务重算；已发出处理包保留当时依据与摘要，进入复核队列。</Text>
          <Text>3. 换人自动登记新代理并为在途请求冻结新快照；旧代理标记为已换人。</Text>
          <Text>4. 两个窗口同时提交时按最新版本判断，后到动作不会覆盖已生成结果。</Text>
          <Text>5. 旧数据缺少代理关系时先回填待确认，补全受理快照前不能导出。</Text>
        </VStack>
      </Box>

      <Modal isOpen={isOpen} onClose={onClose} size="xl">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{modalTitle}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {showForm ? (
              <VStack align="stretch" spacing="4">
                <Flex gap="4">
                  <FormControl isRequired>
                    <FormLabel>代理类型</FormLabel>
                    <Select
                      value={form.kind}
                      isDisabled={action === 'replace'}
                      onChange={(event) => setForm({ ...form, kind: event.target.value as RepresentativeKind })}
                    >
                      <option value="lawyer">代理律师</option>
                      <option value="agent">其他代理人</option>
                    </Select>
                  </FormControl>
                  <FormControl isRequired>
                    <FormLabel>有效期（天）</FormLabel>
                    <Input
                      type="number"
                      min={1}
                      max={3650}
                      value={form.validDays}
                      onChange={(event) => setForm({ ...form, validDays: Number(event.target.value) })}
                    />
                  </FormControl>
                </Flex>
                <Flex gap="4">
                  <FormControl isRequired>
                    <FormLabel>代理人姓名</FormLabel>
                    <Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                  </FormControl>
                  <FormControl isRequired>
                    <FormLabel>掩码联系方式</FormLabel>
                    <Input value={form.contact} onChange={(event) => setForm({ ...form, contact: event.target.value })} />
                  </FormControl>
                </Flex>
                <FormControl isRequired>
                  <FormLabel>执业证 / 授权书 / 资质编号</FormLabel>
                  <Input
                    value={form.credentialRef}
                    onChange={(event) => setForm({ ...form, credentialRef: event.target.value })}
                    placeholder="仅登记编号与摘要，不保存材料明文"
                  />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>查看范围（授权系统）</FormLabel>
                  <HStack wrap="wrap">
                    {data.systems.map((system) => (
                      <Checkbox
                        key={system.id}
                        isChecked={form.scopeSystemIds.includes(system.id)}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            scopeSystemIds: event.target.checked
                              ? [...form.scopeSystemIds, system.id]
                              : form.scopeSystemIds.filter((id) => id !== system.id),
                          })
                        }
                      >
                        {system.name}
                      </Checkbox>
                    ))}
                  </HStack>
                </FormControl>
                <FormControl>
                  <FormLabel>授权请求类型（不勾为全部）</FormLabel>
                  <HStack wrap="wrap">
                    {requestTypes.map((type) => (
                      <Checkbox
                        key={type}
                        isChecked={form.scopeRequestTypes.includes(type)}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            scopeRequestTypes: event.target.checked
                              ? [...form.scopeRequestTypes, type]
                              : form.scopeRequestTypes.filter((item) => item !== type),
                          })
                        }
                      >
                        {representativeKindLabels &&
                          ({ access: '访问', rectification: '更正', deletion: '删除', 'withdraw-consent': '撤回同意', restriction: '限制处理' } as Record<RequestType, string>)[type]}
                      </Checkbox>
                    ))}
                  </HStack>
                </FormControl>
                {action === 'replace' ? (
                  <FormControl isRequired>
                    <FormLabel>换人原因</FormLabel>
                    <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="记录被代理人换人的依据" />
                  </FormControl>
                ) : null}
              </VStack>
            ) : (
              <FormControl isRequired={action !== 'verify-pass'}>
                <FormLabel>
                  {action === 'verify-pass'
                    ? '核验说明（可留空）'
                    : action === 'verify-fail'
                      ? '材料不足说明'
                      : action === 'revoke'
                        ? '撤回原因（数据主体撤回）'
                        : '到期原因'}
                </FormLabel>
                <Textarea value={reason} onChange={(event) => setReason(event.target.value)} />
              </FormControl>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onClose}>取消</Button>
            <Button
              colorScheme="brand"
              isLoading={register.isPending || verify.isPending || change.isPending}
              onClick={submit}
            >
              {action === 'replace' ? '确认换人并重算' : showForm ? '登记授权' : '确认提交'}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
