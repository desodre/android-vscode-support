# AGENTS.md — contexto para agentes

Extensão VS Code (`desodre.android-vscode-support`) para desenvolver apps Android nativos (Kotlin/Java, Gradle) sem Android Studio: descobrir módulos/variantes, compilar, instalar, executar, depurar, Logcat, AVD e navegação de recursos XML. Alvo atual: VS Code desktop no Linux, SDK e projeto na mesma máquina. Roteiro em 10 etapas: [PLANO.md](PLANO.md). Kanban: github.com/users/desodre/projects/9.

## Arquitetura

```
VS Code ── extensão TypeScript (src/, Node, CommonJS) ──JSON por linha via stdin/stdout──▶ serviço Kotlin/JVM (bridge/)
                │                                                                          ├─ adb-utils 0.3.0 → servidor ADB (127.0.0.1:5037)
                ├─ wrapper Gradle do projeto (tarefas androidGradle)                        └─ Gradle Tooling API + init script → módulos/variantes
                ├─ emulador do SDK (AVD) e adb CLI só para iniciar AVD
                └─ depuradores de terceiros (Kotlin by JetBrains `intellij_jvm`, Debugger for Java `java`) via forward JDWP
```

- **Protocolo** (`PROTOCOL_VERSION = 1`): `{version,type:"request",id,method,device?,params}` → `{type:"response",id,result|error}`; streams emitem `{type:"event",id,event,result}` até `{type:"cancel",id}`. stdout = protocolo, stderr = log. Handshake `bridge.hello`.
- **Métodos do bridge** (`Main.kt`): `bridge.hello`, `server.version`, `devices.list`, `devices.track`*, `gradle.discoverProjects`, `app.install|launchers|launch|stop`, `logcat.stream`* (eventos `logcat.started|entry|filterChanged`; entry traz `rawLine,message,priority,tag,processId…`), `debug.findProcess|forwardJdwp|removeForward|setWaitForDebugger|clearWaitForDebugger`. (*stream)
- Descoberta de projeto usa Tooling API + `androidComponents` público do AGP (init script `bridge/src/main/resources/android-discovery.init.gradle`). **Nunca** inferir módulos lendo `build.gradle`.

## Mapa de arquivos (src/)

| Arquivo | Responsabilidade |
| --- | --- |
| `extension.ts` | `activate`/`deactivate`, registro de comandos, status bar, ligação entre componentes. Único lugar com estado global. |
| `bridgeClient.ts` | Processo JVM, requisições com timeout/cancelamento, streams. |
| `bridgeManager.ts` | Uma instância do bridge por vez, reconexão, monitor `devices.track`. |
| `appFlows.ts` | build+instalar, iniciar, parar, attach, depurar (dependências injetadas; UI em `createVscodeAppFlowUi`). |
| `appRunner.ts` | Validação de APK/`applicationId` e chamadas `app.*`. |
| `debug/attach.ts` | Porta local, forward JDWP, handshake, `waitForProcess`, limpeza do forward ao fim da sessão. |
| `logcat.ts` | `LogcatSession` (um stream por vez), filtros, níveis, `logcatOnRun`. |
| `emulator.ts` | `listAvds`, `startAvd` (porta, boot `sys.boot_completed`, encerra o processo em falha/cancelamento). |
| `environment.ts` | Diagnóstico: JDK 17+ (versão em cache), SDK, adb, emulador, `gradlew`, bridge compilado, servidor ADB. |
| `projectDiscovery.ts`, `selection.ts`, `deviceSelection.ts` | Catálogo módulos/variantes; seleção persistida em `workspaceState`; seleção explícita de serial. |
| `sourceSets.ts`, `resourceDependencies.ts` | Source sets ativos da variante; variante compatível e dependências entre módulos. |
| `xmlResources.ts`, `manifestNavigation.ts` | Definição/validação de `@tipo/nome` e `R.tipo.nome`; navegação no manifest. |
| `gradle/` | `runner` (wrapper), `taskProvider` (tarefa `androidGradle`, `executeTaskAndWait`), `diagnostics` (parse de erros), `diagnosticCoordinator` (Problemas sem duplicar language servers), `artifacts` (APK/AAB por metadados). |
| `ui/vscodeHelpers.ts`, `util/abort.ts` | `withCancellableProgress`, `requireTrust`; `sleep` cancelável. |

Kotlin (`bridge/src/main/kotlin/.../`): `Main.kt` (despacho do protocolo), `DeviceActions`, `DebugActions`, `DebugLaunchActions`, `GradleDiscovery`.

## Comandos de desenvolvimento

```sh
npm install
npm run check          # tsc --noEmit
npm run compile        # src → out/
npm test               # compile + ./gradlew :bridge:test :bridge:installDist + node --test out/test/*.test.js
node --test out/test/*.test.js   # só TypeScript; os testes de integração exigem o bridge compilado (installDist)
```

- O Gradle usa **toolchain JDK 17** (`jvmToolchain(17)`); se a máquina não tiver um, o plugin foojay (`settings.gradle.kts`) o baixa na primeira execução.
- CI (`.github/workflows/ci.yml`): Linux, Windows e macOS rodam `check`, `compile`, `:bridge:test :bridge:installDist` e `node --test` em bash (no Windows, o npm usa cmd.exe, onde `./gradlew` não funciona). Testes com executáveis POSIX são pulados no Windows.
- F5 no VS Code abre o Extension Development Host (`.vscode/launch.json`).
- Provas reais (aparelho/AVD/LSP) são scripts opt-in em `test-fixtures/*/` — ver os READMEs de cada fixture. Não publicar serial de aparelho físico em commits, issues ou PRs.

## Convenções

- **Textos para o usuário em português** (comandos, mensagens, erros, docs). Identificadores em inglês; comentários curtos, em inglês ou português conforme o arquivo.
- Testes: `node:test` + `assert/strict`, em `src/test/*.test.ts`. Código que importa `vscode` é testado com stub via `Module._load` (ver `test/environment.test.ts`) ou carregando `vscode` com `require` tardio dentro da UI (`createVscode*Ui`). Lógica nova deve ser pura ou receber dependências injetadas.
- Operações de dispositivo exigem serial escolhido explicitamente (`requireSelectedDevice`); nunca usar implicitamente o único dispositivo conectado.
- Gradle, emulador e dispositivos só em workspace confiável (`requireTrust`).
- Cancelamento via `AbortSignal` até o bridge; recursos criados (processo do emulador, forward JDWP, streams) são limpos em falha e cancelamento.
- Git: branch por tarefa (`feat/…`, `docs/…`), um commit por feature, PR para `main` referenciando a issue.

## Estado (out/2026)

| Etapa | Situação |
| --- | --- |
| 1–2 Fundação, descoberta, build | Concluídas. |
| 3 Dispositivos/execução | Executar validado em aparelho físico e AVD (#22). |
| 4 Edição | Navegação/validação XML pronta (#25). Kotlin/Java LSP **bloqueado** no AGP 9: Java LS sem source paths, sem navegação SDK/cross-module (#23; ver `docs/plan-avd-language.md`, `docs/language-support.md`). |
| 5 Depuração | Attach Java validado em aparelho físico; Kotlin e emulador pendentes (`docs/debugging.md`). |
| 6–10 | Não iniciadas (testes/lint, SDK/AVD manager, preview, profilers, publicação). |

Docs: `docs/debugging.md` (decisão do adaptador DAP), `docs/language-support.md` (matriz LSP), `docs/plan-avd-language.md` (recuperação AVD/LSP), `docs/plan-refactor-improvements.md` (refatoração F1–F7, aplicada).
