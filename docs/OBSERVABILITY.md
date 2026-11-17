# Observabilidade do Distributed Wagering Processor

Voltar ao [README](../README.md) · [matriz de testes](TEST_RESULTS.md) ·
[benchmark k6](PERFORMANCE_REPORT.md).

## O que fica disponível

A stack é local e **opcional**: o perfil Docker Compose `observability` disponibiliza
**Grafana + Loki + Tempo + Prometheus + OpenTelemetry Collector**.
Os serviços financeiros continuam funcionando com o perfil `full` sem
a stack de observabilidade, e falhas de exportação de telemetria nunca são
motivo para desfazer uma transação de dinheiro.

| Serviço | URL local | Finalidade |
| --- | --- | --- |
| Grafana | [http://localhost:3001](http://localhost:3001) | Dashboard central, consulta de métricas, investigação de logs e traces |
| Dashboard central | [http://localhost:3001/d/wagering-observability](http://localhost:3001/d/wagering-observability) | HTTP, erros, SQS, retries, eventos, saúde e logs |
| Prometheus | [http://localhost:9090](http://localhost:9090) | Métricas agregadas e latência por rota |
| OTLP/HTTP | http://localhost:4318 | Entrada padrão de logs, traces e métricas; collector recebe na rede Docker |
| Loki / Tempo | Grafana Explore (também localhost:3100 / localhost:3200 para diagnóstico) | Armazenamento de logs OTLP nativos / traces OTLP |

Grafana utiliza o login de desenvolvimento `admin / local-grafana-change-me`.
O acesso está restrito a `127.0.0.1`; **troque as credenciais e configure
TLS/autenticação antes de qualquer uso fora do computador local**.

## Primeira execução (sem apagar dados)

```bash
cp .env.example .env       # se ainda não tiver arquivo
bun run local:up           # PostgreSQL, MiniStack, Keycloak, API, workers e Grafana
bun run local:status
bun run local:verify       # fluxo real de eventos; cria dados de demonstração
```

O script `local:up` aplica migrations ANTES de iniciar os workers e
verifica readiness da API, Keycloak e Grafana. Repita o comando após
modificar os arquivos de configuração. Para encerrar os containers mantendo
PostgreSQL, Grafana e dados de observabilidade: `bun run local:down`.
**Não use `docker compose down -v`** para o fluxo normal.

Para usar Compose explicitamente:

```bash
docker compose --profile full --profile observability up -d --build
docker compose --profile full --profile observability ps
```

Garanta que as migrations já foram aplicadas antes de iniciar a API e os
workers em um banco novo; prefira `bun run local:up` para garantir a ordem.

## Abrir um log completo e localizar o ponto da falha

1. Abra o dashboard e vá às seções **HTTP**, **Eventos**, ou **Falhas**.
2. Clique em uma linha de log para expandir os campos `service`, `timestamp`,
   `route`, `status`, `error_type`, `event_type`, `event_id`, `wallet_id`,
   `trace_id` e `span_id` (conforme o tipo de operação).
3. Clique em **Abrir trace**, o link gerado no Loki para Tempo a partir do
   `trace_id`. No Tempo, inspecione spans, duração, resultado, etapa, parent
   e o ponto de erro. Também é possível usar Explore → Tempo e colar o
   identificador de trace do cabeçalho `X-Trace-Id` de cada resposta HTTP.
4. Se a mensagem sofreu retry, filtre os logs pelo `event_id`,
   `transaction_id` ou `wallet_id`; a Outbox mantém o contexto W3C
   `traceparent` persistido para a publicação assíncrona, inclusive
   após restart. Logs Loki são registros estruturados, com tempo, severidade,
   recurso e identificação da operação.

### Queries úteis no Grafana Explore (Loki)

```logql
{service_name="wager-api"} |= "http."
{service_name="wager-sqs-consumer"} |= "sqs.message"
{service_name="wager-outbox-publisher"} |= "outbox.publish"
{service_name="wager-reference-worker"} |= "references."
{service_name=~"wager-.*"} | json | level="error"
```

Consultas livres por `event_id` ou `transaction_id`:

```logql
{service_name=~"wager-.*"} |= "cole-aqui-o-identificador"
```

Os identificadores **não viram labels Prometheus ou Loki de alta cardinalidade**;
ficam nos atributos/logs e spans para permitir diagnóstico sem explodir séries.

## Trace completo: HTTP → SQL → Outbox → SQS

```text
HTTP request [X-Trace-Id]
  └─ wager.process
      └─ postgres.financial.transaction
          ├─ wallet + idempotency + ledger [mesmo commit]
          └─ outbox.event.enqueued [traceparent persistido na SQL]
             └─ outbox.publish [outro worker, continua trace]
                └─ SQS SendMessage [MessageAttributes.traceparent]
                   └─ consumidor de eventos externo (se instrumentado)
```

A entrada SQS `WagerTransactionRequested` inicia `sqs.wager.consume`
e `wager.process`; quando traz o atributo de mensagem `traceparent`,
o trace é continuado. Mensagens sem esse atributo ganham um novo trace
(pesquisável por `message_id`, `wallet_id` e `transaction_id`).

**O formato de negócio dos eventos não foi alterado**: a propagação de
contexto fica no campo SQL opcional `outbox_messages.traceparent` e nos
atributos SQS, não dentro do JSON financeiro e nem do hash idempotente.

## Métricas e diagnósticos

| Métrica OTLP | Labels seguras / semântica |
| --- | --- |
| `wager_http_requests_total` | method, route template, status |
| `wager_http_errors_total` | errors 5xx e encerramento da conexão |
| `wager_http_request_duration_ms` | histograma p50/p95/p99 por route |
| `wager_http_exceptions_total` | code e status |
| `wager_transactions_total` | kind, status, transport, replay |
| `wager_sqs_messages_total` | ack, retry, dlq, released, failure |
| `wager_sqs_processing_duration_ms` | duração da execução SQS |
| `wager_outbox_publish_total` | event_type, published/fenced/retry |
| `wager_outbox_publish_duration_ms` | latência do envio e confirmação |
| `wager_reference_scanned_total` e `wager_reference_completed_total` | polling de referência |
| `wager_reference_poll_duration_ms` | tempo de execução de um ciclo |
| `wager_dependency_up` | gauge 0/1 para PostgreSQL e SQS |
| `wager_dependency_probe_duration_ms` | duração dos health checks |
| `wager_telemetry_dropped_total` | registros descartados por limite de buffer local |

Os painéis de latência usam histogramas OTLP, e os de erro apresentam
separadamente **rejeições financeiras esperadas** e falhas de infraestrutura.
O `GET /health/live` verifica a vida do processo; `GET /health/ready`
consulta PostgreSQL e SQS assinando a solicitação com credenciais AWS.

## Segurança, isolamento e disponibilidade

- Exportação OTLP/HTTP JSON no Collector, com pipelines separados para
  Tempo (traces), Loki (logs) e Prometheus (métricas). Usa W3C Trace Context.
  A implementação explícita é compatível com Bun 1.x e **não depende de
  componentes externos para aceitar uma aposta**.
- Não são registrados corpos JSON de apostas, saldos, tokens JWT, cabeçalhos
  Authorization, connection strings ou segredos. Logs de falha carregam
  `error_type` e código, e o corpo público da exceção segue sanitizado.
- OTLP, Prometheus, Grafana, Loki e Tempo expõem portas de diagnóstico **somente**
  em `127.0.0.1` (não em interfaces públicas).
- Falha na transmissão de métricas/logs/spans gera alerta estruturado
  `otel.export.failed` no stdout, sem mudar estado financeiro.
- Persistência local tem volumes próprios para Loki, Tempo, Prometheus e
  Grafana. Retenção inicial: Prometheus 7 dias; Tempo 7 dias.
- A migração `Migration20261117050000` adiciona o campo `traceparent`
  sem modificar registros existentes e possui `down` reversível.

## Evidência da validação integrada

A stack foi iniciada de ponta a ponta em um runner Linux descartável
em **17/11/2026** e validada na
[execução #44009078738 do GitHub Actions](https://github.com/sv-anacaroline/distributed-wagering-processor/actions/runs/44009078738)
(commit `71e4a9e`, antes dos testes adicionais de privacidade).

- `LOCAL READY`: API, Keycloak e Grafana responderam.
- `TELEMETRY_DASHBOARD wagering-observability 16`: 16 painéis carregados do provisionamento.
- `TELEMETRY_SMOKE_PASSED {"logs":true,"metrics":true,"traces":true}`:
  registros OTLP realmente consultados em Loki, Prometheus e Tempo.
- Exercício financeiro real: 6 tipos (incluindo OPENING interno), referência
  fora de ordem, rejeição, **17 eventos da Outbox publicados**, 7 lançamentos
  de ledger, saldo BRL 85.00, versão 7 e reconciliação correta.

A execução confirma a ingestão entre processos, não apenas a existência
dos arquivos YAML. O script `scripts/telemetry-smoke.sh` também está
preparado para verificar o relacionamento entre trace IDs do consumidor
SQS e do publisher da Outbox nas próximas execuções. Validação local da
máquina do usuário depende de executar `bun run local:up`.

## Validação

Verifique readiness, o dashboard e as séries após gerar tráfego:
```bash
bun run local:verify
curl -fsS http://localhost:3001/api/health
curl -fsS http://localhost:9090/-/ready
curl -fsS http://localhost:3000/health/ready
```

Para os painéis aparecerem é necessário gerar operações, e aguardar alguns
segundos pelo batch OTLP e scrape Prometheus. O k6 permanece rotina separada
dos checks obrigatórios de merge: [resultados de performance](PERFORMANCE_REPORT.md).
