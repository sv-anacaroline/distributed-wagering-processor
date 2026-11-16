-- Execute with psql against the same PostgreSQL that processes wagers.
-- Read-only diagnostics. pg_stat views are cumulative and need context.
select relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 2) as hot_pct,
       n_dead_tup, seq_scan, idx_scan
from pg_stat_user_tables
where relname in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages')
order by relname;

select relname, pg_size_pretty(pg_total_relation_size(relid)) as total_size
from pg_stat_user_tables
where relname in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages')
order by relname;

select tablename, indexname, indexdef
from pg_indexes
where schemaname = current_schema()
  and tablename in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages')
order by tablename, indexname;

select s.relname as table_name, s.indexrelname as index_name,
       s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
from pg_stat_user_indexes s
where s.relname in ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages')
order by s.relname, s.indexrelname;

select pid, wait_event_type, wait_event, state,
       now() - query_start as elapsed,
       left(query, 120) as active_sql
from pg_stat_activity
where datname = current_database()
  and wait_event_type = 'Lock'
order by elapsed desc;
