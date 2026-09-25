# 养老机构评估 → 管理复核 → 家属告知 → 费用生效（服务端流程演示）

NestJS + PostgreSQL + TypeORM + decimal.js 的服务端流程。**无前端**。

> ⚠️ 本项目使用**虚构量表 DEMO_ADL**，仅用于行政流程（评估、复核、告知、计费）演示，
> **不构成医疗诊断、护理分级依据或真实护理建议**。该声明同时固化在量表版本与每条家属告知文本中。

## 流程规则（对应业务要求）

1. **必填项缺失不得自动定级**：任一评估员必填条目缺失/无效/误用 NA，案件为 `INCOMPLETE`，无确认等级，不能复核、不能费用生效。
2. **不适用项（NA）如何影响分母由量表定义**：`scale_versions.na_policy` 决定。演示量表为 `EXCLUDE_FROM_DENOMINATOR`，且仅 `STAIRS`、`OUTDOOR` 两题允许 NA；对不允许 NA 的题选 NA 视为无效作答。
3. **两位评估员结果冲突进入复核，不能简单取较高等级**：等级不一致 → `PENDING_REVIEW`；管理员必须在**两位评估员候选等级之内**显式选择并填写意见。取候选外等级（如“折中”）返回 400。
4. **等级确认后生成告知记录**：一致由系统确认（reviewer=`SYSTEM`），冲突由管理员确认；确认即生成一条 `PENDING / CONFIRMED` 告知。
5. **送达失败与尚未确认分别记录**：
   - 送达结果 `status`：`PENDING / DELIVERED / FAILED`（失败原因独立留痕，每次尝试一行）；
   - 可告知状态 `notifiableStatus`：`CONFIRMED / UNCONFIRMED`。尚未确认时也可尝试告知，落 `UNCONFIRMED + FAILED（等级尚未确认）`。
6. **费用生效按机构示例规则独立判断**：等级是否已确认才是生效前提，与家属告知是否送达无关。
7. **同一天不能出现重叠生效等级**：服务层显式校验 + PostgreSQL `btree_gist` 的 daterange 排他约束双保险。月中换级时旧期间自动截至生效日前一日（半开区间首尾相接）。
8. **费用按天分段**：等级期间 × 日费版本切换日二次切分，闭区间逐天连续（含无生效等级空洞段），天数守恒校验；金额一律 decimal.js 计算，两位小数 `ROUND_HALF_UP`。
9. **离返院事件溯源**：`leave_events` 只追加，外部稳定事件号幂等，保存实际发生时间、接收顺序和 LEAVE/RETURN 类型；系统按“发生时间 + 接收顺序”从事件历史重建不重叠暂停区间，包含离院日与返院日。
10. **暂停不按整月推断**：缺返院、返院早于离院、嵌套离院均有独立解释状态；试算只逐日临时暂停，跨等级/费率版本时仍保留原有等级与费率分段并给出 warning，月结遇到未解释异常会阻断。
11. **已结算账不可覆盖**：月结冻结逐日原费用与暂停后应收。迟到事件只对未结算试算生效；命中已结算月份时只追加逐行来源完整的补收/退费调整单，原结算头和原费用行永不更新。
12. **整批原子与可回放**：补录批次整事务提交，稳定事件号/老人内接收顺序冲突整批 409；同一老人使用事务咨询锁串行化。重启后从事件账本重建暂停区间，原账与调整来源仍可追溯。
13. **接口可解释**：评估响应内嵌两位评估员逐项明细（原始选项、分值、是否计入分母、NA 说明、原始分/有效分母/百分比/定级阈值）；费用分段逐段给出等级、日费版本、天数、金额、暂停区间与来源。

## 演示数据

- 量表 `DEMO_ADL v1.0.0`：10 题（8 必填 + STAIRS/OUTDOOR 可 NA），0~3 分制；
  百分比阈值 `<40% LIGHT / [40%,70%) MODERATE / >=70% SEVERE`。
- 示例日费（元/天）：LIGHT 100；MODERATE 180（2024-01-01 起 200）；SEVERE 260（2024-01-01 起 300）。

## 运行

无需系统 PostgreSQL / root：默认在项目内启动**用户态嵌入式 PostgreSQL 18**（`embedded-postgres`）。
如有外部 PG，在 `.env` 设置 `DB_HOST` 即切换为外部连接（见 `.env.example`）。

```bash
npm install
npm run seed          # 可选：仅建表+种子
npm run start         # http://127.0.0.1:3000/api
npm test              # e2e（自带嵌入式 PG，覆盖下列全部场景）
```

## API（均在 /api 前缀下）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/scales/:id` | 量表版本、原始条目/选项、NA 分母策略、定级阈值 |
| POST | `/assessments` | 提交两位评估员作答 → INCOMPLETE / CONFIRMED / PENDING_REVIEW |
| GET | `/assessments/:id` | 案件 + 逐项评分来源 + 复核意见 + 告知记录 |
| POST | `/assessments/:id/review/confirm` | 管理复核（等级限候选内，支持 `idempotencyKey`） |
| POST | `/assessments/:id/notification/attempt` | 家属告知尝试（`{"simulateFail":true}` 模拟通道失败） |
| GET | `/assessments/:id/notification` | 全部告知记录（失败历史、未确认尝试均保留） |
| POST | `/fees/activate` | 等级生效 `{caseId, effectiveDate}` |
| GET | `/fees/segments?elderId=&from=&to=` | 按天分段费用、离院暂停、异常解释与 decimal 合计 |
| POST | `/leave-events` | 整批录入/补录离返院事件；`batchNo` 幂等，冲突整批失败 |
| GET | `/elders/:elderId/leave-events` | 回放事件账本、物化暂停区间和异常 |
| GET | `/leave-periods?elderId=&status=` | 查询不重叠暂停区间及 MATCHED/OPEN/异常解释 |
| GET | `/fees/leave-trial?elderId=&from=&to=` | 逐日费用试算（未配对离院仅临时暂停，不整月停费） |
| POST | `/fees/settle` | 月结 `{elderId,month:"YYYY-MM"}`，冻结原费用和应收 |
| GET | `/fees/settlements/:month?elderId=` | 查询已结算原账、追加调整和当前净额 |
| GET | `/fees/adjustments?elderId=&month=` | 查询迟到事件产生的补收/退费调整及逐日来源 |
| GET | `/openapi` | OpenAPI 3 文档 |

### 示例：迟到离返院事件与已结算调整

```bash
curl -sXPOST localhost:3000/api/fees/settle -H 'Content-Type: application/json' \
  -d '{"elderId":"E1","month":"2024-02"}'

# 月结后补录：2/10 离院、2/12 返院（含首尾，共暂停 3 天）
curl -sXPOST localhost:3000/api/leave-events -H 'Content-Type: application/json' -d '{
  "elderId":"E1",
  "batchNo":"leave-202402-001",
  "events":[
    {"eventNo":"leave-202402-001","eventType":"LEAVE",
     "occurredAt":"2024-02-10T10:00:00+08:00","receiveSequence":101},
    {"eventNo":"return-202402-001","eventType":"RETURN",
     "occurredAt":"2024-02-12T18:00:00+08:00","receiveSequence":102}
  ]}'
# 原 settlement.billedAmount 不变；fee_adjustments 追加 amount=-3*日费 的 REFUND，
# fee_adjustment_lines 逐天连接 settlement_line_id、batch_id 和新的暂停区间键。
```

暂停状态：`MATCHED`（已配对）、`OPEN_MISSING_RETURN`（缺返院，试算临时暂停、月结阻断）、
`ORPHAN_RETURN`（无离院的返院）、`RETURN_BEFORE_DEPARTURE`（返院早于离院）、
`NESTED_DEPARTURE`（嵌套离院需人工核对）。

### 示例：月中升级 + 闰月

```bash
# 1) 轻度确认并 2024-01-01 生效（两位评估员全选独立完成）
curl -sXPOST localhost:3000/api/assessments -H 'Content-Type: application/json' -d '{
  "elderId":"E1","elderName":"张某","familyContact":"13900000000",
  "assessors":[{"assessorId":1,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]},
               {"assessorId":2,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]}]}'
# 全部 10 题均提交；冲突案件再 POST /review/confirm；然后：
curl -sXPOST localhost:3000/api/fees/activate -H 'Content-Type: application/json' \
  -d '{"caseId":"<case-uuid>","effectiveDate":"2024-02-15"}'
curl -s 'localhost:3000/api/fees/segments?elderId=E1&from=2024-02-01&to=2024-02-29'
# 2024 为闰年：2/1~2/14 与 2/15~2/29 两段，共 29 天
```

## e2e 覆盖场景

- 必填缺失 / 无效 NA → INCOMPLETE，不定级、不可复核生效；
- NA 从分母剔除（8 题 TOTAL_DEP + 2 NA → 分母 8 而非 10）及逐项解释；
- LIGHT vs SEVERE 冲突 → 复核候选外等级 400、显式选较低 LIGHT 成功（证明不取高）；
- 重复确认请求：相同幂等键回放、无键重复 409；
- 尚未确认尝试告知 → `UNCONFIRMED/FAILED`；送达失败原因分行留痕；
- 月中升级切旧区间、同案重复生效回放、同日不同等级重叠 409；
- 闰月 2024-02（29 天）分段金额、跨 2024-01-01 调价日同等级二次分段、无等级空洞段、非法闰日期拒绝；
- 月中离/返院只暂停命中日且跨等级/跨费率保留分段；重复稳定事件幂等；返院先到、离院后补后重放出唯一配对区间；
- 缺配对、返院早于离院、嵌套离院返回可解释状态并阻断不明月结；
- 迟到事件命中已结算月份时原账不变，仅追加逐天来源完整的补收/退费调整；重复批次/结算回放不重复调整；
- 并发补录冲突整批失败无半区间；应用重启后事件账本、暂停区间、原费用和调整来源均可回放。
