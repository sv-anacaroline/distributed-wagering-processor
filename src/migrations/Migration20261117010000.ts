import { Migration } from '@mikro-orm/migrations';

/** Explicit many-to-many provider access; wallet identity remains (playerId,currency). */
export class Migration20261117010000 extends Migration {
  override up(): void {
    this.addSql(`create table wallet_provider_grants (
      wallet_id uuid not null references wallets(id) on delete restrict,
      provider_id varchar(128) not null,
      granted_at timestamptz not null default clock_timestamp(),
      primary key (wallet_id,provider_id),
      constraint wallet_provider_grants_provider_not_empty check (length(trim(provider_id)) > 0)
    )`);
    this.addSql(`create index wallet_provider_grants_provider_wallet_idx
      on wallet_provider_grants(provider_id,wallet_id)`);
  }

  override down(): void {
    this.addSql('drop table if exists wallet_provider_grants');
  }
}
