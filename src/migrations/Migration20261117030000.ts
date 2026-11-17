import { Migration } from '@mikro-orm/migrations';

/**
 * Anomalous ledger sums are not bounded by one wallet's NUMERIC(20,2).
 * Diagnostics must remain recordable even when many corrupt ledger rows
 * accumulate beyond the valid balance range.
 */
export class Migration20261117030000 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wallet_reconciliation_anomalies
        alter column calculated_balance type numeric,
        alter column difference type numeric
    `);
  }

  override down(): void {
    this.addSql(`
      alter table wallet_reconciliation_anomalies
        alter column calculated_balance type numeric(20,2),
        alter column difference type numeric(21,2)
    `);
  }
}
