// Opt-in evidence for issue #23. Run with the real Kotlin and Java language servers.
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const fixture = __dirname;
const kotlinPath = path.join(fixture, 'app/src/main/java/io/github/desodre/editingfixture/MainActivity.kt');
const javaPath = path.join(fixture, 'app/src/main/java/io/github/desodre/editingfixture/JavaReceiver.java');
const libraryPath = path.join(fixture, 'fixture/src/main/java/io/github/desodre/editinglibrary/SharedNames.java');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const attempt = async (operation, ms = 15000) => {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
      })
    ]);
  } catch (error) {
    return { error: String(error) };
  } finally {
    clearTimeout(timer);
  }
};
const position = (document, needle) => {
  const offset = document.getText().indexOf(needle);
  if (offset < 0) { throw new Error(`Missing marker ${needle} in ${document.uri.fsPath}`); }
  return document.positionAt(offset + Math.floor(needle.length / 2));
};
const locations = entries => Array.isArray(entries) ? entries.map(entry =>
  (entry.targetUri || entry.uri)?.fsPath || String(entry)) : entries;

module.exports.run = async () => {
  const started = Date.now();
  const report = {
    versions: {
      vscode: vscode.version,
      java: vscode.extensions.getExtension('redhat.java')?.packageJSON.version,
      kotlin: vscode.extensions.getExtension('JetBrains.kotlin-server')?.packageJSON.version,
    },
    configuredJavaAndroidSupport: vscode.workspace.getConfiguration('java').get('jdt.ls.androidSupport.enabled'),
    samples: [],
  };
  try {
    const kotlin = await vscode.workspace.openTextDocument(kotlinPath);
    const java = await vscode.workspace.openTextDocument(javaPath);
    const library = await vscode.workspace.openTextDocument(libraryPath);
    report.languages = [kotlin.languageId, java.languageId, library.languageId];
    const javaActivation = await attempt(() => vscode.extensions.getExtension('redhat.java')?.activate(), 30000);
    const kotlinActivation = await attempt(() => vscode.extensions.getExtension('JetBrains.kotlin-server')?.activate(), 30000);
    report.activationErrors = [javaActivation, kotlinActivation]
      .filter(result => result?.error).map(result => result.error);

    // Gradle import is asynchronous. Record both an early and settled sample.
    for (const target of [15000, 90000]) {
      await pause(Math.max(0, target - (Date.now() - started)));
      const sample = { elapsedSeconds: Math.round((Date.now() - started) / 1000) };
      const projects = await attempt(() => vscode.commands.executeCommand('java.project.getAll'), 20000);
      sample.projects = Array.isArray(projects)
        ? projects.map(project => typeof project === 'string' ? project : JSON.stringify(project).slice(0, 300))
        : projects;
      sample.javaSourcePaths = await attempt(() =>
        vscode.commands.executeCommand('java.project.listSourcePaths', java.uri.toString()), 20000);
      sample.kotlinToJava = locations(await attempt(() =>
        vscode.commands.executeCommand('vscode.executeDefinitionProvider', kotlin.uri,
          position(kotlin, 'SharedNames')), 20000));
      sample.javaToKotlin = locations(await attempt(() =>
        vscode.commands.executeCommand('vscode.executeDefinitionProvider', java.uri,
          position(java, 'MainActivity.class')), 20000));
      sample.javaToJava = locations(await attempt(() =>
        vscode.commands.executeCommand('vscode.executeDefinitionProvider', java.uri,
          position(java, 'BroadcastReceiver')), 20000));
      const completions = await attempt(() => vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider', java.uri, position(java, 'BroadcastReceiver')),
      20000);
      sample.javaCompletions = completions?.items?.slice(0, 12).map(item => String(item.label)) || completions;
      const kotlinCompletions = await attempt(() => vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider', kotlin.uri, position(kotlin, 'TextView(this)')),
      20000);
      sample.kotlinCompletions = kotlinCompletions?.items?.slice(0, 12).map(item => String(item.label)) || kotlinCompletions;
      sample.diagnostics = [kotlin, java, library].map(document => ({
        path: path.relative(fixture, document.uri.fsPath),
        items: vscode.languages.getDiagnostics(document.uri).slice(0, 15).map(item => ({
          source: item.source, message: item.message, severity: item.severity,
        })),
      }));
      report.samples.push(sample);
    }
    console.log('ANDROID_LANGUAGE_IMPORT ' + JSON.stringify(report));
  } finally {
    if (process.env.ANDROID_LANGUAGE_RESULT) {
      writeFileSync(process.env.ANDROID_LANGUAGE_RESULT, JSON.stringify(report, null, 2) + '\n');
    }
  }
};
