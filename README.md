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

## Etapa 02 em desenvolvimento

Com uma pasta Android Gradle aberta, execute **Android: Selecionar módulo** e **Android: Selecionar variante**. A seleção aparece na barra de status e é preservada no workspace. A descoberta consulta o Gradle Tooling API e o `androidComponents` público do Android Gradle Plugin; a extensão não lê o conteúdo de `build.gradle` para inferir módulos ou variantes.

Os comandos **Android: Compilar variante selecionada**, **Android: Gerar AAB da variante selecionada**, **Android: Instalar variante selecionada** e **Android: Limpar módulo selecionado** criam tarefas do VS Code que chamam o wrapper Gradle do projeto. A saída aparece no terminal da tarefa e pode ser cancelada. Erros Kotlin, Java e XML com arquivo e linha são mostrados em **Problemas**. Após `assemble` ou `bundle`, o terminal lista o APK ou AAB da variante e o `applicationId` quando disponível.

A instalação pelo Gradle ainda não oferece seleção de dispositivo; isso faz parte da Etapa 03. A leitura dos artefatos APK usa os metadados gerados pelo Android Gradle Plugin e valida o nome da variante antes de exibir os arquivos.
