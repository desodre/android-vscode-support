import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gradleTaskName } from '../gradle/runner';
import {
  caseMethodName, discoverTests, failureLine, gradleTestFilter, parseJUnitXml, readUnitTestResults,
  unitTestResultsDirectory, unitTestSourceRoots,
} from '../testing/unitTests';

test('descobre métodos @Test em Kotlin, inclusive nomes com crases', () => {
  const source = `package io.example

import org.junit.Test

class HelperTest {
    // @Test fun commented() {}
    @Test
    fun simple() { }

    @Test fun \`com espaços\`() { }

    fun helper() { }

    @org.junit.jupiter.api.Test
    internal fun jupiter() { }
}

class NoTests { fun nothing() { } }
`;
  assert.deepEqual(discoverTests(source, '/m/HelperTest.kt'), [{
    name: 'io.example.HelperTest', file: '/m/HelperTest.kt', line: 4,
    methods: [{ name: 'simple', line: 7 }, { name: 'com espaços', line: 9 }, { name: 'jupiter', line: 14 }],
  }]);
});

test('descobre métodos @Test em Java', () => {
  const source = `package io.example;

import org.junit.Test;

public class FreeTest {
    @Test
    public void first() throws Exception { }

    @Test(expected = IllegalStateException.class) public void second() { }

    private int helper() { return 1; }
}
`;
  assert.deepEqual(discoverTests(source, '/m/FreeTest.java')[0].methods,
    [{ name: 'first', line: 6 }, { name: 'second', line: 8 }]);
});

test('source sets de teste seguem a variante', t => {
  const moduleDir = mkdtempSync(join(tmpdir(), 'android-unit-'));
  t.after(() => rmSync(moduleDir, { recursive: true, force: true }));
  for (const dir of ['test/java', 'test/kotlin', 'testFree/java', 'testPaid/java', 'testFreeDebug/kotlin']) {
    mkdirSync(join(moduleDir, 'src', dir), { recursive: true });
  }
  assert.deepEqual(unitTestSourceRoots({ moduleDir, sourceSetNames: ['main', 'free', 'debug', 'freeDebug'] }), [
    join(moduleDir, 'src', 'test', 'java'), join(moduleDir, 'src', 'test', 'kotlin'),
    join(moduleDir, 'src', 'testFree', 'java'), join(moduleDir, 'src', 'testFreeDebug', 'kotlin'),
  ]);
});

test('tarefa e filtros do Gradle são seguros para o shell', () => {
  const selection = { rootPath: '/root', modulePath: ':app', variant: 'freeDebug' };
  assert.equal(gradleTaskName(selection, 'unitTest'), ':app:testFreeDebugUnitTest');
  assert.equal(unitTestResultsDirectory(selection), join('/root', 'app', 'build', 'test-results', 'testFreeDebugUnitTest'));
  assert.equal(gradleTestFilter('io.example.HelperTest'), 'io.example.HelperTest');
  assert.equal(gradleTestFilter('io.example.HelperTest', 'com espaços & "aspas"'), 'io.example.HelperTest.com*espa*os****aspas*');
  assert.equal(gradleTestFilter('io.example.Outer$Inner', 'run'), 'io.example.Outer$Inner.run');
});

// Shape produced by Gradle for a real failing run of the android-editing fixture.
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="io.example.HelperTest" tests="4" skipped="1" failures="1" errors="0">
  <testcase name="simple" classname="io.example.HelperTest" time="0.012"/>
  <testcase name="com espaços" classname="io.example.HelperTest" time="0.5">
    <failure message="java.lang.AssertionError: expected:&lt;1&gt; but was:&lt;2&gt;" type="java.lang.AssertionError">java.lang.AssertionError: expected:&lt;1&gt; but was:&lt;2&gt;
	at org.junit.Assert.fail(Assert.java:89)
	at io.example.HelperTest.com espaços(HelperTest.kt:10)
</failure>
  </testcase>
  <testcase name="ignored" classname="io.example.HelperTest" time="0.0"><skipped/></testcase>
  <testcase name="param[1]" classname="io.example.HelperTest" time="0.001"></testcase>
  <system-out><![CDATA[]]></system-out>
</testsuite>
`;

test('lê resultados JUnit e localiza a falha no stack trace', () => {
  const cases = parseJUnitXml(REPORT);
  assert.deepEqual(cases.map(item => [item.name, item.outcome, item.durationMs]), [
    ['simple', 'passed', 12], ['com espaços', 'failed', 500], ['ignored', 'skipped', 0], ['param[1]', 'passed', 1],
  ]);
  assert.equal(cases[1].message, 'java.lang.AssertionError: expected:<1> but was:<2>');
  assert.equal(failureLine(cases[1].details!, 'io.example.HelperTest'), 9);
  assert.equal(failureLine(cases[1].details!, 'io.example.Other'), undefined);
  assert.equal(caseMethodName('param[1]'), 'param');
  assert.equal(caseMethodName('withArgs(String)'), 'withArgs');
});

test('ignora relatórios antigos quando o build falha antes dos testes', t => {
  const root = mkdtempSync(join(tmpdir(), 'android-results-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selection = { rootPath: root, modulePath: ':app', variant: 'debug' };
  const directory = unitTestResultsDirectory(selection);
  mkdirSync(directory, { recursive: true });
  const report = join(directory, 'TEST-io.example.HelperTest.xml');
  writeFileSync(report, REPORT);
  utimesSync(report, new Date(1_000_000), new Date(1_000_000));
  assert.equal(readUnitTestResults(selection, 5_000_000, false).length, 0);
  assert.equal(readUnitTestResults(selection, 5_000_000, true).length, 4, 'tarefa UP-TO-DATE mantém resultados');
  utimesSync(report, new Date(6_000_000), new Date(6_000_000));
  assert.equal(readUnitTestResults(selection, 5_000_000, false).length, 4, 'falha de teste grava relatório novo');
});
