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
