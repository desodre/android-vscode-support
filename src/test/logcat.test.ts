import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BridgeStream } from '../bridgeManager';
import { formatLogcatEvent, logcatFilter, logcatLevel, LogcatOnRun, LogcatSession, LogcatSink, shouldOpenLogcatOnRun } from '../logcat';

test('monta parâmetros de filtro e rejeita valores inválidos', () => {
  assert.deepEqual(logcatFilter('all'), { label: 'Todos os processos', params: {} });
  assert.deepEqual(logcatFilter('package', 'com.example.app'),
    { label: 'Aplicativo (ID do pacote)', params: { packageName: 'com.example.app' } });
  assert.deepEqual(logcatFilter('pid', '1234'), { label: 'Processo (PID)', params: { processId: 1234 } });
  assert.throws(() => logcatFilter('package', 'semponto'), /ID de pacote válido/);
  assert.throws(() => logcatFilter('pid', '0'), /PID positivo/);
  assert.throws(() => logcatFilter('pid'), /PID positivo/);
});

test('formata os eventos do stream de logcat', () => {
  assert.equal(formatLogcatEvent('logcat.entry', { rawLine: '10-16 I/Tag: oi' }), '10-16 I/Tag: oi');
  assert.equal(formatLogcatEvent('logcat.entry', { rawLine: '' }), undefined);
  assert.equal(formatLogcatEvent('logcat.started', { processIds: [1, 2] }), 'PIDs filtrados: 1, 2');
  assert.equal(formatLogcatEvent('logcat.started', { processIds: [] }), undefined);
  assert.equal(formatLogcatEvent('logcat.filterChanged', { processIds: [3] }), 'Filtro atualizado para PIDs: 3');
  assert.equal(formatLogcatEvent('logcat.filterChanged', { processIds: [] }), 'Aguardando o aplicativo iniciar…');
  assert.equal(formatLogcatEvent('outro', {}), undefined);
});

interface FakeStream { stopped: boolean; end(error?: Error): void; emit(event: string, data: unknown): void }

function harness(hint?: string) {
  const lines: string[] = [];
  const failures: string[] = [];
  const streams: FakeStream[] = [];
  const sink: LogcatSink = {
    clear: () => { lines.length = 0; }, appendLine: line => lines.push(line),
    entry: (level, line) => lines.push(`[${level}] ${line}`), show: () => undefined, hint: () => hint,
  };
  const session = new LogcatSession(async (_params, _serial, listener) => {
    let end!: (error?: Error) => void;
    const done = new Promise<void>((resolve, reject) => { end = error => error ? reject(error) : resolve(); });
    const entry: FakeStream = { stopped: false, end, emit: listener };
    streams.push(entry);
    const stream: BridgeStream = { stop: () => { entry.stopped = true; entry.emit = () => undefined; end(new Error('Operação cancelada.')); }, done };
    return stream;
  }, sink, message => failures.push(message));
  return { session, lines, failures, streams };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('nova sessão substitui a anterior sem reportar o cancelamento da antiga', async () => {
  const { session, lines, failures, streams } = harness();
  await session.start('serial-a', logcatFilter('all'));
  await session.start('serial-b', logcatFilter('all'));
  assert.equal(streams[0].stopped, true);
  streams[1].emit('logcat.entry', { rawLine: 'nova' });
  await tick();
  assert.deepEqual(lines, ['Logcat: serial-b · Todos os processos', '[info] nova']);
  assert.deepEqual(failures, []);
  assert.equal(session.activeSerial, 'serial-b');
});

test('reporta falha da sessão atual e libera o dispositivo', async () => {
  const { session, failures, streams } = harness();
  await session.start('serial-a', logcatFilter('all'));
  streams[0].end(new Error('dispositivo desconectado'));
  await tick();
  assert.deepEqual(failures, ['dispositivo desconectado']);
  assert.equal(session.activeSerial, undefined);
});

test('troca de dispositivo encerra a sessão; o mesmo dispositivo a mantém', async () => {
  const { session, streams } = harness();
  await session.start('serial-a', logcatFilter('all'));
  session.stopIfSerialChanged('serial-a');
  assert.equal(streams[0].stopped, false);
  session.stopIfSerialChanged(undefined);
  assert.equal(streams[0].stopped, true);
  assert.equal(session.activeSerial, undefined);
});

test('mapeia a prioridade do adb-utils para o nível do canal', () => {
  assert.equal(logcatLevel('verbose'), 'trace');
  assert.equal(logcatLevel('DEBUG'), 'debug');
  assert.equal(logcatLevel('info'), 'info');
  assert.equal(logcatLevel('warn'), 'warn');
  assert.equal(logcatLevel('W'), 'warn');
  assert.equal(logcatLevel('error'), 'error');
  assert.equal(logcatLevel('fatal'), 'error');
  assert.equal(logcatLevel('assert'), 'error');
  assert.equal(logcatLevel(null), 'info');
  assert.equal(logcatLevel('silent'), 'info');
  assert.equal(logcatLevel(3), 'info');
});

test('entradas usam o nível da prioridade; a dica aparece após o cabeçalho', async () => {
  const { session, lines, streams } = harness('Nível do canal: Info.');
  await session.start('serial-a', logcatFilter('package', 'com.example.app'));
  streams[0].emit('logcat.started', { processIds: [10] });
  streams[0].emit('logcat.entry', { rawLine: 'E/Tag: falhou', priority: 'error' });
  streams[0].emit('logcat.entry', { rawLine: 'V/Tag: detalhe', priority: 'verbose' });
  assert.deepEqual(lines, [
    'Logcat: serial-a · Aplicativo (ID do pacote)', 'Nível do canal: Info.', 'PIDs filtrados: 10',
    '[error] E/Tag: falhou', '[trace] V/Tag: detalhe',
  ]);
});

test('logcatOnRun decide, pergunta e lembra a resposta', async () => {
  const remembered: LogcatOnRun[] = [];
  const remember = async (value: LogcatOnRun) => { remembered.push(value); };
  const never = async () => { throw new Error('não deveria perguntar'); };
  assert.equal(await shouldOpenLogcatOnRun('always', never, remember), true);
  assert.equal(await shouldOpenLogcatOnRun('never', never, remember), false);
  assert.equal(await shouldOpenLogcatOnRun('ask', async () => 'open', remember), true);
  assert.equal(await shouldOpenLogcatOnRun(undefined, async () => undefined, remember), false);
  assert.deepEqual(remembered, []);
  assert.equal(await shouldOpenLogcatOnRun('ask', async () => 'always', remember), true);
  assert.equal(await shouldOpenLogcatOnRun('ask', async () => 'never', remember), false);
  assert.deepEqual(remembered, ['always', 'never']);
});
