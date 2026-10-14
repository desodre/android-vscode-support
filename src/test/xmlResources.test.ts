import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { androidModuleRoot, codeResourceReferenceAt, indexModuleResources, unresolvedXmlReferences, xmlReferences } from '../xmlResources';

function fixture(t: TestContext): { root: string; write(relative: string, source: string): string } {
  const root = mkdtempSync(join(tmpdir(), 'android-xml-resources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relative, source) {
      const file = join(root, relative);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, source);
      return file;
    }
  };
}

test('encontra recursos em values, diretórios qualificados e XML de layout', t => {
  const project = fixture(t);
  const strings = project.write('src/main/res/values/strings.xml', '<resources><string name="app_name">App</string><item type="color" name="accent">#fff</item></resources>');
  const layout = project.write('src/main/res/layout/main.xml', '<LinearLayout android:id="@+id/root"><TextView android:text="@string/app_name"/></LinearLayout>');
  const icon = project.write('src/debug/res/drawable-hdpi/icon.png', 'fake image bytes');
  const manifest = project.write('src/main/AndroidManifest.xml', '<manifest android:label="@string/app_name" android:icon="@drawable/icon"/>');
  assert.equal(androidModuleRoot(manifest), project.root);
  const index = indexModuleResources(project.root);
  assert.equal(index.get('string/app_name')?.[0].file, strings);
  assert.equal(index.get('color/accent')?.[0].file, strings);
  assert.equal(index.get('layout/main')?.[0].file, layout);
  assert.equal(index.get('drawable/icon')?.[0].file, icon);
  assert.equal(index.get('id/root')?.[0].file, layout);
  assert.deepEqual(unresolvedXmlReferences('<TextView android:layout_below="@id/root" android:text="@string/app_name"/>', index), []);
});

test('marca somente referências locais ausentes na posição original', t => {
  const project = fixture(t);
  project.write('src/main/res/values/strings.xml', '<resources><string name="known">Known</string></resources>');
  const source = '<!-- @string/comment -->\n<TextView android:text="@string/missing" tools:text="@android:string/ok" android:id="@+id/new" />\n<![CDATA[@string/ignored]]>';
  const missing = unresolvedXmlReferences(source, indexModuleResources(project.root));
  assert.equal(missing.length, 1);
  assert.equal(source.slice(missing[0].start, missing[0].end), '@string/missing');
  assert.equal(source.slice(0, missing[0].start).split('\n').length, 2);
  assert.equal(missing[0].name, 'missing');
});

test('reconhece referência de framework e declaração de id separadamente', () => {
  const refs = xmlReferences('android:background="@android:color/white" id="@+id/button" next="@id/button"');
  assert.deepEqual(refs.map(ref => [ref.type, ref.name, ref.declaration]), [['id', 'button', true], ['id', 'button', false]]);
});

test('não procura recursos de outro módulo', t => {
  const project = fixture(t);
  project.write('src/main/res/values/strings.xml', '<resources><string name="there">There</string></resources>');
  assert.equal(unresolvedXmlReferences('@string/there', indexModuleResources(join(project.root, 'other'))).length, 1);
});

test('usa declarações ainda não salvas do documento ativo', t => {
  const project = fixture(t);
  const file = project.write('src/main/res/values/strings.xml', '<resources/>');
  const current = '<resources><string name="new_name">Novo</string><string name="copy">@string/new_name</string></resources>';
  assert.equal(unresolvedXmlReferences(current, indexModuleResources(project.root)).length, 1);
  assert.deepEqual(unresolvedXmlReferences(current, indexModuleResources(project.root, { file, source: current })), []);
});

test('navega de R.string em Kotlin/Java e ignora android.R', t => {
  const project = fixture(t);
  const target = project.write('src/main/res/values/strings.xml', '<resources><string name="title">Título</string></resources>');
  const index = indexModuleResources(project.root);
  const source = 'val label = R.string.title; val system = android.R.string.ok';
  const local = codeResourceReferenceAt(source, source.indexOf('title'));
  assert.equal(local?.type, 'string');
  assert.equal(local?.name, 'title');
  assert.equal(index.get(`${local?.type}/${local?.name}`)?.[0].file, target);
  assert.equal(codeResourceReferenceAt(source, source.indexOf('ok')), undefined);
});

test('filtra recursos de outros flavors quando a variante está selecionada', t => {
  const project = fixture(t);
  project.write('src/main/res/values/common.xml', '<resources><string name="shared">OK</string></resources>');
  project.write('src/free/res/values/strings.xml', '<resources><string name="free_only">Free</string></resources>');
  project.write('src/paid/res/values/strings.xml', '<resources><string name="paid_only">Paid</string></resources>');
  const free = indexModuleResources(project.root, undefined, ['main', 'free', 'debug', 'freeDebug']);
  assert.ok(free.has('string/shared'));
  assert.ok(free.has('string/free_only'));
  assert.equal(free.has('string/paid_only'), false);
});

test('inclui apenas recursos de dependências locais explicitamente resolvidas', t => {
  const project = fixture(t);
  const app = join(project.root, 'app');
  const library = join(project.root, 'library');
  const shared = project.write('library/src/main/res/values/strings.xml', '<resources><string name="shared">Library</string></resources>');
  project.write('unrelated/src/main/res/values/strings.xml', '<resources><string name="unrelated">Other</string></resources>');
  const index = indexModuleResources(app, undefined, undefined, [{ root: library }]);
  assert.equal(index.get('string/shared')?.[0].file, shared);
  assert.equal(index.has('string/unrelated'), false);
  assert.deepEqual(unresolvedXmlReferences('@string/shared', index), []);
  assert.equal(unresolvedXmlReferences('@string/unrelated', index).length, 1);
  assert.equal(indexModuleResources(app).has('string/shared'), false);
});

test('filtra source sets da biblioteca pela variante e evita duplicar o módulo', t => {
  const project = fixture(t);
  const app = join(project.root, 'app');
  const library = join(project.root, 'library');
  project.write('library/src/main/res/values/strings.xml', '<resources><string name="common">Main</string></resources>');
  project.write('library/src/free/res/values/strings.xml', '<resources><string name="free_only">Free</string></resources>');
  project.write('library/src/paid/res/values/strings.xml', '<resources><string name="paid_only">Paid</string></resources>');
  const mainOnly = indexModuleResources(app, undefined, undefined, [{ root: library }]);
  assert.ok(mainOnly.has('string/common'));
  assert.equal(mainOnly.has('string/free_only'), false);
  const free = indexModuleResources(app, undefined, undefined, [
    { root: library, sourceSetNames: ['main', 'free'] },
    { root: library, sourceSetNames: ['main', 'free'] }
  ]);
  assert.ok(free.has('string/free_only'));
  assert.equal(free.has('string/paid_only'), false);
  assert.equal(free.get('string/common')?.length, 1);
});
