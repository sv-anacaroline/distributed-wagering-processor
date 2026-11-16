import { Migration } from '@mikro-orm/migrations';

/** Applies new section 7 rules without changing the existing domain migration. */
export class Migration20261116213000 extends Migration {
  override up(): void {
    // Only active or completed reversals reserve the original. Rejected
    // attempts cannot permanently prevent a corrected new transaction.
    this.addSql('drop index if exists wager_one_reversal_per_kind');
    this.addSql(`
      create unique index wager_one_active_reversal
      on wager_transactions(provider_id, reference_external_transaction_id)
      where kind in ('REFUND', 'ROLLBACK')
      and status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
    `);

    this.addSql(`
      alter table wager_transactions
        add column reference_retry_attempts integer not null default 0
          check (reference_retry_attempts >= 0),
        add column reference_next_attempt_at timestamptz,
        add column reference_expires_at timestamptz
    `);

    // Safe upgrade for pending references existing before this migration.
    this.addSql(`
      update wager_transactions
      set reference_next_attempt_at = greatest(now(), created_at) + interval '5 seconds',
          reference_expires_at = greatest(now(), created_at) + interval '24 hours'
      where status = 'PENDING_REFERENCE'
    `);

    this.addSql(`
      alter table wager_transactions
      add constraint wager_pending_retry_fields check (
        status <> 'PENDING_REFERENCE'
        or (reference_next_attempt_at is not null and reference_expires_at is not null)
      )
    `);
    this.addSql(`
      alter table wager_transactions
      add constraint wager_reference_retry_order check (
        reference_expires_at is null or reference_expires_at >= created_at
      )
    `);
    this.addSql(`
      alter table wager_transactions
      add constraint wager_resolved_reference_check check (
        status <> 'PROCESSED'
        or reference_external_transaction_id is null
        or reference_transaction_id is not null
      )
    `);

    this.addSql('drop index if exists wager_pending_reference_idx');
    this.addSql(`
      create index wager_pending_reference_due_idx
      on wager_transactions(reference_next_attempt_at, id)
      where status = 'PENDING_REFERENCE'
    `);

    // SQL safety net: only a processed matching transaction can be a
    // resolved reference. The value and wallet are checked in application.
    this.addSql(`
      create function validate_wager_reference() returns trigger
      language plpgsql as $$
      declare ref wager_transactions%rowtype;
      begin
        if new.status <> 'PROCESSED' or new.reference_transaction_id is null then
          return new;
        end if;
        select * into ref from wager_transactions where id = new.reference_transaction_id;
        if not found or ref.status <> 'PROCESSED'
           or ref.provider_id <> new.provider_id
           or ref.external_transaction_id <> new.reference_external_transaction_id
           or ref.wallet_id <> new.wallet_id
           or ref.player_id <> new.player_id
           or ref.currency <> new.currency
           or ref.round_id <> new.round_id
           or ref.game_id <> new.game_id then
          raise exception 'invalid resolved wager reference' using errcode = '23514';
        end if;
        if new.kind = 'REFUND' and
           (ref.kind <> 'BET' or ref.amount <> new.amount) then
          raise exception 'invalid refund reference' using errcode = '23514';
        end if;
        if new.kind = 'ROLLBACK' and
           (ref.kind not in ('BET', 'WIN', 'REFUND') or ref.amount <> new.amount) then
          raise exception 'invalid rollback reference' using errcode = '23514';
        end if;
        if new.kind = 'WIN' and ref.kind <> 'BET' then
          raise exception 'invalid win reference' using errcode = '23514';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_reference_guard
      before insert or update of status, reference_transaction_id on wager_transactions
      for each row execute function validate_wager_reference()
    `);
  }

  override down(): void {
    this.addSql('drop trigger if exists wager_reference_guard on wager_transactions');
    this.addSql('drop function if exists validate_wager_reference()');
    this.addSql('drop index if exists wager_pending_reference_due_idx');
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_resolved_reference_check',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_reference_retry_order',
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists wager_pending_retry_fields',
    );
    this.addSql(`
      alter table wager_transactions
        drop column if exists reference_retry_attempts,
        drop column if exists reference_next_attempt_at,
        drop column if exists reference_expires_at
    `);
    this.addSql('drop index if exists wager_one_active_reversal');
    this.addSql(`
      create unique index wager_one_reversal_per_kind
      on wager_transactions(provider_id, reference_external_transaction_id, kind)
      where kind in ('REFUND', 'ROLLBACK')
      and status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
    `);
  }
}
