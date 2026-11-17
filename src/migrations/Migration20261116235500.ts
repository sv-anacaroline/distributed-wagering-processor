import { Migration } from '@mikro-orm/migrations';

/**
 * A PostgreSQL identity, assigned as events are inserted under the wallet lock,
 * preserves the causal order of events with identical occurred_at timestamps.
 * Existing unpublished rows receive a sequence during backfill; deploy this
 * migration with the publisher stopped to avoid reordering historical backlog.
 */
export class Migration20261116235500 extends Migration {
  override up(): void {
    this.addSql(`alter table outbox_messages
      add column publication_sequence bigint generated always as identity`);
    this.addSql(`create unique index outbox_publication_sequence_unique
      on outbox_messages(publication_sequence)`);
    this.addSql('drop index if exists outbox_wallet_pending_order_idx');
    this.addSql(`create index outbox_wallet_pending_sequence_idx
      on outbox_messages(aggregate_id,publication_sequence)
      where published_at is null`);
  }

  override down(): void {
    this.addSql('drop index if exists outbox_wallet_pending_sequence_idx');
    this.addSql(`create index outbox_wallet_pending_order_idx
      on outbox_messages(aggregate_id,occurred_at,id)
      where published_at is null`);
    this.addSql('drop index if exists outbox_publication_sequence_unique');
    this.addSql('alter table outbox_messages drop column publication_sequence');
  }
}
