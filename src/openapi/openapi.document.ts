export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: '养老评估与费用离返院账本 API',
    version: '1.1.0',
    description:
      '事件溯源式离返院账本、逐日暂停费用、已结算月份调整单。虚构行政流程演示，不构成医疗建议。',
  },
  servers: [{ url: '/api' }],
  components: {
    schemas: {
      Error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
      LeaveEventInput: {
        type: 'object',
        required: ['eventNo', 'eventType', 'occurredAt', 'receiveSequence'],
        properties: {
          eventNo: { type: 'string', maxLength: 128 },
          eventType: { type: 'string', enum: ['LEAVE', 'RETURN'] },
          occurredAt: { type: 'string', format: 'date-time' },
          receiveSequence: { type: 'integer', minimum: 1 },
        },
      },
      RecordLeaveEvents: {
        type: 'object',
        required: ['elderId', 'events'],
        properties: {
          elderId: { type: 'string', maxLength: 64 },
          batchNo: { type: 'string', maxLength: 128 },
          events: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: { $ref: '#/components/schemas/LeaveEventInput' },
          },
        },
      },
      SuspensionPeriod: {
        type: 'object',
        properties: {
          periodKey: { type: 'string' },
          elderId: { type: 'string' },
          status: {
            type: 'string',
            enum: [
              'MATCHED',
              'OPEN_MISSING_RETURN',
              'ORPHAN_RETURN',
              'RETURN_BEFORE_DEPARTURE',
              'NESTED_DEPARTURE',
            ],
          },
          startDate: { type: ['string', 'null'], format: 'date' },
          eventDate: { type: ['string', 'null'], format: 'date' },
          endDate: { type: ['string', 'null'], format: 'date' },
          endDateExclusive: { type: ['string', 'null'], format: 'date' },
          leaveEventNo: { type: ['string', 'null'] },
          returnEventNo: { type: ['string', 'null'] },
          explanation: { type: 'string' },
        },
      },
      FeeSegment: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
          days: { type: 'integer' },
          grade: { type: ['string', 'null'], enum: ['LIGHT', 'MODERATE', 'SEVERE', null] },
          dailyRate: { type: ['string', 'null'] },
          originalAmount: { type: 'string' },
          amount: { type: 'string', description: '暂停后应收' },
          source: {
            type: 'string',
            enum: [
              'GRADE_PERIOD_AND_RATE',
              'GRADE_PERIOD_NO_RATE',
              'NO_EFFECTIVE_GRADE',
              'LEAVE_PAUSED',
            ],
          },
          status: {
            type: 'string',
            enum: ['BILLABLE', 'PAUSED_MATCHED', 'PAUSED_OPEN', 'NO_EFFECTIVE_GRADE', 'MISSING_RATE'],
          },
          leavePeriodKey: { type: ['string', 'null'] },
          warnings: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      FeeTrial: {
        type: 'object',
        properties: {
          elderId: { type: 'string' },
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          totalDays: { type: 'integer' },
          pausedDays: { type: 'integer' },
          originalAmount: { type: 'string' },
          totalAmount: { type: 'string' },
          segments: { type: 'array', items: { $ref: '#/components/schemas/FeeSegment' } },
          anomalies: { type: 'array', items: { $ref: '#/components/schemas/SuspensionPeriod' } },
        },
      },
      FeeAdjustment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          periodMonth: { type: 'string', example: '2024-02' },
          adjustmentType: { type: 'string', enum: ['REFUND', 'SUPPLEMENT'] },
          amount: { type: 'string', description: '退费为负，补收为正' },
          reason: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                feeDate: { type: 'string', format: 'date' },
                beforeBilledAmount: { type: 'string' },
                desiredBilledAmount: { type: 'string' },
                deltaAmount: { type: 'string' },
                leavePeriodKey: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  },
  paths: {
    '/leave-events': {
      post: {
        summary: '整批录入/补录离返院事件',
        description: '稳定 eventNo 幂等；batchNo 相同且载荷相同则回放；任何冲突整事务失败。',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordLeaveEvents' } } } },
        responses: {
          '201': { description: 'ACCEPTED，返回事件、物化区间和可能追加的调整单' },
          '409': { description: '重复事件号/接收顺序冲突/批次载荷冲突' },
        },
      },
    },
    '/elders/{elderId}/leave-events': {
      get: {
        summary: '回放事件账本',
        parameters: [{ name: 'elderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: '事件、暂停区间、异常状态' } },
      },
    },
    '/leave-periods': {
      get: {
        summary: '查询物化暂停区间',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '不重叠暂停区间' } },
      },
    },
    '/fees/segments': {
      get: {
        summary: '原费用分段接口，现已叠加离院暂停',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: '费用试算', content: { 'application/json': { schema: { $ref: '#/components/schemas/FeeTrial' } } } } },
      },
    },
    '/fees/leave-trial': {
      get: {
        summary: '离返院费用试算',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: '逐日和分段试算' } },
      },
    },
    '/fees/settle': {
      post: {
        summary: '月度费用结算',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['elderId', 'month'],
                properties: { elderId: { type: 'string' }, month: { type: 'string', example: '2024-02' } },
              },
            },
          },
        },
        responses: { '201': { description: '已结算或幂等回放' }, '409': { description: '异常事件或缺费率阻断' } },
      },
    },
    '/fees/settlements/{month}': {
      get: {
        summary: '查询原结算、追加调整和当前净额',
        parameters: [
          { name: 'month', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '结算与调整' }, '404': { description: '未找到结算' } },
      },
    },
    '/fees/adjustments': {
      get: {
        summary: '查询迟到事件产生的补收/退费调整',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'month', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '调整单列表', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/FeeAdjustment' } } } } } },
      },
    },
  },
} as const;
