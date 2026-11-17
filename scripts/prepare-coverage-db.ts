import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';

/**
 * Running the suite twice against one database makes deterministic identity
 * fixtures collide (and can silently distort duplicate/retry assertions).
 * Use a fresh database for combined coverage, without test data from the
 * prior integration run. This script must only be called in disposable CI.
 */
const database = 'wagering_coverage';
const orm = await MikroORM.init({ ...config, dbName: 'postgres' });
try {
  const found = await orm.em.fork().execute<Array<{ datname: string }>>(
    'select datname from pg_database where datname=?',
    [database],
  );
  if (found.length) {
    throw new Error(`Refusing to reuse existing coverage database ${database}`);
  }
  await orm.em.fork().execute(`create database ${database}`);
  console.log('Created isolated test database:', database);
} finally {
  await orm.close(true);
}
