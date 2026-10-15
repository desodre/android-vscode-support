# Android VS Code Support

Extensão em desenvolvimento para integrar Android nativo em Kotlin e Java ao VS Code.

- [Plano de implementação](PLANO.md)
- [Kanban público](https://github.com/users/desodre/projects/9)

O trabalho está dividido em dez etapas consecutivas. Cada etapa tem uma issue principal e tarefas menores no Kanban. As primeiras entregas cobrem build e execução; a depuração completa depende do suporte JDWP planejado na biblioteca [`adb-utils`](https://github.com/desodre/adb-utils-gradle-package/issues/32).

## Primeira entrega: fundação

A extensão já oferece três comandos: **Android: Diagnosticar ambiente**, **Android: Versão do servidor ADB** e **Android: Listar dispositivos**. Um serviço Kotlin/JVM usa a versão publicada `io.github.desodre:adb-utils:0.2.0` para consultar o servidor ADB. A extensão se comunica com ele por mensagens JSON versionadas, com IDs por requisição e cancelamento. O serviço escreve o protocolo em stdout e logs em stderr.

### Desenvolver localmente

Requisitos: VS Code, Node.js, JDK 17+ e Android SDK Platform-Tools. Para consultar o ADB, inicie o servidor com `adb start-server`.

```sh
npm install
npm run compile
./gradlew :bridge:installDist
```

Abra este repositório no VS Code e pressione **F5** para abrir a janela de desenvolvimento. A tarefa de lançamento compila a extensão e o serviço. Na Paleta de Comandos, execute **Android: Diagnosticar ambiente**. Os comandos de ADB funcionam mesmo sem um projeto Android aberto; o diagnóstico do wrapper Gradle exige abrir a raiz de um projeto Android que contenha `gradlew`.

As configurações `androidSupport.javaHome`, `androidSupport.sdkPath` e `androidSupport.bridgeLibDirectory` substituem a descoberta automática. `androidSupport.adbHost` e `androidSupport.adbPort` apontam para o servidor ADB; o padrão é `127.0.0.1:5037`.

```sh
npm test
```

O teste integrado usa um servidor ADB simulado em uma porta local. Ele não exige dispositivo físico.

## Etapa 02: projetos e compilação

Com uma pasta Android Gradle aberta, execute **Android: Selecionar módulo** e **Android: Selecionar variante**. A seleção aparece na barra de status e é preservada no workspace. A descoberta consulta o Gradle Tooling API e o `androidComponents` público do Android Gradle Plugin; a extensão não lê o conteúdo de `build.gradle` para inferir módulos ou variantes.

Os comandos **Android: Compilar variante selecionada**, **Android: Gerar AAB da variante selecionada** e **Android: Limpar módulo selecionado** criam tarefas do VS Code que chamam o wrapper Gradle do projeto. A saída aparece no terminal da tarefa e pode ser cancelada. Erros Kotlin, Java e XML com arquivo e linha são mostrados em **Problemas**. Após `assemble` ou `bundle`, o terminal lista o APK ou AAB da variante e o `applicationId` quando disponível.

A leitura dos artefatos APK usa os metadados gerados pelo Android Gradle Plugin e valida o nome da variante antes de exibir os arquivos.

## Etapa 03 em desenvolvimento: dispositivos e execução

**Android: Selecionar dispositivo** mostra os estados `device`, `offline` e `unauthorized`. A seleção é explícita e preservada por workspace para dispositivos físicos; emuladores exigem nova seleção a cada sessão porque o mesmo serial pode ser reutilizado por outro AVD. Desconexão ou mudança de estado invalida a seleção. **Android: Iniciar Logcat** abre uma saída contínua, com filtro opcional por pacote ou PID. O filtro por pacote acompanha reinícios do processo. **Android: Parar Logcat** fecha a coleta.

**Android: Instalar variante selecionada** compila a variante, solicita um dispositivo e instala o APK com `adb-utils`. **Android: Compilar, instalar e executar aplicativo** permite escolher um dispositivo conectado ou iniciar um AVD existente, depois instala e inicia a Activity `MAIN/LAUNCHER`. **Android: Parar aplicativo selecionado** encerra o pacote no dispositivo escolhido. Quando o build produz vários APKs, a extensão pede qual deles instalar; não combina APKs filtrados como se fossem necessariamente um conjunto de splits.

Para iniciar um AVD, o SDK precisa ter Android Emulator e Platform-Tools, e o servidor ADB deve usar `127.0.0.1:5037`. O serviço Kotlin instala um APK por vez; APKs maiores que 512 MiB exigem outro fluxo de instalação. A localização de artefatos ainda assume o diretório `build/outputs` padrão do módulo.

## Etapa 04 em desenvolvimento: edição e recursos

Ao abrir XML Android, Kotlin ou Java, a extensão oferece **Ir para Definição** para referências `@tipo/nome` e `R.tipo.nome`. Quando um módulo e uma variante foram selecionados, a busca considera os source sets dessa variante e os módulos locais declarados como dependências Gradle. A opção `androidSupport.xmlLocalResourceDiagnostics` permite avisos sobre recursos não encontrados no índice; ela começa desativada porque recursos de bibliotecas externas e gerados ainda não são indexados.

Os diagnósticos de build agora são descartados quando a variante muda, o arquivo é editado ou o build é cancelado. Um build antigo não substitui diagnósticos de um build mais recente; mensagens iguais de Gradle e dos servidores de linguagem são exibidas uma vez quando coincidem na localização e no texto.

Para conclusão, navegação e refatoração gerais de Kotlin/Java, a estratégia é usar as extensões Kotlin by JetBrains e Language Support for Java by Red Hat. Consulte a [prova e matriz de aceitação](docs/language-support.md). O suporte Android desses servidores ainda precisa ser validado em um projeto misto com flavors antes de concluir a etapa.

## Etapa 05 em desenvolvimento: depuração

**Android: Conectar depurador ao aplicativo em execução** usa o dispositivo selecionado, procura o PID do pacote e cria um encaminhamento JDWP por meio de `adb-utils:0.3.0`. Escolha Kotlin by JetBrains ou Debugger for Java quando ambos estiverem instalados. A extensão verifica o handshake antes do attach e remove o encaminhamento ao terminar a sessão. O aplicativo deve estar instalado, em execução e ser depurável. O adaptador Java usa o módulo Gradle e os diretórios de código da variante para localizar fontes e avaliar expressões. Um breakpoint Java com pilha, variável, avaliação e passo foi validado em aparelho físico; Kotlin e emulador ainda exigem validação. Consulte a [decisão e matriz de validação](docs/debugging.md) e a [fixture de teste](test-fixtures/android-debug/README.md).

**Android: Compilar, instalar e depurar aplicativo** compila a variante selecionada, instala o APK no dispositivo escolhido, reinicia o pacote aguardando o depurador e conecta ao novo PID. Se a conexão for cancelada ou falhar, encerra o processo e limpa a configuração de espera. A espera pelo depurador, a descoberta do novo PID e o handshake JDWP passaram em aparelho físico; o comando completo ainda precisa de validação em dispositivo e emulador.
