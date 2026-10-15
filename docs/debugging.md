# Depuração Android: decisão e primeira integração

**Etapa 5, issues #27 a #30. Estado em 15/10/2026:** a ponte ADB e o adaptador Java foram validados em um aparelho Android físico. O adaptador Kotlin atingiu o breakpoint e respondeu às consultas de threads, pilha e escopos, mas não respondeu à consulta de variáveis dentro do limite do teste. A validação em emulador permanece pendente.

## Adaptadores

Reutilizar adaptadores JDWP existentes: `intellij_jvm`, incluído em **Kotlin by JetBrains**, para Kotlin/Java; ou `java`, incluído em **Debugger for Java**, para Java. A extensão Android coordena dispositivo, PID, forward e ciclo de vida da sessão e entrega `hostName`/`port` ao adaptador selecionado. Não há motivo comprovado para criar um adaptador DAP próprio antes da prova de fontes e breakpoints.

O adaptador Kotlin e a importação Android ainda são [experimentais nas notas do Kotlin LSP](https://github.com/Kotlin/kotlin-lsp/blob/main/RELEASES.md). O [depurador Java documenta a configuração de attach por porta](https://github.com/microsoft/vscode-java-debug/blob/main/Configuration.md). O [manual do ADB](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md) documenta `jdwp:<pid>` como destino de `forward`. A versão publicada `adb-utils:0.3.0` fornece a API tipada usada pela ponte Kotlin.

O Debugger for Java também precisa de `projectName` para avaliar expressões e de `sourcePaths` para localizar os fontes. A extensão obtém esses valores do módulo Gradle e dos source sets da variante selecionada. Em uma prova com o módulo `app`, o attach Java atingiu `JavaProbe.java:7`, apresentou a variável `input`, avaliou seu valor e executou um passo. Sem `projectName`, a avaliação falhou apesar de o breakpoint funcionar.

## Fluxo disponível

1. Selecionar módulo de aplicativo, variante e dispositivo ADB explicitamente. O aplicativo deve estar instalado, em execução e ser depurável.
2. **Android: Conectar depurador ao aplicativo em execução** encontra PIDs pelo pacote. Se houver mais de um, pede a seleção do processo.
3. A ponte Kotlin cria `tcp:<porta-local> → jdwp:<pid>` no serial selecionado com `noRebind`. A extensão confirma o handshake JDWP antes de iniciar o adaptador.
4. A extensão inicia `vscode.debug.startDebugging` com o adaptador instalado. Ao terminar a sessão, falhar a conexão ou desativar a extensão, remove apenas o forward que ela criou. A ponte verifica se o destino do mapeamento ainda é o mesmo PID antes da remoção.

O comando **Android: Compilar, instalar e depurar aplicativo** acrescenta build e instalação, reinicia o pacote com `am set-debug-app -w`, aguarda o novo PID e então executa o attach. O início não usa `am start -W`, pois a Activity pode estar aguardando o depurador. A configuração transitória de espera é limpa após iniciar o attach; em caso de falha ou cancelamento, a extensão também encerra o processo. A [documentação oficial do ADB](https://developer.android.com/tools/adb) descreve `set-debug-app -w` e `clear-debug-app`.

`pidof` fornece candidatos pelo nome principal do pacote; ainda não lista todos os processos depuráveis. A [descoberta JDWP da biblioteca](https://github.com/desodre/adb-utils-gradle-package/issues/16) permanece necessária para processos secundários, mudanças de PID e reconexão. Em aparelho físico, o fluxo transitório de espera pelo depurador, a descoberta do novo PID e o handshake JDWP passaram. Restam a prova da retomada pelo comando completo da extensão e a validação em emulador.

## Prova no aparelho físico

O app misto de [teste de depuração](../test-fixtures/android-debug/README.md) foi compilado como APK `debug` e instalado em um SM_G990E (API 36). A ponte Kotlin encontrou o PID pelo pacote no serial explícito, criou o forward `tcp → jdwp`, e o handshake respondeu corretamente. A sessão `java` do VS Code atingiu o breakpoint, mostrou a pilha no arquivo e linha corretos, leu `input`, avaliou a expressão e parou após um passo. O forward foi removido ao fim do teste. A fixture e o [teste físico opt-in](../test-fixtures/android-debug/physical-dap-smoke.js) permitem repetir essa verificação.

A sessão `intellij_jvm` também recebeu o evento DAP `stopped` com razão `breakpoint` no mesmo aparelho. A importação pelo Kotlin LSP precisou usar um JDK 21 completo via `org.gradle.java.home`; seu runtime embutido não forneceu `jlink`. Na primeira tentativa, o aparelho desapareceu do USB/ADB antes da leitura da pilha; o bridge não conseguiu remover o forward porque o serial já não existia. Após reconectar, uma segunda tentativa atingiu o breakpoint, mas a consulta de threads esgotou o tempo. Na terceira tentativa, com USB estável, o adaptador respondeu às consultas de threads, `stackTrace` e `scopes`. A consulta DAP `variables` não respondeu em 15 segundos e a sessão foi encerrada. Não restou forward; o aplicativo de teste e a espera pelo depurador foram encerrados. Ainda faltam confirmar os valores da pilha e dos escopos, variáveis, avaliação e passo Kotlin.

O AVD `adb_utils_api21_rc` iniciou brevemente no ADB, mas o processo do emulador terminou com `SIGSEGV` (código 139). O mesmo ocorreu com o emulador alternativo e com o binário do SDK em modo de software. A prova em emulador requer estabilizar um AVD antes de executar os breakpoints.

## Prova necessária

- Em aparelho e emulador, conectar ao PID correto com dois dispositivos ligados e verificar que o forward é removido ao encerrar.
- Atingir um breakpoint Kotlin e outro Java em app misto; confirmar arquivo/linha, passo a passo, pilha, variáveis e avaliação.
- Repetir após reinício do processo e após falha de attach, comprovando que não resta forward antigo.
- Validar a importação de fontes Android dos servidores de linguagem. A [prova da etapa 4](language-support.md) encontrou source paths Java vazios no projeto AGP 9.0.1; esse problema pode impedir o mapeamento correto de breakpoints.

Os testes automatizados da ponte cobrem serial explícito, validação de PID/porta, protocolo ADB e propriedade do forward. Os testes da extensão cobrem o ciclo de limpeza e o handshake JDWP local. A prova completa Kotlin/Java em aparelho e emulador permanece pendente.
