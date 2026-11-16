import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { OidcAuthGuard } from './oidc.guard.js';
import { ReconciliationService } from './reconciliation.service.js';

@Controller('internal')
@UseGuards(OidcAuthGuard)
export class MetricsController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    const total = await this.reconciliation.divergenceCount();
    return `# HELP wallet_reconciliation_divergences_total Divergent wallet ledger reconciliations recorded in PostgreSQL\n# TYPE wallet_reconciliation_divergences_total counter\nwallet_reconciliation_divergences_total ${total}\n`;
  }
}
