# Depuração Android: decisão e primeira integração

**Etapa 5, issues #27 e #28. Estado em 14/10/2026:** a integração inicial permite conectar a um processo já em execução. Ainda falta validar breakpoints Kotlin e Java em dispositivo ou emulador real.

## Adaptadores

Reutilizar adaptadores JDWP existentes: `intellij_jvm`, incluído em **Kotlin by JetBrains**, para Kotlin/Java; ou `java`, incluído em **Debugger for Java**, para Java. A extensão Android coordena dispositivo, PID, forward e ciclo de vida da sessão e entrega `hostName`/`port` ao adaptador selecionado. Não há motivo comprovado para criar um adaptador DAP próprio antes da prova de fontes e breakpoints.

O adaptador Kotlin e a importação Android ainda são [experimentais nas notas do Kotlin LSP](https://github.com/Kotlin/kotlin-lsp/blob/main/RELEASES.md). O [depurador Java documenta a configuração de attach por porta](https://github.com/microsoft/vscode-java-debug/blob/main/Configuration.md). O [manual do ADB](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md) documenta `jdwp:<pid>` como destino de `forward`. A versão publicada `adb-utils:0.3.0` fornece a API tipada usada pela ponte Kotlin.

## Fluxo disponível

1. Selecionar módulo de aplicativo, variante e dispositivo ADB explicitamente. O aplicativo deve estar instalado, em execução e ser depurável.
2. **Android: Conectar depurador ao aplicativo em execução** encontra PIDs pelo pacote. Se houver mais de um, pede a seleção do processo.
3. A ponte Kotlin cria `tcp:<porta-local> → jdwp:<pid>` no serial selecionado com `noRebind`. A extensão confirma o handshake JDWP antes de iniciar o adaptador.
4. A extensão inicia `vscode.debug.startDebugging` com o adaptador instalado. Ao terminar a sessão, falhar a conexão ou desativar a extensão, remove apenas o forward que ela criou. A ponte verifica se o destino do mapeamento ainda é o mesmo PID antes da remoção.

`pidof` fornece candidatos pelo nome principal do pacote; ainda não lista todos os processos depuráveis. A [descoberta JDWP da biblioteca](https://github.com/desodre/adb-utils-gradle-package/issues/16) permanece necessária para processos secundários, mudanças de PID e reconexão. O comando atual também não compila, instala ou inicia o aplicativo aguardando o depurador; essas etapas pertencem às próximas tarefas da etapa 5.

## Prova necessária

- Em aparelho e emulador, conectar ao PID correto com dois dispositivos ligados e verificar que o forward é removido ao encerrar.
- Atingir um breakpoint Kotlin e outro Java em app misto; confirmar arquivo/linha, passo a passo, pilha, variáveis e avaliação.
- Repetir após reinício do processo e após falha de attach, comprovando que não resta forward antigo.
- Validar a importação de fontes Android dos servidores de linguagem. A [prova da etapa 4](language-support.md) encontrou source paths Java vazios no projeto AGP 9.0.1; esse problema pode impedir o mapeamento correto de breakpoints.

Os testes automatizados da ponte cobrem serial explícito, validação de PID/porta, protocolo ADB e propriedade do forward. Os testes da extensão cobrem o ciclo de limpeza e o handshake JDWP local. A prova em app real ainda está pendente.
