import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { RiskService } from './risk.service';
import { assessRiskSchema, AssessRiskInput, AssessRiskDto } from './risk.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';

@ApiTags('risk')
@ApiBearerAuth('access-token')
@Controller('risk')
export class RiskController {
  constructor(private readonly riskService: RiskService) {}

  @Post('assess')
  @ApiOperation({
    summary: 'Assess the risk score of a hypothetical transaction',
    description:
      'Evaluates a transaction intent and returns a risk score with detailed factors. ' +
      'Consider using POST /transactions/simulate for full governance pipeline evaluation.',
  })
  @ApiBody({ type: AssessRiskDto })
  @ApiResponse({ status: 200, description: 'Risk assessment with score and detailed factors' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  assess(
    @CurrentUser('organizationId') _organizationId: string,
    @Body(new ZodValidationPipe(assessRiskSchema)) body: AssessRiskInput,
  ) {
    return this.riskService.assess(body);
  }
}
