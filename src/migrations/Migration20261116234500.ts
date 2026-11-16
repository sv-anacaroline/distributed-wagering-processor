import { Migration } from '@mikro-orm/migrations';

/** Index the oldest unpublished event per wallet; protect Inbox dedup identity. */
export class Migration20261116234500 extends Migration {
  override up(): void {
    this.addSql(`create index outbox_wallet_pending_order_idx
      on outbox_messages(aggregate_id, occurred_at, id)
      where published_at is null`);
    this.addSql(`
      create function protect_inbox_identity() returns trigger
      language plpgsql as $$
      begin
        if (new.consumer_name, new.message_id, new.payload_hash, new.received_at)
           is distinct from (old.consumer_name, old.message_id, old.payload_hash, old.received_at) then
          raise exception 'inbox identity and payload are immutable' using errcode = '23514';
        end if;
        if old.processed_at is not null and new.processed_at is distinct from old.processed_at then
          raise exception 'processed inbox cannot be reopened' using errcode = '23514';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`create trigger inbox_identity_guard before update on inbox_messages
      for each row execute function protect_inbox_identity()`);
  }
  override down(): void {
    this.addSql('drop trigger if exists inbox_identity_guard on inbox_messages');
    this.addSql('drop function if exists protect_inbox_identity()');
    this.addSql('drop index if exists outbox_wallet_pending_order_idx');
  }
}
