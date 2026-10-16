import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sleep } from '../util/abort';

let trusted = true;
let cancel: (() => void) | undefined;
let progressOptions: { title?: string; cancellable?: boolean } | undefined;
const vscodeStub = {
  ProgressLocation: { Notification: 15 },
  workspace: { get isTrusted() { return trusted; } },
  window: {
    withProgress: (options: { title?: string; cancellable?: boolean },
      task: (progress: unknown, token: { onCancellationRequested(listener: () => void): { dispose(): void } }) => Promise<unknown>) => {
      progressOptions = options;
      return task({}, {
        onCancellationRequested: listener => { cancel = listener; return { dispose: () => { cancel = undefined; } }; },
      });
    },
  },
};

const runtimeModule = require('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = runtimeModule._load;
let helpers: typeof import('../ui/vscodeHelpers');
try {
  runtimeModule._load = (request, parent, isMain) => request === 'vscode'
    ? vscodeStub : originalLoad.call(runtimeModule, request, parent, isMain);
  helpers = require('../ui/vscodeHelpers') as typeof import('../ui/vscodeHelpers');
} finally {
  runtimeModule._load = originalLoad;
}

test('sleep resolve após o prazo e remove o listener de cancelamento', async () => {
  const controller = new AbortController();
  let listeners = 0;
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<typeof add>) => { listeners++; add(...args); }) as typeof add;
  signal.removeEventListener = ((...args: Parameters<typeof remove>) => { listeners--; remove(...args); }) as typeof remove;
  await sleep(1, signal, 'cancelado');
  assert.equal(listeners, 0);
});

test('sleep rejeita com a mensagem do chamador antes e durante a espera', async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(sleep(10, aborted.signal, 'antes'), /^Error: antes$/);
  const controller = new AbortController();
  const waiting = sleep(10_000, controller.signal, 'durante');
  controller.abort();
  await assert.rejects(waiting, /^Error: durante$/);
});

test('withCancellableProgress aborta o sinal quando a notificação é cancelada', async () => {
  let received: AbortSignal | undefined;
  const result = helpers.withCancellableProgress('Android: teste', async signal => {
    received = signal;
    cancel?.();
    return signal.aborted;
  });
  assert.equal(await result, true);
  assert.equal(received?.aborted, true);
  assert.deepEqual(progressOptions, { location: 15, title: 'Android: teste', cancellable: true });
  assert.equal(cancel, undefined, 'a inscrição no token é descartada ao terminar');
});

test('requireTrust bloqueia ações em pasta não confiável', () => {
  trusted = false;
  assert.throws(() => helpers.requireTrust('iniciar um emulador'),
    /^Error: Confie na pasta de trabalho antes de iniciar um emulador\.$/);
  trusted = true;
  assert.doesNotThrow(() => helpers.requireTrust('iniciar um emulador'));
});
