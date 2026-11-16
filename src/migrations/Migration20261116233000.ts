import { Migration } from '@mikro-orm/migrations';

/** Reconciliation anomalies are audit data, not silent wallet corrections. */
export class Migration20261116233000 extends Migration {
  override up(): void {
    this.addSql(`create table wallet_reconciliation_anomalies (
      id uuid primary key,
      wallet_id uuid not null references wallets(id),
      stored_balance numeric(20,2) not null,
      calculated_balance numeric(20,2) not null,
      difference numeric(21,2) not null,
      checked_entries bigint not null check (checked_entries >= 0),
      detected_at timestamptz not null,
      constraint reconciliation_difference_check
        check (stored_balance - calculated_balance = difference)
    )`);
    this.addSql(`create index reconciliation_anomaly_wallet_time_idx
      on wallet_reconciliation_anomalies(wallet_id, detected_at desc)`);
  }
  override down(): void {
    this.addSql('drop table if exists wallet_reconciliation_anomalies');
  }
}
