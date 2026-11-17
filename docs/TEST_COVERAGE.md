# Cobertura de testes — metodologia e leitura

Voltar ao [relatório central](TEST_RESULTS.md).

## Dois relatórios distintos

**Unidade:** `bun run test:cov:unit` → `bun test --coverage ./src`.
Valida regras financeiras, factories, transições, serialização de eventos,
parser SQS, decisão de retry, publisher e consumidor (em isolamento).
O relatório separado documenta o que foi exercitado sem PostgreSQL/SQS reais.

**Integrado:** `bun run test:cov:full` → `bun test --coverage ./src ./test`.
A CI executa com PostgreSQL 17, MiniStack SQS FIFO, migrations, E2E HTTP,
workers e cenários concorrentes reais. O orchestrator `src/application/process-wager.ts`
**não é mais excluído da cobertura**; seus caminhos de persistência aparecem
no LCOV. Testes `*.spec.ts` e `*.test.ts` ficam fora do denominador.

**Isolamento:** execute a cobertura integrada numa base SQL recém-migrada, sem
resíduos do primeiro run. O helper `scripts/prepare-coverage-db.ts` cria
`wagering_coverage` e se recusa a reutilizar um banco preexistente. A CI
estabelece `DB_NAME=wagering_coverage` no segundo run. Não use esse script
para recriar banco com dados importantes.

## Última medição verificada

[Job de teste e cobertura](https://github.com/sv-anacaroline/distributed-wagering-processor/actions/runs/44003014324/job/133771467291)
(commit `5f2f042`, Bun 1.4.4).

| Escopo | Linhas (LCOV) | Funções (LCOV) |
| --- | ---: | ---: |
| Unidade | 82,67% | 87,78% |
| Integrado | 97,36% | 98,42% |

Os percentuais são calculados de `LH/LF` e `FNH/FNF` por
`scripts/coverage-report.ts`. O resumo nativo do Bun pode empregar
outra contagem de linhas e por isso diferir ligeiramente. A versão
integrada tem gate de pelo menos **70%** de linhas e funções.

A integração real com Keycloak roda em job separado e **não é agregada ao
LCOV integrado**, para não confundir cobertura de autenticação com cobertura
da aplicação em modo local de teste.

## Onde obter os arquivos

- GitHub Actions, job `Unit, E2E, coverage and PostgreSQL`, artefato
  `financial-test-coverage` (diretórios `unit/` e `integrated/`).
- CircleCI, job `quality-financial`: artefatos `financial-quality/coverage/`
  com `lcov.info` e `report.md` em cada categoria.
- Nos dois casos, o Markdown contém linha por arquivo, cobertura de funções,
  totais e escopo. O LCOV é preservado para inspeção por IDE ou ferramenta externa.

**Cobertura de código não equivale a cobertura de todos os cenários lógicos.**
A matriz de casos/eventos por transição está no relatório central, e o k6
tem resultados de desempenho independentes.
