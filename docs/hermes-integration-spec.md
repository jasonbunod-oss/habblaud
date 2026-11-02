# Especificação de integração: monitoramento do Hermes AI Agent no Habblaud

> **Arquivo:** `docs/hermes-integration-spec.md`
> **Status:** SPECIFICATION phase — apenas especificação, sem implementação de código.
> **Versão do Hermes alvo:** v0.22.5, SHA `5894e750c3db` (2026.9.24). Instalação: `C:/Users/ADMIN/AppData/Local/hermes/hermes-agent`.
> **Baseline do Habblaud:** `faa1a01`, Node/TS ESM, zero dependências de runtime, Vitest (1852 pass / 19 falhas pré-existentes no Windows).

---

## 1. Propósito e escopo

Adicionar o **Hermes AI Agent** como uma terceira fonte de agentes no Habblaud, ao lado do Claude Code e do Codex, de modo que as sessões ativas do Hermes (e dos seus subagentes delegados) apareçam no escritório virtual com status, atividade, sala (projeto), conta (perfil) e histórico, respeitando o contrato `AgentSource` e a regra de dados verdadeiros.

Escopo desta spec:

- Extensão do tipo `Provider` para incluir `'hermes'`.
- Nova fonte `server/sources/hermes/*` (L1 arquivos, L2 SQLite read-only, L3 HTTP/SSE opcional).
- Mapeamento Hermes → Habblaud (AgentKind, AgentStatus, ActivityKind, sala, conta, durações, tokens/custo).
- Suporte multi-perfil (24 perfis servidos pelo gateway multiplex) e subagentes via `parent_session_id` / `async_delegations`.
- Atualização em tempo real por polling + watchers de arquivo + SSE opcional.
- Testes unitários/integrados e plano de fases.

Fora do escopo (não implementado por esta spec, pode ser fase posterior): envio de mensagens/permissoes ao Hermes, terminal interativo no transcript Hermes, Habblaud World (sem mudanças em `shared/world/` ou `server/world/`).

---

## 2. Não-objetivos e garantias de preservação

### 2.1 Não-objetivos

- Não substituir nem alterar o monitoramento de Claude Code ou Codex.
- Não escrever em nenhum arquivo/dado do Hermes (somente leitura).
- Não consumir segredos (`.env`, `auth.json`) nem expô-los.
- Não verificar ao vivo a API HTTP do Hermes (endpoints documentados mas não testados); L3 é opcional e degradável.
- Não fabricar agentes, andares, status, tokens ou personagens (regra de dados verdadeiros do Habblaud World).

### 2.2 Garantias de preservação

- **Claude Code / Codex:** toda mudança aditiva; `Provider` permanece compatível (`'claude'` segue default ausente). `SourceSet`, `HistorySet`, `Office` não mudam de contrato; a fonte Hermes entra pelo mesmo padrão do Codex (`server/index.ts:133-143`).
- **Local-first / segurança:** apenas leitura de arquivos allow-listed; DB em modo read-only com `busy_timeout`; API somente loopback se usada; nenhum dado sai do computador sem consentimento (Habblaud World inalterado).
- **Verdade dos dados:** o que o Habblaud envia ao World vem só da projeção real (`shared/world/projection.ts`); a fonte Hermes alimenta o mesmo `Office` e não cria caminho paralelo de dados.
- **Windows:** compatibilidade de separadores de path, modos de arquivo (chmod no-op), CRLF no i18n, `node:sqlite` no Node 24; testes executados no Windows.
- **Zero runtime deps:** leitura SQLite via `node:sqlite` (built-in, Node ≥ 22.5) com fallback de cópia/polling; sem bibliotecas externas. Se `node:sqlite` indisponível, a fonte degrada para L1 (arquivos) e loga aviso.
- **i18n:** todo texto visível via `tr()` em `shared/locales/*`; `npm run i18n:check` deve permanecer 2980/2982 (ou atualizar help-text CRLF conforme convenção).
- **CHANGELOG:** entrada em `## [Não lançado]` (seção existente, linha 15 do `CHANGELOG.md`).

---

## 3. Base de evidências e suposições

### 3.1 Evidências observadas (medidas no ambiente)

- Hermes instalado em `C:/Users/ADMIN/AppData/Local/hermes/hermes-agent`, versão `0.22.5+471.g5894e75` (2026.9.24), SHA `5894e750c3db`.
- Data dir `C:/Users/ADMIN/AppData/Local/hermes`, default profile + 24 perfis servidos (gateway multiplex, PID 21460, `gateway_state.json`).
- `state.db` por perfil (schema v32, WAL, ~1.46 GB) com tabelas: `sessions` (65 colunas), `messages`, `async_delegations` (confirmadas via `sqlite_master` + `PRAGMA table_info`).
- Colunas-chave de `sessions`: `id, source, user_id, session_key, chat_id, chat_type, thread_id, display_name, origin_json, expiry_finalized, model, model_config, system_prompt, parent_session_id, started_at, ended_at, end_reason, message_count, tool_call_count, input/output/cache_read/cache_write/reasoning tokens, cwd, git_branch, git_repo_root, billing_*, estimated/actual_cost_usd, cost_status/source, pricing_version, title, api_call_count, handoff_*, compression_*, profile_name, rewind_count, archived, pinned, system_prompt_hash, git_metadata_generation, title_source, last_activity_at, last_activity_description, last_activity_provenance, hidden, last_read_at, compression_recovery_deadline, tool_names, transport_profile, created_source, compression_overload_streak, auto_archived, runtime_revision/generation, transcript_revision`.
- Valores observados de `source`: `'desktop'`, `'subagent'`, `'local'`. `parent_session_id` liga subagentes.
- `messages`: `id, session_id, role, tool_name, finish_reason, timestamp, token_count (NULL observado), tool_calls (JSON array `{id,call_id,type,function:{name,arguments}}`), content (prévia de resultado para `role=tool`), compacted, observed, active, display_*, tool_call_uid(s)`.
- `async_delegations`: `delegation_id, origin_session, origin_ui_session_id, parent_session_id, state (running/completed/error), dispatched_at, completed_at, updated_at, event_json, result_json (summary, total_duration_seconds), delivery_state (pending/delivered), delivery_attempts, delivered_at, owner_pid, owner_started_at, task_json (goals), duration_seconds`.
- `cron/jobs.json`: `jobs[]` com `id,name,schedule,state,enabled,paused_at,repeat.completed,next_run_at,last_run_at,last_status,last_error,deliver,script,...`.
- `sessions/sessions.json`: sessões de plataforma (telegram dm) com `origin`, tokens, custo, `suspended`.
- `gateway_state.json`: `pid, kind, gateway_state, active_agents, platforms{state,error_code,error_message,updated_at,writer_pid,needs_attention}, served_profiles_count, parked_profiles, code_sha/version, active_work`.
- SSE de runs: `message.delta, message.interim, reasoning.available, tool.started, tool.completed, subagent.start, subagent.complete, approval.request, approval.responded, run.queued, run.steered, run.stopping, run.interrupted, run.completed, run.failed, run.cancelled, replay.truncated`; keepalive `: keepalive` a cada 10 s.
- API (definida em código, não verificada ao vivo): `/health, /health/detailed, /v1/models, /api/model/options, /v1/capabilities, /v1/skills, /v1/toolsets, /v1/chat/completions, /v1/responses, /v1/runs, /v1/runs/{id}, /v1/runs/{id}/events (SSE), /v1/runs/{id}/approval, /steer, /resolve-unknown, /stop, /api/sessions*, /api/jobs*, /api/platforms/{platform}/events`. Capabilities: `run_status, run_events_sse, run_stop, run_steer, run_approval_response, tool_progress_events, approval_events, session_resources, model_options, session_chat, session_chat_streaming, session_fork, session_model_lock, reasoning_streaming, skills_api` (true); `admin_config_rw, jobs_admin, memory_write_api, audio_api, realtime_voice` (false).

### 3.2 Suposições (a validar na implementação)

- `node:sqlite` disponível no Node 24 do ambiente (experimental). Se indisponível, fallback L1 + log de aviso; L2 desligado.
- `token_count` é NULL no sample; custo/tokens só quando presentes (não fabricar). `estimated/actual_cost_usd` e tokens de sessão podem ser usados quando não-nulos.
- Um "perfil" Hermes ≈ uma "conta" Habblaud (como Claude account letter); mapeamento perfil→letra TBD (ver §16).
- `git_repo_root`/`cwd` definem a sala; ausentes → nome do perfil como fallback de sala.
- Versão pinada: qualquer mudança de schema do Hermes pode quebrar o reader; validar `schema_version` (PRAGMA user_version) e desligar L2 com aviso se divergir.

---

## 4. Pontos de extensão no Habblaud (arquivos/linhas)

| Arquivo | Linha(s) | Mudança |
|---|---|---|
| `shared/types.ts` | 18 | `Provider = 'claude' | 'codex' | 'hermes'` |
| `server/sources/source.ts` | 21-39, 41-113 | `AgentSource`/`SourceSet` já suportam; nenhum cambio de contrato; nova fonte implementa a interface |
| `server/index.ts` | 133-143 | Instanciar `HermesSource` condicional a `config.hermes`, `agents.add(hermes)`, expor `hermesLive`, wire `POST /api/hermes/events` (opcional) |
| `server/index.ts` | 195-198 | Adicionar `HermesHistory` ao `HistorySet` se terminal ativo |
| `server/index.ts` | 238 | `transcriptPathOf` para Hermes via `hermes.transcriptPathOf` (ou manter Claude-only para permissions; Hermes não suporta answer no v1) |
| `server/config.ts` | 43-61, 240-255 | Adicionar `hermes: boolean`, `hermesDirs: string[]`, `hermesApiUrl?: string` ao `Config` e parsing de env |
| `server/model/office.ts` | 99-120 | `MainInput.provider` já opcional; usar `'hermes'`; `SubInput` sem provider (herda) |
| `server/http/app.ts` | 353-362 | Rotas `/api/stream`, `/api/snapshot` já genéricas |
| `shared/locales/*` | — | Novas strings via `tr()` |
| `CHANGELOG.md` | 15 | Entrada em `## [Não lançado]` |

Novos arquivos (a criar na implementação, não agora):

- `server/sources/hermes/source.ts` — `HermesSource implements AgentSource` (provider `'hermes'`).
- `server/sources/hermes/live.ts` — `HermesLive` interface (applyHookEvent opcional).
- `server/sources/hermes/files.ts` — leitura L1 (JSON/YAML).
- `server/sources/hermes/db.ts` — leitura L2 (node:sqlite, read-only).
- `server/sources/hermes/map.ts` — funções puras de mapeamento (testáveis).
- `server/sources/hermes/dedup.ts` — dedup LRU com TTL.
- `server/sources/hermes/http.ts` — cliente L3 (fetch + SSE), opcional.
- `server/sources/hermes/history.ts` — `HermesHistory implements HistoryProvider`.
- `server/sources/hermes/__fixtures__/` — fixtures de teste.

---

## 5. Fontes de dados Hermes e estratégia de acesso (L1/L2/L3)

Zero dependências de runtime. Camadas com degradação graciosa:

### L1 — Arquivos (JSON)

- `profiles/<name>/` (diretório por perfil) — enumerar subdiretórios de `dataDir/profiles/`.
- `gateway_state.json` — estado do gateway (PID, active_agents, platforms, served_profiles_count).
- `cron/jobs.json` — jobs agendados.
- `sessions/sessions.json` — sessões de plataforma.
- Memórias `MEMORY.md`/`USER.md` — apenas metadados (tamanho, mtime), nunca conteúdo em texto de atividade sem redação.
- Allow-list estrita: só os arquivos acima + `state.db` (L2). **Nunca** ler `auth.json`, `.env`, `state.db-wal`/`-shm` diretamente (usar a API SQLite).

Acesso: `node:fs` (`readFileSync`, `readdirSync`, `statSync`, `watch`). Parsing com `JSON.parse` em try/catch; arquivo ausente → degradação silenciosa.

### L2 — SQLite read-only

- `profiles/<name>/state.db` (WAL). Abrir com `node:sqlite` em modo read-only (`open` com `readOnly: true` ou `file:...?mode=ro`) + `PRAGMA busy_timeout = 5000`. Nunca escrever.
- Tabelas lidas: `sessions`, `messages`, `async_delegations`. (Possivelmente `cron` se migrar; v1 usa `cron/jobs.json`.)
- Consultas parametrizadas, `LIMIT` e janela temporal (`last_activity_at >= now - window`) para evitar varrer 1.46 GB.
- Concorrência: o gateway mantém WAL; leituras com `busy_timeout` retornam `SQLITE_BUSY` ocasionalmente → retry com backoff (3 tentativas, 100/300/900 ms) e, se persistir, pular o ciclo e logar `warnOnce`.
- Se `node:sqlite` indisponível ou schema_version divergente → L2 desligado, L1 permanece.

### L3 — HTTP/SSE (opcional)

- Ativado apenas se `HABBLAUD_HERMES_API_URL` definido (default nenhum). Somente hosts loopback (`127.0.0.1`, `localhost`, `::1`) aceitos; URLs não-loopback são recusadas no boot (log + desligado) por segurança.
- Endpoints usados (quando disponíveis): `/health`, `/v1/runs`, `/v1/runs/{id}/events` (SSE), `/api/sessions`.
- Reutilizar padrão de `server/codex/http.ts` (Host loopback) e SSE client com reconexão exponencial + jitter.
- L3 nunca é necessário para o funcionamento básico; L1+L2 bastam.

### Justificativa zero-deps

`node:sqlite` (Node ≥ 22.5) e `node:fs`/`node:http` são built-ins. Nenhuma lib de SQLite/HTTP client. Fallback de cópia de DB não é necessário (read-only + busy_timeout cobre o caso); se o arquivo estiver bloqueado, pular ciclo.

---

## 6. Mudanças no Provider e no contrato AgentSource

### 6.1 `shared/types.ts:18`

```ts
export type Provider = 'claude' | 'codex' | 'hermes';
```

Atualizar o comentário das linhas 12-17 para incluir `- hermes: Hermes AI Agent (perfis sob o data dir do Hermes).`

### 6.2 `AgentSource` (`server/sources/source.ts:21-39`)

Sem mudança de contrato. `HermesSource` implementa:

- `provider = 'hermes' as const`.
- `start()` síncrono/assíncrono: `office.beginBoot()` antes, reconstrução L1+L2, `office.endBoot()` em `finally`.
- `stop()`: limpar timers/watchers, fechar DB handles.
- `sources(): SourceInfo[]` — uma entrada por perfil observado (como Codex por conta).
- `transcriptPathOf(agentId)`: caminho do transcript (se mapeado) — Hermes não tem transcript em arquivo compatível com o terminal do Habblaud; retornar `undefined` no v1 (terminal desligado para Hermes). Documentar limitação.
- `terminalParser?`: ausente (usa default do Claude, mas sem path não é invocado).

### 6.3 Registro (`server/index.ts:133-143`)

Padrão Codex:

```ts
const hermesDirs = config.hermes ? discoverHermesProfiles(process.env, config.home) : [];
const hermes = hermesDirs.length ? new HermesSource({ accounts, office, dirs: hermesDirs, env: process.env, home: config.home }) : undefined;
if (hermes) agents.add(hermes);
const hermesLive: HermesLive | undefined = hermes;
```

Wire `POST /api/hermes/events` (se L3/hook existir) análogo a `server/codex/http.ts:64-78`, aceitando apenas host loopback. No v1 pode ficar ausente (L1/L2 polling bastam); se implementado, seguir o guard de `server/http/guard.ts`.

### 6.4 Histórico (`server/index.ts:195-198`)

Adicionar `HermesHistory` ao `HistorySet` apenas se `config.terminal` e `hermes` existirem. `HermesHistory` lê sessões recentes de `state.db` (ended_at != null) e mapeia para `RecentSession`. Como Hermes não expõe transcript compatível, o terminal pode abrir em modo somente-leitura/indisponível; documentar.

### 6.5 Permissões/mensagens (`server/index.ts:238`)

Manter `transcriptPathOf: (id) => claude.transcriptPathOf(id)` para `PermissionRegistry`; Hermes não recebe answer no v1 (limitação §16). Mensagens (`MessageRegistry`) permanecem Claude/Codex.

---

## 7. Tabela de mapeamento Hermes → Habblaud

### 7.1 AgentKind

| Condição Hermes | AgentKind |
|---|---|
| `sessions.source` ∈ {`'desktop'`, `'local'`} e `parent_session_id IS NULL` e `created_source != 'subagent'` | `'main'` |
| `sessions.source = 'subagent'` OU `parent_session_id IS NOT NULL` OU `created_source = 'subagent'` | `'sub'` |

### 7.2 AgentStatus

| Condição | AgentStatus |
|---|---|
| `ended_at IS NULL` e `last_activity_at` dentro de `WORKING_WINDOW_MS` (ex.: 90 s) e (última mensagem assistant com tool_calls OU `last_activity_description` indica execução) | `'working'` |
| `ended_at IS NULL` e aguardando aprovação (L3 `approval.request` pendente ou `last_activity_description` ~ "approval"/"waiting") | `'waiting'` |
| `ended_at IS NULL` e inativo além de `IDLE_WINDOW_MS` (ex.: 5 min) | `'idle'` |
| `ended_at IS NOT NULL` e `end_reason` ∈ {`'completed'`, `'done'`, `null` normal} | `'done'` (sub) / `'offline'` (main) |
| `ended_at IS NOT NULL` e `end_reason` indica erro/cancelamento | `'offline'` (main) / `'done'` com erro (sub) |
| Sessão arquivada (`archived = 1`) ou `hidden = 1` | não exibir (filtrar) |

Janelas configuráveis; valores iniciais conservadores. Nunca inventar "working" sem evidência recente (truthful data).

### 7.3 ActivityKind (de `tool_name` / role)

| Hermes | ActivityKind |
|---|---|
| `tool_name` ∈ {`terminal`, `bash`, `run_command`, `execute`} | `'run'` |
| `read_file`, `read` | `'read'` |
| `write_file`, `write` | `'write'` |
| `patch`, `edit_file`, `apply_patch` | `'edit'` |
| `search_files`, `grep`, `search` | `'search'` |
| `delegate_task`, `spawn_agent` (tool) | `'delegate'` |
| `browser`, `web_search`, `web_extract` | `'web'` / `'browser'` |
| `git`* | `'git'` |
| `test`* | `'test'` |
| role `assistant` com `tool_calls` não vazio | `'plan'` ou `'delegate'` (se tool é delegate) |
| role `assistant` sem tool_calls | `'respond'` |
| role `user` | `'prompt'` |
| `approval.request` (L3 ou derivado) | `'ask'` |
| erro em tool result (`finish_reason` de erro / content com erro) | `'error'` |
| compactação (`compression_*` mudou) | `'compact'` |
| conclusão de subagente (`async_delegations.state` completed) | `'done'` |
| demais | `'other'` |

\* Heurística por nome contendo "git"/"test"; documentar como best-effort.

### 7.4 Sala (roomId) e projeto

1. `git_repo_root` se não-nulo → `normalizeCwd(git_repo_root)` (mesma normalização do Office, `server/model/office.ts:325`).
2. senão `cwd` se não-nulo → `normalizeCwd(cwd)`.
3. senão nome do perfil (`profile_name` ou nome do diretório do perfil) → sala sintética `hermes:<profile>`.

Conta (`account`): id do perfil Hermes (ex.: `default`, `profile-orchestrator`). Mapeamento para letra de conta Habblaud é TBD (§16); v1 usa o id do perfil como account string (compatível com `MainInput.account: string`).

### 7.5 Durações, tokens, custo

- `startedAt`: `sessions.started_at` (epoch; converter se for segundos → ms).
- `lastEventAt`: `sessions.last_activity_at`.
- Tokens: preencher `stats` do agente apenas se presentes (`input/output/cache_read/cache_write/reasoning tokens`); não estimar. `token_count` em `messages` é NULL no sample → ignorar.
- Custo: `estimated_cost_usd`/`actual_cost_usd` quando não-nulos; `cost_status`/`cost_source` para auditoria.
- Duração de turno: `async_delegations.duration_seconds` / `total_duration_seconds` (result_json).

### 7.6 Subagentes e orquestrador

- `async_delegations` com `state = 'running'` → criar subagente (`office.addSub`) vinculado ao `parent_session_id` (agente principal), com `startedAt = dispatched_at`.
- `state = 'completed'` → marcar subagente `'done'` e entregar resultado (`result_json.summary`) como atividade `'done'`.
- `state = 'error'` → atividade `'error'` com resumo.
- `delivery_state`/`delivery_attempts`/`delivered_at` → rastrear entrega; se `pending` além de TTL, logar aviso (não fabricar status).
- Orquestrador = sessão pai que possui filhos em `async_delegations` ou `sessions` com `parent_session_id`. Detectado por existência de filhos, não por flag.
- Eventos SSE `subagent.start`/`subagent.complete` (L3) podem adiantar o estado; dedup por `(delegation_id, state, timestamp)`.

---

## 8. Multi-perfil e sessões concorrentes

- Enumerar `profiles/` sob o data dir (`HABBLAUD_HERMES_DIRS` pode sobrescrever a lista; default = todos os subdirs de `<dataDir>/profiles` ou `<home>/.hermes/profiles`).
- Uma instância de `HermesSource` por data dir? Decisão: **uma instância por fonte**, contendo a lista de perfis (análogo a Codex com múltiplas contas em uma `CodexSource`). Perfis entram em `sources()` como `SourceInfo` separados. Isso mantém `SourceSet.of('hermes')` único e simplifica `agents`.
- Concorrência de sessões: um agente por sessão ativa; subagentes vinculados ao pai. Dedup de sessões por `(profile, session_id)`.
- Gateway multiplex (24 perfis) é um único processo; polling do DB por perfil. Limitar concorrência de leituras (max 4 paralelas) para não sobrecarregar o WAL.

---

## 9. Monitoramento de orquestrador e subagentes

- Ler `async_delegations` a cada ciclo de polling (janela: `updated_at >= now - 24h` ou `state = 'running'`).
- Criar/atualizar subagentes via `office.addSub` / status updates.
- `event_json` pode conter detalhes do dispatch; usar apenas campos conhecidos (goals de `task_json`, summary de `result_json`); redigir conteúdo livre em atividade (truncar + mascarar segredos).
- Duração: `duration_seconds` ou `total_duration_seconds`.
- Se `owner_pid` não corresponder ao gateway ativo, marcar delegação como stale (log, não inventar).

---

## 10. Estratégia de atualização em tempo real

- **Polling DB:** intervalo padrão 5 s (configurável `HABBLAUD_HERMES_POLL_MS`, min 2 s). A cada ciclo: L1 (arquivos) + L2 (queries incrementais por `last_activity_at`/`updated_at`).
- **File watchers:** `fs.watch` em `gateway_state.json`, `cron/jobs.json`, `sessions/sessions.json` (debounce 300 ms). DB não é "watchável" de forma confiável → polling.
- **L3 SSE:** se `HABBLAUD_HERMES_API_URL` definido, conectar a `/v1/runs/{id}/events` por run ativo; reconexão exponencial (1s,2s,4s,... max 30s) + jitter ±20%.
- **Dedup:** LRU set com TTL 10 min, chave `(source, session_id, message_id, tool_call_id, timestamp)`. Implementar em `server/sources/hermes/dedup.ts` (Map com eviction por tamanho 10k e TTL).
- **Throttle:** o `Hub` já throttla ~200 ms (`server/http/sse.ts:12-145`); a fonte apenas chama `office` mutations; não throttlear adicionalmente.

---

## 11. Tratamento de erros, reconexão e logging

- Cada fonte/perfil envolto em try/catch; falha de um perfil não derruba os outros (`SourceSet.start()` já isola: `server/sources/source.ts:68-80`).
- Degraded flag por fonte (`hermesDegraded: boolean` exposto em `sources()` como `SourceInfo` com status degradado, se o tipo permitir; senão log + métrica em `/api/health`).
- Retry/backoff para SQLite busy e para L3; circuit breaker: após 5 falhas consecutivas em um perfil, pular por 60 s e logar `warnOnce`.
- Nunca lançar exceção não tratada no loop de polling (usar `try/catch` + `log.error`).
- SSE reconnection com backoff+jitter; desconexão prolongada (>5 min) → marcar fonte como degraded.
- Logs via `log` existente (`server/log.ts`), mensagens via `tr()`.

---

## 12. Segurança e local-first

- Allow-list de arquivos (§5 L1); proibido ler `auth.json`, `.env`, `*.key`, `credentials*`.
- DB somente leitura: abrir com `mode=ro` e `busy_timeout`; nenhum `INSERT/UPDATE/DELETE`.
- L3 apenas loopback; recusar URLs não-loopback (como `server/codex/http.ts:5-7`).
- Redação de PII em texto de atividade: truncar previews a 200 chars, mascarar padrões de token/secret (regex para `sk-`, `ghp_`, `Bearer `, emails opcionais).
- Não enviar dados do Hermes ao Habblaud World por caminho próprio; o World usa apenas `office.list()` (já verdadeiro).
- Permissões: Hermes não recebe answer no v1 (limitação); não expor endpoint de controle remoto.

---

## 13. Compatibilidade Windows

- Usar `node:path` (`join`, `resolve`, `sep`) em vez de strings com `/`; normalizar paths do Hermes (que podem vir com `/` mesmo no Windows).
- Modos de arquivo: `chmod` é no-op no Windows; não depender de permissões POSIX.
- CRLF: help-text/i18n strings com CRLF devem manter paridade (i18n:check 2980/2982); novas strings sem CRLF.
- `node:sqlite` no Node 24: verificar disponibilidade com `try { require('node:sqlite') }` e degradar.
- Paths longos: usar `\\?\` prefix apenas se necessário (evitar; preferir paths curtos via env).
- Testes executados no Windows; evitar suposições de case-sensitivity.

---

## 14. Plano de testes

### 14.1 Unitários (novos)

- `map.test.ts`: funções puras de mapeamento (AgentKind, AgentStatus, ActivityKind, sala, conta) com casos de borda.
- `db.test.ts`: leitura read-only com fixture DB (cópia de `state.db` truncada/anonimizada em `__fixtures__`); verificar queries e busy handling (mock).
- `files.test.ts`: leitura L1 com temp dir (profiles, gateway_state, cron, sessions.json); ausência de arquivos.
- `dedup.test.ts`: LRU TTL, eviction, chave composta.
- `sse.test.ts` (L3): mock de EventSource; reconexão/backoff.

### 14.2 Integração

- `hermes-source.test.ts`: mock de data dir completo → boot → agents no Office → status/atividade; subagentes via `async_delegations`.
- Verificar que `office.beginBoot/endBoot` são chamados em par (mesmo em falha).
- Verificar degradação quando `node:sqlite` ausente (mock).

### 14.3 Regressão

- Rodar suíte completa; não adicionar falhas além das 19 pré-existentes do Windows.
- `npm run typecheck` 0 erros; `npm run build` 0; `npm run i18n:check` 2980/2982 (ou atualizar conforme convenção).
- Fixtures em `server/sources/hermes/__fixtures__/` (DB anonimizado) — não commitar dados reais com PII.

---

## 15. Plano de implementação por fases (independientemente testáveis)

### Fase 0 — Spec + tipos + esqueleto (sem leitura de dados)

- **Entrada:** esta spec aprovada.
- **Ações:** `Provider` union (`shared/types.ts:18`); config `hermes`/`hermesDirs`/`hermesApiUrl` (default off); criar diretório `server/sources/hermes/` com stubs; env gating `HABBLAUD_HERMES` (default off, como `HABBLAUD_CODEX`).
- **Saída:** typecheck 0; testes compilam; nenhuma mudança de comportamento (Hermes desligado por default).
- **Testes:** unit de config parsing.

### Fase 1 — L1 file reader

- **Ações:** `files.ts` (profiles, gateway_state, cron, sessions.json); `HermesSource` com boot L1; registrar condicionalmente em `server/index.ts:133-143` quando `HABBLAUD_HERMES=1`.
- **Saída:** agentes mínimos a partir do gateway (1 por perfil ativo) com status derivado de `gateway_state.json`.
- **Testes:** `files.test.ts`, integração com temp dir.

### Fase 2 — Mapeamento de sessões (L2)

- **Ações:** `db.ts` (read-only node:sqlite) + `map.ts`; `sessions` → agentes + status + salas.
- **Saída:** agentes reais com projeto/conta/durações.
- **Testes:** `db.test.ts`, `map.test.ts`.

### Fase 3 — Atividade a partir de messages/tool_calls

- **Ações:** ler `messages` por sessão; mapear `tool_name`/role → ActivityKind; alimentar `office` (addActivity).
- **Saída:** feed de atividade do Hermes.
- **Testes:** unit de mapeamento de atividade + integração.

### Fase 4 — async_delegations / subagentes / orquestrador

- **Ações:** ler `async_delegations`; `office.addSub`; estados running/completed/error; durações.
- **Saída:** subagentes Hermes visíveis.
- **Testes:** integração com fixture de delegações.

### Fase 5 — L3 HTTP/SSE (opcional)

- **Ações:** `http.ts` cliente com fetch + SSE; wire `POST /api/hermes/events` se houver hook; reconexão.
- **Saída:** atualização ao vivo adiantada; degradação graciosa se API indisponível.
- **Testes:** mock SSE.

### Fase 6 — i18n, CHANGELOG, docs, regressão

- **Ações:** strings em `shared/locales/*` via `tr()`; entrada em `## [Não lançado]`; atualizar README se aplicável; rodar gates.
- **Saída:** i18n:check ok; testes 1852+ sem novas falhas; CHANGELOG atualizado.

---

## 16. Limitações e questões em aberto

1. **API não verificada ao vivo:** endpoints documentados mas não testados; L3 opcional e pode ser descartado se inconsistente.
2. **`token_count` NULL** no sample; custo/tokens só quando presentes; não estimar.
3. **Sem campo de projeto explícito** além de `cwd`/`git_repo_root`; fallback para nome do perfil.
4. **Mapeamento perfil → letra de conta** (como Claude account letter) TBD; v1 usa id do perfil como account.
5. **Leitura de conteúdo de mensagem** para previews de atividade: decidir nível de redação; v1 trunca a 200 chars e mascara segredos.
6. **`node:sqlite` experimental** no Node 24; validar disponibilidade e performance em 1.46 GB WAL.
7. **Transcript/terminal Hermes** não compatível com parser do Habblaud; terminal desligado para Hermes no v1.
8. **Permissões/mensagens** não suportadas para Hermes no v1 (apenas Claude/Codex).
9. **Schema version:** validar `PRAGMA user_version` (observado v32); mudança de schema pode quebrar reader.
10. **Gateway multiplex:** 24 perfis, DB pode estar locked; busy_timeout + retry.
11. **`origin_json`/`display_name`** podem conter PII; não exibir sem redação.

---

## 17. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| DB locked pelo gateway (WAL) | read-only + busy_timeout 5 s + retry/backoff; pular ciclo se persistir |
| Performance em 1.46 GB | queries com janela temporal e LIMIT; índices existentes; polling 5 s |
| Schema drift do Hermes | validar user_version; desligar L2 com aviso se divergir |
| node:sqlite indisponível | degradar para L1; log de aviso; fonte continua ativa |
| PII em atividade/previews | truncar + mascarar; allow-list de campos |
| Violação truthful-data | não fabricar; status só com evidência recente; World inalterado |
| Regressão nos gates | testes por fase; rodar suíte completa antes de merge |
| Múltiplos perfis sobrecarregando | max 4 leituras paralelas; circuit breaker |
| L3 inseguro | apenas loopback; recusar outras URLs |
| Windows path/CRLF | node:path; testes no Windows; i18n:check |

---

## 18. Status de implementação

- [ ] Fase 0 — Spec + tipos + esqueleto
- [ ] Fase 1 — L1 file reader
- [ ] Fase 2 — Mapeamento de sessões (L2)
- [ ] Fase 3 — Atividade (messages/tool_calls)
- [ ] Fase 4 — async_delegations / subagentes
- [ ] Fase 5 — L3 HTTP/SSE (opcional)
- [ ] Fase 6 — i18n / CHANGELOG / docs / regressão

> Esta spec é o único artefato desta tarefa. Nenhum código foi implementado.
