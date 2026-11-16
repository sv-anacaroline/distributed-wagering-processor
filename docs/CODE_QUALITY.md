# Code quality

## Convenções

- `.editorconfig` garante UTF-8, LF, dois espaços e newline final.
- `.gitattributes` normaliza LF em código e infraestrutura.
- `.prettierrc` controla formatação; nenhuma regra ESLint disputa layout.
- `eslint.config.mjs`: ESLint 10, TypeScript-ESLint 8 e *type-aware linting*.
- `tsconfig.json` mantém `strict` e amplia checagens de inicialização, valores opcionais e índices.
- `no-explicit-any`, `no-unsafe-*`, `no-floating-promises` e `no-misused-promises` são erros.

## Comandos

```bash
bun install
bun run format:check
bun run format              # formata código (ver diff antes do commit)
bun run lint
bun run lint:fix            # corrige automaticamente somente o que é seguro
bun run lint:quick          # Oxlint opcional para feedback rápido
bun run typecheck
bun run test                # testes unitários Bun
bun run test:e2e            # E2E Bun e PostgreSQL
bun run test:cov            # cobertura e threshold inicial
bun run build
```

A meta inicial de cobertura é 70% de linhas e funções do código carregado pelos testes, com arquivos de configuração/entrada excluídos. Aumentar conforme o domínio ganhar testes. Cobertura alta não substitui testes de concorrência e integração real.

## Jest versus Bun

O desafio exige Bun como executor de testes. O Bun oferece APIs familiares ao Jest (`describe`, `it`, `expect`, mocks), mas mantemos as importações de `bun:test`, sem adicionar Jest como runner independente.

## GitHub Actions e merge

Todo PR para `master` e push em `master` executam:
- `Lint, format and TypeScript`: Prettier, ESLint type-aware, `tsc --noEmit`.
- `Unit, E2E, coverage and PostgreSQL`: Bun unit/E2E/coverage, build e inspeção do MikroORM com PostgreSQL 17.
- `Validate k6 scenario configuration`: `docker compose config` e `k6 inspect` dos cinco cenários, sem executar carga.

A simulação de deploy só ocorre em push na `master`, depois de ambos os jobs bem-sucedidos; não executa `terraform apply`, deploy nem ações AWS.

Para efetivamente **impedir merge com checks falhando**, habilite uma *branch ruleset* para `master` em **Settings → Rules → Rulesets** exigindo os três nomes de jobs acima. O YAML sozinho inicia os checks, mas não bloqueia o botão de merge.

## Reprodutibilidade

O arquivo `bun.lock` foi gerado pelo Bun no CI e está versionado. O Docker e o GitHub Actions usam `bun install --frozen-lockfile`. Alterações de dependências exigem regenerar o lock com `bun install` e versionar a diferença.
