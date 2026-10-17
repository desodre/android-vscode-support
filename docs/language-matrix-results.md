# Matriz inicial de edição Kotlin/Java (#23)

Prova local no Extension Development Host, em perfis isolados, com VS Code 1.132.0, Kotlin by JetBrains 0.0.13, Red Hat Java 1.57.0 e JDK 21 para Gradle. As três fixtures compilaram. Os resultados abaixo são da amostra aos 90 segundos; os relatórios brutos permaneceram locais e não devem ser publicados sem saneamento.

| Capacidade | JVM Kotlin/Java | Android: um módulo | Android: `:app` + `:fixture` |
| --- | --- | --- | --- |
| Projetos listados pelo Java LS | Sim | Sim | Sim, ambos |
| Source paths do Java LS | Java e Kotlin | Vazios | Vazios em ambos os módulos |
| Definição Java → Kotlin | Funciona | Vazia | Vazia |
| Definição Java → SDK Android | Não se aplica | Vazia | Vazia |
| Definição Kotlin → Java | Vazia | Vazia | Vazia |
| Definição de `R`/`BuildConfig` | Não se aplica | Não medida | Vazia |
| Diagnóstico Java de arquivo fora do classpath | Não | Sim | Sim, nos dois módulos |

O controle JVM separa duas falhas: a importação Java funciona sem AGP, enquanto a navegação Kotlin → Java permanece vazia até nesse controle. Nos projetos Android, a ausência de source paths e o diagnóstico de arquivo fora do classpath indicam falha adicional na importação Java. A ativação da extensão Kotlin foi observada, mas não comprova que o Kotlin LSP concluiu a importação ou indexação.

O tempo de 90 segundos é uma amostra, não um marco de sincronização concluída. A próxima prova deve habilitar `intellij.trace.server`, capturar o estado de importação Kotlin e comparar o Java LS após sinal explícito de sync. A matriz ainda não cumpre os critérios de conclusão, referências, rename, variantes ou diagnósticos da #23; a issue permanece aberta. Os comandos e cenários estão em [`test-fixtures/android-editing/README.md`](../test-fixtures/android-editing/README.md).

## Pré-condições da repetição (17/10/2026)

A repetição em perfil novo com trace `verbose` não constitui evidência semântica válida: o relatório mostrou `redhat.java` ausente, apesar de existir um symlink no diretório de extensões. A instalação pelo CLI corrigiu o registro. A matriz agora rejeita esse caso antes das consultas e preserva cada amostra em disco.

A inspeção dos source maps distribuídos na extensão oficial Kotlin 0.0.13 identificou uma condição adicional: `activateExtension` chama `checkEulaAccepted` antes de iniciar o cliente. Essa verificação exige concluir a configuração inicial de região, licença e compartilhamento de dados. Portanto, `isActive=true` e saída Kotlin vazia não comprovam importação ou falha do suporte Kotlin/Java. O perfil novo foi aberto para o usuário concluir essa configuração; nenhuma aceitação foi automatizada.

É necessário repetir o controle JVM com ambos os servidores registrados e evidência de inicialização/importação do Kotlin. Só depois comparar os projetos Android. A hipótese de falha de importação Java no AGP permanece em investigação; esta rodada não estabelece sua causa nem substitui as medições anteriores.
