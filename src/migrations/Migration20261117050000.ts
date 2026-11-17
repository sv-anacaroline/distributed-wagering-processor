import { Migration } from '@mikro-orm/migrations';

/** Persist W3C parent context so asynchronous event publication continues the trace. */
export class Migration20261117050000 extends Migration {
  override up(): void {
    this.addSql('alter table outbox_messages add column traceparent varchar(55) null');
    this.addSql(`alter table outbox_messages add constraint outbox_traceparent_format
      check (traceparent is null or traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$')`);
  }
  override down(): void {
    this.addSql('alter table outbox_messages drop constraint if exists outbox_traceparent_format');
    this.addSql('alter table outbox_messages drop column if exists traceparent');
  }
}
