// Opt-in physical proof for device selection, app actions, and Logcat.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const repo = path.resolve(__dirname, '../..');
const applicationId = 'io.github.desodre.debugfixture';
const artifactPath = path.join(__dirname, 'app/build/outputs/apk/debug/app-debug.apk');
const bridgeLib = path.join(repo, 'bridge/build/install/bridge/lib');
const adb = process.env.ANDROID_ADB || 'adb';
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/java') : 'java';
const runFile = promisify(execFile);
const { BridgeClient } = require(path.join(repo, 'out/bridgeClient.js'));
const { DeviceSelectionStore } = require(path.join(repo, 'out/deviceSelection.js'));
const { findBuiltArtifacts } = require(path.join(repo, 'out/gradle/artifacts.js'));
const { installApk, launcherActivities, launchApp, stopApp } = require(path.join(repo, 'out/appRunner.js'));

function events() {
  const items = [];
  const waiters = new Set();
  return {
    get length() { return items.length; },
    push(event, data) {
      items.push({ event, data });
      for (const waiter of waiters) { waiter(); }
    },
    async waitFor(predicate, from = 0, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const found = items.slice(from).find(item => predicate(item.event, item.data));
        if (found) { return found.data; }
        const remaining = deadline - Date.now();
        if (remaining <= 0) { throw new Error('Tempo esgotado aguardando evento do dispositivo.'); }
        await new Promise((resolve, reject) => {
          const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
          const timer = setTimeout(() => { waiters.delete(wake); reject(new Error('Tempo esgotado aguardando evento do dispositivo.')); }, remaining);
          waiters.add(wake);
        });
      }
    },
  };
}

async function adbCommand(serial, ...args) {
  return runFile(adb, ['-s', serial, ...args], { timeout: 30_000 });
}

async function pidOf(serial) {
  try {
    const { stdout } = await adbCommand(serial, 'shell', 'pidof', applicationId);
    return Number(stdout.trim().split(/\s+/)[0]) || undefined;
  } catch { return undefined; }
}

async function waitForPid(serial, expected) {
  for (let i = 0; i < 30; i++) {
    const pid = await pidOf(serial);
    if (expected(pid)) { return pid; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('O PID do aplicativo não atingiu o estado esperado.');
}

async function emitMarker(serial, suffix) {
  const marker = `stage3-${suffix}-${Date.now()}`;
  await adbCommand(serial, 'shell', 'am', 'broadcast', '-n', `${applicationId}/.Stage3ProbeReceiver`, '--es', 'marker', marker);
  return marker;
}

async function stopStream(stream) {
  if (!stream) { return; }
  stream.stop();
  await assert.rejects(stream.done, /cancelada|cancelled/i);
}

async function run() {
  const serial = process.env.ANDROID_SERIAL;
  assert.ok(serial, 'Defina ANDROID_SERIAL para executar a prova física.');
  assert.ok(existsSync(artifactPath), 'Compile o APK debug da fixture antes da prova.');
  assert.ok(existsSync(bridgeLib), 'Compile a distribuição da ponte Kotlin antes da prova.');
  const client = await BridgeClient.start(java, bridgeLib, '127.0.0.1', 5037, () => {});
  let tracking;
  let packageLogcat;
  let pidLogcat;
  let passed = false;
  const failures = [];
  try {
    const devices = await client.request('devices.list');
    const selected = devices.find(device => device.serial === serial);
    assert.equal(selected?.state, 'device', 'O dispositivo escolhido precisa estar online.');

    const stored = new Map();
    const selection = new DeviceSelectionStore({
      get: key => stored.get(key),
      update: async (key, value) => { stored.set(key, value); },
    });
    await selection.updateDevices(devices);
    assert.equal(selection.selectedSerial, undefined, 'Não deve haver escolha automática de serial.');
    await selection.select(serial);
    assert.equal(selection.selectedSerial, serial);
    const tracked = events();
    tracking = client.startStream('devices.track', {}, undefined, (event, data) => tracked.push(event, data));
    const snapshot = await tracked.waitFor(event => event === 'devices.changed');
    assert.ok(snapshot.some(device => device.serial === serial && device.state === 'device'));
    await stopStream(tracking);
    tracking = undefined;
    assert.equal((await client.request('devices.list')).find(device => device.serial === serial)?.state, 'device');

    const target = { rootPath: __dirname, modulePath: ':app', variant: 'debug', applicationId };
    const artifacts = findBuiltArtifacts(target, applicationId);
    const apk = artifacts.find(artifact => artifact.type === 'APK' && artifact.file === artifactPath);
    assert.ok(apk, 'Metadados da variante debug não apontam para o APK da fixture.');
    assert.equal(await installApk(client, serial, apk, target), applicationId);
    const activities = await launcherActivities(client, serial, applicationId);
    assert.ok(activities.includes(`${applicationId}/.MainActivity`), 'Activity inicial não encontrada.');
    await stopApp(client, serial, applicationId);
    await launchApp(client, serial, applicationId, activities[0]);
    const firstPid = await waitForPid(serial, pid => Number.isInteger(pid) && pid > 0);

    const packageEvents = events();
    packageLogcat = client.startStream('logcat.stream', { packageName: applicationId }, serial,
      (event, data) => packageEvents.push(event, data));
    const started = await packageEvents.waitFor(event => event === 'logcat.started');
    assert.ok(started.processIds.includes(firstPid), 'O filtro por pacote não incluiu o PID do app.');
    const packageMarker = await emitMarker(serial, 'package');
    const packageEntry = await packageEvents.waitFor((event, data) => event === 'logcat.entry' && data.message?.includes(packageMarker));
    assert.equal(packageEntry.processId, firstPid);

    const beforeStop = packageEvents.length;
    await stopApp(client, serial, applicationId);
    await waitForPid(serial, pid => pid === undefined);
    await packageEvents.waitFor((event, data) => event === 'logcat.filterChanged' && data.processIds.length === 0, beforeStop);
    const beforeRestart = packageEvents.length;
    await launchApp(client, serial, applicationId, activities[0]);
    const secondPid = await waitForPid(serial, pid => Number.isInteger(pid) && pid > 0);
    await packageEvents.waitFor((event, data) => event === 'logcat.filterChanged' && data.processIds.includes(secondPid), beforeRestart);
    const restartMarker = await emitMarker(serial, 'restart');
    await packageEvents.waitFor((event, data) => event === 'logcat.entry' && data.message?.includes(restartMarker));
    await stopStream(packageLogcat);
    packageLogcat = undefined;

    const pidEvents = events();
    pidLogcat = client.startStream('logcat.stream', { processId: secondPid }, serial,
      (event, data) => pidEvents.push(event, data));
    const pidStarted = await pidEvents.waitFor(event => event === 'logcat.started');
    assert.deepEqual(pidStarted.processIds, [secondPid]);
    const pidMarker = await emitMarker(serial, 'pid');
    const pidEntry = await pidEvents.waitFor((event, data) => event === 'logcat.entry' && data.message?.includes(pidMarker));
    assert.equal(pidEntry.processId, secondPid);
    await stopStream(pidLogcat);
    pidLogcat = undefined;
    assert.equal((await client.request('devices.list')).find(device => device.serial === serial)?.state, 'device');
    passed = true;
  } catch (error) { failures.push(error); }
  finally {
    for (const stream of [tracking, packageLogcat, pidLogcat]) {
      try { await stopStream(stream); } catch (error) { failures.push(error); }
    }
    try { await stopApp(client, serial, applicationId); } catch (error) { failures.push(error); }
    client.dispose();
  }
  if (failures.length) { throw new Error(failures.map(error => error.message ?? String(error)).join('; ')); }
  if (passed) { console.log('PASS physical stage 3: seleção explícita, rastreamento, instalação, início/parada, filtros de logcat e cancelamento.'); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
