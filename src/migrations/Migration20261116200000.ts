import { Migration } from '@mikro-orm/migrations';

/**
 * PostgreSQL invariants are mandatory: exact NUMERIC, unique identities,
 * append-only ledger and wallet/ledger consistency verified at SQL COMMIT.
 * The app must still lock the wallet row FOR UPDATE within the SQL transaction.
 */
export class Migration20261116200000 extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20, 2) not null check (balance >= 0),
        version integer not null default 1 check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallet_player_currency_unique unique (player_id, currency),
        constraint wallet_identity_currency_unique unique (id, player_id, currency),
        constraint wallet_id_currency_unique unique (id, currency),
        constraint wallet_time_check check (updated_at >= created_at)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null check (length(trim(provider_id)) > 0),
        external_transaction_id text not null check (length(trim(external_transaction_id)) > 0),
        idempotency_key text not null unique check (length(trim(idempotency_key)) > 0),
        payload_hash text not null check (length(trim(payload_hash)) > 0),
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) not null check (amount > 0),
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions(id),
        status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        response_snapshot jsonb,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_identity_wallet_currency_unique unique (id, wallet_id, currency),
        constraint wager_wallet_identity_fk
          foreign key (wallet_id, player_id, currency) references wallets(id, player_id, currency),
        constraint wager_reference_required check (
          (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null)
          and (kind in ('WIN', 'REFUND', 'ROLLBACK') or reference_external_transaction_id is null)
          and reference_external_transaction_id is distinct from external_transaction_id
        ),
        constraint wager_pending_reference_required check (
          status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null
        ),
        constraint wager_failure_code_check check (
          (status in ('REJECTED', 'FAILED') and failure_code is not null)
          or (status not in ('REJECTED', 'FAILED') and failure_code is null)
        ),
        constraint wager_processed_at_check check (
          (status = 'PROCESSED' and processed_at is not null)
          or (status <> 'PROCESSED' and processed_at is null)
        )
      )
    `);
    this.addSql(`
      create unique index wager_one_reversal_per_kind
      on wager_transactions(provider_id, reference_external_transaction_id, kind)
      where kind in ('REFUND', 'ROLLBACK')
    `);
    this.addSql(
      `create index wager_pending_reference_idx on wager_transactions(status, created_at) where status = 'PENDING_REFERENCE'`,
    );
    this.addSql(
      `create index wager_wallet_created_idx on wager_transactions(wallet_id, created_at, id)`,
    );

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        wallet_version integer not null check (wallet_version >= 1),
        direction text not null check (direction in ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) not null check (amount > 0),
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(20, 2) not null check (balance_before >= 0),
        balance_after numeric(20, 2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint ledger_wallet_version_unique unique (wallet_id, wallet_version),
        constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id),
        constraint ledger_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets(id, currency),
        constraint ledger_transaction_wallet_fk
          foreign key (transaction_id, wallet_id, currency)
          references wager_transactions(id, wallet_id, currency),
        constraint ledger_exact_arithmetic_check check (
          (direction = 'DEBIT' and balance_before - amount = balance_after)
          or (direction = 'CREDIT' and balance_before + amount = balance_after)
        )
      )
    `);
    this.addSql(
      `create index ledger_wallet_page_idx on wallet_ledger_entries(wallet_id, created_at, id)`,
    );

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null check (length(trim(payload_hash)) > 0),
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id),
        constraint inbox_valid_time check (processed_at is null or processed_at >= received_at),
        constraint inbox_valid_consumer check (length(trim(consumer_name)) > 0),
        constraint inbox_valid_message check (length(trim(message_id)) > 0)
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null references wallets(id),
        event_type text not null check (length(trim(event_type)) > 0),
        payload jsonb not null check (jsonb_typeof(payload) = 'object'),
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        claimed_by text,
        claim_expires_at timestamptz,
        constraint outbox_claim_check check ((claimed_by is null) = (claim_expires_at is null)),
        constraint outbox_retry_time_check check (next_attempt_at is null or next_attempt_at >= occurred_at),
        constraint outbox_published_time_check check (published_at is null or published_at >= occurred_at),
        constraint outbox_event_identity_check check (
          payload->>'eventId' = id::text
          and payload->>'aggregateId' = aggregate_id::text
          and payload->>'eventType' = event_type
        )
      )
    `);
    this.addSql(`
      create index outbox_due_idx
      on outbox_messages(next_attempt_at, claim_expires_at, occurred_at)
      where published_at is null
    `);

    this.addSql(`
      create function reject_ledger_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only' using errcode = '23514';
      end;
      $$
    `);
    this.addSql(`
      create trigger ledger_no_update_delete
      before update or delete on wallet_ledger_entries
      for each row execute function reject_ledger_mutation()
    `);
    this.addSql(`
      create trigger ledger_no_truncate
      before truncate on wallet_ledger_entries
      for each statement execute function reject_ledger_mutation()
    `);

    this.addSql(`
      create function protect_wallet_identity() returns trigger
      language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.created_at)
           is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet identity is immutable' using errcode = '23514';
        end if;
        if new.balance is distinct from old.balance then
          if new.version <> old.version + 1 then
            raise exception 'balance change must increment wallet version exactly once' using errcode = '23514';
          end if;
        elsif new.version <> old.version then
          raise exception 'wallet version changes only with balance' using errcode = '23514';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_update_guards
      before update on wallets
      for each row execute function protect_wallet_identity()
    `);

    this.addSql(`
      create function check_wallet_ledger_consistency() returns trigger
      language plpgsql as $$
      declare
        w wallets%rowtype;
        current_entry wallet_ledger_entries%rowtype;
        prior_entry wallet_ledger_entries%rowtype;
        selected_wallet_id uuid;
      begin
        if tg_table_name = 'wallets' then
          selected_wallet_id := new.id;
        else
          selected_wallet_id := new.wallet_id;
        end if;

        select * into w from wallets where id = selected_wallet_id;
        if not found then
          raise exception 'wallet missing for ledger invariant' using errcode = '23514';
        end if;
        select * into current_entry from wallet_ledger_entries
          where wallet_id = w.id and wallet_version = w.version;

        if w.version = 1 and w.balance = 0 and not found then
          return null;
        end if;
        if not found or current_entry.balance_after <> w.balance then
          raise exception 'wallet balance must match its latest ledger entry' using errcode = '23514';
        end if;

        if current_entry.wallet_version = 1 then
          if current_entry.direction <> 'CREDIT' or current_entry.balance_before <> 0 then
            raise exception 'opening ledger must credit an empty wallet' using errcode = '23514';
          end if;
        else
          select * into prior_entry from wallet_ledger_entries
            where wallet_id = w.id and wallet_version = current_entry.wallet_version - 1;
          if found then
            if prior_entry.balance_after <> current_entry.balance_before then
              raise exception 'ledger continuity violation' using errcode = '23514';
            end if;
          elsif current_entry.wallet_version <> 2 or current_entry.balance_before <> 0 then
            raise exception 'ledger version gap' using errcode = '23514';
          end if;
        end if;

        if tg_table_name = 'wallet_ledger_entries' then
          if new.wallet_version > w.version then
            raise exception 'future wallet ledger version' using errcode = '23514';
          end if;
        end if;
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_balance_ledger_guard
      after insert or update on wallets
      deferrable initially deferred
      for each row execute function check_wallet_ledger_consistency()
    `);
    this.addSql(`
      create constraint trigger ledger_balance_wallet_guard
      after insert on wallet_ledger_entries
      deferrable initially deferred
      for each row execute function check_wallet_ledger_consistency()
    `);

    this.addSql(`
      create function reject_terminal_wager_mutation() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'terminal wager status is immutable' using errcode = '23514';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
            new.kind, new.amount, new.currency, new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
            old.kind, old.amount, old.currency, old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager identity and payload are immutable' using errcode = '23514';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_terminal_guard
      before update on wager_transactions
      for each row execute function reject_terminal_wager_mutation()
    `);

    this.addSql(`
      create function protect_outbox_event() returns trigger
      language plpgsql as $$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox event identity/payload immutable' using errcode = '23514';
        end if;
        if new.attempts < old.attempts or
           (old.published_at is not null and new.published_at is distinct from old.published_at) then
          raise exception 'outbox publication progress cannot be reversed' using errcode = '23514';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger outbox_event_guard
      before update on outbox_messages
      for each row execute function protect_outbox_event()
    `);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
    this.addSql('drop function if exists protect_outbox_event()');
    this.addSql('drop function if exists reject_terminal_wager_mutation()');
    this.addSql('drop function if exists check_wallet_ledger_consistency()');
    this.addSql('drop function if exists protect_wallet_identity()');
    this.addSql('drop function if exists reject_ledger_mutation()');
  }
}
