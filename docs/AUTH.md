# Autenticação e autorização — Keycloak (seção 2)

A autenticação é uma integração OIDC com **Keycloak externo**, não uma
implementação própria de usuários/senhas. A aplicação só valida access
tokens JWT assinados usando RS256, JWKS, issuer, audiência, validade
e `azp` (OAuth *authorized party*). Isso dá uma demonstração de Auth
real sem competir com a correção financeira do desafio.

## Modelo

- `provider-a` e `provider-b` são **confidential clients**
  com *Service Accounts* habilitadas. Eles obtêm access tokens via
  `client_credentials` e apresentam `Authorization: Bearer <token>`.
- O IdP emite um `azp` assinado igual ao client ID; esse valor define a
  identidade do provider. A API exige `providerId` no JSON/URL igual
  ao `azp`. Se houver `provider_id` adicional no token, ele também
  precisa concordar com o `azp`. O cliente **não pode** escolher sua
  própria identidade apenas alterando o request.
- `wagering-api` é a audiência obrigatória (`aud`); tokens destinados
  a outros serviços são recusados.
- `wagering-monitor` é o cliente confidencial destinado a
  `GET /internal/metrics`; tokens dos providers não dão acesso às
  métricas globais.
- `POST /wallets` registra um grant no PostgreSQL para o client
  autenticado na **mesma transação SQL** da abertura da wallet.
  `wallet_provider_grants(wallet_id, provider_id)` oferece grants
  explícitos e multi-provider sem duplicar wallet
  `(player_id,currency)`. Consultas de wallet/ledger, reconciliação
  e comandos/consultas de wagering verificam esse grant antes de
  acessar o objeto financeiro.
- Para wallets preexistentes à migration, os grants começam vazios:
  **acesso negado até autorização explícita** pelo operador.
  Um provider novo **não** ganha acesso automaticamente só porque
  conhece um `playerId` ou um `walletId`.
- `GET /health/live` e `GET /health/ready` continuam públicos.
- O canal **SQS é interno e confiável por premissa da seção 2**.
  Não adicionamos tokens de usuário às mensagens nem outro login ao
  consumer. O `providerId` do envelope segue as regras do domínio:
  referências devem pertencer ao mesmo provider, player, wallet,
  moeda e rodada, preservando unicidade/idempotência. A produção deve
  restringir acesso às filas por IAM e proteger a origem das mensagens.

## Testar em Docker Compose (desenvolvimento)

Pré-requisitos: Docker Compose, Bun 1.4.4, curl e PostgreSQL.
O Keycloak está em uma imagem fixada (`26.8.2`); realm
`wagering` importado automaticamente do JSON versionado
`infra/keycloak/wagering-realm.json`. H2 persistido em um volume local
é **somente para desenvolvimento**. Não usar `start-dev`, secrets
de exemplo ou H2 em produção.

```bash
cp .env.example .env
docker compose --profile auth up -d postgres keycloak

# Acompanhe a inicialização do realm (primeira execução demora mais):
docker compose --profile auth logs -f keycloak

# Em um terminal separado:
bun install --frozen-lockfile
bun run db:migrate:up

# API rodando no HOST; OIDC_JWKS_URL deve apontar para localhost.
OIDC_JWKS_URL=http://localhost:8080/realms/wagering/protocol/openid-connect/certs \
  bun run start:dev
```

Para iniciar a API como **container Compose**, as URLs são diferentes:
`OIDC_ISSUER=http://localhost:8080/realms/wagering` (valor assinado,
visível pelo cliente) e
`OIDC_JWKS_URL=http://keycloak:8080/realms/wagering/protocol/openid-connect/certs`
(acessível pela rede Docker). O Compose já configura esse JWKS interno.
A API containerizada também depende de Postgres e das filas
provisionadas pelo Terraform local. Para uma demonstração apenas de
Auth, iniciar a API diretamente no host evita a necessidade do
emulador SQS.

O console Keycloak está em <http://localhost:8080/admin>, com usuário
`admin` e senha dev configurada em `KEYCLOAK_ADMIN_PASSWORD`. Realm:
`wagering`. Não existem usuários cadastrados pelo nosso backend.

### Obter access token

```bash
export PROVIDER_A_TOKEN=$(curl -fsS -X POST \
  'http://localhost:8080/realms/wagering/protocol/openid-connect/token' \
  -d grant_type=client_credentials \
  -d client_id=provider-a \
  -d "client_secret=${KEYCLOAK_PROVIDER_A_SECRET:-local-provider-a-change-me}" \
  | bun -e 'let s="";for await(const x of Bun.stdin.stream())s+=new TextDecoder().decode(x);console.log(JSON.parse(s).access_token)')

curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/wallets/00000000-0000-4000-8000-000000000000
curl -i -H "Authorization: Bearer $PROVIDER_A_TOKEN" \
  http://localhost:3000/wallets/00000000-0000-4000-8000-000000000000
```

Resultados: health `200`, wallet sem Bearer `401`, wallet
autenticada sem grant `403`.

Para criar uma wallet autorizada:

```bash
curl -i -X POST http://localhost:3000/wallets \
  -H "Authorization: Bearer $PROVIDER_A_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

O novo wallet ID pode ser consultado em `GET /wallets/:walletId`,
com o token de `provider-a`. `provider-b` recebe `403` até
que um operador autorize sua associação com a wallet.

### Teste automatizado com tokens reais

```bash
# Com o Keycloak, PostgreSQL e migrations preparados:
HTTP_AUTH_MODE=oidc \
OIDC_ISSUER=http://localhost:8080/realms/wagering \
OIDC_JWKS_URL=http://localhost:8080/realms/wagering/protocol/openid-connect/certs \
OIDC_AUDIENCE=wagering-api \
bun run test:auth:e2e
```

O teste acessa Keycloak real via `client_credentials`, executa
requests reais no NestJS e valida Postgres: API pública/privada,
401 por token ausente/malformado, criação da wallet e grant,
403 de isolamento entre providers (wallet, ledger, reconciliation,
wager, consultas), replay idempotente, saldo após aposta e
métricas restritas ao cliente operacional. GitHub Actions executa
a mesma suíte num job separado **Keycloak OIDC real-token E2E**
(`auth-idp`).

O restante dos testes existentes não depende de Keycloak:
`HTTP_AUTH_MODE=disabled` permanece disponível **exclusivamente**
em ambiente não produtivo, mediante opção explícita.

## Grants multi-provider

Para um serviço que opera em mais de um provider, a wallet do
player permanece **uma só por moeda**. Não criaremos uma wallet
por provider. Um operador autorizado pode realizar concessão
de acesso em processo administrativo auditado (não existe endpoint
de concessão público neste desafio):

```sql
-- Somente DBA ou um procedimento operacional restrito; nunca exponha
-- esse SQL como API acessível ao provider.
INSERT INTO wallet_provider_grants (wallet_id, provider_id)
VALUES ('<wallet-uuid>'::uuid, 'provider-b')
ON CONFLICT DO NOTHING;
```

Não usar scripts de concessão sem validação do vínculo comercial
entre o provider e o player. Revogação/gestão de grants exige
processo administrativo próprio, fora do timebox do desafio.

## Referência do .env

| Variável | Uso |
| --- | --- |
| `HTTP_AUTH_MODE` | `oidc` por padrão, `disabled` somente dev/teste |
| `OIDC_ISSUER` | URL **exata** presente no token, com `/realms/wagering` |
| `OIDC_JWKS_URL` | JWKS alcançável pela API; `localhost` no host, `keycloak` no Compose |
| `OIDC_AUDIENCE` | `wagering-api` |
| `OIDC_METRICS_CLIENT_ID` | `wagering-monitor` |
| `KEYCLOAK_PORT` | Porta host, 8080 por padrão; atualizar `OIDC_ISSUER` se mudar |
| `KEYCLOAK_PROVIDER_A_SECRET` | Secret do confidential client A (dev) |
| `KEYCLOAK_PROVIDER_B_SECRET` | Secret do confidential client B (dev) |
| `KEYCLOAK_MONITOR_SECRET` | Secret do client operacional (dev) |
| `KEYCLOAK_ADMIN_PASSWORD` | Admin somente no Keycloak local; não é usuário da aplicação |
| `PAGINATION_CURSOR_SECRET` | HMAC dos cursores; segredo compartilhado entre réplicas |

Segredos devem vir do Secret Manager em produção, nunca de `.env`
versionado ou da configuração do realm de desenvolvimento.

### Erros

- `401 UNAUTHORIZED`: token ausente, inválido, expirado,
  issuer/aud errados ou `azp` inválido.
- `403 FORBIDDEN`: JWT válido porém provider diferente do body/URL,
  wallet sem grant, ou client não autorizado a métricas.
- `503 INFRASTRUCTURE_UNAVAILABLE`: IdP/JWKS indisponível durante
  validação de chave desconhecida/expirada.
- `HTTP_AUTH_MODE=disabled` com `NODE_ENV=production` **não**
  desativa o guard: falha fechado se não houver configuração OIDC.

## Produção e EKS

Usar Keycloak externo com HTTPS, storage durável e alta disponibilidade.
Configurar `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_AUDIENCE`, segredos
de cursor e acesso IAM às filas via configuração segura do deployment.
`start-dev`, H2 e secrets de exemplo não são arquitetura de produção.
Em produção, o container espera `NODE_ENV=production`.

O IdP administra criação/revogação de client credentials, políticas
de emissão de tokens, rotação de chaves e revogação. A API mantém
cache de **chaves públicas JWKS**, com TTL de 5 minutos; esse cache
não participa da idempotência financeira. Não armazenamos senhas,
refresh tokens ou tokens em PostgreSQL.

**Limite:** revogação imediata de access token não é garantida
pela validação offline de JWT; tokens de curta duração (~5 min
neste realm) limitam a janela. Para requisitos mais estritos,
implementar introspecção/revogação conforme SLA do IdP, sem
interferir nas transações financeiras.
