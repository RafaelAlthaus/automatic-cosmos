# Resumo Completo das Alteracoes (Agent)

Este documento resume as principais alteracoes feitas em relacao ao codigo original, focando em robustez, desempenho, paralelismo e rastreabilidade dos downloads.

## 1) Arquitetura de execucao (download)

- O fluxo de batch evoluiu para um modelo com maior controle de concorrencia.
- O endpoint de batch (`src/app/api/download-batch/route.ts`) passou a usar fila de workers para processar itens com paralelismo real.
- A concorrencia passou a ser guiada por perfil (`fast`, `balanced`, `safe`) via `groupConcurrency` em `src/lib/download-profiles.ts`.
- Mantida a opcao de parada por erro critico (`stopOnCriticalError`) e resumo final com motivo.

## 2) Perfis de performance e estabilidade

- Criado `src/lib/download-profiles.ts` com perfis:
  - `fast`
  - `balanced`
  - `safe`
- Cada perfil controla:
  - `maxAttempts`
  - backoff (`retryBaseDelayMs`, `retryMaxDelayMs`)
  - pacing (`basePacingMs`, `maxPacingMs`)
  - cooldown de challenge
  - timeouts de captura/download
  - concorrencia de processamento (`groupConcurrency`)

## 3) Robustez na captura e download

### `src/lib/scraper.ts`

- Adicionado `getDownloadUrlWithRetry(...)` com retries e backoff.
- `getDownloadUrl(...)` passou a aceitar opcoes de timeout:
  - `captureTimeoutMs`
  - `downloadTimeoutMs`
- Melhorias de detecao de challenge/rate-limit.
- Erros de captura receberam contexto de debug (ex.: URL atual, sinais de login/challenge, respostas recentes).
- Parsing de formatos robustecido para rotulos como `HD MP4 (hevc)`.

### `src/lib/download-queue.ts`

- Criada classificacao de erro (`transient` vs `terminal`).
- Incluidos padroes de challenge/rate-limit e falhas de captura como cenarios retryaveis.
- Helpers para backoff e agrupamento.

## 4) Scraping com retry automatico

- Scraping ganhou retry por URL com backoff + jitter.
- Adicionada deteccao de pagina de bloqueio/challenge no scraping.
- Adicionado cooldown extra para casos de challenge/rate-limit.
- Mensagens de progresso de retry passaram a ser emitidas no stream.
- Coleta por URL ampliada para ate 12 cards (antes 6).

## 5) Nomenclatura sequencial de arquivos

- Implementada nomenclatura deterministica no batch:
  - `0001.mp4`, `0002.mp4`, etc.
- `DownloadBatchInputVideo` ganhou `sequenceIndex` em `src/lib/types.ts`.
- `DownloadBatchEvent` ganhou `suggestedFilename`.
- Batch gera `suggestedFilename` e frontend usa esse nome no download.
- `src/app/api/proxy-file/route.ts` passou a respeitar `filename` tambem no branch de URL remota.

## 6) Frontend / UX operacional (`src/app/page.tsx`)

- Adicionado seletor de perfil de download.
- Adicionado toggle:
  - `Stop batch on critical errors (resume later)`
- Melhorias no fluxo de checkpoint/resume.
- Auditoria de sequencia via `sequenceNumber`.
- Tratamento mais detalhado dos estados do batch:
  - `queued`, `running`, `retrying`, `done`, `failed`, `summary`
- Fila de disparo de downloads no cliente com concorrencia por perfil.

## 7) Otimizacoes de I/O e performance

- Reducao de overhead no cliente ao evitar buffering desnecessario em JS em partes do fluxo.
- `src/app/api/download/route.ts` (branch de arquivo local) migrado de leitura em buffer completo para streaming (`createReadStream`), reduzindo uso de memoria e latencia para iniciar transferencia.

## 8) Contratos e tipagem

### `src/lib/types.ts`

- Novos contratos para batch e operacao:
  - `DownloadBatchInputVideo`
  - `DownloadBatchEvent`
  - `DownloadBatchSummary`
  - `DownloadProfileName`
- `DownloadBatchSummary` inclui:
  - `stopped?: boolean`
  - `stopReason?: string`

## 9) Testes e tooling

- `vitest` adicionado com script `test` no `package.json`.
- Criado `src/lib/download-queue.test.ts` cobrindo:
  - ordenacao de agrupamento
  - classificacao de erro
  - comportamento de backoff

## 10) Resultado final observado

- Mais resiliencia a falhas intermitentes (timeouts/challenge/captura).
- Mais controle sobre custo x velocidade por perfil.
- Maior paralelismo efetivo no batch.
- Organizacao posterior simplificada por nomes sequenciais.
- Melhor rastreabilidade operacional por eventos e sumario final.
