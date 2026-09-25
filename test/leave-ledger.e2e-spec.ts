import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GradeCode } from '../src/common/enums';
import { LeaveEventType, LeavePeriodStatus } from '../src/common/leave.enums';

describe('离返院事件账本与护理费用暂停 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ds: DataSource;

  const ITEMS = [
    'TRANSFER',
    'WALKING',
    'BATHING',
    'DRESSING',
    'TOILETING',
    'EATING',
    'CONTINENCE',
    'GROOMING',
    'STAIRS',
    'OUTDOOR',
  ];

  function answers(grade: GradeCode) {
    const map: Record<string, string> = {};
    for (const item of ITEMS) map[item] = 'INDEPENDENT';
    if (grade === GradeCode.MODERATE) {
      for (const item of ITEMS.slice(0, 8)) map[item] = 'MUCH_HELP';
    }
    if (grade === GradeCode.SEVERE) {
      for (const item of ITEMS.slice(0, 8)) map[item] = 'TOTAL_DEP';
    }
    return Object.entries(map).map(([itemCode, optionCode]) => ({ itemCode, optionCode }));
  }

  async function createConfirmedCase(elderId: string, grade: GradeCode) {
    const res = await http
      .post('/api/assessments')
      .send({
        elderId,
        elderName: `离院老人${elderId}`,
        familyContact: '13900000000',
        assessors: [
          { assessorId: 1, answers: answers(grade) },
          { assessorId: 2, answers: answers(grade) },
        ],
      })
      .expect(201);
    expect(res.body.confirmedGrade).toBe(grade);
    return res.body.id as string;
  }

  async function activate(elderId: string, grade: GradeCode, date: string) {
    const caseId = await createConfirmedCase(elderId, grade);
    await http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: date })
      .expect(201);
  }

  function leaveEvent(
    eventId: string,
    elderId: string,
    eventType: LeaveEventType,
    occurredAt: string,
    receivedSeq: number,
  ) {
    return { eventId, elderId, eventType, occurredAt, receivedSeq };
  }

  async function postEvents(events: unknown[], status = 201) {
    return http.post('/api/fees/leave-events').send({ events }).expect(status);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
    ds = app.get(DataSource);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('月中离返院：只暂停命中日，保留等级分段和费率分段', async () => {
    const elderId = 'E-LEAVE-MID';
    await activate(elderId, GradeCode.MODERATE, '2023-12-25');
    await postEvents([
      leaveEvent('evt-mid-out', elderId, LeaveEventType.DEPARTURE, '2024-01-05T08:00:00+08:00', 1),
      leaveEvent('evt-mid-back', elderId, LeaveEventType.RETURN, '2024-01-07T18:00:00+08:00', 2),
    ]);

    const res = await http
      .get('/api/fees/leave/trial')
      .query({ elderId, from: '2024-01-01', to: '2024-01-10' })
      .expect(200);

    expect(res.body.totalDays).toBe(10);
    expect(res.body.pausedDays).toBe(3);
    expect(res.body.billedDays).toBe(7);
    expect(res.body.baseAmount).toBe('2000.00');
    expect(res.body.pausedAmount).toBe('600.00');
    expect(res.body.netAmount).toBe('1400.00');

    const statuses = res.body.segments.map((s: any) => s.status);
    expect(statuses).toEqual(['ACTIVE', 'PAUSED', 'ACTIVE']);
    const [before, paused, after] = res.body.segments;
    expect(before).toMatchObject({
      startDate: '2024-01-01',
      endDate: '2024-01-04',
      days: 4,
      status: 'ACTIVE',
      grade: GradeCode.MODERATE,
      dailyRate: '200.00',
      netAmount: '800.00',
    });
    expect(paused).toMatchObject({
      startDate: '2024-01-05',
      endDate: '2024-01-07',
      days: 3,
      status: 'PAUSED',
      netAmount: '0.00',
      baseAmount: '600.00',
      leavePeriodDepartureEventId: 'evt-mid-out',
      leavePeriodReturnEventId: 'evt-mid-back',
    });
    expect(after).toMatchObject({ startDate: '2024-01-08', endDate: '2024-01-10', days: 3 });

    // 原始在院基线仍完整可回放，未被离院区间覆盖
    const base = await http
      .get('/api/fees/segments')
      .query({ elderId, from: '2024-01-01', to: '2024-01-10' })
      .expect(200);
    expect(base.body.totalAmount).toBe('2000.00');
  });

  it('暂停区间跨等级/费率版本：逐日暂停并保留切分，不按整月停费', async () => {
    const elderId = 'E-LEAVE-CROSS';
    const lightCase = await createConfirmedCase(elderId, GradeCode.LIGHT);
    await http
      .post('/api/fees/activate')
      .send({ caseId: lightCase, effectiveDate: '2023-12-30' })
      .expect(201);

    const severeCase = await createConfirmedCase(elderId, GradeCode.SEVERE);
    // SEVERE 双评估员一致时无需复核；月中升级
    await http
      .post('/api/fees/activate')
      .send({ caseId: severeCase, effectiveDate: '2024-01-02' })
      .expect(201);

    await postEvents([
      leaveEvent('evt-cross-out', elderId, LeaveEventType.DEPARTURE, '2023-12-31T08:00:00+08:00', 10),
      leaveEvent('evt-cross-back', elderId, LeaveEventType.RETURN, '2024-01-03T18:00:00+08:00', 11),
    ]);

    const res = await http
      .get('/api/fees/leave/trial')
      .query({ elderId, from: '2023-12-31', to: '2024-01-04' })
      .expect(200);

    expect(res.body.pausedDays).toBe(4);
    expect(res.body.netAmount).toBe('300.00'); // 仅 1/4 在院 SEVERE
    expect(res.body.segments.filter((s: any) => s.status === 'PAUSED')).toHaveLength(2);
    expect(res.body.segments.filter((s: any) => s.status === 'PAUSED').map((s: any) => s.grade)).toEqual([
      GradeCode.LIGHT,
      GradeCode.SEVERE,
    ]);
    expect(res.body.notices.join(' ')).toContain('跨等级');
    expect(res.body.notices.join(' ')).toContain('跨费率版本');
  });

  it('重复回调幂等：不重复生成区间，也不重复减费', async () => {
    const elderId = 'E-LEAVE-DUP';
    await activate(elderId, GradeCode.LIGHT, '2024-02-01');
    const out = leaveEvent('evt-dup-out', elderId, LeaveEventType.DEPARTURE, '2024-02-10T08:00:00+08:00', 20);
    const back = leaveEvent('evt-dup-back', elderId, LeaveEventType.RETURN, '2024-02-11T18:00:00+08:00', 21);

    const first = await postEvents([out, back]);
    expect(first.body.insertedCount).toBe(2);
    const second = await postEvents([back, out]);
    expect(second.body.replayed).toBe(true);
    expect(second.body.insertedCount).toBe(0);
    expect(second.body.duplicateCount).toBe(2);

    const periods = await http.get('/api/fees/leave-periods').query({ elderId }).expect(200);
    expect(periods.body.periods).toHaveLength(1);
    expect(periods.body.periods[0].status).toBe(LeavePeriodStatus.MATCHED);

    const trial = await http
      .get('/api/fees/leave/trial')
      .query({ elderId, from: '2024-02-01', to: '2024-02-12' })
      .expect(200);
    expect(trial.body.pausedDays).toBe(2);
    expect(trial.body.netAmount).toBe('1000.00'); // 12 天 - 暂停 2 天
  });

  it('先收到返院再补离院：归并后得到唯一正确区间', async () => {
    const elderId = 'E-LEAVE-LATE-DEPARTURE';
    await activate(elderId, GradeCode.LIGHT, '2024-03-01');

    const first = await postEvents([
      leaveEvent('evt-order-back', elderId, LeaveEventType.RETURN, '2024-03-06T18:00:00+08:00', 30),
    ]);
    expect(first.body.periods).toEqual([]);
    expect(first.body.anomalies).toHaveLength(1);
    expect(first.body.anomalies[0].anomalyType).toBe('ORPHAN_RETURN');

    const second = await postEvents([
      leaveEvent('evt-order-out', elderId, LeaveEventType.DEPARTURE, '2024-03-04T08:00:00+08:00', 31),
    ]);
    expect(second.body.anomalies).toEqual([]);
    expect(second.body.periods).toHaveLength(1);
    expect(second.body.periods[0]).toMatchObject({
      departureEventId: 'evt-order-out',
      returnEventId: 'evt-order-back',
      status: LeavePeriodStatus.MATCHED,
      startDate: '2024-03-04',
      endDateExclusive: '2024-03-07',
    });

    const trial = await http
      .get('/api/fees/leave/trial')
      .query({ elderId, from: '2024-03-01', to: '2024-03-08' })
      .expect(200);
    expect(trial.body.pausedDays).toBe(3);
    expect(trial.body.netAmount).toBe('500.00');
  });

  it('返院早于离院、缺少配对均有可解释状态，且不按整月停费', async () => {
    const elderId = 'E-LEAVE-BAD';
    await activate(elderId, GradeCode.LIGHT, '2024-04-01');
    await postEvents([
      leaveEvent('evt-bad-back', elderId, LeaveEventType.RETURN, '2024-04-03T18:00:00+08:00', 40),
      leaveEvent('evt-bad-out', elderId, LeaveEventType.DEPARTURE, '2024-04-05T08:00:00+08:00', 41),
    ]);

    const periods = await http.get('/api/fees/leave-periods').query({ elderId }).expect(200);
    expect(periods.body.periods[0]).toMatchObject({
      status: LeavePeriodStatus.AWAITING_RETURN,
      startDate: '2024-04-05',
      endDateExclusive: null,
    });
    expect(periods.body.anomalies[0]).toMatchObject({
      anomalyType: 'RETURN_BEFORE_DEPARTURE',
      returnEventId: 'evt-bad-back',
      departureEventId: 'evt-bad-out',
    });

    const trial = await http
      .get('/api/fees/leave/trial')
      .query({ elderId, from: '2024-04-01', to: '2024-04-10' })
      .expect(200);
    expect(trial.body.pausedDays).toBe(0);
    expect(trial.body.netAmount).toBe('1000.00');
    expect(trial.body.notices.join(' ')).toContain('缺少返院配对');
  });

  it('迟到事件命中已结算月份：不改原账目，只追加唯一退费调整单', async () => {
    const elderId = 'E-LEAVE-SETTLED';
    await activate(elderId, GradeCode.LIGHT, '2024-05-01');

    const settled = await http
      .post('/api/fees/settlements')
      .send({
        elderId,
        from: '2024-05-01',
        to: '2024-05-10',
        idempotencyKey: 'settle-may-1-10',
      })
      .expect(201);
    expect(settled.body.settlement.netAmount).toBe('1000.00');
    const settlementId = settled.body.settlement.id;

    await postEvents([
      leaveEvent('evt-late-out', elderId, LeaveEventType.DEPARTURE, '2024-05-03T08:00:00+08:00', 50),
      leaveEvent('evt-late-back', elderId, LeaveEventType.RETURN, '2024-05-04T18:00:00+08:00', 51),
    ]);

    const detail = await http.get(`/api/fees/settlements/${settlementId}`).expect(200);
    expect(detail.body.settlement.netAmount).toBe('1000.00');
    expect(detail.body.entries.filter((e: any) => e.status === 'ACTIVE')).toHaveLength(10);
    expect(detail.body.adjustments).toHaveLength(1);
    expect(detail.body.adjustments[0]).toMatchObject({
      adjustmentType: 'REFUND',
      amount: '200.00',
      settlementId,
    });
    expect(detail.body.adjustments[0].items).toHaveLength(2);

    const replayEvents = await postEvents([
      leaveEvent('evt-late-out', elderId, LeaveEventType.DEPARTURE, '2024-05-03T08:00:00+08:00', 50),
      leaveEvent('evt-late-back', elderId, LeaveEventType.RETURN, '2024-05-04T18:00:00+08:00', 51),
    ]);
    expect(replayEvents.body.adjustments).toEqual([]);
    const again = await http.get('/api/fees/adjustments').query({ elderId }).expect(200);
    expect(again.body).toHaveLength(1);
    expect(again.body[0].items).toHaveLength(2);
  });

  it('并发补录冲突：数据库锁/唯一约束保证整批失败，无半区间', async () => {
    const elderId = 'E-LEAVE-CONCURRENT';
    await activate(elderId, GradeCode.LIGHT, '2024-06-01');

    const payloadA = {
      events: [
        leaveEvent('evt-con-a-out', elderId, LeaveEventType.DEPARTURE, '2024-06-02T08:00:00+08:00', 60),
        leaveEvent('evt-con-a-back', elderId, LeaveEventType.RETURN, '2024-06-03T18:00:00+08:00', 61),
      ],
    };
    const payloadB = {
      events: [
        leaveEvent('evt-con-b-out', elderId, LeaveEventType.DEPARTURE, '2024-06-04T08:00:00+08:00', 60),
      ],
    };

    const [a, b] = await Promise.all([
      http.post('/api/fees/leave-events').send(payloadA),
      http.post('/api/fees/leave-events').send(payloadB),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect([a.body.code, b.body.code].join(' ')).toContain('RECEIVED_SEQ_CONFLICT');

    const events = await http.get('/api/fees/leave-events').query({ elderId }).expect(200);
    const periods = await http.get('/api/fees/leave-periods').query({ elderId }).expect(200);
    if (a.status === 201) {
      expect(events.body.events.map((e: any) => e.eventId).sort()).toEqual([
        'evt-con-a-back',
        'evt-con-a-out',
      ]);
      expect(periods.body.periods).toHaveLength(1);
    } else {
      expect(events.body.events.map((e: any) => e.eventId)).toEqual(['evt-con-b-out']);
      expect(periods.body.periods).toHaveLength(1);
      expect(periods.body.periods[0].status).toBe(LeavePeriodStatus.AWAITING_RETURN);
    }
  });

  it('重启后事件账本、暂停区间、原费用和调整来源均可回放', async () => {
    const elderId = 'E-LEAVE-REPLAY';
    await activate(elderId, GradeCode.LIGHT, '2024-07-01');
    const firstSettle = await http
      .post('/api/fees/settlements')
      .send({ elderId, from: '2024-07-01', to: '2024-07-10' })
      .expect(201);
    const settlementId = firstSettle.body.settlement.id;
    await postEvents([
      leaveEvent('evt-replay-out', elderId, LeaveEventType.DEPARTURE, '2024-07-08T08:00:00+08:00', 70),
      leaveEvent('evt-replay-back', elderId, LeaveEventType.RETURN, '2024-07-09T18:00:00+08:00', 71),
    ]);

    await app.close();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
    ds = app.get(DataSource);

    const events = await http.get('/api/fees/leave-events').query({ elderId }).expect(200);
    expect(events.body.events).toHaveLength(2);
    const periods = await http.get('/api/fees/leave-periods').query({ elderId }).expect(200);
    expect(periods.body.periods[0]).toMatchObject({
      status: LeavePeriodStatus.MATCHED,
      startDate: '2024-07-08',
      endDateExclusive: '2024-07-10',
    });

    const settlement = await http.get(`/api/fees/settlements/${settlementId}`).expect(200);
    expect(settlement.body.settlement.netAmount).toBe('1000.00');
    expect(settlement.body.entries).toHaveLength(10);
    expect(settlement.body.adjustments).toHaveLength(1);
    expect(settlement.body.adjustments[0].adjustmentType).toBe('REFUND');
    expect(settlement.body.adjustments[0].amount).toBe('200.00');
    expect(settlement.body.adjustments[0].items.map((i: any) => i.entryDate)).toEqual([
      '2024-07-08',
      '2024-07-09',
    ]);
    expect(settlement.body.adjustments[0].items[0].chargeEntryId).toBeTruthy();

    const dbAdjustment = await ds.query(
      `SELECT a.source_event_ids, i.departure_event_id, i.return_event_id
         FROM fee_adjustments a
         JOIN fee_adjustment_items i ON i.adjustment_id = a.id
        WHERE a.settlement_id = $1
        ORDER BY i.entry_date`,
      [settlementId],
    );
    expect(dbAdjustment).toHaveLength(2);
    expect(dbAdjustment[0].source_event_ids).toEqual(['evt-replay-out', 'evt-replay-back']);
  }, 120_000);

  it('暴露 OpenAPI 文档', async () => {
    const doc = await http.get('/api/openapi.json').expect(200);
    expect(doc.body.openapi).toMatch(/^3\./);
    expect(doc.body.paths['/fees/leave-events'].post.summary).toContain('离返院');
    expect(doc.body.components.schemas.LeaveEventInput.properties.receivedSeq.type).toBe('integer');
  });
});
