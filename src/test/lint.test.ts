import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { formatLintSummary, lintReportFiles, lintReportStamp, parseLintReport, readLintReport } from '../gradle/lint';
import { gradleTaskName } from '../gradle/runner';

// Trimmed from a real `lintFreeDebug` report (AGP 9.0.1), plus synthetic cases.
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<issues format="6" by="lint 9.0.1">
    <issue
        id="OldTargetApi"
        severity="Warning"
        message="Not targeting the latest versions of Android; consult the \`android.os.Build.VERSION_CODES\` javadoc &amp; update."
        category="Correctness"
        url="https://developer.android.com/distribute/best-practices/develop/target-sdk.html"
        errorLine1="        targetSdk = 35"
        errorLine2="        ~~~~~~~~~~~~~~">
        <location
            file="/workspace/app/build.gradle.kts"
            line="12"
            column="9"/>
    </issue>
    <issue id="HardcodedText" severity="Fatal" message="Use &quot;@string&quot;&#xA;resource" category="I18N">
        <location file="src/main/res/layout/screen.xml" line="3" column="5"/>
        <location file="src/main/res/layout/other.xml" line="9" column="1"/>
    </issue>
    <issue id="Typos" severity="Information" message="Possível erro de digitação" category="Messages">
        <location file="src/main/res/values/strings.xml" line="2" column="7"/>
    </issue>
    <issue id="LintBaseline" severity="Ignore" message="ignorado" category="Lint">
        <location file="src/main/AndroidManifest.xml" line="1" column="1"/>
    </issue>
    <issue id="MissingVersion" severity="Error" message="Sem versão" category="Correctness"/>
</issues>
`;

test('converte o relatório XML do lint em problemas localizados', () => {
  const report = parseLintReport(REPORT, '/workspace/app');
  assert.equal(report.issues.length, 3);
  assert.deepEqual(report.issues[0], {
    file: '/workspace/app/build.gradle.kts', line: 12, column: 9, endColumn: 23, severity: 'warning',
    message: 'Not targeting the latest versions of Android; consult the `android.os.Build.VERSION_CODES` javadoc & update.',
    code: 'OldTargetApi', codeUrl: 'https://developer.android.com/distribute/best-practices/develop/target-sdk.html',
    category: 'Correctness',
  });
  assert.deepEqual(report.issues[1], {
    file: resolve('/workspace/app', 'src/main/res/layout/screen.xml'), line: 3, column: 5, severity: 'error',
    message: 'Use "@string"\nresource', code: 'HardcodedText', category: 'I18N',
  });
  assert.equal(report.issues[2].severity, 'information');
  assert.deepEqual(report.unlocated, [{ code: 'MissingVersion', severity: 'error', message: 'Sem versão' }]);
  assert.equal(formatLintSummary(report), 'Lint: 4 problema(s) — 2 erro(s), 1 aviso(s), 1 informação(ões).');
});

test('tarefa e caminhos do relatório seguem módulo e variante', () => {
  const selection = { rootPath: '/root', modulePath: ':feature:login', variant: 'freeDebug' };
  assert.equal(gradleTaskName(selection, 'lint'), ':feature:login:lintFreeDebug');
  assert.deepEqual(lintReportFiles(selection), {
    xml: join('/root', 'feature', 'login', 'build', 'reports', 'lint-results-freeDebug.xml'),
    html: join('/root', 'feature', 'login', 'build', 'reports', 'lint-results-freeDebug.html'),
  });
});

test('só aceita relatório desta execução', t => {
  const root = mkdtempSync(join(tmpdir(), 'android-lint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selection = { rootPath: root, modulePath: ':app', variant: 'debug' };
  const { xml } = lintReportFiles(selection);
  assert.equal(readLintReport(selection, undefined, true), undefined, 'sem arquivo');
  mkdirSync(join(root, 'app', 'build', 'reports'), { recursive: true });
  writeFileSync(xml, REPORT);
  utimesSync(xml, new Date(1_000_000), new Date(1_000_000));
  const before = lintReportStamp(selection);
  assert.equal(readLintReport(selection, before, false), undefined, 'falha sem relatório novo');
  assert.equal(readLintReport(selection, before, true)?.issues.length, 3, 'tarefa atualizada mantém relatório válido');
  utimesSync(xml, new Date(2_000_000), new Date(2_000_000));
  assert.equal(readLintReport(selection, before, false)?.issues.length, 3, 'lint com erros grava relatório e falha');
});
