import { Controller, Get, Header } from '@nestjs/common';
import { openapiDocument } from './openapi.document';

@Controller('openapi')
export class OpenApiController {
  @Get()
  @Header('content-type', 'application/json; charset=utf-8')
  document() {
    return openapiDocument;
  }
}
