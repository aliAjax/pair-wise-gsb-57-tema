# 用户隐私权利请求履约工作台

覆盖访问、更正、删除、撤回同意和限制处理请求的多页面履约工作台。项目使用 Next.js App Router、Chakra UI、Zustand、TanStack Query、tRPC、Zod 和 TypeScript 构建。

## 功能

- 客服登记请求，根据地区、身份核验状态和请求类型生成处理步骤与期限。
- **代理授权处置链**：代理律师/代理人资质登记与核验独立管理；受理时冻结代理关系与查看范围快照，任务证据只按这份快照产出。
- 定位相关系统、分派任务、登记执行证据、合并跨系统结果并记录处理意见。
- **撤回 / 到期 / 换人一条处置链**：被代理人撤回、授权到期或换人后，未交付材料立即失效并按最新代理关系重算；已发出处理包保留当时受理快照与摘要、进入复核队列登记意见。
- **并发与写入可靠性**：两个窗口同时提交授权变更和任务完成时，后到动作按最新代理关系判断（乐观版本校验），不能覆盖已生成结果；证据按批次产出，写入中断后从完整批次续做，重试不重复生成证据和处理包（稳定键 + 批次账本）。
- **旧数据回填**：历史请求缺少代理关系时先回填待确认，补全受理快照前不能产出证据或导出处理包。
- 身份材料只保存掩码引用和摘要，不保存材料明文；授权材料同样仅保存编号与摘要。
- 重复请求、身份材料不足、跨系统结果冲突、授权依据失效自动进入复核队列。
- 支持任务开始、完成和阻断，冲突逐项复核，延期必须填写原因。
- 截止时间前关闭必须记录提前关闭理由，未完成任务、存在冲突或失效未重算材料时服务端拒绝关闭；关闭时按受理快照生成处理包，交付后依据变更转入复核。
- 汇总登记、核验、分派、证据、冲突、延期、代理变更和关闭审计，导出脱敏处理包（含受理快照与处理包依据）。

tRPC 路由使用 Zod 校验操作输入；TanStack Query 管理服务数据；Zustand 管理工作区筛选状态；每次成功操作都会把完整工作区写入浏览器 `localStorage`。

## 运行

```bash
npm install
npm run dev
```

开发服务地址：`http://localhost:18457`

## 验证处置链

```bash
npm run verify:chain
```

脚本覆盖 5 个场景共 27 项断言：受理快照冻结、批次写入中断续做与幂等、撤回后已发出包保留依据复核、换人后未交付材料失效重算、旧数据回填前阻断导出、两个窗口并发的版本裁决。

## 构建

```bash
npm run build
npm run start
```

## 目录

```text
src/
  app/          Next App Router 页面与 tRPC API Handler
  components/   应用外壳、页面头、状态标签
  features/     总览、请求列表、请求详情、代理授权、复核、系统、审计
  lib/          Zod Schema、tRPC 客户端、TanStack Query Hooks、本地存储
  server/       tRPC 服务路由
  services/     流程模板、履约业务规则、代理处置链、批次写入、处理包
  stores/       Zustand 工作区状态
  types/        领域类型
scripts/
  verify-chain.ts  处置链端到端断言
```

## 处置链关键模型

- `representatives`：代理关系簿，含资质摘要、查看范围（系统/请求类型）、有效期、核验状态与撤回/到期/换人历史。
- `intakeSnapshot`：受理时冻结的代理关系与查看范围，证据 (`evidence.basisSnapshotId`) 和处理包 (`deliveryPackage.basisSnapshotId`) 均锁定该快照。
- `evidence.basisState`：`current`（依据现行）/ `superseded`（已随包发出、依据变更留痕）/ `undelivered-voided`（未交付已失效，触发重算）。
- `writeBatches`：证据/处理包批次账本，`plannedKeys/producedKeys` 支持中断续做与重试幂等。
