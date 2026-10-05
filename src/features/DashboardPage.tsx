'use client'

import NextLink from 'next/link'
import {
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Progress,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  VStack,
} from '@chakra-ui/react'
import { AlertTriangle, ArrowRight, Clock3, Database, Scale, ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge, TypeBadge } from '@/components/StatusBadge'
import { useWorkspaceQuery } from '@/lib/hooks'
import { deadlineState } from '@/services/workflow'
import { regionLabels } from '@/lib/schemas'

export function DashboardPage() {
  const { data, isLoading, error } = useWorkspaceQuery()

  if (isLoading || !data) return <Box className="panel">正在加载履约工作区...</Box>
  if (error) return <Box className="panel">工作区加载失败：{error.message}</Box>

  const openRequests = data.requests.filter(
    (request) => !['completed', 'rejected'].includes(request.status),
  )
  const reviewRequests = data.requests.filter(
    (request) =>
      request.status === 'review-required' ||
      request.status === 'recalculating' ||
      request.identity.status === 'insufficient' ||
      request.conflicts.length > 0,
  )
  const overdueRequests = openRequests.filter(
    (request) => new Date(request.dueAt).getTime() < Date.now(),
  )
  const missingBasisRequests = data.requests.filter((request) => !request.intakeSnapshot)
  const packagesUnderReview = data.requests.reduce(
    (total, request) =>
      total + request.deliveryPackages.filter((pkg) => pkg.status === 'under-review').length,
    0,
  )
  const recalculatingRequests = data.requests.filter(
    (request) => request.status === 'recalculating',
  )
  const completedTasks = data.requests.reduce(
    (total, request) => total + request.tasks.filter((task) => task.status === 'completed').length,
    0,
  )
  const totalTasks = data.requests.reduce((total, request) => total + request.tasks.length, 0)

  const sorted = [...openRequests].sort(
    (left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime(),
  )

  return (
    <Box>
      <PageHeader
        title="履约运行总览"
        description="汇总请求期限、身份核验、跨系统执行、冲突复核和操作审计。"
        actions={
          <>
            <NextLink href="/review">
              <Button variant="outline">查看复核队列</Button>
            </NextLink>
            <NextLink href="/requests">
              <Button colorScheme="brand">登记或处理请求</Button>
            </NextLink>
          </>
        }
      />

      <Box className="metric-grid">
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">
            未完成请求
          </Text>
          <Heading mt="2" mb="1" size="lg">
            {openRequests.length}
          </Heading>
          <Text color="gray.500" fontSize="xs">
            覆盖访问、更正、删除、撤回同意和限制处理
          </Text>
        </Box>
        <Box className="metric danger">
          <Text color="gray.600" fontSize="sm">
            复核队列
          </Text>
          <Heading mt="2" mb="1" size="lg">
            {reviewRequests.length}
          </Heading>
          <Text color="gray.500" fontSize="xs">
            重复请求、身份材料不足或结果冲突
          </Text>
        </Box>
        <Box className="metric warning">
          <Text color="gray.600" fontSize="sm">
            已逾期
          </Text>
          <Heading mt="2" mb="1" size="lg">
            {overdueRequests.length}
          </Heading>
          <Text color="gray.500" fontSize="xs">
            逾期请求不会自动关闭
          </Text>
        </Box>
        <Box className="metric">
          <Text color="gray.600" fontSize="sm">
            任务完成度
          </Text>
          <Heading mt="2" mb="1" size="lg">
            {completedTasks} / {totalTasks}
          </Heading>
          <Progress
            mt="2"
            size="sm"
            value={totalTasks ? (completedTasks / totalTasks) * 100 : 0}
            colorScheme="brand"
          />
        </Box>
      </Box>

      {missingBasisRequests.length || packagesUnderReview || recalculatingRequests.length ? (
        <Box className="panel" mb="4" p="4">
          <HStack spacing="6">
            {missingBasisRequests.length ? (
              <Badge colorScheme="yellow" p="2">
                {missingBasisRequests.length} 个旧数据待回填代理关系，导出已阻断
              </Badge>
            ) : null}
            {recalculatingRequests.length ? (
              <Badge colorScheme="orange" p="2">
                {recalculatingRequests.length} 个请求授权依据失效，未交付材料重算中
              </Badge>
            ) : null}
            {packagesUnderReview ? (
              <Badge colorScheme="red" p="2">
                {packagesUnderReview} 个已发出处理包保留依据并进入复核
              </Badge>
            ) : null}
          </HStack>
        </Box>
      ) : null}

      <Box className="two-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">期限最近的请求</Heading>
            <NextLink href="/requests">
              <Button size="xs" variant="ghost" rightIcon={<ArrowRight size={14} />}>
                查看全部
              </Button>
            </NextLink>
          </Flex>
          <TableContainer>
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>请求编号</Th>
                  <Th>类型</Th>
                  <Th>地区</Th>
                  <Th>状态</Th>
                  <Th>期限</Th>
                </Tr>
              </Thead>
              <Tbody>
                {sorted.slice(0, 6).map((request) => {
                  const deadline = deadlineState(request.dueAt)
                  return (
                    <Tr key={request.id}>
                      <Td>
                        <NextLink href={`/requests/${request.id}`}>
                          <Text color="brand.600" fontWeight="600">
                            {request.code}
                          </Text>
                        </NextLink>
                      </Td>
                      <Td>
                        <TypeBadge type={request.type} />
                      </Td>
                      <Td>{regionLabels[request.region]}</Td>
                      <Td>
                        <StatusBadge status={request.status} />
                      </Td>
                      <Td color={deadline.color} fontWeight="600">
                        {deadline.label}
                      </Td>
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
          </TableContainer>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">履约控制点</Heading>
            <Badge colorScheme="brand">{data.systems.length} 个系统</Badge>
          </Flex>
          <VStack align="stretch" spacing="4">
            <Flex gap="12px" align="flex-start">
              <ShieldCheck size={20} color="#237b78" />
              <Box>
                <Text fontWeight="600">受理快照冻结</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  受理时冻结代理关系与查看范围，任务证据只按该快照产出。
                </Text>
              </Box>
            </Flex>
            <Flex gap="12px" align="flex-start">
              <Scale size={20} color="#8a55c7" />
              <Box>
                <Text fontWeight="600">代理变更处置链</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  撤回/到期/换人后未交付材料立即失效重算，已发出处理包保留依据进入复核。
                </Text>
              </Box>
            </Flex>
            <Flex gap="12px" align="flex-start">
              <Database size={20} color="#3e73a4" />
              <Box>
                <Text fontWeight="600">跨系统结果合并</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  各系统任务分别执行，结果冲突时进入统一复核队列。
                </Text>
              </Box>
            </Flex>
            <Flex gap="12px" align="flex-start">
              <Clock3 size={20} color="#d18a28" />
              <Box>
                <Text fontWeight="600">期限控制</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  截止时间前关闭必须填写理由，逾期也不会静默关闭。
                </Text>
              </Box>
            </Flex>
            <Flex gap="12px" align="flex-start">
              <AlertTriangle size={20} color="#c74d4d" />
              <Box>
                <Text fontWeight="600">例外与冲突留痕</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  延期、冲突处理、证据登记和关闭动作全部进入操作审计。
                </Text>
              </Box>
            </Flex>
          </VStack>
        </Box>
      </Box>

      <Box className="panel">
        <Flex className="panel-title">
          <Heading size="sm">最近操作审计</Heading>
          <NextLink href="/audit">
            <Button size="xs" variant="ghost">
              导出处理包
            </Button>
          </NextLink>
        </Flex>
        <HStack align="stretch" spacing="4">
          {data.audit.slice(0, 3).map((entry) => (
            <Box key={entry.id} className="summary-box" flex="1" mb="0">
              <Text fontWeight="600">{entry.action}</Text>
              <Text mt="1" color="gray.600" fontSize="sm">
                {entry.detail}
              </Text>
              <Text mt="2" color="gray.500" fontSize="xs">
                {entry.operator} · {new Date(entry.createdAt).toLocaleString('zh-CN')}
              </Text>
            </Box>
          ))}
        </HStack>
      </Box>
    </Box>
  )
}
