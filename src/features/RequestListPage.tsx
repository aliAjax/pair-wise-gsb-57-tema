'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  useDisclosure,
  useToast,
} from '@chakra-ui/react'
import { Plus } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge, TypeBadge } from '@/components/StatusBadge'
import { useCreateRequestMutation, useWorkspaceQuery } from '@/lib/hooks'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import {
  regionLabels,
  requestStatusLabels,
  requestTypeLabels,
  type Region,
  type RequestStatus,
  type RequestType,
} from '@/lib/schemas'
import { deadlineState, templateName } from '@/services/workflow'

const initialForm = {
  dataSubjectName: '',
  dataSubjectContact: '',
  representativeId: '' as string,
  requesterName: '',
  requesterContact: '',
  region: 'cn' as Region,
  type: 'access' as RequestType,
  affectedSystemIds: [] as string[],
  identityMaterialType: 'masked-id' as
    | 'masked-id'
    | 'account-ownership'
    | 'authorization-letter'
    | 'none',
  identityReference: '',
  note: '',
}

export function RequestListPage() {
  const router = useRouter()
  const toast = useToast()
  const { data, isLoading } = useWorkspaceQuery()
  const createRequest = useCreateRequestMutation()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [form, setForm] = useState(initialForm)
  const store = useWorkspaceStore()

  if (isLoading || !data) return <Box className="panel">正在加载请求列表...</Box>

  const activeRepresentatives = data.representatives.filter(
    (rep) => rep.kind !== 'self' && rep.status === 'active' && rep.verification.status === 'verified',
  )
  const selectedRepresentative = activeRepresentatives.find(
    (rep) => rep.id === form.representativeId,
  )

  const filtered = data.requests.filter((request) => {
    const keyword = store.requestSearch.toLowerCase()
    return (
      (!keyword ||
        `${request.code}${request.dataSubjectName}${request.requesterName}${request.dataSubjectContact}`
          .toLowerCase()
          .includes(keyword)) &&
      (!store.requestType || request.type === store.requestType) &&
      (!store.requestStatus || request.status === store.requestStatus)
    )
  })

  async function submit() {
    if (!form.dataSubjectName.trim() || !form.dataSubjectContact.trim()) {
      toast({ title: '请填写数据主体姓名和掩码联系方式', status: 'warning' })
      return
    }
    if (!form.affectedSystemIds.length) {
      toast({ title: '请至少选择一个相关系统', status: 'warning' })
      return
    }
    if (form.representativeId) {
      const rep = activeRepresentatives.find((item) => item.id === form.representativeId)
      const outOfScope = form.affectedSystemIds.filter(
        (systemId) => !rep?.scopeSystemIds.includes(systemId),
      )
      if (outOfScope.length) {
        toast({
          title: '查看范围超出授权',
          description: `授权范围不包含所选系统，请调整系统或更换代理。`,
          status: 'error',
        })
        return
      }
    }
    const next = await createRequest.mutateAsync({
      input: {
        dataSubjectName: form.dataSubjectName,
        dataSubjectContact: form.dataSubjectContact,
        representativeId: form.representativeId || null,
        requesterName:
          form.requesterName.trim() ||
          (selectedRepresentative ? selectedRepresentative.name : form.dataSubjectName),
        requesterContact:
          form.requesterContact.trim() ||
          (selectedRepresentative ? selectedRepresentative.contact : form.dataSubjectContact),
        region: form.region,
        type: form.type,
        affectedSystemIds: form.affectedSystemIds,
        identityMaterialType: form.identityMaterialType,
        identityReference: form.identityReference,
        note: form.note,
      },
      operator: '客服专员',
    })
    const created = next.requests.find(
      (request) =>
        request.dataSubjectName === form.dataSubjectName &&
        request.dataSubjectContact === form.dataSubjectContact,
    )
    toast({
      title: '请求已登记，受理快照已冻结',
      description: created?.duplicateOf
        ? `检测到与 ${created.duplicateOf} 疑似重复，已进入复核队列。`
        : '已按代理关系与查看范围冻结快照并生成流程。',
      status: created?.duplicateOf ? 'warning' : 'success',
    })
    setForm(initialForm)
    onClose()
    if (created) router.push(`/requests/${created.id}`)
  }

  return (
    <Box>
      <PageHeader
        title="请求工作台"
        description="登记隐私权利请求，按地区和类型生成处理步骤，并跟踪期限、身份核验和系统任务。"
        actions={
          <Button colorScheme="brand" leftIcon={<Plus size={16} />} onClick={onOpen}>
            登记请求
          </Button>
        }
      />

      <Box className="toolbar">
        <Input
          width="290px"
          value={store.requestSearch}
          onChange={(event) => store.setRequestSearch(event.target.value)}
          placeholder="搜索编号、请求人或联系方式"
        />
        <Select
          width="150px"
          value={store.requestType}
          onChange={(event) => store.setRequestType(event.target.value as RequestType | '')}
          placeholder="请求类型"
        >
          {Object.entries(requestTypeLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          width="150px"
          value={store.requestStatus}
          onChange={(event) => store.setRequestStatus(event.target.value as RequestStatus | '')}
          placeholder="处理状态"
        >
          {Object.entries(requestStatusLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </Select>
        <Box className="grow" />
        <Text color="gray.600" fontSize="sm">
          共 {filtered.length} 条请求
        </Text>
      </Box>

      <Box className="panel">
        <TableContainer>
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>请求编号</Th>
                <Th>数据主体 / 代理人</Th>
                <Th>类型</Th>
                <Th>地区</Th>
                <Th>涉及系统</Th>
                <Th>状态</Th>
                <Th>剩余期限</Th>
                <Th>风险标记</Th>
                <Th>操作</Th>
              </Tr>
            </Thead>
            <Tbody>
              {filtered.map((request) => {
                const deadline = deadlineState(request.dueAt)
                return (
                  <Tr key={request.id}>
                    <Td className="mono">{request.code}</Td>
                    <Td>
                      <Text fontWeight="600">{request.dataSubjectName}</Text>
                      <Text color="gray.500" fontSize="xs">
                        {request.dataSubjectContact}
                      </Text>
                      {request.intakeSnapshot?.kind !== 'self' && request.intakeSnapshot ? (
                        <Text color="brand.600" fontSize="xs">
                          代理：{request.intakeSnapshot.representativeName}
                        </Text>
                      ) : (
                        <Text color="gray.400" fontSize="xs">本人申请</Text>
                      )}
                      {!request.intakeSnapshot ? (
                        <Badge colorScheme="yellow" mt="1">代理关系待回填</Badge>
                      ) : null}
                    </Td>
                    <Td>
                      <TypeBadge type={request.type} />
                    </Td>
                    <Td>{regionLabels[request.region]}</Td>
                    <Td>{request.affectedSystemIds.length} 个</Td>
                    <Td>
                      <StatusBadge status={request.status} />
                    </Td>
                    <Td color={deadline.color} fontWeight="600">
                      {deadline.label}
                    </Td>
                    <Td>
                      <HStack wrap="wrap" spacing="1">
                        {!request.intakeSnapshot ? (
                          <Badge colorScheme="yellow">缺代理快照</Badge>
                        ) : null}
                        {request.status === 'recalculating' ? (
                          <Badge colorScheme="orange">依据失效重算</Badge>
                        ) : null}
                        {request.duplicateOf ? <Badge colorScheme="orange">重复</Badge> : null}
                        {request.identity.status === 'insufficient' ? (
                          <Badge colorScheme="red">身份不足</Badge>
                        ) : null}
                        {request.conflicts.length ? (
                          <Badge colorScheme="red">{request.conflicts.length} 项冲突</Badge>
                        ) : null}
                      </HStack>
                    </Td>
                    <Td>
                      <Button
                        size="xs"
                        variant="link"
                        colorScheme="brand"
                        onClick={() => router.push(`/requests/${request.id}`)}
                      >
                        打开工作区
                      </Button>
                    </Td>
                  </Tr>
                )
              })}
            </Tbody>
          </Table>
        </TableContainer>
      </Box>

      <Modal isOpen={isOpen} onClose={onClose} size="xl">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>登记隐私权利请求</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Alert status="info" mb="4" borderRadius="5px">
              受理时立即冻结代理关系与查看范围快照；身份材料只保存掩码引用和摘要，不保存明文。
            </Alert>
            <Flex gap="4">
              <FormControl isRequired>
                <FormLabel>数据主体姓名</FormLabel>
                <Input
                  value={form.dataSubjectName}
                  onChange={(event) => setForm({ ...form, dataSubjectName: event.target.value })}
                />
              </FormControl>
              <FormControl isRequired>
                <FormLabel>数据主体掩码联系方式</FormLabel>
                <Input
                  value={form.dataSubjectContact}
                  onChange={(event) => setForm({ ...form, dataSubjectContact: event.target.value })}
                  placeholder="例如 zh***@example.com"
                />
              </FormControl>
            </Flex>

            <FormControl mt="4">
              <FormLabel>代理关系（受理即冻结查看范围）</FormLabel>
              <Select
                value={form.representativeId}
                onChange={(event) => setForm({ ...form, representativeId: event.target.value })}
              >
                <option value="">数据主体本人申请（查看范围与请求一致）</option>
                {activeRepresentatives.map((rep) => (
                  <option key={rep.id} value={rep.id}>
                    {rep.kind === 'lawyer' ? '代理律师' : '代理人'} · {rep.name}（{rep.scopeSystemIds.length} 个系统）
                  </option>
                ))}
              </Select>
              {selectedRepresentative ? (
                <Alert status="warning" mt="2" borderRadius="5px">
                  仅限授权范围：{selectedRepresentative.scopeSystemIds.join('、')}
                  {selectedRepresentative.expiresAt
                    ? `；授权至 ${new Date(selectedRepresentative.expiresAt).toLocaleDateString('zh-CN')}`
                    : ''}
                </Alert>
              ) : null}
            </FormControl>

            {selectedRepresentative ? (
              <Flex gap="4" mt="4">
                <FormControl>
                  <FormLabel>代为提交人姓名</FormLabel>
                  <Input
                    value={form.requesterName}
                    onChange={(event) => setForm({ ...form, requesterName: event.target.value })}
                    placeholder={selectedRepresentative.name}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>代为提交人联系方式</FormLabel>
                  <Input
                    value={form.requesterContact}
                    onChange={(event) => setForm({ ...form, requesterContact: event.target.value })}
                    placeholder={selectedRepresentative.contact}
                  />
                </FormControl>
              </Flex>
            ) : null}

            <Flex gap="4" mt="4">
              <FormControl isRequired>
                <FormLabel>地区</FormLabel>
                <Select
                  value={form.region}
                  onChange={(event) => setForm({ ...form, region: event.target.value as Region })}
                >
                  {Object.entries(regionLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormControl isRequired>
                <FormLabel>请求类型</FormLabel>
                <Select
                  value={form.type}
                  onChange={(event) => setForm({ ...form, type: event.target.value as RequestType })}
                >
                  {Object.entries(requestTypeLabels).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </FormControl>
            </Flex>

            <FormControl mt="4" isRequired>
              <FormLabel>相关系统</FormLabel>
              <HStack wrap="wrap">
                {data.systems.map((system) => (
                  <Checkbox
                    key={system.id}
                    isChecked={form.affectedSystemIds.includes(system.id)}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        affectedSystemIds: event.target.checked
                          ? [...form.affectedSystemIds, system.id]
                          : form.affectedSystemIds.filter((id) => id !== system.id),
                      })
                    }
                  >
                    {system.name}
                  </Checkbox>
                ))}
              </HStack>
            </FormControl>

            <Flex gap="4" mt="4">
              <FormControl isRequired>
                <FormLabel>身份材料类型</FormLabel>
                <Select
                  value={form.identityMaterialType}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      identityMaterialType: event.target.value as typeof form.identityMaterialType,
                    })
                  }
                >
                  <option value="masked-id">掩码证件</option>
                  <option value="account-ownership">账号所有权证明</option>
                  <option value="authorization-letter">授权书</option>
                  <option value="none">暂无材料</option>
                </Select>
              </FormControl>
              <FormControl isRequired>
                <FormLabel>材料摘要引用</FormLabel>
                <Input
                  value={form.identityReference}
                  onChange={(event) => setForm({ ...form, identityReference: event.target.value })}
                  placeholder="例如 310***********1234 或核验单编号"
                />
              </FormControl>
            </Flex>

            <FormControl mt="4">
              <FormLabel>登记说明</FormLabel>
              <Textarea
                value={form.note}
                onChange={(event) => setForm({ ...form, note: event.target.value })}
                placeholder="记录客户说明、材料范围和需要关注的处理要求"
              />
            </FormControl>

            <Alert status="success" mt="4" borderRadius="5px">
              将生成：{templateName(form.region, form.type)}
            </Alert>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onClose}>
              取消
            </Button>
            <Button colorScheme="brand" isLoading={createRequest.isPending} onClick={submit}>
              登记并打开
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}
