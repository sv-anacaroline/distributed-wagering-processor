import 'reflect-metadata';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

// The domain entities will be introduced in subsequent, isolated tasks.
// These paths work for the Bun TypeScript CLI and compiled EKS/production code.
const dbPassword = process.env.DB_PASSWORD ?? process.env.POSTGRES_PASSWORD;

if (process.env.NODE_ENV === 'production' && !dbPassword) {
  throw new Error('DB_PASSWORD must be configured in production');
}

export default defineConfig({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number.parseInt(
    process.env.DB_PORT ?? process.env.POSTGRES_PORT ?? '5432',
    10,
  ),
  dbName: process.env.DB_NAME ?? process.env.POSTGRES_DB ?? 'wagering',
  user: process.env.DB_USER ?? process.env.POSTGRES_USER ?? 'wagering',
  password: dbPassword ?? 'local_dev_only',

  entities: ['./dist/**/*.entity.js'],
  entitiesTs: ['./src/**/*.entity.ts'],
  metadataProvider: ReflectMetadataProvider,
  discovery: {
    // Temporary only, until the first persistence entity is implemented.
    warnWhenNoEntities: false,
  },
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    emit: 'ts',
    transactional: true,
    allOrNothing: true,
    disableForeignKeys: false,
    snapshot: true,
    tableName: 'mikro_orm_migrations',
  },
});
