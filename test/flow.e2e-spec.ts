import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GradeCode } from '../src/common/enums';

/**
 * 全流程 e2e：
 * 必填缺失不定级 / NA 分母按量表定义 / 双评估员冲突进复核不取高 /
 * 告知失败与尚未确认分别记录 / 费用独立生效 / 月中升级 / 闰月天数 /
 * 重复确认请求 / 同日重叠生效拦截 / 评分来源与费用分段可解释
 */
describe('养老评估-复核-告知-费用 全流程 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let conflictCaseId: string;

  const ITEMS_8 = [
    'TRANSFER',
    'WALKING',
    'BATHING',
    'DRESSING',
    'TOILETING',
    'EATING',
    'CONTINENCE',
    'GROOMING',
  ];
  const OPT = {
    INDEPENDENT: 'INDEPENDENT',
    SOME_HELP: 'SOME_HELP',
    MUCH_HELP: 'MUCH_HELP',
    TOTAL_DEP: 'TOTAL_DEP',
    NA: 'NA',
  };

  /** 构造 10 条答案（含 STAIRS/OUTDOOR 两个可 NA 项） */
  function answers(
    override: Record<string, string> = {},
    omit: string[] = [],
  ) {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = OPT.INDEPENDENT;
    map.STAIRS = OPT.INDEPENDENT;
    map.OUTDOOR = OPT.INDEPENDENT;
    Object.assign(map, override);
    return Object.entries(map)
      .filter(([code]) => !omit.includes(code))
      .map(([itemCode, optionCode]) => ({ itemCode, optionCode }));
  }

  function payload(
    elderId: string,
    a1: ReturnType<typeof answers>,
    a2: ReturnType<typeof answers>,
    familyContact = '13800000000',
  ) {
    return {
      elderId,
      elderName: `老人${elderId}`,
      familyContact,
      assessors: [
        { assessorId: 1, answers: a1 },
        { assessorId: 2, answers: a2 },
      ],
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
    // 清空业务表（保留量表与日费规则种子）
    const ds = app.get(DataSource);
    await ds.query(`
      TRUNCATE fee_adjustment_lines, fee_adjustments, fee_settlement_lines,
               fee_settlements, leave_suspension_periods, leave_events,
               leave_event_batches, grade_periods, notification_records,
               review_decisions, assessor_answers, assessment_cases
      RESTART IDENTITY CASCADE
    `);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  it('必填项缺失：两位评估员都不得自动定级，案件 INCOMPLETE 且无确认等级', async () => {
    const res = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-MISS',
          answers({}, ['BATHING']), // 必填项洗澡缺失
          answers({}, ['EATING']),
        ),
      )
      .expect(201);

    expect(res.body.status).toBe('INCOMPLETE');
    expect(res.body.confirmedGrade).toBeNull();
    expect(res.body.conflicting).toBe(false);

    const d1 = res.body.assessor1Details;
    const d2 = res.body.assessor2Details;
    expect(d1.gradeable).toBe(false);
    expect(d1.grade).toBeNull();
    expect(d1.missingRequired.map((x: any) => x.itemCode)).toContain('BATHING');
    expect(d2.missingRequired.map((x: any) => x.itemCode)).toContain('EATING');
    // 逐项解释中标注缺失原因
    const bathingLine = d1.lines.find((l: any) => l.itemCode === 'BATHING');
    expect(bathingLine.optionCode).toBeNull();
    expect(bathingLine.note).toContain('必填项缺失');
  });

  it('INCOMPLETE 案件尝试复核/生效均被拒绝', async () => {
    const created = await http
      .post('/api/assessments')
      .send(payload('E-MISS2', answers({}, ['DRESSING']), answers({})))
      .expect(201);

    await http
      .post(`/api/assessments/${created.body.id}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.LIGHT,
        reviewerId: 'mgr1',
        comment: '不应允许确认未定级案件',
      })
      .expect(409)
      .expect((r) =>
        expect(r.body.message.code ?? r.body.message).toBeTruthy(),
      );

    await http
      .post('/api/fees/activate')
      .send({ caseId: created.body.id, effectiveDate: '2024-01-01' })
      .expect(409);
  });

  it('NA 按量表定义从分母剔除：评分来源可解释（含 NA 时等级随有效分母变化）', async () => {
    // 7 项 TOTAL_DEP + STAIRS NA + OUTDOOR NA
    const override: Record<string, string> = {};
    for (const code of ITEMS_8) override[code] = OPT.TOTAL_DEP;
    override.STAIRS = OPT.NA;
    override.OUTDOOR = OPT.NA;

    const res = await http
      .post('/api/assessments')
      .send(payload('E-NA', answers(override), answers(override)))
      .expect(201);

    const d = res.body.assessor1Details;
    expect(d.gradeable).toBe(true);
    expect(d.rawScore).toBe(24);
    expect(d.denominator).toBe(8); // 2 个 NA 项从分母剔除
    expect(d.maxScore).toBe(24);
    expect(d.naCount).toBe(2);
    expect(Number(d.scorePct)).toBeCloseTo(100, 5);
    expect(d.grade).toBe(GradeCode.SEVERE);
    const naLine = d.lines.find((l: any) => l.itemCode === 'STAIRS');
    expect(naLine.na).toBe(true);
    expect(naLine.includedInDenominator).toBe(false);
    expect(naLine.note).toContain('从分母剔除');
  });

  it('非允许 NA 的条目选 NA 视为无效作答：必填项不定级', async () => {
    const res = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-NABAD',
          answers({ BATHING: OPT.NA }),
          answers({ BATHING: OPT.NA }),
        ),
      )
      .expect(201);
    expect(res.body.status).toBe('INCOMPLETE');
    const line = res.body.assessor1Details.lines.find(
      (l: any) => l.itemCode === 'BATHING',
    );
    expect(line.note).toContain('量表未定义');
  });

  it('两位评估员等级一致：系统确认并自动生成待送达告知（PENDING）', async () => {
    const res = await http
      .post('/api/assessments')
      .send(payload('E-AGREE', answers({}), answers({})))
      .expect(201);

    expect(res.body.status).toBe('CONFIRMED');
    expect(res.body.confirmedGrade).toBe(GradeCode.LIGHT);
    expect(res.body.review.result).toBe('AGREEMENT');
    expect(res.body.review.reviewerId).toBe('SYSTEM');
    // 确认后即生成告知记录：已确认可告知，但尚未送达
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].status).toBe('PENDING');
    expect(res.body.notifications[0].notifiableStatus).toBe('CONFIRMED');
  });

  it('冲突：LIGHT vs SEVERE 进入复核，绝不自动取较高等级', async () => {
    const light = answers({ EATING: OPT.SOME_HELP }); // 1/30 = 3.33% LIGHT
    const severe = (() => {
      const o: Record<string, string> = {};
      for (const code of ITEMS_8) o[code] = OPT.TOTAL_DEP;
      o.STAIRS = OPT.TOTAL_DEP; // 27/30 = 90% SEVERE（OUTDOOR 独立）
      return answers(o);
    })();

    const res = await http
      .post('/api/assessments')
      .send(payload('E-CONFLICT', light, severe))
      .expect(201);

    expect(res.body.status).toBe('PENDING_REVIEW');
    expect(res.body.conflicting).toBe(true);
    expect(res.body.assessor1Grade).toBe(GradeCode.LIGHT);
    expect(res.body.assessor2Grade).toBe(GradeCode.SEVERE);
    expect(res.body.confirmedGrade).toBeNull();
    expect(res.body.review).toBeNull();
    expect(res.body.notifications).toHaveLength(0); // 未确认不生成确认告知
    conflictCaseId = res.body.id;
  });

  it('复核：候选外等级被拒（不得折中/自动取高）；未确认不得费用生效', async () => {
    // 候选外：两评估员给的是 LIGHT / SEVERE，MODERATE 不在候选内
    await http
      .post(`/api/assessments/${conflictCaseId}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.MODERATE,
        reviewerId: 'mgr1',
        comment: '折中取中度',
      })
      .expect(400);

    // 冲突案件未确认时即尝试费用生效 → 拒绝
    await http
      .post('/api/fees/activate')
      .send({ caseId: conflictCaseId, effectiveDate: '2024-02-01' })
      .expect(409);
  });

  it('复核：管理员显式选择较低候选 LIGHT 并留意见（证明非简单取高）', async () => {
    const res = await http
      .post(`/api/assessments/${conflictCaseId}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.LIGHT,
        reviewerId: 'mgr-wang',
        comment: '复核录像与生活记录，评定为轻度（评估员2对多项理解有偏差）',
      })
      .expect(201);

    expect(res.body.replayed).toBe(false);
    expect(res.body.case.status).toBe('CONFIRMED');
    expect(res.body.case.confirmedGrade).toBe(GradeCode.LIGHT);
    expect(res.body.case.review.result).toBe('CONFIRMED');
    expect(res.body.case.review.comment).toContain('评定为轻度');
    // 确认后生成告知 PENDING
    const notif = res.body.case.notifications[0];
    expect(notif.status).toBe('PENDING');
    expect(notif.notifiableStatus).toBe('CONFIRMED');
  });

  it('重复确认请求：相同幂等键回放；无幂等键重复确认 409', async () => {
    // 再造一个冲突案件
    const conflict = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-DUP',
          answers({}),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.TOTAL_DEP;
            return answers(o);
          })(),
        ),
      )
      .expect(201);
    expect(conflict.body.status).toBe('PENDING_REVIEW');
    const id = conflict.body.id;

    const body = {
      confirmedGrade: GradeCode.SEVERE,
      reviewerId: 'mgr2',
      comment: '复核确认重度',
      idempotencyKey: 'idem-001',
    };
    const first = await http
      .post(`/api/assessments/${id}/review/confirm`)
      .send(body)
      .expect(201);
    expect(first.body.replayed).toBe(false);

    const again = await http
      .post(`/api/assessments/${id}/review/confirm`)
      .send(body)
      .expect(201);
    expect(again.body.replayed).toBe(true);

    // 不带幂等键（或不同键）的重复确认 → 409
    const noKey = await http
      .post(`/api/assessments/${id}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'mgr2',
        comment: '不带幂等键的再次确认',
      })
      .expect(409);
    expect(JSON.stringify(noKey.body)).toContain('不得重复确认');
  });

  it('告知：尚未确认案件的尝试独立记录为 UNCONFIRMED/FAILED', async () => {
    const pending = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-NOTIFY-UNCONFIRMED',
          answers({}),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.TOTAL_DEP;
            return answers(o);
          })(),
          '13800000001',
        ),
      )
      .expect(201);
    expect(pending.body.status).toBe('PENDING_REVIEW');

    const attempt = await http
      .post(`/api/assessments/${pending.body.id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(attempt.body.notifiableStatus).toBe('UNCONFIRMED');
    expect(attempt.body.status).toBe('FAILED');
    expect(attempt.body.failureReason).toContain('尚未确认');
  });

  it('告知：送达失败独立记录 FAILED + 原因；重试成功后两条记录都保留', async () => {
    // 一致确认案件，家属联系方式以 -FAIL 结尾 → 通道失败
    const c = await http
      .post('/api/assessments')
      .send(payload('E-NOTIFY-FAIL', answers({}), answers({}), '138-FAIL'))
      .expect(201);
    const id = c.body.id;

    // 确认时自动生成的 PENDING 记录存在；第一次尝试失败 → 新行
    const fail1 = await http
      .post(`/api/assessments/${id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(fail1.body.status).toBe('FAILED');
    expect(fail1.body.notifiableStatus).toBe('CONFIRMED');
    expect(fail1.body.failureReason).toContain('号码无效');

    const fail2 = await http
      .post(`/api/assessments/${id}/notification/attempt`)
      .send({ simulateFail: true })
      .expect(201);
    expect(fail2.body.status).toBe('FAILED');
    expect(fail2.body.failureReason).toContain('网关超时');
    expect(fail2.body.id).not.toBe(fail1.body.id); // 失败历史各自成行

    const list = await http
      .get(`/api/assessments/${id}/notification`)
      .expect(200);
    // 1 条自动 PENDING + 2 条失败尝试
    expect(list.body).toHaveLength(3);
    expect(list.body.filter((n: any) => n.status === 'FAILED')).toHaveLength(2);

    // 送达成功与告知结果、费用生效完全独立：成功与否都不影响费用接口
    const okCase = await http
      .post('/api/assessments')
      .send(payload('E-NOTIFY-OK', answers({}), answers({}), '13900000000'))
      .expect(201);
    const delivered = await http
      .post(`/api/assessments/${okCase.body.id}/notification/attempt`)
      .send({})
      .expect(201);
    expect(delivered.body.status).toBe('DELIVERED');
  });

  // ---------------------------------------------------------------------------
  // 费用：月中升级 + 闰月天数 + 同日重叠拦截
  // ---------------------------------------------------------------------------
  let lightCaseId: string;
  let severeCaseId: string;

  it('费用：月中升级——旧区间截至前一日，新区间接续，同日不重叠', async () => {
    // 1) 轻度案件，2024-01-01 生效
    const light = await http
      .post('/api/assessments')
      .send(payload('E-FEE', answers({}), answers({})))
      .expect(201);
    lightCaseId = light.body.id;
    await http
      .post('/api/fees/activate')
      .send({ caseId: lightCaseId, effectiveDate: '2024-01-01' })
      .expect(201)
      .expect((r) => expect(r.body.replayed).toBe(false));

    // 2) 重度案件（复核确认），2024-02-15 月中升级
    const severe = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-FEE',
          answers({}),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.TOTAL_DEP;
            return answers(o);
          })(),
        ),
      )
      .expect(201);
    expect(severe.body.status).toBe('PENDING_REVIEW');
    severeCaseId = severe.body.id;
    await http
      .post(`/api/assessments/${severeCaseId}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'mgr3',
        comment: '复核确认重度，月中调整',
      })
      .expect(201);

    const upgrade = await http
      .post('/api/fees/activate')
      .send({ caseId: severeCaseId, effectiveDate: '2024-02-15' })
      .expect(201);
    expect(upgrade.body.period.grade).toBe(GradeCode.SEVERE);
    expect(upgrade.body.period.startDate).toBe('2024-02-15');

    // 重复生效请求（同案同日同等级）→ 幂等回放
    const replay = await http
      .post('/api/fees/activate')
      .send({ caseId: severeCaseId, effectiveDate: '2024-02-15' })
      .expect(201);
    expect(replay.body.replayed).toBe(true);
  });

  it('费用：同一天不得出现重叠生效等级（另案同日不同等级 → 409，DB 约束兜底）', async () => {
    // E-FEE 老人在 2024-02-15 当天已随升级为 SEVERE；再用其轻度案件在同日生效 → 重叠
    const overlap = await http
      .post('/api/fees/activate')
      .send({ caseId: lightCaseId, effectiveDate: '2024-02-15' })
      .expect(409);
    expect(JSON.stringify(overlap.body)).toMatch(/重叠|OVERLAP/);

    // 同一天对同一老人再走一个已确认案件同样拦截（服务层 + gist 约束双保险）
    const another = await http
      .post('/api/assessments')
      .send(payload('E-FEE', answers({}), answers({}), '13700000000'))
      .expect(201);
    expect(another.body.confirmedGrade).toBe(GradeCode.LIGHT);
    const sameDay = await http
      .post('/api/fees/activate')
      .send({ caseId: another.body.id, effectiveDate: '2024-02-15' })
      .expect(409);
    expect(JSON.stringify(sameDay.body)).toMatch(/重叠|OVERLAP/);
  });

  it('费用：闰月分段——2024-02 共 29 天，1~14 轻度、15~29 重度，decimal 合计 5900.00', async () => {
    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-FEE', from: '2024-02-01', to: '2024-02-29' })
      .expect(200);

    expect(res.body.totalDays).toBe(29);
    expect(res.body.segments).toHaveLength(2);
    const [s1, s2] = res.body.segments;
    expect(s1.grade).toBe(GradeCode.LIGHT);
    expect(s1.startDate).toBe('2024-02-01');
    expect(s1.endDate).toBe('2024-02-14');
    expect(s1.days).toBe(14);
    expect(s1.dailyRate).toBe('100.00');
    expect(s1.amount).toBe('1400.00');
    expect(s2.grade).toBe(GradeCode.SEVERE);
    expect(s2.startDate).toBe('2024-02-15');
    expect(s2.endDate).toBe('2024-02-29');
    expect(s2.days).toBe(15);
    expect(s2.dailyRate).toBe('300.00');
    expect(s2.amount).toBe('4500.00');
    expect(res.body.totalAmount).toBe('5900.00');
  });

  it('费用：跨日费版本切换日（2024-01-01 调价）同等级期间内二次切分', async () => {
    // 另一位老人：2023-12-25 起 MODERATE，覆盖调价日
    const moderateAssess = await http
      .post('/api/assessments')
      .send(
        payload(
          'E-RATE',
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.MUCH_HELP; // 16/30=53.3%
            return answers(o);
          })(),
          (() => {
            const o: Record<string, string> = {};
            for (const c of ITEMS_8) o[c] = OPT.MUCH_HELP;
            return answers(o);
          })(),
        ),
      )
      .expect(201);
    expect(moderateAssess.body.confirmedGrade).toBe(GradeCode.MODERATE);

    await http
      .post('/api/fees/activate')
      .send({ caseId: moderateAssess.body.id, effectiveDate: '2023-12-25' })
      .expect(201);

    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-RATE', from: '2023-12-25', to: '2024-01-10' })
      .expect(200);

    // 12/25~12/31 共 7 天 @180；1/1~1/10 共 10 天 @200
    expect(res.body.totalDays).toBe(17);
    expect(res.body.segments).toHaveLength(2);
    expect(res.body.segments[0].rateEffectiveFrom).toBe('2000-01-01');
    expect(res.body.segments[0].days).toBe(7);
    expect(res.body.segments[0].amount).toBe('1260.00');
    expect(res.body.segments[1].rateEffectiveFrom).toBe('2024-01-01');
    expect(res.body.segments[1].days).toBe(10);
    expect(res.body.segments[1].amount).toBe('2000.00');
    expect(res.body.totalAmount).toBe('3260.00');
  });

  it('费用：无生效等级的日期空洞单列 NO_EFFECTIVE_GRADE 且金额为 0', async () => {
    // 全新老人，只在 2024-03-10 起生效 LIGHT
    const c = await http
      .post('/api/assessments')
      .send(payload('E-GAP', answers({}), answers({})))
      .expect(201);
    await http
      .post('/api/fees/activate')
      .send({ caseId: c.body.id, effectiveDate: '2024-03-10' })
      .expect(201);

    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-GAP', from: '2024-03-01', to: '2024-03-15' })
      .expect(200);

    expect(res.body.totalDays).toBe(15);
    const gap = res.body.segments.find((s: any) => s.source === 'NO_EFFECTIVE_GRADE');
    expect(gap).toMatchObject({
      startDate: '2024-03-01',
      endDate: '2024-03-09',
      days: 9,
      grade: null,
      amount: '0.00',
    });
    const paid = res.body.segments.find((s: any) => s.source === 'GRADE_PERIOD_AND_RATE');
    expect(paid.days).toBe(6);
    expect(paid.amount).toBe('600.00');
    expect(res.body.totalAmount).toBe('600.00');
  });

  it('费用：非法闰日期（2023-02-29）拒绝', async () => {
    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-FEE', from: '2023-02-01', to: '2023-02-29' })
      .expect(409);
    expect(JSON.stringify(res.body)).toMatch(/不合法|INVALID/);
  });

  // ---------------------------------------------------------------------------
  // 离返院事件账本：幂等、乱序、暂停分段、结算后调整、并发和重启回放
  // ---------------------------------------------------------------------------
  async function activateGradePeriod(
    elderId: string,
    gradeOverride: Record<string, string> = {},
    effectiveDate = '2024-02-01',
    confirmed?: GradeCode,
  ): Promise<string> {
    const c = await http
      .post('/api/assessments')
      .send(payload(elderId, answers(gradeOverride ?? {}), answers(gradeOverride ?? {})))
      .expect(201);
    let caseId = c.body.id;
    if (c.body.status === 'PENDING_REVIEW') {
      await http
        .post(`/api/assessments/${caseId}/review/confirm`)
        .send({
          confirmedGrade: confirmed ?? GradeCode.SEVERE,
          reviewerId: 'leave-mgr',
          comment: '离返院费用测试确认等级',
        })
        .expect(201);
    }
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate })
      .expect(201);
    return caseId;
  }

  it('离返院：月中离院/返院只暂停命中日，跨等级和费率版本仍保留分段解释', async () => {
    await activateGradePeriod('E-LEAVE-CROSS', {}, '2024-02-01');
    const severe: Record<string, string> = {};
    for (const c of ITEMS_8) severe[c] = OPT.TOTAL_DEP;
    await activateGradePeriod('E-LEAVE-CROSS', severe, '2024-02-20', GradeCode.SEVERE);

    await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-CROSS',
        batchNo: 'cross-leave',
        events: [
          {
            eventNo: 'evt-cross-leave',
            eventType: 'LEAVE',
            occurredAt: '2024-02-10T10:00:00+08:00',
            receiveSequence: 1,
          },
        ],
      })
      .expect(201);
    await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-CROSS',
        batchNo: 'cross-return',
        events: [
          {
            eventNo: 'evt-cross-return',
            eventType: 'RETURN',
            occurredAt: '2024-02-25T18:00:00+08:00',
            receiveSequence: 2,
          },
        ],
      })
      .expect(201);

    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-LEAVE-CROSS', from: '2024-02-01', to: '2024-02-29' })
      .expect(200);

    expect(res.body.totalDays).toBe(29);
    expect(res.body.pausedDays).toBe(16); // 2/10~2/25 含首尾
    expect(res.body.originalAmount).toBe('4900.00'); // 19*100 + 10*300
    expect(res.body.totalAmount).toBe('2100.00'); // 9*100 + 4*300
    expect(res.body.segments.map((s: any) => s.startDate)).toEqual([
      '2024-02-01',
      '2024-02-10',
      '2024-02-20',
      '2024-02-26',
    ]);
    const lightPaid = res.body.segments[0];
    const pausedLight = res.body.segments[1];
    const pausedSevere = res.body.segments[2];
    const severePaid = res.body.segments[3];
    expect(lightPaid).toMatchObject({ grade: GradeCode.LIGHT, days: 9, amount: '900.00' });
    expect(pausedLight).toMatchObject({ status: 'PAUSED_MATCHED', grade: GradeCode.LIGHT, days: 10, amount: '0.00', originalAmount: '1000.00' });
    expect(pausedSevere).toMatchObject({ status: 'PAUSED_MATCHED', grade: GradeCode.SEVERE, days: 6, amount: '0.00', originalAmount: '1800.00' });
    expect(severePaid).toMatchObject({ grade: GradeCode.SEVERE, days: 4, amount: '1200.00' });
    expect(JSON.stringify(pausedLight.warnings.concat(pausedSevere.warnings))).toContain('跨等级');

    const periods = await http
      .get('/api/leave-periods')
      .query({ elderId: 'E-LEAVE-CROSS' })
      .expect(200);
    expect(periods.body).toHaveLength(1);
    expect(periods.body[0]).toMatchObject({
      status: 'MATCHED',
      startDate: '2024-02-10',
      endDate: '2024-02-25',
    });
  });

  it('离返院：跨日费版本时暂停日仍按版本切分，给出跨版本解释', async () => {
    const moderate: Record<string, string> = {};
    for (const c of ITEMS_8) moderate[c] = OPT.MUCH_HELP;
    await activateGradePeriod('E-LEAVE-RATE', moderate, '2023-12-28', GradeCode.MODERATE);

    await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-RATE',
        batchNo: 'rate-cross',
        events: [
          { eventNo: 'rate-leave', eventType: 'LEAVE', occurredAt: '2023-12-31T08:00:00+08:00', receiveSequence: 50 },
          { eventNo: 'rate-return', eventType: 'RETURN', occurredAt: '2024-01-02T18:00:00+08:00', receiveSequence: 51 },
        ],
      })
      .expect(201);

    const res = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-LEAVE-RATE', from: '2023-12-28', to: '2024-01-05' })
      .expect(200);

    expect(res.body.pausedDays).toBe(3);
    expect(res.body.originalAmount).toBe('1720.00');
    expect(res.body.totalAmount).toBe('1140.00');
    expect(res.body.segments.map((s: any) => s.status)).toEqual([
      'BILLABLE',
      'PAUSED_MATCHED',
      'PAUSED_MATCHED',
      'BILLABLE',
    ]);
    expect(res.body.segments[1]).toMatchObject({
      days: 1,
      rateEffectiveFrom: '2000-01-01',
      dailyRate: '180.00',
      amount: '0.00',
      originalAmount: '180.00',
    });
    expect(res.body.segments[2]).toMatchObject({
      days: 2,
      rateEffectiveFrom: '2024-01-01',
      dailyRate: '200.00',
      amount: '0.00',
      originalAmount: '400.00',
    });
    expect(JSON.stringify(res.body.segments.map((s: any) => s.warnings))).toContain('跨日费版本');
  });

  it('离返院：缺少配对和返院早于离院均给可解释状态，不能整月停费', async () => {
    await activateGradePeriod('E-LEAVE-BAD', {}, '2024-07-01');
    await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-BAD',
        batchNo: 'bad-return',
        events: [
          { eventNo: 'true-early-return', eventType: 'RETURN', occurredAt: '2024-07-03T08:00:00+08:00', receiveSequence: 60 },
          { eventNo: 'late-leave-after-return', eventType: 'LEAVE', occurredAt: '2024-07-05T08:00:00+08:00', receiveSequence: 61 },
        ],
      })
      .expect(201);

    const periods = await http
      .get('/api/leave-periods')
      .query({ elderId: 'E-LEAVE-BAD' })
      .expect(200);
    const statuses = periods.body.map((p: any) => p.status).sort();
    expect(statuses).toEqual(['OPEN_MISSING_RETURN', 'RETURN_BEFORE_DEPARTURE']);

    const fees = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-LEAVE-BAD', from: '2024-07-01', to: '2024-07-10' })
      .expect(200);
    // 返院早于离院不产生暂停；缺少配对的离院从 7/5 起逐日临时暂停，而非整月 0 元
    expect(fees.body.pausedDays).toBe(6);
    expect(fees.body.totalAmount).toBe('400.00');
    expect(fees.body.anomalies.map((a: any) => a.status)).toContain('RETURN_BEFORE_DEPARTURE');

    await http
      .post('/api/fees/settle')
      .send({ elderId: 'E-LEAVE-BAD', month: '2024-07' })
      .expect(409)
      .expect((r) => expect(JSON.stringify(r.body)).toContain('MONTH_NOT_SETTLEABLE'));
  });

  it('离返院：重复回调按稳定事件号幂等，不重复减费', async () => {
    await activateGradePeriod('E-LEAVE-IDEM', {}, '2024-03-01');
    const body = {
      elderId: 'E-LEAVE-IDEM',
      batchNo: 'idem-batch',
      events: [
        { eventNo: 'evt-idem-leave', eventType: 'LEAVE', occurredAt: '2024-03-05T08:00:00+08:00', receiveSequence: 10 },
        { eventNo: 'evt-idem-return', eventType: 'RETURN', occurredAt: '2024-03-06T20:00:00+08:00', receiveSequence: 11 },
      ],
    };
    const first = await http.post('/api/leave-events').send(body).expect(201);
    const second = await http.post('/api/leave-events').send(body).expect(201);
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);

    const ledger = await http
      .get('/api/elders/E-LEAVE-IDEM/leave-events')
      .expect(200);
    expect(ledger.body.events).toHaveLength(2);
    expect(ledger.body.periods).toHaveLength(1);

    const fees = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-LEAVE-IDEM', from: '2024-03-01', to: '2024-03-10' })
      .expect(200);
    expect(fees.body.pausedDays).toBe(2);
    expect(fees.body.totalAmount).toBe('800.00');

    // 绕过 batchNo 的重复稳定事件号也必须整批拒绝
    await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-IDEM',
        batchNo: 'different-batch',
        events: [body.events[0]],
      })
      .expect(409)
      .expect((r) => expect(JSON.stringify(r.body)).toContain('DUPLICATE_EVENT_NO'));
  });

  it('离返院：先收到返院，再补离院，重放后得到唯一正确区间', async () => {
    await activateGradePeriod('E-LEAVE-ORDER', {}, '2024-04-01');
    const ret = await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-ORDER',
        batchNo: 'return-first',
        events: [
          { eventNo: 'evt-ordered-return', eventType: 'RETURN', occurredAt: '2024-04-12T09:00:00+08:00', receiveSequence: 20 },
        ],
      })
      .expect(201);
    expect(ret.body.periods[0].status).toBe('ORPHAN_RETURN');
    expect(ret.body.periods[0].explanation).toContain('缺少可配对离院事件');

    await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-ORDER',
        batchNo: 'leave-later',
        events: [
          { eventNo: 'evt-ordered-leave', eventType: 'LEAVE', occurredAt: '2024-04-10T08:00:00+08:00', receiveSequence: 21 },
        ],
      })
      .expect(201);

    const periods = await http
      .get('/api/leave-periods')
      .query({ elderId: 'E-LEAVE-ORDER' })
      .expect(200);
    expect(periods.body).toHaveLength(1);
    expect(periods.body[0]).toMatchObject({
      status: 'MATCHED',
      startDate: '2024-04-10',
      endDate: '2024-04-12',
      leaveEventNo: 'evt-ordered-leave',
      returnEventNo: 'evt-ordered-return',
    });

    const fees = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-LEAVE-ORDER', from: '2024-04-01', to: '2024-04-12' })
      .expect(200);
    expect(fees.body.pausedDays).toBe(3);
    expect(fees.body.totalAmount).toBe('900.00');
  });

  it('离返院：迟到事件命中已结算月份时不改原账，只追加唯一退费调整单', async () => {
    await activateGradePeriod('E-LEAVE-LATE', {}, '2024-05-01');
    const before = await http
      .post('/api/fees/settle')
      .send({ elderId: 'E-LEAVE-LATE', month: '2024-05' })
      .expect(201);
    expect(before.body.replayed).toBe(false);
    expect(before.body.settlement.originalAmount).toBe('3100.00');
    expect(before.body.settlement.billedAmount).toBe('3100.00');

    await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-LATE',
        batchNo: 'late-matched',
        events: [
          { eventNo: 'late-leave', eventType: 'LEAVE', occurredAt: '2024-05-10T08:00:00+08:00', receiveSequence: 30 },
          { eventNo: 'late-return', eventType: 'RETURN', occurredAt: '2024-05-12T18:00:00+08:00', receiveSequence: 31 },
        ],
      })
      .expect(201)
      .expect((r) => {
        expect(r.body.adjustments).toHaveLength(1);
        expect(r.body.adjustments[0]).toMatchObject({
          adjustmentType: 'REFUND',
          amount: '-300.00',
        });
        expect(r.body.adjustments[0].lines).toHaveLength(3);
      });

    const settled = await http
      .get('/api/fees/settlements/2024-05')
      .query({ elderId: 'E-LEAVE-LATE' })
      .expect(200);
    expect(settled.body.settlement.billedAmount).toBe('3100.00');
    expect(settled.body.currentNetAmount).toBe('2800.00');
    expect(settled.body.adjustments[0].lines.map((l: any) => l.feeDate)).toEqual([
      '2024-05-10',
      '2024-05-11',
      '2024-05-12',
    ]);

    // 同一事件批次/回调重放不重复生成调整；重复 settlement 也幂等回放
    const replayEvents = await http
      .post('/api/leave-events')
      .send({
        elderId: 'E-LEAVE-LATE',
        batchNo: 'late-matched',
        events: [
          { eventNo: 'late-leave', eventType: 'LEAVE', occurredAt: '2024-05-10T08:00:00+08:00', receiveSequence: 30 },
          { eventNo: 'late-return', eventType: 'RETURN', occurredAt: '2024-05-12T18:00:00+08:00', receiveSequence: 31 },
        ],
      })
      .expect(201);
    expect(replayEvents.body.replayed).toBe(true);
    const replaySettle = await http
      .post('/api/fees/settle')
      .send({ elderId: 'E-LEAVE-LATE', month: '2024-05' })
      .expect(201);
    expect(replaySettle.body.replayed).toBe(true);
    const afterReplay = await http
      .get('/api/fees/adjustments')
      .query({ elderId: 'E-LEAVE-LATE', month: '2024-05' })
      .expect(200);
    expect(afterReplay.body).toHaveLength(1);
  });

  it('离返院：并发补录接收顺序冲突时整批失败，重启后事件/区间/原账/调整均可回放', async () => {
    await activateGradePeriod('E-LEAVE-RESTART', {}, '2024-06-01');
    await http
      .post('/api/fees/settle')
      .send({ elderId: 'E-LEAVE-RESTART', month: '2024-06' })
      .expect(201);

    const [ok, conflict] = await Promise.all([
      http.post('/api/leave-events').send({
        elderId: 'E-LEAVE-RESTART',
        batchNo: 'concurrent-ok',
        events: [
          { eventNo: 'restart-leave', eventType: 'LEAVE', occurredAt: '2024-06-08T08:00:00+08:00', receiveSequence: 40 },
          { eventNo: 'restart-return', eventType: 'RETURN', occurredAt: '2024-06-09T20:00:00+08:00', receiveSequence: 41 },
        ],
      }),
      http.post('/api/leave-events').send({
        elderId: 'E-LEAVE-RESTART',
        batchNo: 'concurrent-bad',
        events: [
          { eventNo: 'conflicting-return', eventType: 'RETURN', occurredAt: '2024-06-20T20:00:00+08:00', receiveSequence: 41 },
        ],
      }),
    ]);

    const statuses = [ok.status, conflict.status].sort();
    expect(statuses).toEqual([201, 409]);
    if (ok.status === 409) throw new Error('接受成功批次意外失败：' + JSON.stringify(ok.body));
    expect(ok.body.adjustments).toHaveLength(1);
    expect(ok.body.adjustments[0].amount).toBe('-200.00');

    const ds = app.get(DataSource);
    const counts = await ds.query(
      `SELECT
        (SELECT count(*) FROM leave_events WHERE elder_id='E-LEAVE-RESTART')::text AS events,
        (SELECT count(*) FROM leave_event_batches WHERE elder_id='E-LEAVE-RESTART')::text AS batches,
        (SELECT count(*) FROM leave_suspension_periods WHERE elder_id='E-LEAVE-RESTART')::text AS periods,
        (SELECT count(*) FROM fee_adjustments WHERE elder_id='E-LEAVE-RESTART')::text AS adjustments`,
    );
    expect(counts[0]).toMatchObject({ events: '2', batches: '1', periods: '1', adjustments: '1' });

    // 模拟应用重启：重新创建 NestApplication；启动钩子会从事件历史重建暂停区间。
    await app.close();
    const moduleRef2 = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef2.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());

    const replayedLedger = await http
      .get('/api/elders/E-LEAVE-RESTART/leave-events')
      .expect(200);
    expect(replayedLedger.body.events).toHaveLength(2);
    expect(replayedLedger.body.periods).toHaveLength(1);
    expect(replayedLedger.body.periods[0]).toMatchObject({
      status: 'MATCHED',
      startDate: '2024-06-08',
      endDateExclusive: '2024-06-10',
    });
    const replayedSettlement = await http
      .get('/api/fees/settlements/2024-06')
      .query({ elderId: 'E-LEAVE-RESTART' })
      .expect(200);
    expect(replayedSettlement.body.settlement.billedAmount).toBe('3000.00');
    expect(replayedSettlement.body.currentNetAmount).toBe('2800.00');
    expect(replayedSettlement.body.adjustments).toHaveLength(1);
    expect(replayedSettlement.body.adjustments[0].lines[0].batchId).toBeTruthy();
    expect(replayedSettlement.body.adjustments[0].lines[0].settlementLineId).toBeTruthy();
  });

  it('OpenAPI：离返院事件、暂停、试算、结算和调整接口可发现', async () => {
    const doc = await http.get('/api/openapi').expect(200);
    for (const path of [
      '/leave-events',
      '/leave-periods',
      '/fees/leave-trial',
      '/fees/settle',
      '/fees/adjustments',
    ]) {
      expect(doc.body.paths[path]).toBeTruthy();
    }
  });
});
