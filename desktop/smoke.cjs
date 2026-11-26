const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const name = 'SAG V1 desktop smoke';
const title = '甲醇供应链测试';
const event = '甲醇制烯烃测试事件';
const entity = '测试乙烯';
const preference = 'sag-desktop-smoke';
const chunksPerFile = 30;
const entities = [
  { type: '原料', name: '测试甲醇', description: 'MTO 工艺原料' },
  { type: '产品', name: entity, description: 'MTO 工艺产品' }
];
// More than one batch per document, with overlapping entities in different orders.
const fixtures = Array.from({ length: 3 }, (_, fileIndex) => ({
  title: `${title} ${fileIndex + 1}`,
  chunks: Array.from({ length: chunksPerFile }, (_, chunkIndex) => ({
    key: String(chunkIndex + 1),
    heading: `甲醇工艺 ${chunkIndex + 1}`,
    content: '甲醇通过 MTO 工艺生产乙烯和丙烯。',
    event: {
      title: event,
      content: '甲醇通过 MTO 工艺生产乙烯和丙烯。',
      keywords: ['甲醇', 'MTO'],
      entities: fileIndex % 2 ? [...entities].reverse() : entities
    }
  }))
}));

async function until(predicate, message) {
  for (let i = 0; i < 120; i++) {
    const result = await predicate();
    if (result) return result;
    await delay(250);
  }
  throw new Error(message);
}

async function smoke(contents, origin, profile, mode) {
  const unauthenticated = await fetch(origin + '/api/projects', { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthenticated.status, 401, 'Direct HTTP must require a desktop token');

  const evaluate = (fn, ...args) => contents.executeJavaScript(
    `(${fn})(${args.map(arg => JSON.stringify(arg)).join(',')})`
  );
  const api = (url, options = null, status = 200) => evaluate(async (url, options, status) => {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
    if (response.status !== status) throw new Error(`${url}: ${response.status} ${await response.text()}`);
    return response.json();
  }, url, options, status);

  await until(() => evaluate(() => document.querySelector('#root')?.childElementCount), 'V1 frontend did not mount');
  const baseline = path.join(profile, 'smoke-records.json');
  const { projects } = await api('/api/projects');
  let project = projects.find(item => item.name === name);
  let imported;

  if (mode === 'read') {
    const records = JSON.parse(fs.readFileSync(baseline, 'utf8'));
    assert.equal(project?.id, records.projectId, 'Project ID changed across restart');
    assert.equal(await evaluate(key => localStorage.getItem(key), preference), 'saved', 'Browser storage was lost');
    imported = records.imported;
  } else {
    if (mode === 'upgrade') {
      assert.ok(project, 'The older installation project did not survive the upgrade');
    } else {
      assert.equal(projects.length, 0, 'New installation database was not empty');
      ({ project } = await api('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      }, 201));
    }

    imported = await Promise.all(fixtures.map(async fixture => {
      const params = new URLSearchParams({ sourceId: project.id, fileName: fixture.title + '.json', format: 'json' });
      const { job } = await api('/api/documents/import-structured/file/jobs?' + params, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(fixture)
      }, 202);
      const completed = await until(async () => {
        const { job: current } = await api('/api/documents/import-structured/jobs/' + job.id);
        if (current.status === 'FAILED') throw new Error(fixture.title + ': ' + current.error);
        return current.status === 'COMPLETED' && current;
      }, fixture.title + ' import timed out');
      assert.ok(completed.documentId, 'Import did not return a document ID');
      assert.equal(completed.chunkCount, chunksPerFile, 'Chunks missing from imported document');
      assert.equal(completed.eventCount, chunksPerFile, 'Events missing from imported document');
      return { id: completed.documentId, title: fixture.title };
    }));
    await evaluate(key => localStorage.setItem(key, 'saved'), preference);
  }

  const { documents } = await api(`/api/projects/${project.id}/documents`);
  assert.equal(imported.length, fixtures.length);
  for (const doc of imported) {
    assert.ok(documents.some(item => item.id === doc.id && item.title === doc.title), 'Imported document missing: ' + doc.title);
  }
  const { graph } = await api(`/api/projects/${project.id}/graph`);
  assert.ok(graph.events.some(item => item.title === event), 'Imported event missing from graph');
  assert.ok(graph.entities.some(item => item.name === entity), 'Imported entity missing from graph');
  assert.ok(graph.edges.length, 'Imported relationships missing from graph');

  contents.reload();
  await until(() => evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.chem-workspace-tabs button'))
      .find(item => /^(知识超图|Hypergraph)$/.test(item.textContent.trim()));
    if (!tab || tab.disabled) return false;
    tab.click();
    return true;
  }), 'Could not open V1 Hypergraph tab');
  await until(() => evaluate(event => {
    return Array.from(document.querySelectorAll('.react-flow__node'))
      .some(node => node.textContent.includes(event) && node.getBoundingClientRect().width > 0);
  }, event), 'V1 Hypergraph did not render the imported event');

  if (mode !== 'read') fs.writeFileSync(baseline, JSON.stringify({ projectId: project.id, imported }));
  fs.writeFileSync(path.join(profile, `smoke-${mode}.ok`), origin + '\n');
}

module.exports = { smoke };
