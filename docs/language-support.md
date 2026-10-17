# Prova de suporte a Kotlin e Java em projetos Android Gradle

**Escopo:** etapa 4, issue #23. Estado em 14/10/2026: decisão de integração tomada e primeira prova em projeto Android executada; critérios de edição Android ainda não comprovados por completo.

## Decisão

Usar o [Kotlin Language Server oficial](https://kotlinlang.org/docs/kotlin-lsp.html) pela extensão **Kotlin by JetBrains** (`jetbrains.kotlin-server`) para arquivos Kotlin e o [Language Support for Java by Red Hat](https://github.com/redhat-developer/vscode-java) para arquivos Java. A extensão Android VS Code Support deve fornecer a descoberta de módulo/variante e o contexto de recursos Android; não deve implementar um segundo servidor genérico de Kotlin ou Java. A instalação das extensões de linguagem deve ser apresentada como requisito da experiência de edição até que a prova determine se é seguro oferecê-las como parte de um pacote.

Esta é uma decisão de arquitetura, não uma declaração de que as duas importações Android funcionam no mesmo workspace. O [Kotlin LSP está em Alpha](https://kotlinlang.org/docs/kotlin-lsp.html) e sua importação Android Gradle é experimental. A [importação Android do servidor Java](https://github.com/redhat-developer/vscode-java) também é experimental. Em VS Code estável, a opção `java.jdt.ls.androidSupport.enabled` tem valor padrão `auto`, que só ativa Android no VS Code Insiders; usar `on` durante a prova. Não gravar essa opção no projeto do usuário sem explicar e testar o efeito.

O [registro de versões do Kotlin LSP](https://github.com/Kotlin/kotlin-lsp/blob/main/RELEASES.md) documenta suporte a source sets Gradle não padrão e referências cruzadas Kotlin/Java, mas também relata correções recentes na importação Android. Por isso, exigir validação de `R`, `BuildConfig`, dependências, módulos e flavors. No mesmo registro, a versão atual da extensão oficial é `v0.0.13` no lançamento `v263.6379.0`; o identificador antigo `jetbrains.kotlin` foi substituído por `jetbrains.kotlin-server`. Usar um único servidor Kotlin ativo durante a prova.

## Ambiente observado

Para a #24, o modelo de descoberta passa a incluir diretórios estáticos Java/Kotlin informados pela API pública `variant.sources` do AGP, inclusive os adicionados por plugins a uma única variante. A fixture `android-editing` prova que `app/custom/free/java` aparece em `freeDebug` e não em `paidDebug`; o layout da extensão marca esses caminhos como ativos ou inativos ao trocar a variante. Isso fornece contexto correto aos consumidores internos da extensão. A resolução de símbolos nos servidores Kotlin/Java ainda depende da validação de importação da #23; esta mudança não afirma corrigir o classpath do Java LS.

| Item | Resultado local | Consequência |
| --- | --- | --- |
| VS Code | `1.132.0`, Linux x64 | Ambiente inicial da prova. |
| Java | OpenJDK `26.0.1` no `PATH` | Atende ao mínimo de JDK 25 do Kotlin LSP. A extensão Java usa JRE incluído nas plataformas suportadas; a versão universal sem JRE exige Java 25. Confirmar qual JVM cada extensão inicia. |
| Servidor Java | `redhat.java@1.57.0` instalado | Pode ser testado após ativar importação Android. |
| Kotlin oficial | `jetbrains.kotlin-server@0.0.13` instalado em perfil isolado | A extensão ativou; a navegação Kotlin para Java entre módulos ainda não funcionou na prova. |
| Kotlin legado | `fwcd.kotlin@0.2.36` e `mathiasfrohlich.kotlin@1.7.1` instalados | Desativar ambos no perfil de prova para evitar sobreposição de provedores Kotlin. |
| Projeto desta extensão | Apenas serviço Kotlin/JVM, sem módulo de app Android | Não serve como fixture para `R`, manifest ou variantes. |

As primeiras consultas no perfil pessoal encontraram restrições de escrita. A prova seguinte usou perfis e diretórios de extensões isolados em `/tmp`, sem alterar o perfil pessoal.

## Primeira prova em projeto Android

Em 14/10/2026, uma fixture local com `:app` Kotlin, `:fixture` Java, flavors `free` e `paid`, AGP `9.0.1`, Gradle `9.6.0` e JDK 21 compilou `assembleFreeDebug` e `assemblePaidDebug`. O serviço Gradle da extensão descobriu as variantes de ambos os módulos; a extensão ativou em um Extension Development Host do VS Code estável `1.132.0` com Kotlin oficial `0.0.13` e Java Red Hat `1.57.0` instalados em perfil isolado. A configuração de importação Android do servidor Java estava em `on`.

Após a primeira prova, a descoberta Gradle passou a informar dependências de projeto por variante. Na mesma fixture, `:app` reportou `:fixture` em `freeDebug` e `paidDebug`; o índice da extensão encontrou `string/fixture_label` em `:fixture/src/main/res/values/strings.xml` a partir de `:app`. Esta verificação cobre recursos de módulos locais declarados no Gradle, mas ainda não cobre AARs externas e recursos gerados.

Uma chamada à API de definição do VS Code para `R.string.test_label` no arquivo Kotlin devolveu `app/src/main/res/values/strings.xml`. O comando de diagnóstico da extensão concluiu. As chamadas de conclusão nos arquivos Kotlin e Java devolveram itens, mas a prova ainda não verificou se incluíam símbolos do Android SDK ou referências cruzadas. A chamada de definição para uma classe Java de `:fixture` usada pelo Kotlin de `:app` devolveu zero destinos. O servidor Java informou que `FixtureActivity.java` não estava no classpath de `:fixture` e só reportaria erros de sintaxe. Não houve diagnóstico Kotlin ou XML naquele instante. Esses resultados impedem marcar #23 como concluída.

Uma segunda execução com perfil novo observou o mesmo aviso de classpath e zero destinos para Kotlin → Java após 30 e 90 segundos. O comando `java.project.getAll` listou `:app` e `:fixture`, mas `java.project.listSourcePaths` para o arquivo Java devolveu lista vazia nas duas medições. Portanto, esperar mais pela sincronização não resolveu a ausência de source paths no modelo do servidor Java. O problema foi reproduzido sem modificar o perfil pessoal do VS Code.

Investigação posterior: o script de importação Android incluído no JDT LS da extensão Red Hat `1.57.0` encerra a configuração quando `android.bootClasspath` não fornece `android.jar`. A fixture com AGP `9.0.1` não expôs essa propriedade; o `.classpath` gerado continha apenas o JRE e o contêiner Gradle, sem `src/main/java`. Uma cópia temporária do script com fallback para o `android.jar` do SDK fez aparecer o diretório fonte no `.classpath` e removeu o aviso, confirmando a causa imediata. Ela também produziu erros de classes Java padrão e não restaurou a navegação Kotlin → Java, portanto não é uma configuração pronta para usuários.

Em 15/10/2026, repetimos a importação em um perfil limpo do VS Code `1.132.0` com a fixture versionada em `test-fixtures/android-editing`, Java Red Hat `1.57.0`, Kotlin by JetBrains `0.0.13`, JDK 21 para o Gradle e `java.jdt.ls.androidSupport.enabled=on`. `freeDebug` e `paidDebug` compilaram. Após cerca de 90 segundos, `java.project.getAll` encontrou os dois módulos, mas `java.project.listSourcePaths` retornou `[]` para o app; ambos os arquivos Java receberam o aviso de que não pertencem ao classpath. Definições Kotlin → Java, Java → Kotlin e Java → Android SDK retornaram zero destinos. A lista de conclusão Java continha palavras do documento, mas isso não demonstra resolução do SDK. Não houve diagnóstico Kotlin nesse instante; isso também não comprova a importação do Kotlin LSP. O script `language-import-smoke.js` preserva essa prova de forma repetível e registra o resultado em JSON sem modificar arquivos do usuário.

As [notas oficiais do AGP 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes) confirmam que `android.bootClasspath` foi removido da API antiga e indicam `androidComponents.sdkComponents` como substituto. Isso é compatível com a falha observada no importador Java, embora a prova não estabeleça que seja a única causa. A [importação Android do Java Red Hat](https://github.com/redhat-developer/vscode-java) continua experimental. Não alterar o classpath gerado pelo servidor nem instalar um remendo no perfil do usuário como solução final: o teste anterior com fallback para `android.jar` trouxe erros adicionais e não restaurou a navegação entre linguagens. A #23 permanece aberta até completar a matriz de aceite.

Também foi testada `JetBrains.intellij-server@0.0.13` em perfil isolado, com opções de região e compartilhamento de dados definidas. Após 120 segundos, a navegação Kotlin → Java e Java → Kotlin continuou sem destinos. Como o servidor não deixou logs nessa prova, ela não confirma que o backend inicializou; é preciso resolver a ativação antes de julgar sua compatibilidade Android.

A próxima prova deve inspecionar a sincronização de ambos os servidores, confirmar itens de conclusão específicos do Android, repetir navegação cruzada após importação completa e executar renomeações com recompilação. Registrar o aviso de classpath com a fixture e as versões acima ao investigar se a causa está na importação Android do servidor Java, no ambiente de prova ou na configuração da extensão.

## Fixture mínima de aceitação

Criar ou selecionar um projeto Android Gradle pequeno com `:app` e `:core`, um flavor `free` e outro `paid`, variantes `freeDebug` e `paidDebug`, um arquivo Kotlin no app e um Java na biblioteca. Incluir `AndroidManifest.xml`, `res/values/strings.xml`, `res/layout/` e ao menos um recurso presente apenas em `src/free/`. Registrar versões exatas do Gradle wrapper, AGP, Kotlin, JDK, VS Code e extensões. O app deve compilar antes de atribuir falhas aos servidores de linguagem.

| Verificação no VS Code | Resultado exigido | Evidência a guardar |
| --- | --- | --- |
| Importação | Kotlin LSP e Java LS terminam a sincronização para `:app` e `:core` sem erro de classpath. | Canais de saída dos dois servidores, tempos e versões. |
| Conclusão | Em Kotlin e Java, completar APIs do Android SDK, classe do outro idioma e símbolos de `R` da variante escolhida. | Captura de tela ou transcript das sugestões e arquivo de origem. |
| Navegação | Ir à definição de classe entre módulos/idiomas, dependência externa e recurso; localizar usos entre `:app` e `:core`. | Arquivo e linha de origem/destino, lista de referências. |
| Refatoração | Renomear uma classe Kotlin e uma Java usadas no outro módulo, verificando o diff e recompilando. | Diff resultante e resultado do Gradle. |
| Flavors/source sets | Alternar `freeDebug`/`paidDebug` e verificar visibilidade correta do recurso exclusivo, classes geradas e manifest correspondente. | Diagnósticos antes/depois e build de cada variante. |
| Diagnósticos | Introduzir um erro real em cada idioma, corrigi-lo, sincronizar e comprovar que alertas falsos não permanecem. | Painel Problemas e saídas do build/servidores. |

O teste de navegação para `R` e XML cruza a issue de recursos Android da etapa 4: se os servidores não oferecerem esse caminho, a extensão deverá fornecer um provedor específico, sem atribuir falsamente a capacidade ao Kotlin LSP ou ao Java LS. Diagnósticos de compilação da extensão atual devem ser comparados com os dos servidores para evitar duplicatas no painel Problemas.

## Procedimento de prova

1. Abrir a fixture com a versão estável do VS Code, instalar `jetbrains.kotlin-server` e `redhat.java`, desativar os provedores Kotlin legados neste workspace e registrar versões. Conferir o JDK usado para iniciar os servidores; o serviço ADB Kotlin deste projeto e o Gradle da fixture podem usar JDKs distintos.
2. Definir temporariamente `java.jdt.ls.androidSupport.enabled` como `on` no perfil de prova. Manter os demais ajustes padrões inicialmente e salvar os canais de saída de ambos os servidores.
3. Executar a matriz acima após uma sincronização limpa. Repetir após alterar a variante, salvar um script Gradle e reiniciar o VS Code. Registrar falhas por idioma e por variante, com passos reproduzíveis.
4. Corrigir apenas lacunas sob controle desta extensão (contexto Android, navegação de recursos e diagnósticos). Para falha interna de importação dos servidores, registrar reprodução com versões e acompanhar o projeto responsável; não ocultar o erro com diagnósticos artificiais.
5. Marcar a issue #23 concluída somente após completar, navegar e refatorar Kotlin/Java na fixture mista com flavors, inclusive APIs Android e símbolos gerados, sem falsos erros persistentes após o sync. A etapa 4 depende também da validação dos recursos Android descrita no plano.

## Referências

- [Kotlin Language Server: funcionalidades, estado Alpha e AGP experimental](https://kotlinlang.org/docs/kotlin-lsp.html)
- [Kotlin LSP: releases, ID da extensão e correções Android](https://github.com/Kotlin/kotlin-lsp/blob/main/RELEASES.md)
- [Red Hat Java: Gradle/Android e configuração `java.jdt.ls.androidSupport.enabled`](https://github.com/redhat-developer/vscode-java)
- [VS Code Java: importação Gradle e modo Standard/Hybrid](https://github.com/redhat-developer/vscode-java#supported-vs-code-settings)
