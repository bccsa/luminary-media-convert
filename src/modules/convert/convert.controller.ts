import { Body, Controller, Post } from '@nestjs/common';
import { ConvertService } from './convert.service.js';

@Controller('api')
export class ConvertController {
  constructor(private readonly convert: ConvertService) {}

  // POST /api/forms - create a new form
  @Post('/forms')
  async createForm(
    @Body('schema') schema: any,
    @Body('name') name: string,
    @Body('formId') formId?: string
  ) {
    return '';
  }
}
