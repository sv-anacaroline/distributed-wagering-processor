import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';

let orm: MikroORM;
beforeAll(async () => {
  orm = await MikroORM.init(config);
});
afterAll(async () => {
  await orm.close(true);
});

async function newWallet(): Promise<string> {
  const id = randomUUID();
  await orm.em.execute(
    `insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
     values(?::uuid, ?::uuid, 'BRL', 0.00, 1, now(), now())`,
    [id, randomUUID()],
  );
  return id;
}

describe('PostgreSQL wallet row lock scope', () => {
  it('permits FK-style KEY SHARE during wallet NO KEY UPDATE', async () => {
    const id = await newWallet();
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id=?::uuid for no key update', [id]);
      acquired();
      await waiting;
    });
    await locked;
    try {
      await orm.em.fork().transactional(async (em) => {
        await em.execute('select id from wallets where id=?::uuid for key share nowait', [id]);
      });
    } finally {
      release();
      await holding;
    }
  });

  it('prevents two writers from holding the same wallet lock simultaneously', async () => {
    const id = await newWallet();
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id=?::uuid for no key update', [id]);
      acquired();
      await waiting;
    });
    await locked;
    let failure: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        await em.execute('select id from wallets where id=?::uuid for no key update nowait', [id]);
      });
    } catch (error: unknown) {
      failure = error;
    } finally {
      release();
      await holding;
    }
    expect(failure).toBeInstanceOf(Error);
  });

  it('allows locking different wallets with no mutual exclusion', async () => {
    const a = await newWallet();
    const b = await newWallet();
    await orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id=?::uuid for no key update', [a]);
      await orm.em.fork().transactional(async (independent) => {
        await independent.execute(
          'select id from wallets where id=?::uuid for no key update nowait',
          [b],
        );
      });
    });
  });
});
