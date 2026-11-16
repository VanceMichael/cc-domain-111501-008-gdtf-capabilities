import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { serve, send } from './runtime.mjs';

async function loadProfile(scenario) {
  if (scenario === 'legacy' || scenario === 'feature') {
    const config = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));
    const raw = Object.fromEntries(await Promise.all(config.documents.map(async document =>
      [document.id, await readFile(new URL('../fixtures/raw/' + document.file, import.meta.url))])));
    return { config, raw, visible: scenario === 'legacy' ? config.documents.slice(0, 1) : config.documents };
  }
  if (scenario === 'anomaly' || scenario === 'anomaly-legacy') {
    const config = JSON.parse(await readFile(new URL('../fixtures/anomaly.json', import.meta.url)));
    const files = [...config.documents, ...(config.round2Raw ? [{ id: '__round2__', file: config.round2Raw }] : [])];
    const raw = Object.fromEntries(await Promise.all(files.map(async document =>
      [document.id, await readFile(new URL('../fixtures/raw/' + document.file, import.meta.url))])));
    return {
      config, raw,
      visible: scenario === 'anomaly-legacy' ? config.documents.slice(0, 1) : config.documents
    };
  }
  throw new Error(`unknown scenario ${scenario}`);
}

export async function createSource({ scenario = 'legacy' } = {}) {
  const profile = await loadProfile(scenario);
  const { config, raw, visible } = profile;
  return serve(async ({ request, response, url, state }) => {
    if (url.pathname === config.entry) return send(response, 200, {
      revision: state.round, transmissionWindow: config.transmissionWindow ?? null,
      documents: visible.map(({ file, ...document }) => ({ ...document,
        revision: document.id === config.changedDocument ? state.round : 1,
        href: '/raw/' + document.path })) });
    const document = visible.find(value => '/raw/' + value.path === decodeURIComponent(url.pathname));
    if (!document) return send(response, 404, { error: 'document unavailable' });
    if (state.failDoc === document.id) return send(response, 503, { error: 'temporarily unavailable' });
    if (state.missingDoc === document.id) return send(response, 404, { error: 'not delivered' });
    let bytes = raw[document.id];
    if (state.round === 2 && document.id === config.changedDocument) {
      if (config.round2Raw) {
        bytes = raw.__round2__;
      } else {
        let content = bytes.toString('utf8').replace(config.replaceFrom, config.replaceTo);
        if (document.format === 'ndjson') content += '\n{"seq":10,"session":"s1","operation":"Commit","arguments":[""],"result":"true","error":"0"}';
        bytes = Buffer.from(content);
      }
    }
    const etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"';
    const headers = { etag, 'content-type': 'application/octet-stream', 'content-length': bytes.length };
    if (request.headers['if-none-match'] === etag) {
      delete headers['content-length'];
      return send(response, 304, '', headers);
    }
    send(response, 200, bytes, headers);
  }, { round: 1, failDoc: null, missingDoc: null });
}
