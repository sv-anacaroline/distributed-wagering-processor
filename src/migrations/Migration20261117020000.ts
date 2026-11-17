import { Migration } from '@mikro-orm/migrations';

/**
 * Financial transaction rows are immutable audit records after acceptance.
 * Ledger has always been append-only. Without this guard a processed LOSS
 * or REJECTED wager (which has no ledger FK) could still be deleted directly.
 */
export class Migration20261117020000 extends Migration {
  override up(): void {
    this.addSql(`
      create function reject_wager_deletion() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wager_transactions is append-only'
          using errcode = '23514';
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_no_delete
      before delete on wager_transactions
      for each row execute function reject_wager_deletion()
    `);
    this.addSql(`
      create trigger wager_no_truncate
      before truncate on wager_transactions
      for each statement execute function reject_wager_deletion()
    `);
  }

  override down(): void {
    this.addSql('drop trigger if exists wager_no_truncate on wager_transactions');
    this.addSql('drop trigger if exists wager_no_delete on wager_transactions');
    this.addSql('drop function if exists reject_wager_deletion()');
  }
}
