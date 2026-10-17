// Read-only, opt-in semantic matrix for issue #23. Run with the real language servers.
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const scenario = process.env.ANDROID_LANGUAGE_SCENARIO;
const scenarios = {
  jvm: {
    project: 'android-vscode-jvm-control',
    kotlin: 'src/main/kotlin/io/github/desodre/jvmcontrol/KotlinEntry.kt',
    java: 'src/main/java/io/github/desodre/jvmcontrol/JavaHelper.java',
    kotlinToJava: 'JavaHelper.message', javaToKotlin: 'KotlinEntry.class',
    kotlinClass: 'KotlinEntry', javaClass: 'JavaHelper',
    kotlinCompletion: 'JavaHelper.', kotlinExpected: 'message',
    javaCompletion: 'KotlinEntry.', javaExpected: 'semanticMarker',
  },
  androidSingle: {
    project: 'android-vscode-debug-fixture',
    kotlin: 'app/src/main/java/io/github/desodre/debugfixture/MainActivity.kt',
    java: 'app/src/main/java/io/github/desodre/debugfixture/JavaProbe.java',
    kotlinToJava: 'JavaProbe.doublePlusOne', javaToKotlin: 'MainActivity.class',
    javaToSdk: 'Activity', kotlinClass: 'MainActivity', javaClass: 'JavaProbe',
    kotlinCompletion: 'JavaProbe.', kotlinExpected: 'doublePlusOne',
    javaCompletion: 'MainActivity.', javaExpected: 'semanticMarker',
  },
  androidMixed: {
    project: 'android-vscode-editing-fixture',
    kotlin: 'app/src/main/java/io/github/desodre/editingfixture/MainActivity.kt',
    java: 'app/src/main/java/io/github/desodre/editingfixture/JavaReceiver.java',
    library: 'fixture/src/main/java/io/github/desodre/editinglibrary/SharedNames.java',
    kotlinToJava: 'SharedNames.labelResource', javaToKotlin: 'MainActivity.class',
    javaToSdk: 'BroadcastReceiver', kotlinClass: 'MainActivity', javaClass: 'JavaReceiver',
    kotlinCompletion: 'SharedNames.', kotlinExpected: 'labelResource',
    javaCompletion: 'MainActivity.', javaExpected: 'semanticMarker',
    resource: 'R.string.flavor_label', generated: 'BuildConfig.BUILD_TYPE',
  },
};

const definition = scenarios[scenario];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => value === undefined ? undefined
  : JSON.parse(JSON.stringify(value).replaceAll(root || '', '<workspace>'));
const attempt = async (operation, timeoutMs = 20_000) => {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
    ]);
  } catch (error) { return { error: String(error) }; }
  finally { clearTimeout(timer); }
};
const position = (document, needle) => {
  const offset = document.getText().indexOf(needle);
  if (offset < 0) { throw new Error(`Marcador ausente: ${needle}`); }
  return document.positionAt(offset + Math.floor(needle.length / 2));
};
const positionAfter = (document, needle) => {
  const offset = document.getText().indexOf(needle);
  if (offset < 0) { throw new Error(`Marcador ausente: ${needle}`); }
  return document.positionAt(offset + needle.length);
};
const location = entry => {
  const uri = entry.targetUri || entry.uri;
  const range = entry.targetSelectionRange || entry.range;
  const file = uri?.scheme === 'file' ? path.relative(root, uri.fsPath) : undefined;
  return { scheme: uri?.scheme, file: file && !file.startsWith('..') ? file : undefined,
    external: !file || file.startsWith('..'), line: range?.start?.line };
};
const locations = value => Array.isArray(value) ? value.map(location) : value;
const query = (command, document, needle, ...rest) => attempt(() =>
  vscode.commands.executeCommand(command, document.uri, position(document, needle), ...rest));
const queryAfter = (command, document, needle) => attempt(() =>
  vscode.commands.executeCommand(command, document.uri, positionAfter(document, needle)));
const editSummary = value => value?.entries ? value.entries().map(([uri, edits]) => {
  const relative = path.relative(root, uri.fsPath);
  return { file: relative.startsWith('..') ? undefined : relative,
    external: relative.startsWith('..'), edits: edits.length };
}) : value;
const completionSummary = (value, expected) => {
  if (value?.error) { return value; }
  const items = value?.items || [];
  const label = item => String(item.label?.label || item.label);
  const matches = items.filter(item => label(item).startsWith(expected));
  const methodKinds = [vscode.CompletionItemKind.Method, vscode.CompletionItemKind.Function];
  return { count: items.length, expected, matched: matches.length > 0,
    semanticMatched: matches.some(item => methodKinds.includes(item.kind)),
    matches: matches.slice(0, 4).map(item => ({ label: label(item), kind: item.kind })),
    sample: items.slice(0, 8).map(label) };
};
const containsFile = (entries, relativePath) => Array.isArray(entries)
  && entries.some(entry => entry.file === relativePath);
const hasEntries = entries => Array.isArray(entries) && entries.length > 0;

module.exports.run = async () => {
  if (!root || !definition) { throw new Error('Defina ANDROID_LANGUAGE_SCENARIO: jvm, androidSingle ou androidMixed.'); }
  const report = {
    scenario, project: definition.project,
    versions: { vscode: vscode.version,
      java: vscode.extensions.getExtension('redhat.java')?.packageJSON.version,
      kotlin: vscode.extensions.getExtension('JetBrains.kotlin-server')?.packageJSON.version },
    configuredJavaAndroidSupport: vscode.workspace.getConfiguration('java').get('jdt.ls.androidSupport.enabled'),
    kotlinStartupConfiguration: {
      trace: vscode.workspace.getConfiguration('intellij').get('trace.server'),
      regionConfigured: vscode.workspace.getConfiguration('intellij').inspect('region')?.globalValue !== undefined,
    },
    samples: [],
  };
  const started = Date.now();
  try {
    const missing = ['redhat.java', 'JetBrains.kotlin-server'].filter(id => !vscode.extensions.getExtension(id));
    if (missing.length) {
      report.setupError = `Extensões ausentes no perfil: ${missing.join(', ')}`;
      throw new Error(report.setupError);
    }
    const kotlin = await vscode.workspace.openTextDocument(path.join(root, definition.kotlin));
    const java = await vscode.workspace.openTextDocument(path.join(root, definition.java));
    const library = definition.library
      ? await vscode.workspace.openTextDocument(path.join(root, definition.library)) : undefined;
    report.languages = [kotlin.languageId, java.languageId, library?.languageId].filter(Boolean);
    const extensions = ['redhat.java', 'JetBrains.kotlin-server'];
    report.activation = await Promise.all(extensions.map(async id => {
      const extension = vscode.extensions.getExtension(id);
      const result = await attempt(() => extension?.activate(), 30_000);
      return { id, available: Boolean(extension), active: Boolean(extension?.isActive),
        error: result?.error ? clean(result.error) : undefined };
    }));

    for (const target of [15_000, 90_000]) {
      await pause(Math.max(0, target - (Date.now() - started)));
      const sample = { elapsedSeconds: Math.round((Date.now() - started) / 1000) };
      sample.projects = clean(await attempt(() => vscode.commands.executeCommand('java.project.getAll')));
      sample.javaSourcePaths = clean(await attempt(() =>
        vscode.commands.executeCommand('java.project.listSourcePaths', java.uri.toString())));
      sample.kotlinToJava = locations(await query('vscode.executeDefinitionProvider', kotlin, definition.kotlinToJava));
      sample.javaToKotlin = locations(await query('vscode.executeDefinitionProvider', java, definition.javaToKotlin));
      if (definition.javaToSdk) {
        sample.javaToSdk = locations(await query('vscode.executeDefinitionProvider', java, definition.javaToSdk));
      }
      if (definition.resource) {
        sample.resource = locations(await query('vscode.executeDefinitionProvider', kotlin, definition.resource));
        sample.generated = locations(await query('vscode.executeDefinitionProvider', kotlin, definition.generated));
      }
      sample.kotlinReferences = locations(await query('vscode.executeReferenceProvider', kotlin, definition.kotlinClass));
      sample.javaReferences = locations(await query('vscode.executeReferenceProvider', java, definition.javaClass));
      sample.kotlinRename = editSummary(await query('vscode.executeDocumentRenameProvider', kotlin,
        definition.kotlinClass, 'RenamedKotlinProbe'));
      sample.javaRename = editSummary(await query('vscode.executeDocumentRenameProvider', java,
        definition.javaClass, 'RenamedJavaProbe'));
      sample.kotlinCompletion = completionSummary(await queryAfter('vscode.executeCompletionItemProvider', kotlin,
        definition.kotlinCompletion), definition.kotlinExpected);
      sample.javaCompletion = completionSummary(await queryAfter('vscode.executeCompletionItemProvider', java,
        definition.javaCompletion), definition.javaExpected);
      sample.diagnostics = [kotlin, java, library].filter(Boolean).map(document => ({
        file: path.relative(root, document.uri.fsPath),
        items: vscode.languages.getDiagnostics(document.uri).slice(0, 12).map(item => ({
          source: item.source, message: clean(item.message), severity: item.severity,
        })),
      }));
      sample.semantic = {
        javaProjectsListed: Array.isArray(sample.projects) && sample.projects.length > 0,
        javaSourcesListed: hasEntries(Array.isArray(sample.javaSourcePaths)
          ? sample.javaSourcePaths : sample.javaSourcePaths?.data),
        kotlinToJava: containsFile(sample.kotlinToJava, definition.library || definition.java),
        javaToKotlin: containsFile(sample.javaToKotlin, definition.kotlin),
        javaToSdk: definition.javaToSdk ? hasEntries(sample.javaToSdk) : undefined,
        kotlinReferences: containsFile(sample.kotlinReferences, definition.java),
        javaReferences: containsFile(sample.javaReferences, definition.kotlin),
        kotlinRename: containsFile(sample.kotlinRename, definition.java),
        javaRename: containsFile(sample.javaRename, definition.kotlin),
        kotlinCompletion: sample.kotlinCompletion?.semanticMatched === true,
        javaCompletion: sample.javaCompletion?.semanticMatched === true,
        resource: definition.resource ? hasEntries(sample.resource) : undefined,
        generated: definition.generated ? hasEntries(sample.generated) : undefined,
      };
      report.samples.push(sample);
      if (process.env.ANDROID_LANGUAGE_RESULT) {
        writeFileSync(process.env.ANDROID_LANGUAGE_RESULT, JSON.stringify(report, null, 2) + '\n');
      }
    }
  } finally {
    if (process.env.ANDROID_LANGUAGE_RESULT) {
      writeFileSync(process.env.ANDROID_LANGUAGE_RESULT, JSON.stringify(report, null, 2) + '\n');
    }
  }
};
