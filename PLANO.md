# Plano de implementação: desenvolvimento Android nativo no VS Code

## Objetivo e limites iniciais

Oferecer no VS Code um fluxo integrado para projetos Android Gradle em Kotlin e Java: abrir, editar, compilar, instalar, executar, depurar, testar e inspecionar apps. O primeiro alvo é o VS Code desktop com projeto e Android SDK na mesma máquina. Linux é o ambiente inicial de validação; Windows e macOS entram antes da primeira publicação pública. Suporte a SSH, WSL, containers e Codespaces exige uma decisão própria sobre onde executar Gradle, JVM, ADB e emulador.

O objetivo é cobrir as capacidades úteis do Android Studio de forma incremental. Recursos como Compose Preview, editor visual de layouts e profilers exigem provas de viabilidade antes de prometer equivalência funcional.

## Arquitetura proposta

- **Extensão TypeScript:** comandos, seletores, tarefas, diagnósticos, Test Explorer, painéis e ciclo de vida dos processos.
- **Serviço Kotlin/JVM:** usa `io.github.desodre:adb-utils`, expõe operações ADB por um protocolo local versionado (mensagens JSON por stdin/stdout), emite eventos contínuos e trata cancelamento e reconexão.
- **Gradle do projeto:** o wrapper executa builds e testes. Para descobrir módulos, variantes e artefatos, avaliar Gradle Tooling API e APIs públicas do Android Gradle Plugin; não depender de parsing de `build.gradle` nem de APIs internas.
- **Linguagens:** integrar o Kotlin Language Server oficial e o suporte Java do VS Code; a extensão acrescenta contexto Android, recursos XML e informações da variante selecionada.
- **Depuração:** a extensão coordena build, instalação, inicialização, PID e encaminhamento JDWP; um adaptador DAP fornece breakpoints, pilhas e variáveis.

## Dependências já conhecidas

- A biblioteca ADB 0.2.0 suporta `forward` entre portas TCP. O destino `jdwp:<pid>` está em desenvolvimento na [issue #32](https://github.com/desodre/adb-utils-gradle-package/issues/32), subtarefa da [#10](https://github.com/desodre/adb-utils-gradle-package/issues/10). Isso afeta a etapa 5, não as etapas 1–4.
- A descoberta de processos JDWP está planejada na [issue #16](https://github.com/desodre/adb-utils-gradle-package/issues/16). A etapa 5 deve validar se sua API é suficiente ou se necessita uma complementação.
- O Kotlin Language Server oficial informa suporte experimental a projetos Android Gradle. A etapa 4 é uma prova obrigatória em projetos reais antes de assumir cobertura de edição.

## Etapas consecutivas

### 1. Fundação da extensão e contrato entre processos

**Implementar:** criar o projeto da extensão, comandos e configurações; criar o serviço Kotlin/JVM como consumidor da versão publicada de `adb-utils`; definir mensagens com ID, operação, dispositivo, resultado, erro e cancelamento; separar stdout do protocolo e stderr dos logs; encerrar o serviço quando a extensão terminar. Detectar JDK, Android SDK, wrapper Gradle, `adb` e servidor ADB; mostrar instruções claras quando faltar algo.

**Concluída quando:** a extensão abre em modo de desenvolvimento, inicia e encerra o serviço sem processos órfãos, exibe a versão do servidor ADB e informa falhas de ambiente de modo acionável.

### 2. Importação de projetos e compilação

**Implementar:** detectar projetos Android Gradle, módulos de app/biblioteca, variantes e flavors; oferecer seleção persistente de módulo e variante; executar `assemble`, `install` e `clean` via wrapper; exibir progresso, permitir cancelar e transformar erros de compilação em diagnósticos clicáveis. Localizar APK/AAB e `applicationId` da variante pelo modelo/artefatos do build.

**Concluída quando:** um projeto com vários módulos e flavors compila a variante escolhida, abre o arquivo/linha de um erro e não executa a variante errada.

### 3. Dispositivos, instalação e execução

**Plano de recuperação e validação pendente:** [AVD e edição Kotlin/Java](docs/plan-avd-language.md), entregas A1–A2.

**Implementar:** listar e acompanhar dispositivos com `adb-utils`, selecionar serial explicitamente, distinguir `device`, `offline` e `unauthorized`; instalar o artefato correto; iniciar e parar o app; abrir `logcat` filtrável pelo processo; iniciar um AVD já configurado. Usar o `adb` do SDK para iniciar o servidor, pois a biblioteca não o inicia.

**Concluída quando:** o comando **Executar** compila, instala e inicia um app em um dispositivo ou emulador selecionado, com logs visíveis e limpeza correta após erro ou cancelamento.

**Marco:** primeiro fluxo Android utilizável no VS Code.

### 4. Edição Kotlin, Java e recursos Android

**Plano de recuperação e validação pendente:** [AVD e edição Kotlin/Java](docs/plan-avd-language.md), entregas B1–B3.

**Implementar:** validar Kotlin LSP e suporte Java com projetos Android de referência; completar, navegar e refatorar código Kotlin/Java; reconhecer classes geradas, recursos `R`, manifest e source sets da variante; acrescentar validação e navegação para XML, manifest e referências a recursos. Evitar diagnósticos duplicados entre servidores de linguagem e build.

**Concluída quando:** um projeto misto Kotlin/Java com flavors permite completar APIs Android e recursos, ir à definição e editar sem erros falsos persistentes após sincronizar o build.

### 5. Depuração Kotlin e Java

**Pré-requisitos:** validar a entrega de `jdwp:<pid>` (#32) e a descoberta de processos (#16); avaliar a reutilização de um adaptador Java/Kotlin existente antes de criar um próprio.

**Implementar:** configuração **Depurar Android**, build de variante depurável, instalação/início com espera pelo depurador quando necessário, seleção de PID, `forward` para JDWP, conexão DAP, mapeamento de fontes Kotlin/Java, breakpoints, pilha, variáveis, avaliação e limpeza do forward. Cobrir reinício do processo e vários dispositivos conectados.

**Concluída quando:** um breakpoint Kotlin e um Java são atingidos em app real e em emulador, com passo a passo e inspeção de variáveis; encerrar a sessão remove o encaminhamento.

**Marco:** MVP de edição, build, execução e debug.

### 6. Testes, lint e análise do artefato

**Implementar:** descobrir e executar testes unitários e instrumentados por módulo/variante no Test Explorer; mostrar falhas por classe/método; executar Android Lint e expor resultados como diagnósticos; abrir relatórios; acrescentar inspeção básica de APK/AAB, tamanho e manifesto efetivo.

**Concluída quando:** o usuário executa um teste isolado e uma suíte completa, vê a falha no arquivo correto e recebe resultados de lint sem abrir outro IDE.

### 7. Gerenciamento do ambiente e criação de projetos

**Implementar:** listar/instalar pacotes do SDK, gerenciar AVDs, configurar caminho do SDK/JDK, verificar licenças e compatibilidade do projeto; oferecer modelos versionados para criar um app Kotlin/Compose e um app Java/Views. Detectar instalações existentes antes de propor mudanças.

**Concluída quando:** em uma máquina preparada apenas com JDK e ferramentas Android, o usuário cria um projeto, configura um emulador e chega ao fluxo da etapa 3 por comandos do VS Code.

### 8. Ferramentas visuais de interface

**Primeiro, provar viabilidade:** renderizar um `@Preview` Compose e um layout XML fora do Android Studio, avaliando Layoutlib, APIs disponíveis, licenças, compatibilidade por versão e custo de manutenção.

**Se a prova funcionar, implementar:** prévia Compose com estados e dispositivos, edição visual de XML, catálogo de recursos, navegação entre código e componentes, atualização ao salvar. Usar um editor/painel próprio do VS Code.

**Concluída quando:** as prévias reproduzem os exemplos de referência, informam recursos não suportados e não bloqueiam a edição durante recompilações.

### 9. Inspeção e desempenho

**Implementar em incrementos:** explorador de arquivos do app e banco de dados, inspeção de layout em execução, rede e métricas, captura de traces de CPU/memória, análise de APK e assinatura de release. Para cada recurso, comprovar primeiro que existe uma interface pública ou ferramenta de linha de comando sustentável.

**Concluída quando:** cada painel mostra dados verificáveis de um app em execução e documenta as limitações por versão do Android/dispositivo.

### 10. Compatibilidade, qualidade e publicação

**Implementar:** matriz de CI em Linux, Windows e macOS; testes da extensão e do serviço, fixtures Android, cenários com vários módulos/flavors/dispositivos, medição de tempo de ativação e uso de memória; documentação, empacotamento VSIX e publicação. Decidir e testar suporte remoto (WSL/SSH/container) com separação explícita entre ADB local e Gradle remoto.

**Concluída quando:** instalar a VSIX em uma máquina limpa reproduz os fluxos do MVP; regressões críticas passam pela CI e o usuário encontra instruções para configuração e diagnóstico.

## Ordem de entrega

Executar as etapas 1→10 em sequência. As etapas 1–3 dão o primeiro fluxo utilizável; 4–5 fecham o MVP de desenvolvimento; 6–7 completam o fluxo diário; 8–9 aproximam os recursos visuais e de inspeção do Android Studio; 10 prepara uma distribuição confiável. Reavaliar o escopo da etapa seguinte após o critério de conclusão da etapa atual.

## Referências técnicas

- [API de extensões do VS Code](https://code.visualstudio.com/api/extension-guides/overview), [Task Provider](https://code.visualstudio.com/api/extension-guides/task-provider), [Debug Adapter](https://code.visualstudio.com/api/extension-guides/debugger-extension), [Testing API](https://code.visualstudio.com/api/extension-guides/testing) e [Custom Editors](https://code.visualstudio.com/api/extension-guides/custom-editors).
- [Kotlin Language Server](https://kotlinlang.org/docs/kotlin-lsp.html).
- [Gradle Tooling API](https://docs.gradle.org/current/userguide/tooling_api.html) e [APIs públicas do Android Gradle Plugin](https://developer.android.com/build/extend-agp).
- [Build Android pela linha de comando](https://developer.android.com/build/building-cmdline), [testes](https://developer.android.com/studio/test/command-line) e [ferramentas do SDK](https://developer.android.com/tools).
- [Compose Preview e Layoutlib](https://developer.android.com/develop/ui/compose/tooling/previews).
