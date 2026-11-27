const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const name = 'SAG V1 desktop smoke';
const title = '甲醇供应链测试';
const event = '甲醇制烯烃测试事件';
const entity = '乙烯';
const sulfuricAcid = 'Sulphuric acid';
const preference = 'sag-desktop-smoke';
const chunksPerFile = 30;
const entities = [
  { type: '原料', name: '测试甲醇', description: 'MTO 工艺原料' },
  { type: '产品', name: entity, description: 'MTO 工艺产品' },
  { type: '产品', name: sulfuricAcid, description: '无机酸节点别名匹配样例' }
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
      const { job } = fixture === fixtures[0]
        ? await evaluate(async (url, fixture) => {
          const documents = [{
            ...fixture,
            chunks: fixture.chunks.map(({ event, ...chunk }) => ({ ...chunk, events: [event] })),
            eventsWithoutChunk: []
          }];
          // The V2 envelope also crosses the legacy Fastify 64 MiB request limit.
          const body = new Blob([
            '\uFEFF',
            ...Array(65).fill(' '.repeat(1024 ** 2)),
            JSON.stringify({ schemaVersion: 1, project: { name: 'V2 export' }, documents })
          ], { type: 'application/octet-stream' });
          const response = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(90000) });
          if (response.status !== 202) throw new Error('Large V2 import: ' + response.status + ' ' + await response.text());
          return response.json();
        }, '/api/documents/import-structured/file/jobs?' + params, fixture)
        : await api('/api/documents/import-structured/file/jobs?' + params, {
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
    contents.reload();
    await until(() => evaluate(() => {
      const tab = Array.from(document.querySelectorAll('.chem-workspace-tabs button'))
        .find(item => /^(知识资产|Assets)$/.test(item.textContent.trim()));
      if (!tab || tab.disabled) return false;
      tab.click();
      return true;
    }), 'Could not open the knowledge assets tab');
    await until(() => evaluate(title => {
      const row = Array.from(document.querySelectorAll('.chem-assets-rail button'))
        .find(item => item.textContent.includes(title));
      if (!row) return false;
      row.click();
      return true;
    }, imported[0].title), 'The large package document was not visible in the asset list');
    await until(() => evaluate(() => {
      const button = Array.from(document.querySelectorAll('.chem-assets-rail button'))
        .find(item => /^(重命名|Rename)$/.test(item.textContent.trim()));
      if (!button) return false;
      button.click();
      return true;
    }), 'Could not invoke document rename');
    imported[0].title += '（已重命名）';
    await until(() => evaluate(title => {
      const input = document.querySelector('dialog[open] #rename-document-input');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, imported[0].title), 'The renderer did not open the rename dialog');
    await evaluate(() => document.querySelector('dialog[open] button[type=submit]').click());
    await until(() => evaluate(title => !document.querySelector('dialog[open]') &&
      document.querySelector('.chem-assets-rail')?.textContent.includes(title), imported[0].title),
    'The updated title was not shown in the knowledge assets');
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

  await evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.chem-workspace-tabs button'))
      .find(item => /^(产业链图谱|Chain atlas)$/.test(item.textContent.trim()));
    if (!tab) throw new Error('Missing chain atlas tab');
    tab.click();
  });
  await until(() => evaluate(() => document.querySelector('.chain-atlas-index-heading')?.textContent.includes('v2.1')),
    'Source tree did not open');
  assert.equal(await evaluate(() => document.querySelectorAll('.chain-atlas-tree [aria-expanded="true"]').length), 0,
    'Source tree should start with every branch collapsed');
  await evaluate(() => {
    const row = document.querySelector('.chain-atlas-tree .chain-atlas-row-main');
    row.querySelector('.chain-atlas-branch-count').click();
  });
  await until(() => evaluate(() => {
    const row = document.querySelector('.chain-atlas-tree .chain-atlas-row-main');
    return row?.getAttribute('aria-expanded') === 'true' &&
      Boolean(row.closest('li').querySelector('.chain-atlas-children'));
  }), 'Clicking the far end of an atlas row did not expand it');
  const treeAction = label => evaluate(label => {
    const button = Array.from(document.querySelectorAll('.chain-atlas-section-actions button'))
      .find(item => item.textContent.trim() === label);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, label);
  const atlasText = (chinese, english) => evaluate((chinese, english) =>
    Array.from(document.querySelectorAll('.chain-atlas-section-actions button'))
      .some(button => button.textContent.trim() === chinese) ? chinese : english,
  chinese, english);
  const closeTree = await atlasText('全部收起', 'Collapse all');
  await until(() => treeAction(closeTree), 'Source tree collapse action was unavailable');
  await evaluate(() => {
    document.querySelectorAll('.chain-atlas-tabs button')[1].click();
  });
  await until(() => evaluate(() => {
    const index = document.querySelector('.chain-atlas-index');
    return index?.textContent.includes('v3.0') && index.textContent.includes('制造业') &&
      !index.textContent.includes('原油及石油产品');
  }), 'Applications tree did not switch independently');
  assert.equal(await evaluate(() => document.querySelectorAll('.chain-atlas-tree [aria-expanded="true"]').length), 0,
    'Applications tree should start with every branch collapsed');
  const expandTree = await atlasText('全部展开', 'Expand all');
  await until(() => treeAction(expandTree), 'Applications tree expand action was unavailable');
  await until(() => evaluate(() => {
    const tree = document.querySelector('.chain-atlas-tree');
    return tree?.querySelectorAll('.chain-atlas-row-main[aria-expanded="true"]').length > 950 &&
      tree.textContent.includes('氧化铁脱硫介质') && tree.textContent.includes('苯并三氮唑');
  }), 'Expanding the whole track did not open deep application branches');
  assert.equal(await evaluate(() => document.querySelectorAll('.chain-atlas a[href], .chain-atlas-note, .chain-atlas-unmatched').length), 0,
    'Atlas should not display external links, explanatory notes, or unmatched notices');
  await until(() => treeAction(closeTree), 'Applications tree collapse action was unavailable');
  await until(() => evaluate(() => document.querySelectorAll('.chain-atlas-tree .chain-atlas-row-main[aria-expanded="true"]').length === 0),
    'Collapse all did not reset the applications track');
  const enterAtlasSearch = query => evaluate(query => {
    const input = document.querySelector('.chain-atlas-search input');
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, query);
  await until(() => enterAtlasSearch('A-45-4520'), 'Applications search was unavailable');
  await until(() => evaluate(() => {
    const row = document.querySelector('.chain-atlas-results .chain-atlas-row-main');
    if (!row?.textContent.includes('生物质燃气生产和供应业')) return false;
    row.click();
    return true;
  }), 'Could not locate a new unmatched application branch');
  await until(() => evaluate(() => {
    const row = document.querySelector('.chain-atlas-row[data-focused="true"]');
    const primary = row?.querySelector('.chain-atlas-row-main');
    if (!primary || row.querySelector('.chain-atlas-match')) return false;
    primary.click();
    return true;
  }), 'Unmatched application row could not expand');
  assert.equal(await evaluate(() => document.querySelectorAll('[data-sag-detail-drawer], .chain-atlas-unmatched').length), 0,
    'Expanding an unmatched row must not open a details drawer');
  await until(() => enterAtlasSearch('A-26-2611-01'), 'Sulfuric acid search was unavailable');
  await until(() => evaluate(() => {
    const match = document.querySelector('.chain-atlas-results .chain-atlas-match');
    if (!match) return false;
    match.click();
    return true;
  }), 'The sulfuric acid classification did not match its library entity');
  await until(() => evaluate(name => {
    if (document.querySelector('[data-sag-detail-drawer] h2')?.textContent.trim() === name) return true;
    // An upgraded profile may also contain the original Chinese fixture entity.
    const choice = Array.from(document.querySelectorAll('.chain-atlas-results .chain-atlas-matches button'))
      .find(item => item.querySelector('strong')?.textContent.trim() === name);
    choice?.click();
    return false;
  }, sulfuricAcid), 'The standard name did not resolve the imported English alias');
  await evaluate(() => document.querySelector('[data-sag-detail-drawer] button')?.click());
  await evaluate(() => document.querySelectorAll('.chain-atlas-tabs button')[0].click());
  await until(() => evaluate(() => document.querySelector('.chain-atlas-index-heading')?.textContent.includes('v2.1')),
    'Source tree did not reopen');
  await until(() => enterAtlasSearch('74-85-1'), 'Source search was unavailable');
  await until(() => evaluate(() => {
    const row = Array.from(document.querySelectorAll('.chain-atlas-results .chain-atlas-row'))
      .find(item => item.querySelector('.chain-atlas-node-label')?.textContent === '乙烯' &&
        item.textContent.includes('CAS 74-85-1'));
    const locate = row?.querySelector('.chain-atlas-row-main');
    if (!locate) return false;
    locate.click();
    return true;
  }), 'Atlas search result did not locate the node in its branch');
  await until(() => evaluate(() => {
    const row = document.querySelector('.chain-atlas-row[data-focused="true"]');
    const primary = row?.querySelector('.chain-atlas-row-main');
    if (!primary || !row.querySelector('.chain-atlas-match')) return false;
    primary.querySelector('.chain-atlas-branch-count').click();
    return true;
  }), 'A matching entity blocked expansion from the rest of the row');
  assert.equal(await evaluate(() => !!document.querySelector('[data-sag-detail-drawer]')), false,
    'Row expansion opened a drawer instead of expanding');
  await until(() => evaluate(() => {
    const match = document.querySelector('.chain-atlas-row[data-focused="true"] .chain-atlas-match');
    if (!match) return false;
    match.click();
    return true;
  }), 'No library entity matched the atlas node');
  await until(() => evaluate(entity =>
    document.querySelector('[data-sag-detail-drawer] h2')?.textContent.trim() === entity,
    entity), 'Atlas entity did not open the library detail drawer');
  assert.equal(await evaluate(() =>
    document.querySelector('.chain-atlas-row[data-focused="true"] .chain-atlas-row-main')?.getAttribute('aria-expanded')), 'true',
    'Opening an entity changed the branch expansion state');

  if (mode !== 'read') fs.writeFileSync(baseline, JSON.stringify({ projectId: project.id, imported }));
  fs.writeFileSync(path.join(profile, `smoke-${mode}.ok`), origin + '\n');
}

module.exports = { smoke };
