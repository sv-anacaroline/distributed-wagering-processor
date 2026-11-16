import { Migration } from '@mikro-orm/migrations';

/**
 * Reserve page space for HOT updates on frequently modified wallet balances.
 * This changes future page fill behavior without rewriting existing ledger data.
 * The balance/version/updated_at columns are not indexed, so wallet writes can
 * remain HOT (subject to sufficient free space and MVCC visibility).
 */
export class Migration20261116223000 extends Migration {
  override up(): void {
    this.addSql('alter table wallets set (fillfactor = 85)');
  }

  override down(): void {
    this.addSql('alter table wallets reset (fillfactor)');
  }
}
