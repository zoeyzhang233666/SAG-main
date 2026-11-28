const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const name = 'SAG V1 desktop smoke';
const title = '甲醇供应链测试';
const event = '甲醇制烯烃产业链测试事件';
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
  assert.ok(graph.events.some(item => item.title === event && item.category === '工艺'), 'Imported event category missing from graph');
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
  assert.equal(await evaluate(() => document.querySelector('[data-graph-renderer]')?.dataset.graphRenderer), 'atlas-2d');
  if (mode === 'write') {
    assert.equal(await evaluate(() => document.querySelector('[data-graph-renderer] select')?.value), 'columns',
      'A fresh profile should default to the original columns layout');
  }
  const graphModeButton = label => evaluate(label => {
    const button = Array.from(document.querySelectorAll('[role="group"] button'))
      .find(element => element.textContent.trim() === label);
    if (!button) return false;
    button.click();
    return true;
  }, label);
  const supportsWebGL = await evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(context);
  });
  if (supportsWebGL) {
    assert.ok(await graphModeButton('3D'), 'Could not select 3D');
    await until(() => evaluate(() => Boolean(document.querySelector('[data-graph-3d="ready"] canvas'))),
      '3D graph did not create a WebGL canvas');
    await until(() => evaluate(() => Boolean(document.querySelector(
      '[data-orbital-mode="plates"] .sag-orbital-label [data-event-category]'
    ))), '3D planet did not render imported event categories');
    await until(() => evaluate(() => {
      const count = document.querySelector('.atlas-orbital-legend span:last-child')?.textContent.match(/\d+/)?.[0];
      return Number(count) > 0;
    }), '3D planet should show related nodes on the outer orbit');
    await evaluate(() => document.querySelector('.atlas-orbital-tools button')?.click());
    await until(() => evaluate(() => Boolean(document.querySelector('[data-orbital-mode="nodes"] canvas'))),
      '3D dual-orbit mode did not render');
    assert.ok(await graphModeButton('2D'), 'Could not return to 2D');
    await until(() => evaluate(() => !document.querySelector('[data-graph-3d]')), '3D scene was not released');
    console.log('WebGL2 graph mounted and released');
  }
  await evaluate(() => {
    window.__sagSmokeWebGL2 = Object.getOwnPropertyDescriptor(window, 'WebGL2RenderingContext');
    Object.defineProperty(window, 'WebGL2RenderingContext', { configurable: true, value: undefined });
  });
  assert.ok(await graphModeButton('3D'), 'Could not check 3D fallback');
  await until(() => evaluate(() => Array.from(document.querySelectorAll('[role="status"]'))
    .some(item => /已返回 2D|Returned to 2D/.test(item.textContent))), 'Missing 3D fallback message');
  await evaluate(() => {
    const original = window.__sagSmokeWebGL2;
    if (original) Object.defineProperty(window, 'WebGL2RenderingContext', original);
    else delete window.WebGL2RenderingContext;
    delete window.__sagSmokeWebGL2;
  });
  console.log('WebGL-unavailable fallback passed');
  if (mode !== 'read') {
    const headers = { 'Content-Type': 'application/json' };
    const { session } = await api('/api/mcp/sessions', {
      method: 'POST', headers, body: JSON.stringify({ sourceIds: [project.id], title: 'Exploration smoke' })
    }, 201);
    const ask = (input) => evaluate(async (sessionId, input) => {
      const response = await fetch(`/api/mcp/sessions/${sessionId}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(25000)
      });
      const raw = await response.text();
      const frames = raw.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      if (!frames.some(frame => frame.type === 'done')) throw new Error('MCP ask failed: ' + raw.slice(-1800));
      return frames;
    }, session.id, input);
    const prompt = { content: event, clientTurnId: randomUUID() };
    const first = await ask(prompt);
    const firstEvidence = first.find(frame => frame.type === 'evidence')?.evidence;
    assert.ok(firstEvidence?.eventIds.length, 'First answer did not emit real event evidence');
    const followUp = { content: '它有哪些相关实体？', clientTurnId: randomUUID(),
      anchor: { kind: 'event', id: firstEvidence.eventIds[0] } };
    const second = await ask(followUp);
    assert.ok(second.some(frame => frame.type === 'evidence'), 'Anchor follow-up lost its project evidence');
    await ask({ ...followUp, retry: true });
    const history = await api(`/api/mcp/sessions/${session.id}`);
    assert.equal(history.messages.filter(message => message.role === 'user').length, 2, 'Retry duplicated the user turn');
    assert.equal(history.messages.filter(message => message.role === 'assistant').length, 2, 'Retry duplicated a completed answer');
    const current = await api(`/api/projects/${project.id}/graph?eventIds=${firstEvidence.eventIds.join(',')}`);
    assert.ok(firstEvidence.eventIds.every(id => current.graph.events.some(event => event.id === id)));
  }
  contents.reload();
  await until(() => evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.chem-workspace-tabs button'))
      .find(item => /^(探索|Explore)$/.test(item.textContent.trim()));
    if (!tab || tab.disabled) return false;
    tab.click();
    return true;
  }), 'Could not open exploration');
  await until(() => evaluate(() => Boolean(document.querySelector('[data-explore-workspace] [role="separator"]'))),
    'Exploration resizer did not render');
  await until(() => evaluate(() => {
    const canvas = document.querySelector('[data-explore-workspace] [data-graph-renderer="universe-2d"]');
    const pane = document.querySelector('[data-explore-workspace] .atlas-explore-conversation');
    const label = canvas?.querySelector('.atlas-universe-node [data-event-category]');
    if (!label || !pane || getComputedStyle(pane).colorScheme !== 'dark') return false;
    if (!canvas.querySelector('.atlas-universe-galaxy') || getComputedStyle(label).visibility !== 'visible') return false;
    const bounds = canvas.getBoundingClientRect();
    const box = label.getBoundingClientRect();
    return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
  }), 'Exploration should open with visible event stars and a dark conversation pane');
  const appliedCategory = await evaluate(() => {
    const picker = document.querySelector('[data-explore-workspace] .atlas-universe-category');
    const category = picker?.options[1]?.value;
    if (!category) return null;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(picker, category);
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    return category;
  });
  assert.ok(appliedCategory, 'The star graph has no event categories to filter');
  await until(() => evaluate(category => {
    const labels = Array.from(document.querySelectorAll('[data-explore-workspace] .atlas-universe-node [data-event-category]'));
    return labels.length > 0 && labels.every(label => label.textContent === category);
  }, appliedCategory), 'The star graph did not respect its event category filter');
  if (mode !== 'read') {
    await until(() => evaluate(() => Boolean(document.querySelector('[data-explore-workspace] .chem-answer-artifact svg'))),
      'Exploration did not render the persisted SVG answer');
    await until(() => evaluate(() => Boolean(document.querySelector('[data-explore-workspace] .react-flow__node'))),
      'Exploration did not render the evidence graph');
    await evaluate(() => {
      const citation = document.querySelector('[data-explore-workspace] .chem-answer-artifact button');
      if (!citation) throw new Error('No SVG citation');
      citation.click();
    });
    await until(() => evaluate(() => Boolean(document.querySelector('[data-sag-detail-drawer]'))), 'Citation did not open its source');
    await evaluate(() => Array.from(document.querySelectorAll('[data-sag-detail-drawer] button'))
      .find(button => /^(关闭|Close)$/.test(button.textContent.trim()))?.click());
    await until(() => evaluate(() => !document.querySelector('[data-sag-detail-drawer]')), 'Citation drawer did not close');
  }
  console.log('Exploration workbench, anchored answers and turn deduplication passed');



  await evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.chem-workspace-tabs button'))
      .find(item => /^(产业链图谱|Chain atlas)$/.test(item.textContent.trim()));
    if (!tab) throw new Error('Missing chain atlas tab');
    tab.click();
  });
  await until(() => evaluate(() => {
    const heading = document.querySelector('.chain-atlas-index-heading')?.textContent ?? '';
    return /一次原料|Primary materials/.test(heading);
  }), 'Source tree did not open');
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
    const heading = document.querySelector('.chain-atlas-index-heading')?.textContent ?? '';
    return /行业门类|Industry sectors/.test(heading) &&
      index?.textContent.includes('制造业') &&
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
  await until(() => evaluate(() => {
    const heading = document.querySelector('.chain-atlas-index-heading')?.textContent ?? '';
    return /一次原料|Primary materials/.test(heading);
  }), 'Source tree did not reopen');
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
