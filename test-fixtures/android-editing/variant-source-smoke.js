// Opt-in AGP integration proof for issue #24. Run after compiling the bridge and fixture.
const assert = require('node:assert/strict');
const path = require('node:path');
const { BridgeClient } = require('../../out/bridgeClient');
const { discoverGradleRoot } = require('../../out/projectDiscovery');
const { classifySourceFile, resolveSourceSets } = require('../../out/sourceSets');

(async () => {
  const root = __dirname;
  const bridge = await BridgeClient.start(
    path.join(process.env.JAVA_HOME || '/usr/lib/jvm/java-21-openjdk', 'bin', 'java'),
    path.join(root, '../../bridge/build/install/bridge/lib'), '127.0.0.1', 5037,
    () => undefined,
  );
  try {
    const modules = await discoverGradleRoot(bridge, root);
    const app = modules.find(module => module.path === ':app');
    assert.ok(app, 'app module was not discovered');
    const free = app.variants.find(variant => variant.name === 'freeDebug');
    const paid = app.variants.find(variant => variant.name === 'paidDebug');
    assert.ok(free && paid, 'both flavor variants must be discovered');
    const custom = path.join(root, 'app/custom/free/java');
    assert.ok(free.javaSourceDirs?.includes(custom), 'AGP must report the custom free source directory');
    assert.ok(!paid.javaSourceDirs?.includes(custom), 'paid variant must not include free-only sources');
    const layout = resolveSourceSets(app, free);
    assert.equal(classifySourceFile(path.join(custom, 'io/github/desodre/editingfixture/FreeOnly.java'), layout), 'active');
    const buildConfig = free.javaGeneratedDirs?.find(dir => dir.includes(`${path.sep}buildConfig${path.sep}`));
    assert.ok(buildConfig, 'AGP must report the generated BuildConfig source directory');
    assert.ok(layout.generatedRoots.some(item => item.path === buildConfig && item.exists));
    assert.ok(!paid.javaGeneratedDirs?.includes(buildConfig), 'paid variant must not include free BuildConfig');
    console.log('PASS: AGP reports static and generated source directories per variant');
  } finally {
    bridge.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
