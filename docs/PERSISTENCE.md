# Persistência — MikroORM + PostgreSQL

## Escolhas

- **MikroORM 7** (NestJS 12, Bun 1.x, driver PostgreSQL 17).
- As classes de domínio permanecerão independentes do ORM. As entidades de persistência serão introduzidas em tarefas próprias.
- SQL migrations serão **versionadas** em `src/migrations/`. Não usamos `schema:update --run` em ambientes compartilhados.
- Migrations PostgreSQL usam transações (`transactional: true`, `allOrNothing: true`) e não desabilitam constraints de foreign key.
- O gerenciamento de migrations **não acontece no bootstrap** da API, para evitar corrida entre réplicas EKS.
- Ao criar uma migration, implementar/revisar `up()` **e** `down()`, inspecionando SQL e incluindo constraints de unicidade, imutabilidade e saldo não negativo quando as entidades forem modeladas.
- Migration inicial `Migration20261116200000.ts` cria cinco tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`, com constraints, índices e triggers. Mapeamentos de entidades ORM são uma entrega posterior; não executar autogeração do schema contra um banco com esta migration sem antes alinhar os mapeamentos.

## Pré-requisitos

- Bun 1.x.
- PostgreSQL 17 acessível.
- Credenciais definidas no `.env` local (`POSTGRES_*`) ou em `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Em produção, `DB_PASSWORD` é obrigatório.
- CLI: `@mikro-orm/cli` instalada em devDependencies; a aplicação usa `@mikro-orm/nestjs` com o mesmo arquivo `src/mikro-orm.config.ts`.

## Instalar e executar

```bash
cp .env.example .env
# Edite o .env para seu PostgreSQL.
bun install
docker compose up -d postgres
bun run db:debug
bun run db:migrate:up
bun run start:dev
```

A aplicação NestJS estabelece conexão com o banco no bootstrap. Sem PostgreSQL ela **não ficará pronta**, o que é esperado.

## Gerenciar migrations

```bash
# Gerar migrations posteriores somente após implementar os mapeamentos MikroORM
bun run db:migrate:create --name=add_future_table

# Consultar
bun run db:migrate:pending
bun run db:migrate:list
bun run db:migrate:check

# Aplicar migrations pendentes
bun run db:migrate:up

# Desfazer somente a migration mais recente (exige método down)
bun run db:migrate:rollback
# Equivalente: bun run db:migrate:down
```

**Cuidado:** rollback não apaga dados automaticamente em segurança. Revisar o SQL da reversão, dependências e backups, especialmente em ambientes compartilhados. Nunca executar `migration:fresh` ou `schema:drop` em produção.

Durante desenvolvimento com o Compose, ao executar os comandos no host, a conexão utiliza `localhost:${POSTGRES_PORT}`. Dentro dos containers, `DB_HOST=postgres`.

Os arquivos `.ts` das migrations ficam em `src/migrations/` e compilam para `dist/migrations/` para execução posterior; snapshots gerados devem ser versionados junto das migrations.

## CI / CD

O workflow GitHub Actions (em `.github/workflows/ci.yml`) roda qualidade e build em PRs/push na `master`, utilizando um serviço PostgreSQL descartável. O segundo job **apenas imprime os passos futuros** (Terraform plan, imagem ECR, migrations, deployment EKS, smoke test), sem autenticar em AWS ou aplicar qualquer alteração. A implantação real ficará para outra tarefa, com credenciais temporárias e aprovações.

**Reprodutibilidade:** `bun.lock` está versionado; CI e Docker executam `bun install --frozen-lockfile`. O workflow aplica migrations, testa constraints em PostgreSQL real, executa rollback e reaplica no banco temporário. **Não repetir rollback de migrations destrutivas em produção.**
