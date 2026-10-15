# Diagnóstico do AVD no host — issue #22

**Estado:** prova parcial em 15/10/2026. Nenhum serial de dispositivo físico foi registrado. Os logs completos são locais e não devem ser publicados sem revisão.

## Ambiente e controle

- Linux x86_64, sessão Wayland, KVM disponível e utilizável no host. Dentro do sandbox de desenvolvimento, sockets/ADB eram bloqueados; resultados dali não representam a execução real.
- AVD de prova: Pixel 8, imagem Android API 37 x86_64 com páginas de 16 KiB, 2 GiB de RAM configurados, GPU automática. O mesmo AVD foi usado nas tentativas; não foi feito `wipe-data` nem gravado snapshot.
- O host contém dois SDKs. Um oferece Emulator 36.5.11 e outro, escolhido pela descoberta automática da extensão nesta sessão, Emulator 37.1.11. A variável `ANDROID_HOME` apontava para um subdiretório `platform-tools`, enquanto `ANDROID_SDK_ROOT` apontava para o segundo SDK. Os SDKs também diferem nas plataformas e Build Tools instalados.
- Havia cerca de 7–9 GiB livres em disco. A disponibilidade de memória variou durante as tentativas.

## Resultado observado

| Tentativa | Configuração | Resultado |
| --- | --- | --- |
| CLI, Emulator 36.5.11 | Boot frio, sem carregar/salvar snapshot, GPU automática, porta ADB fixa | `sys.boot_completed=1`; log do emulador indica boot em 38,9 s. O processo foi encerrado pelo limite controlado após a prova. |
| `startAvd` da extensão, Emulator 36.5.11 | Argumentos de produção `-avd` e `-port`, SDK/ADB locais | Retornou após 21 s com `sys.boot_completed=1`; o emulador iniciado foi encerrado em seguida. |
| CLI, Emulator 37.1.11 | Mesmo AVD, boot frio e GPU automática | Não chegou ao boot. O log mostra timeouts em comandos ADB e threads QEMU sem resposta. A consulta ADB excedeu seu limite e a execução do diagnóstico terminou sem cleanup; a sessão ficou sob forte pressão de memória. |

O registro do kernel no horário da terceira tentativa mostra falta global de memória, um processo `qemu-system-x86` com aproximadamente 2,3 GiB residentes e encerramento forçado de um processo da interface. Isso confirma que **repetir a prova pesada no estado atual é arriscado**. Não demonstra, isoladamente, defeito do Emulator 37.1.11: o boot frio, a carga concorrente e a memória disponível também diferiram. Não há backtrace confiável que identifique a origem do SIGSEGV anteriormente observado.

## Decisão e próxima prova

1. A extensão agora aceita `androidSupport.emulatorPath`, um executável absoluto independente do SDK de build. Isso permite reproduzir o binário 36.5.11 que concluiu o boot sem alterar a instalação do SDK principal. A lista de AVDs e o início usam o mesmo executável.
2. A fixture compilou com SDK coerente, um único worker Gradle e heap limitado. A prova do comando completo está preparada em `test-fixtures/android-debug/avd-run-command-smoke.js`, mas ainda **não passou**: falta executá-la no Extension Development Host quando houver pelo menos 8 GiB de memória disponível. O teste recusa iniciar se essa margem ou a condição de nenhum AVD pré-existente não forem atendidas.
3. Antes de nova comparação com Emulator 37, limitar a carga concorrente, monitorar RAM/swap e garantir cleanup mesmo se uma consulta ADB travar. Se o problema persistir com memória suficiente, capturar backtrace e comparar GPU/Vulkan e snapshots uma variável por vez.
4. A #22 permanece aberta. Ainda faltam a prova integrada no VS Code e os casos de cancelamento, timeout e falha de processo.
