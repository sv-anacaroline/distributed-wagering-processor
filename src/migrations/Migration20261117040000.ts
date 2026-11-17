import { Migration } from '@mikro-orm/migrations';

/**
 * Inbox dedup identities and confirmed Outbox intentions are durable.
 * Neither table participates in a normal deletion workflow. In particular,
 * deleting an unpublished event would silently violate at-least-once delivery.
 */
export class Migration20261117040000 extends Migration {
  override up(): void {
    this.addSql(`
      create function reject_durable_message_deletion() returns trigger
      language plpgsql as $$
      begin
        raise exception 'inbox and outbox history must not be deleted'
          using errcode = '23514';
      end;
      $$
    `);
    for (const table of ['inbox_messages', 'outbox_messages']) {
      this.addSql(`
        create trigger ${table}_no_delete
        before delete on ${table}
        for each row execute function reject_durable_message_deletion()
      `);
      this.addSql(`
        create trigger ${table}_no_truncate
        before truncate on ${table}
        for each statement execute function reject_durable_message_deletion()
      `);
    }
  }

  override down(): void {
    for (const table of ['outbox_messages', 'inbox_messages']) {
      this.addSql(`drop trigger if exists ${table}_no_truncate on ${table}`);
      this.addSql(`drop trigger if exists ${table}_no_delete on ${table}`);
    }
    this.addSql('drop function if exists reject_durable_message_deletion()');
  }
}
