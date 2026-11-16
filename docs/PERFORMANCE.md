# Testes de performance — k6

## Objetivo

Estabelecer testes reproduzíveis de latência HTTP antes do domínio financeiro.
**Não é um benchmark de corretude de dinheiro**: após implementar wallet/ledger, criar cenários dedicados para BET duplicado, duas BET concorrentes, múltiplas instâncias, falhas e reconciliação.

## Pré-requisitos e execução

Iniciar a API pelo Compose (`docker compose up --build -d`). O k6 é executado em um container e não exige instalação local.

```bash
bun run test:load:smoke
bun run test:load:load
bun run test:load:stress
bun run test:load:spike
bun run test:load:soak
```

O alias `bun run test:load` executa smoke. Os comandos usam `id -u`/`id -g`
para executar o k6 com o mesmo usuário do host e preservar permissões de escrita
em `performance/results/`. Os comandos pressupõem shell POSIX (Linux/macOS). Pode configurar no `.env`:
- `K6_VUS`: VUs-base (5).
- `K6_DURATION`: duração de smoke (15s).
- `K6_STAGE_DURATION`: duração padrão de estágio (30s).
- `K6_SOAK_DURATION`: soak (10m).
- `K6_BASE_URL`: URL acessível **dentro** do container k6 (default `http://api:3000`).
- `K6_P95_MS`: override opcional para threshold p95.
- `K6_ENVIRONMENT`: etiqueta do ambiente (local).

## Cenários

| Script | Modelo | Finalidade |
| --- | --- | --- |
| `scenarios/smoke.js` | constant-vus curto | Verificar comportamento básico |
| `scenarios/load.js` | ramping-vus | Carga nominal |
| `scenarios/stress.js` | ramping-vus crescente | Explorar saturação |
| `scenarios/spike.js` | ramping-vus abrupto | Tráfego repentino |
| `scenarios/soak.js` | constant-vus prolongado | Estabilidade temporal |

Configuração compartilhada em `config/`, request/check em `utils/http.js`, resultados em `utils/report.js`.

## Resultados e thresholds

Os cenários possuem checks de status HTTP 200 e body `Hello World!`.
Thresholds iniciais: `http_req_failed < 1%`, `checks > 99%` e p95 dependente do cenário. São *valores de alerta iniciais*, não critérios financeiros do enunciado.

Ao final, o k6 escreve `performance/results/<cenario>-summary.json` com RPS, quantidade de requests, erros e p50/p95/p99. Esse diretório é ignorado pelo Git.

### Metodologia antes de comparar resultados

Documentar: commit, versão do k6, perfil Docker/EKS, CPU/RAM, quantidade de réplicas, conectividade, tamanho da base, VUs, estágio, warmup, taxas de erro, métricas de lock e atraso da outbox. O desafio **não exige meta de RPS**.

Os testes financeiros posteriores terão de conferir no PostgreSQL `wallet.balance == ledger reconstituído`, além das métricas HTTP.
