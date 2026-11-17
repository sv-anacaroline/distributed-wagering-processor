# Teste de performance com k6 — fluxo financeiro real

[Resultados e status das medições](PERFORMANCE_REPORT.md) ·
[relatório central de testes](TEST_RESULTS.md).

## Preparação

Os cenários executam **rotas financeiras**, não apenas `GET /`. Suba o
ambiente local com Keycloak, PostgreSQL, MiniStack, API e workers, e aplique
as migrations antes de executar carga.

```bash
cp .env.example .env
docker compose --profile full up --build -d
docker compose exec -T api bun run db:migrate:up
```

O k6 usa dois clients OIDC do realm importado: `provider-a` para as
operações financeiras e `wagering-monitor` para `/internal/metrics`.
Os segredos do Compose são exclusivamente de **desenvolvimento**.
No host não é necessário instalar o k6: executamos
`grafana/k6:1.8.2` em container.

## Rotina completa e resultados reais

Depois de inicializar o ambiente com `bun run local:up` e verificar o fluxo
com `bun run local:verify`, execute
`bun run test:load:all` para percorrer **os seis cenários**, preservando
os resultados dos cenários concluídos mesmo quando outro falha. Os artefatos
`performance/results/*-summary.json`, `benchmark-index.json` e `*.log`
registram os valores medidos.

A rotina independente [GitHub Actions](../.github/workflows/performance-benchmark.yml)
também pode ser acionada manualmente (`workflow_dispatch`); no branch
de implementação uma execução de bootstrap é disparada por alterações na
própria rotina. Ela **não integra a CI obrigatória**, não é status requerido
e não bloqueia merges. O [CircleCI opcional](../.circleci/config.yml)
também chama o mesmo `scripts/run-performance.sh` quando explicitamente habilitado.

## Execução manual, separada do merge

```bash
bun run test:load                # smoke
bun run test:load:load
bun run test:load:stress
bun run test:load:spike
bun run test:load:soak
bun run test:load:hot-wallet     # mesma wallet para VUs concorrentes
```

Os perfis são `smoke` (curto), `load` (rampa nominal),
`stress` (carga crescente), `spike` (pico brusco), `soak`
(sustentado) e `hot-wallet` (disputa pelo mesmo saldo).
A configuração é ajustável por `K6_VUS`, `K6_DURATION`,
`K6_STAGE_DURATION`, `K6_SOAK_DURATION`, `K6_P95_MS`,
`K6_ENVIRONMENT` e `K6_BASE_URL`.

Para serviço externo, configure `K6_OIDC_TOKEN_URL`,
`K6_OIDC_CLIENT_ID`, `K6_OIDC_CLIENT_SECRET`,
`K6_OIDC_MONITOR_CLIENT_ID` e `K6_OIDC_MONITOR_CLIENT_SECRET`
ou um token explícito apropriado. Não versione segredos. O modo
`K6_AUTH_MODE=disabled` é **somente para desenvolvimento local**.

## Evidência por rota

Além de tempos HTTP p50/p95/p99, cada iteração valida a corrida de
BET, débito único, rejeição financeira correta, replay, ledger e
reconciliação. As tags `endpoint` permitem inspecionar latência
separada de cada rota; para a lista completa de rotas veja
[o relatório de performance](PERFORMANCE_REPORT.md).

Cada cenário escreve um JSON em `performance/results/<cenario>-summary.json`,
ignorado pelo Git; o CircleCI pode publicar esses arquivos como artefatos.

## CircleCI opcional

A configuração em [`.circleci/config.yml`](../.circleci/config.yml)
contém o workflow `optional-financial-performance`, acionado
**somente** quando o parâmetro da pipeline `run_performance=true`.
O workflow obrigatório de testes **não depende do k6**, que jamais deve
ser requerido para aceitar o merge.

O `K6_P95_MS` é um limiar experimental do cenário, não o SLA
fixado pelo enunciado. Não inferir RPS ou latências sem executar os
scripts em ambiente identificado.
