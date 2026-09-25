import { Controller, Get, Header } from '@nestjs/common';

const openapi = {
  openapi: '3.0.3',
  info: {
    title: '养老护理费用与离返院账本 API',
    version: '1.0.0',
    description:
      '等级期间、费率版本、离返院事件账本、暂停区间、试算、结算和追加调整。所有金额以字符串 decimal 返回。',
  },
  servers: [{ url: '/api' }],
  paths: {
    '/fees/activate': {
      post: {
        summary: '等级生效',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['caseId', 'effectiveDate'],
                properties: {
                  caseId: { type: 'string', format: 'uuid' },
                  effectiveDate: { type: 'string', format: 'date' },
                  idempotencyKey: { type: 'string', maxLength: 128 },
                },
              },
            },
          },
        },
        responses: { '201': { description: '等级期间已生效或重复请求回放' } },
      },
    },
    '/fees/segments': {
      get: {
        summary: '在院费用基线分段（不应用离院暂停）',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: '等级×费率逐日合并分段' } },
      },
    },
    '/fees/leave-events': {
      get: {
        summary: '查询不可变离返院事件账本',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '事件历史' } },
      },
      post: {
        summary: '批量录入离返院事件并原子归并物化',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['events'],
                properties: {
                  events: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/components/schemas/LeaveEventInput' },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: '事件入库、暂停区间物化和调整追加整批成功' },
          '409': { description: '稳定事件号/接收顺序冲突，整批失败，无半区间' },
        },
      },
    },
    '/fees/leave-periods': {
      get: {
        summary: '查询物化暂停区间与异常状态',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'MATCHED/AWAITING_RETURN/OVERLAPPING_DEPARTURE 等状态' } },
      },
    },
    '/fees/leave/trial': {
      get: {
        summary: '离院感知费用试算',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
        ],
        responses: { '200': { description: '逐日落库前的暂停、等级和费率分段' } },
      },
    },
    '/fees/settlements': {
      get: {
        summary: '查询老人结算单',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '已结算汇总' } },
      },
      post: {
        summary: '结算费用并冻结原始逐日账目',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['elderId', 'from', 'to'],
                properties: {
                  elderId: { type: 'string' },
                  from: { type: 'string', format: 'date' },
                  to: { type: 'string', format: 'date' },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: '结算成功或相同幂等键回放' },
          '409': { description: '结算区间重叠或日期非法' },
        },
      },
    },
    '/fees/settlements/{id}': {
      get: {
        summary: '查询结算单、原始逐日账目和调整单',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: '可回放结算来源' } },
      },
    },
    '/fees/adjustments': {
      get: {
        summary: '查询迟到事件追加的补收/退费调整',
        parameters: [
          { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'settlementId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: '调整单和逐日来源明细' } },
      },
    },
  },
  components: {
    schemas: {
      LeaveEventInput: {
        type: 'object',
        required: ['eventId', 'elderId', 'eventType', 'occurredAt', 'receivedSeq'],
        properties: {
          eventId: { type: 'string', maxLength: 128, description: '稳定事件号' },
          elderId: { type: 'string', maxLength: 64 },
          eventType: { type: 'string', enum: ['DEPARTURE', 'RETURN'] },
          occurredAt: { type: 'string', format: 'date-time', description: '带时区 ISO-8601 时间' },
          receivedSeq: { type: 'integer', minimum: 1, description: '接收顺序' },
          note: { type: 'string' },
        },
      },
      LeavePeriod: {
        type: 'object',
        properties: {
          departureEventId: { type: 'string' },
          returnEventId: { type: ['string', 'null'] },
          status: {
            type: 'string',
            enum: [
              'MATCHED',
              'AWAITING_RETURN',
              'RETURN_BEFORE_DEPARTURE',
              'OVERLAPPING_DEPARTURE',
              'ORPHAN_RETURN',
            ],
          },
          startDate: { type: 'string', format: 'date' },
          endDateExclusive: { type: ['string', 'null'], format: 'date' },
          statusReason: { type: 'string' },
        },
      },
    },
  },
};

@Controller()
export class OpenApiController {
  @Get('openapi.json')
  @Header('content-type', 'application/json; charset=utf-8')
  document() {
    return openapi;
  }
}
