# Plano de recuperação: AVD e edição Kotlin/Java

**Estado em 15/10/2026.** Complementa as etapas 3 e 4 do [plano principal](../PLANO.md). O PR #59 foi integrado à `main`; ele registra a falha de importação, mas não conclui a [#23](https://github.com/desodre/android-vscode-support/issues/23). O PR #61 foi encerrado sem merge. A [#22](https://github.com/desodre/android-vscode-support/issues/22) permanece aberta até a integração da nova correção à `main`.

## Resultado esperado e fronteiras

1. Um AVD existente inicia a partir do VS Code, chega a `sys.boot_completed=1` e recebe o comando **Compilar, instalar e executar**. Falhas de inicialização e cancelamento deixam processos e recursos sob controle e mostram uma mensagem útil.
2. Na fixture Android mista, os servidores Kotlin e Java reconhecem módulos, fontes, dependências, SDK, classes geradas e variante selecionada. Conclusão, navegação, referências, renomeação e diagnósticos passam na matriz abaixo.
3. Só encerrar #22 e #23 depois das provas no Extension Development Host e da integração do código à `main`. O serial de qualquer aparelho físico fica fora de commits, issues, PRs e relatórios públicos.

Os trabalhos são independentes até a prova final de execução/depuração em emulador. A falha nativa do emulador não deve ser confundida com falha do comando da extensão; a compilação Gradle bem-sucedida não deve ser confundida com importação semântica no LSP.

## Base já observada

| Trilha | Evidência | Lacuna |
| --- | --- | --- |
| AVD | O comando Executar passou em aparelho físico no PR #56. A invocação CLI com os mesmos argumentos usados pela extensão concluiu o boot; a prova no Extension Development Host concluiu boot, build, instalação, início e parada do app. Testes com executáveis falsos passaram para falha, timeout, cancelamento e disputa de porta. Uma invocação alternativa sem janela sofreu SIGSEGV, mas não faz parte do comando da extensão. | Integrar a correção à `main` e conferir os critérios da #22 após o merge. O SIGSEGV do modo alternativo pode ser investigado separadamente se houver necessidade de execução sem janela. |
| Kotlin/Java | `:app` e `:fixture` da fixture AGP 9.0.1 compilam em `freeDebug` e `paidDebug`. Com Java Red Hat 1.57.0 e Kotlin by JetBrains 0.0.13, o Java LS lista os módulos, mas seus source paths ficam vazios; Java → SDK e Kotlin ↔ Java não retornam definições após 90 s. | A origem exata de cada falha e o estado real da importação do Kotlin LSP ainda precisam ser medidos separadamente. Itens genéricos de conclusão e ausência momentânea de diagnósticos não provam suporte semântico. |
| XML | Navegação/validação Android específica da extensão foi integrada no PR #58; #25 está concluída. | A prova semântica Kotlin/Java da #23 continua necessária, inclusive `R` e classes geradas. |

O [AGP 9 removeu `android.bootClasspath` da API antiga](https://developer.android.com/build/releases/agp-9-0-0-release-notes), com indicação de `androidComponents.sdkComponents`. Isso é compatível com a falha observada no importador Java, mas não demonstra uma causa única. A [importação Android do Java Red Hat é experimental](https://github.com/redhat-developer/vscode-java/blob/main/package.json). Existe também uma [issue aberta do Kotlin LSP para navegação entre módulos Android](https://github.com/Kotlin/kotlin-lsp/issues/210); confirmar se nossa reprodução tem a mesma causa antes de depender dela.

## Entrega A — diagnosticar o SIGSEGV do AVD (#22)

### A1. Capturar a linha de base do host, sem alterar AVDs

- Executar fora de um sandbox que bloqueie sockets e dispositivos: registrar versão e caminho do emulador e do SDK, sistema/arquitetura, ABI e API de cada AVD de prova, espaço livre, modo gráfico, `emulator -accel-check`, existência/permissões de `/dev/kvm` e disponibilidade de display. Não publicar caminhos pessoais ou identificadores de dispositivos.
- Reproduzir **um AVD por vez** pelo CLI, sem VS Code, com duração limite e saída capturada em arquivo temporário; registrar código/sinal de saída, último marco do boot e trecho relevante de stderr. Confirmar a mesma falha em duas execuções limpas antes de classificá-la.
- Se houver SIGSEGV, obter backtrace do processo com mecanismo disponível no host e identificar biblioteca/fase da queda. Verificar se a queda ocorre antes da ligação ao ADB, durante gráfico/aceleração ou após aparecer como `device`.
- Usar cópia descartável da configuração/dados do AVD ou opções de linha de comando para as comparações. Preservar snapshots e dados dos AVDs originais. Separar as variáveis: inicialização fria sem snapshot, modo de GPU `auto` e `software`, Vulkan habilitado/desabilitado, imagem de sistema e versão do emulador. Não combinar várias mudanças numa única tentativa.
- Interpretar `-accel-check` e as opções de GPU conforme a [documentação oficial de aceleração](https://developer.android.com/studio/run/emulator-acceleration), de [linha de comando](https://developer.android.com/studio/run/emulator-commandline) e de [problemas conhecidos](https://developer.android.com/studio/run/emulator-troubleshooting). Software rendering pode ajudar a isolar a GPU; não presumir que ele contorna ausência de aceleração da VM.

**Saída:** relatório reproduzível com matriz tentativa → configuração → fase → resultado, logs curtos saneados e hipótese principal sustentada por backtrace ou diferença controlada. Se nenhum AVD iniciar pelo CLI, registrar bloqueio do host e prosseguir apenas com testes simulados da extensão; #22 permanece aberta.

### A2. Tornar a inicialização da extensão observável e segura

- Comparar exatamente o comando e o ambiente que `src/emulator.ts` envia ao processo com o CLI funcional: SDK escolhido, AVD, porta reservada, variáveis de ambiente e opções necessárias. Adicionar opção de lançamento apenas se a prova justificar e definir como preservá-la entre plataformas.
- Cobrir no código: erro de `spawn`, saída imediata, saída durante boot, timeout, cancelamento, porta ocupada entre verificação e início, ADB indisponível e processo sobrevivente. Registrar fase de inicialização e causa legível. Reter evidência temporária de falha tempo suficiente para diagnóstico, removendo-a quando não necessária.
- Evitar que uma falha do AVD selecione outro dispositivo ou instale o app nele. Verificar que o processo iniciado pela extensão é encerrado em cancelamento/timeout e que um emulador pré-existente não é encerrado por engano. Cobrir isso com executável falso e ADB falso determinísticos em testes de unidade/integração locais.
- Repetir no Extension Development Host: **Iniciar AVD existente** → seleção do novo emulador → build da variante → instalação → início do app → parada. Conferir estado do ADB e `sys.boot_completed`, cancelamento e mensagem de erro. O sucesso do CLI é pré-requisito para atribuir falha desse fluxo à extensão.

**Aceite da #22:** ao menos um AVD existente chega ao boot e executa o app com o comando completo; falhas e cancelamentos não deixam seleção incorreta nem processo iniciado pela extensão sem controle. A prova física já integrada continua válida. Registrar versão e imagem do emulador usadas.

## Entrega B — isolar as falhas de edição Android (#23)

### B1. Matriz de importação controlada

- Partir da [fixture mista](../test-fixtures/android-editing/README.md), build limpo de `freeDebug` e `paidDebug`, perfis VS Code isolados e diretórios de cache separados. Fixar e registrar versões de VS Code, Java Red Hat/JDT LS, Kotlin by JetBrains, JDK de cada servidor, JDK do Gradle, Gradle, AGP, SDK e sistema. Desativar provedores Kotlin concorrentes no perfil de prova.
- Usar três controles: projeto JVM puro Kotlin/Java, Android de módulo único e Android misto `:app` → `:fixture`; quando viável, comparar AGP 8 compatível com a fixture AGP 9.0.1 sem mudar outras variáveis. Isso separa falha geral do servidor, falha Android, falha do AGP 9 e falha entre módulos.
- Executar Java Android support explicitamente em `on`, confirmar modo de importação Standard e aguardar um **marco de sincronização concluída** nos canais de saída, não apenas um prazo fixo. Registrar `java.project.getAll`, `java.project.listSourcePaths`, natureza/modelo do projeto e classpath gerado, além de erros de Gradle/Buildship. Não alterar o perfil pessoal.
- Confirmar que o processo Kotlin LSP iniciou, importou Gradle e indexou os dois módulos; capturar estados/logs e respostas LSP para definição, referências, conclusão e rename. Distinguir resposta vazia de requisição antes da inicialização, timeout e servidor indisponível. Repetir em perfil novo e após reinicialização do servidor.
- Aprimorar `language-import-smoke.js` para guardar todos os resultados por cenário e assertar marcadores **semânticos** específicos (por exemplo `BroadcastReceiver`, `SharedNames`, `MainActivity`, `R`, `BuildConfig`), destino e arquivo de origem; não aceitar apenas quantidade de itens. Manter saída curta e saneada.

**Saída:** tabela por cenário e linguagem com importação, source paths, dependências, APIs Android, navegação intra e entre módulos, referências e diagnósticos. Cada falha terá etapa causal provável e reprodução mínima. Se AGP 8 passar e AGP 9 falhar, priorizar compatibilidade com a API removida; se ambos falharem, investigar importação Android mais ampla. Se Kotlin falhar sozinho em múltiplos módulos, comparar com a issue upstream #210.

### B2. Definir a correção por camada, após a matriz

- **Configuração/versão:** testar versão compatível do servidor e ajustes documentados em perfil isolado. Promover para orientação da extensão apenas o que passar na fixture completa; nunca gravar automaticamente opções experimentais no projeto do usuário.
- **Importação Java:** se o JDT LS perder fontes e dependências do AGP 9, localizar o ponto de falha no importador e avaliar atualização upstream ou uma integração sustentada por API pública. O modelo mínimo precisa incluir fontes Java da variante, `android.jar`, JRE correto, dependências de projeto/AAR e fontes geradas. Um fallback que apenas acrescenta `android.jar` falhou antes com erros de classes padrão; não usá-lo como solução.
- **Importação Kotlin:** confirmar variante, source sets, dependências entre módulos e diretórios gerados no modelo recebido pelo servidor. Caso a falha esteja no Kotlin LSP, acompanhar/corroborar reprodução upstream e avaliar um provedor **específico e limitado** da extensão somente para navegação Android comprovável. Não declarar rename cruzado suportado por um índice textual; rename deve vir de edição semântica verificável ou permanecer como limitação explícita.
- **Contrato da extensão:** usar descoberta Gradle já existente para oferecer módulo, variante, recursos e diagnósticos de build aos provedores que aceitem integração estável. A #24 cobre source sets/código gerado; a #26 cobre diagnósticos/refatorações. Só movê-las de `On hold` quando a camada responsável e um teste de integração estiverem definidos.
- Para falha estritamente interna de um servidor, preparar reprodução mínima e linkar uma issue upstream existente ou propor uma nova issue para revisão do mantenedor. Não modificar arquivos de instalação do usuário nem vender um remendo temporário como suporte completo.

**Saída:** decisão registrada por capacidade: `suportada`, `suportada pela extensão`, `bloqueada upstream` ou `a implementar`, com versão testada e prova. A escolha deve evitar dois provedores concorrentes para a mesma operação sem critério de precedência.

### B3. Fechar a matriz funcional

| Capacidade | Prova de aceite |
| --- | --- |
| Conclusão | APIs Android, símbolos Kotlin/Java entre módulos, `R` e `BuildConfig` aparecem no arquivo e variante corretos; item escolhido insere código que compila. |
| Navegação/referências | Kotlin → Java, Java → Kotlin, Java → SDK, intra módulo, dependência local e recurso Android apontam para arquivo/linha esperados; referências incluem usos entre módulos. |
| Rename | Renomear classe Kotlin e classe Java usadas no outro módulo; inspecionar edições propostas, aplicar em cópia da fixture e recompilar ambas as variantes. Nenhuma alteração em código não relacionado. |
| Variantes | Alternar `freeDebug`/`paidDebug`, invalidar/sincronizar modelo e confirmar fontes, recurso exclusivo, `R`, `BuildConfig` e manifest corretos. |
| Diagnósticos | Introduzir e corrigir erros reais Kotlin/Java/XML; a mensagem some após sync e o painel não duplica o mesmo erro com texto/posição equivalentes. Nenhum aviso falso persistente em projeto compilável. |

Executar prova automatizada no Extension Development Host com servidores reais e perfis limpos, seguida de uma inspeção manual das operações de edição. Arquivar só resultados e trechos de log necessários, sem caminhos privados/serial físico. A #23 fecha somente quando a matriz cumprir os critérios da issue. Uma limitação de servidor deve ficar documentada e manter a issue aberta até haver correção ou mudança explícita de escopo. A etapa 4 ainda depende de #24 e #26.

## Ordem de PRs e pontos de decisão

| Ordem | PR proposto | Issues | Condição para seguir |
| --- | --- | --- | --- |
| 1 | Prova de ambiente AVD e matriz CLI, com diagnóstico de causa | #22 | CLI funcional ou bloqueio de host demonstrado; nenhuma mudança especulativa no comando. |
| 2 | Matriz automatizada de importação Kotlin/Java e análise por servidor | #23 | Importação/semântica medidas com controles JVM, Android simples e misto. Pode avançar em paralelo ao PR 1. |
| 3 | Correção de início/observabilidade do AVD e prova de execução | #22 | Ao menos um AVD inicia pelo CLI; caso contrário, manter #22 aberta e avançar na trilha de linguagens. |
| 4 | Correção suportável de classpath/modelo Java e Kotlin, em PRs menores se as causas divergirem | #23, possivelmente #24 | Cada correção resolve um conjunto de asserts sem regressões nos controles. |
| 5 | Integração de variantes, rename e diagnósticos; prova final da etapa 4 | #23, #24, #26 | Matriz B3 passa e código integra `main`. |

Depois de cada PR integrado: conferir os critérios da issue, atualizar o Kanban, manter aberta a pendência comprovada e remover apenas worktrees sem trabalho remanescente. A etapa 5 de depuração em emulador continua dependente de um AVD estável e do mapeamento de fontes da etapa 4.
