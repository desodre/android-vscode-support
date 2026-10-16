# Plano de melhorias: refatoração da extensão e Logcat

**Estado em 16/10/2026, base `71e1679`.** Complementa o [plano principal](../PLANO.md) sem alterar a ordem das etapas. O objetivo é reduzir o acoplamento de `src/extension.ts` antes que a etapa 6 (testes e lint) acrescente novos comandos ao mesmo arquivo, corrigir pequenas inconsistências encontradas na análise e aproximar o Logcat do fluxo do Android Studio.

## Resultado esperado e fronteiras

1. `src/extension.ts` fica restrito a ativação, registro de comandos e ligação entre componentes. O estado de longa duração (bridge, Logcat, diagnósticos) passa a pertencer a classes com ciclo de vida explícito e testes próprios.
2. As features F1–F5 são refatorações **sem mudança de comportamento visível**: mesmos comandos, mensagens, seleção de dispositivo e limpeza de recursos. F6 e F7 alteram o comportamento de forma deliberada e documentada.
3. Cada feature é um PR independente, com `npm test` passando e sem regressão nas provas manuais já registradas (Executar em aparelho físico e AVD, attach Java em aparelho físico).
4. Nenhuma feature muda o protocolo entre a extensão e o serviço Kotlin.

## Base observada

| Área | Evidência | Lacuna |
| --- | --- | --- |
| `src/extension.ts` | 612 linhas, 13 variáveis globais mutáveis (`:20–33`), sem testes. Mistura ciclo de vida do bridge, Logcat, fluxos de run/debug, publicação de diagnósticos e regras de variante para XML. | Lógica pura e lógica de estado não são testáveis porque dependem do módulo `vscode` e de globais. |
| Progresso cancelável | O bloco `withProgress` + `AbortController` + `onCancellationRequested` se repete em `:127`, `:211`, `:240` e `:340`. | Duplicação. |
| Confiança no workspace | Quatro verificações quase iguais em `:124`, `:147`, `:164` e `:225`. | Duplicação, mensagens divergentes. |
| Ambiente | `environment.ts:54` usa `spawnSync('java -version')` com timeout de 3 s, executado a cada `inspectEnvironment`, inclusive em todo início de AVD. | Bloqueia a thread do Extension Host. |
| Depuração | `debugSelected` descarta o retorno de `waitForProcess` (`:346`), e `attachToApplication` consulta `debug.findProcess` de novo (`:277`). O filtro de PIDs existe em `attach.ts` e em `extension.ts:278`. | Requisição e lógica duplicadas. |
| Espera cancelável | `delay` em `emulator.ts` e o sleep interno de `waitForProcess` em `debug/attach.ts` implementam a mesma espera com `AbortSignal`. | Duplicação. |
| `package.json` | 17 entradas `onCommand:*` em `activationEvents`, com `engines.vscode ^1.100`. Desde o VS Code 1.74, os comandos declarados em `contributes.commands` já ativam a extensão. | Ruído de manutenção. |
| `emulatorPath` | `environment.ts` aceita caminho relativo e o mostra como encontrado; `emulator.ts:14` rejeita o mesmo valor. | Diagnóstico enganoso. |
| Wrapper Gradle | `inspectEnvironment` só procura `gradlew` em `workspaceFolders[0]`; a descoberta de projetos aceita várias pastas. | Falso problema em workspaces multi-root. |
| Logcat | Filtro "Aplicativo" exige digitar o ID do pacote; saída em `OutputChannel` simples, sem níveis. | A variante selecionada já conhece o `applicationId`. |

O padrão a seguir já existe no projeto: dependências de UI injetáveis (`createVscodeSelectionUi`, `createVscodeDeviceSelectionUi`) e carregamento tardio de `vscode` via `require`, o que permite testar com `node --test` e um stub, como em `src/test/environment.test.ts`.

## F1 — Utilitários compartilhados de cancelamento e confiança

- Criar `src/util/abort.ts` com `sleep(ms, signal, message)`, substituindo `delay` em `emulator.ts` e o sleep interno de `waitForProcess`. Preservar as mensagens atuais de cancelamento de cada chamador.
- Criar `src/ui/progress.ts` com `withCancellableProgress(title, fn: (signal) => Promise<T>)`, que encapsula `withProgress`, `AbortController` e a remoção do listener. Substituir as quatro ocorrências em `extension.ts`.
- Criar `requireTrust(action: string)` com uma única mensagem parametrizada ("Confie na pasta de trabalho antes de …") e substituir as quatro verificações.
- Testes: `sleep` resolve, rejeita ao abortar antes e durante a espera, e remove o listener; `withCancellableProgress` aborta o sinal ao cancelar o token (com stub de `vscode`).

**Aceite:** nenhuma ocorrência restante do padrão manual de progresso em `extension.ts`; testes de `emulator` e `debugAttach` passam sem alteração de asserts.

## F2 — `BridgeManager`

- Extrair `getBridge` e `ensureDeviceTracking` (`extension.ts:359–407`) para `src/bridgeManager.ts`, com `get(): Promise<BridgeClient>`, `onDevicesChanged` e `dispose()`.
- Injetar a fábrica do cliente (`BridgeClient.start`) e a leitura de ambiente para testar sem JVM.
- Manter as garantias atuais: uma única inicialização concorrente, recriação quando o cliente fechar, reinício do monitor de dispositivos para cada novo cliente e nenhum log de erro quando o fechamento foi intencional.
- Testes com cliente falso: chamadas concorrentes geram uma única inicialização; cliente fechado é substituído; falha de inicialização permite nova tentativa; `dispose` encerra monitor e cliente.

**Aceite:** `extension.ts` não contém mais `bridge`, `deviceTracking` nem `ensureDeviceTracking`; `deactivate` delega a `BridgeManager.dispose()`.

## F3 — `LogcatSession`

- Extrair `startLogcat`, `stopLogcat`, `logcatStream`, `logcatOutput` e `activeLogcatSerial` para `src/logcat.ts`.
- Separar a montagem dos parâmetros de filtro (validação de pacote e PID) e a formatação dos eventos `logcat.entry`, `logcat.started` e `logcat.filterChanged` em funções puras.
- A sessão expõe `start(serial, filter)`, `stop()` e `stopIfSerialChanged(serial)`; o handler de mudança de dispositivo chama este último.
- Testes: formatação dos três eventos, validação de filtros, parar uma sessão antiga não afeta a nova (o caso hoje protegido por `logcatStream === stream`).

**Aceite:** comportamento idêntico ao atual nos comandos Iniciar/Parar Logcat; mudança de dispositivo continua encerrando a sessão.

## F4 — Regras de variante e diagnósticos testáveis

- Mover a escolha de variante compatível de `resourceContext` (`extension.ts:476–487`) para uma função pura em `src/resourceDependencies.ts`: módulo selecionado usa a variante selecionada; outros módulos usam a única variante com mesmo build type e flavors contidos na seleção; senão, a única variante existente; senão, nenhuma.
- Extrair de `createBuildDiagnostics` (`:418–442`) o filtro que oculta issues já publicadas por outros servidores (mesma linha, coluna e mensagem normalizada) e o fingerprint de publicação, em `src/gradle/diagnosticCoordinator.ts` ou módulo vizinho.
- Testes: casos com flavors de dimensões diferentes, ambiguidade e módulo sem seleção; deduplicação por posição e por espaçamento da mensagem; republicação sem mudança não gera nova escrita.

**Aceite:** os navegadores XML e os diagnósticos se comportam como antes nas fixtures `android-editing`; `npm test` cobre as duas regras.

## F5 — Fluxos de aplicativo fora de `extension.ts`

- Criar `src/appFlows.ts` com `buildAndInstall`, `launchInstalled`, `attachToApplication` e `debugSelected`, recebendo por injeção: bridge, UI de escolha (`pickApk`, `pickActivity`, `pickPid`, `pickAdapter`), executor de tarefa e log.
- Fazer `waitForProcess` alimentar o attach: passar os PIDs já obtidos a `attachToApplication` em vez de consultar `debug.findProcess` de novo. Usar uma única função de normalização de PIDs exportada de `debug/attach.ts`.
- Mover `installedApplicationIds` e `installedKey` para o módulo de fluxos.
- Testes com bridge falso: APK único não abre seletor; cancelamento do seletor encerra sem instalar; falha de attach no fluxo de depuração para o app e limpa `waitForDebugger`; attach bem-sucedido não para o app.

**Aceite:** `extension.ts` cai para algo próximo de 250 linhas e só registra comandos; prova manual de Executar e Depurar em aparelho físico repetida no Extension Development Host.

## F6 — Correções de ambiente e manifesto

- `environment.ts`: guardar em cache a versão do Java por caminho do executável e trocar `spawnSync` por `execFile` assíncrono. O cache é invalidado quando `androidSupport.javaHome` muda.
- Aplicar a mesma regra de caminho absoluto de `emulator.ts` ao `emulatorPath` no diagnóstico e reportar como problema um valor relativo ou inexistente.
- Procurar o wrapper Gradle em todas as pastas do workspace; reportar problema só se nenhuma tiver `gradlew`.
- Remover de `package.json` as entradas `onCommand:*`, mantendo `onLanguage:*`.
- Testes em `environment.test.ts`: cache por caminho, `emulatorPath` relativo e workspace multi-root.

**Aceite:** iniciar um AVD não executa `java -version` após a primeira detecção; a extensão continua ativando por todos os comandos da paleta com o manifesto reduzido.

**Depende de:** nenhuma. Pode ser o primeiro PR, por ter baixo risco.

## F7 — Logcat integrado ao aplicativo

- No filtro "Aplicativo", preencher o campo com o `applicationId` instalado para a variante e o dispositivo (ou o da variante selecionada) e permitir edição.
- Adicionar a configuração `androidSupport.logcatOnRun` (`"ask"` padrão, `"always"`, `"never"`). Depois de **Executar** ou **Depurar**, abrir o Logcat filtrado pelo pacote no mesmo dispositivo, reaproveitando `logcat.filterChanged` para acompanhar reinícios do processo.
- Trocar o canal por `vscode.window.createOutputChannel('Android Logcat', { log: true })` e mapear o campo `priority` que o evento `logcat.entry` já envia (`Main.kt:138`, em minúsculas, ou `null`) para os níveis do `LogOutputChannel`. Entradas sem prioridade usam `info`. Avaliar na prova manual se o carimbo de tempo que o `LogOutputChannel` acrescenta atrapalha a leitura do `rawLine`.
- Testes: mapeamento de prioridade (incluindo `null` e valores desconhecidos), decisão de `logcatOnRun` e preenchimento do pacote.

**Aceite:** em aparelho físico, **Executar** abre o Logcat do app sem digitar o pacote; o filtro de nível do painel Output funciona; desativar a opção mantém o comportamento atual.

**Depende de:** F3.

## Ordem de PRs

| Ordem | PR | Feature | Condição para seguir |
| --- | --- | --- | --- |
| 1 | Correções de ambiente e manifesto | F6 | `npm test` passa; comandos ativam a extensão sem `onCommand`. |
| 2 | Utilitários de cancelamento e confiança | F1 | Sem mudança de asserts nos testes existentes. |
| 3 | `BridgeManager` | F2 | Reconexão verificada matando o processo Kotlin com a extensão aberta. |
| 4 | `LogcatSession` | F3 | Logcat igual ao atual em aparelho físico. |
| 5 | Regras de variante e diagnósticos | F4 | Fixture `android-editing` com `freeDebug` e `paidDebug` sem regressão. Pode ir em paralelo a 3–4. |
| 6 | Fluxos de aplicativo | F5 | Executar e Depurar repetidos no Extension Development Host. |
| 7 | Logcat integrado | F7 | Prova manual de Executar com Logcat automático. |

F1–F5 não devem misturar mudanças de comportamento: qualquer correção encontrada durante a extração vai para um commit separado, descrito no PR. Ao concluir F5, atualizar o README apenas se a estrutura descrita lá mudar; ao concluir F7, documentar `androidSupport.logcatOnRun` no README.
