import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json, request } from './http.mjs';
import { interpretGdtf, interpretManifest } from './gdtf.mjs';

const ENTRY = '/fixture';

// managed 模式：经 HTTP 取得目录与原始字节，输出模式可解释的控制地址与功能依据。
// 采集端只通过 HTTP 观察来源，不读取模拟器内部状态，也不使用固定样本答案。
export async function collectManaged({ base, repository }) {
  const catalog = await json(base, ENTRY);
  const failures = [];
  const promoted = [];

  for (const document of catalog.documents ?? []) {
    const prior = repository.indexEntry(document.id);
    // 新一轮投递开始：上一轮遗留的待办先解除，失败分支会重新登记。
    if (repository.pendingEntries()[document.id]) await repository.clearPending(document.id);
    const response = await fetchDocument(base, repository, document, prior, failures);
    if (!response) continue; // 失败或缺件已留痕并标记待办，保留既有解释
    const { bytes, digest, etag, reused } = response;

    if (!reused) {
      // 先留存原始字节与索引，再进入解释；此边界终止进程后重开仍能续做。
      await repository.indexDocument(document.id, {
        id: document.id, path: document.path, format: document.format,
        href: document.href, revision: document.revision, etag, digest,
        catalogRevision: catalog.revision ?? null
      });
    } else {
      await repository.indexDocument(document.id, {
        ...prior, revision: document.revision, catalogRevision: catalog.revision ?? null
      });
    }

    const versionKey = `${document.id}:${digest}`;
    const existing = repository.interpretation(versionKey);
    if (existing) {
      // 内容未变（304 或相同摘要）：不重复解释，已确认关系不被覆盖。
      promoted.push({ document: document.id, reused: true, interpretation: existing });
      continue;
    }

    await repository.markPending(document.id, {
      stage: 'retained-not-interpreted', digest, path: document.path,
      revision: document.revision, reason: 'raw evidence retained before interpretation commit'
    });

    let interpretation;
    try {
      const meta = { id: document.id, path: document.path, revision: document.revision };
      interpretation = document.format === 'xml'
        ? interpretGdtf(bytes.toString('utf8'), meta)
        : document.format === 'json'
          ? interpretManifest(bytes.toString('utf8'), meta)
          : unsupportedInterpretation(meta);
    } catch (error) {
      await repository.note({
        code: 'interpretation-failed', document: document.id, path: document.path,
        reason: error.message
      });
      failures.push({ document: document.id, reason: error.message });
      continue;
    }

    for (const note of interpretation.notes ?? []) {
      await repository.note(note);
    }
    const entry = {
      ...interpretation,
      versionKey,
      digest,
      etag: etag ?? prior?.etag ?? null,
      sourceRevision: document.revision,
      catalogRevision: catalog.revision ?? null,
      committedAt: new Date().toISOString()
    };
    await repository.saveInterpretation(versionKey, entry);

    if (interpretation.kind === 'gdtf-interpretation') {
      await promoteCapabilities(repository, document, entry);
    }
    await repository.clearPending(document.id);
    promoted.push({ document: document.id, reused: false, interpretation: entry });
  }

  // 目录中消失的文件：保留已确认证据与解释，只把完整性降为未决。
  for (const id of Object.keys(repository.indexEntries())) {
    if (!(catalog.documents ?? []).some(document => document.id === id)) {
      await repository.note({
        code: 'document-withdrawn', document: id,
        reason: 'previously indexed document is absent from the current catalog; retained evidence kept'
      });
      failures.push({ document: id, reason: 'withdrawn from catalog' });
    }
  }

  linkFirmwareEvidence(repository, promoted, catalog);
  const pending = repository.pendingEntries();
  const interpretations = Object.values(repository.interpretations());
  const unresolved = interpretations.flatMap(entry => entry.unresolved ?? []);
  const conflicts = interpretations.flatMap(entry =>
    (entry.capabilities ?? []).filter(capability => capability.status === 'conflict'));
  const unknown = interpretations.flatMap(entry => entry.unknown ?? []);
  const incompleteInterpretation = interpretations.some(entry => entry.status !== 'explained');
  // 取得文件与解释关系两个层次分别核对：目录开放的每个文件都要拿到，
  // 且都有当前摘要对应的解释；历史版本解释不计入数量比较。
  const catalogDocs = catalog.documents ?? [];
  const catalogSize = catalogDocs.length;
  const indexedCatalogDocs = catalogDocs.filter(document => repository.indexEntry(document.id)).length;
  const explainedCatalogDocs = catalogDocs.filter(document => {
    const indexed = repository.indexEntry(document.id);
    return indexed && repository.interpretation(`${document.id}:${indexed.digest}`);
  }).length;
  const complete = failures.length === 0
    && Object.keys(pending).length === 0
    && indexedCatalogDocs === catalogSize
    && explainedCatalogDocs === catalogSize
    && !incompleteInterpretation;

  await repository.cursor('managed', {
    catalogRevision: catalog.revision ?? null,
    documents: (catalog.documents ?? []).map(document => ({ id: document.id, revision: document.revision })),
    complete,
    updatedAt: new Date().toISOString()
  });

  return {
    imported: promoted.length,
    complete,
    mode: 'managed',
    versions: interpretations.map(entry => ({
      versionKey: entry.versionKey, document: entry.documentId,
      sourceRevision: entry.sourceRevision, status: entry.status, digest: entry.digest
    })),
    unresolved,
    conflicts: conflicts.map(capability => ({ id: capability.id, diagnostics: capability.diagnostics })),
    unknown: unknown.length,
    pending: Object.keys(pending),
    failures
  };
}

async function fetchDocument(base, repository, document, prior, failures) {
  const headers = prior?.etag ? { 'if-none-match': prior.etag } : {};
  let response;
  try {
    response = await request(base, document.href, { headers });
  } catch (error) {
    await retainFailure(repository, document, 'request-failed', error.message, failures);
    return null;
  }
  if (response.status === 304 && prior?.digest) {
    const bytes = await readRaw(repository, prior.digest);
    if (bytes === null) {
      await retainFailure(repository, document, 'evidence-missing',
        '304 response but retained raw evidence is unavailable', failures);
      return null;
    }
    return { bytes, digest: prior.digest, etag: prior.etag, reused: true };
  }
  if (!response.ok) {
    await retainFailure(repository, document, `source-status-${response.status}`,
      `document status ${response.status}`, failures);
    return null;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const etag = response.headers.get('etag');
  const digest = await repository.retain(document.path, bytes, {
    etag, revision: document.revision, document: document.id
  });
  return { bytes, digest, etag, reused: false };
}

async function readRaw(repository, digest) {
  try {
    return await readFile(join(repository.directory, 'raw', digest));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function retainFailure(repository, document, code, reason, failures) {
  await repository.note({ code, document: document.id, path: document.path, reason });
  // 已索引文件拉取失败时标记待办；未索引文件同样进入待办，等下次投递补齐。
  const prior = repository.indexEntry(document.id);
  await repository.markPending(document.id, {
    stage: 'awaiting-document',
    digest: prior?.digest ?? null, path: document.path, revision: document.revision, reason
  });
  failures.push({ document: document.id, code, reason });
}

function promoteCapabilities(repository, document, interpretation) {
  // 同一文档的旧当前记录先撤下，但旧版本解释仍保留在 interpretations 中。
  const records = interpretation.capabilities.map(capability => ({
    ...capability,
    digest: interpretation.digest,
    sourceRevision: interpretation.sourceRevision
  }));
  return repository.replaceRecordsForDocument(document.id, records);
}

function linkFirmwareEvidence(repository, promoted, catalog) {
  const manifests = promoted
    .map(item => item.interpretation)
    .filter(entry => entry?.kind === 'firmware-manifest' && entry.describes);
  const catalogOffersManifest = (catalog.documents ?? []).some(document => document.format === 'json');
  let changed = false;
  for (const entry of Object.values(repository.state.interpretations)) {
    if (entry.kind !== 'gdtf-interpretation') continue;
    const manifest = manifests.find(item => item.describes === entry.provenance?.path
      || item.describes === repository.indexEntry(entry.documentId)?.path);
    if (manifest) {
      entry.firmware = { document: manifest.documentId, revision: manifest.revision, describes: manifest.describes };
      changed = true;
    } else if (catalogOffersManifest) {
      // 目录开放了固件清单却无法关联：明确留痕，不把描述当成已由固件确认。
      entry.firmware = null;
      entry.status = entry.status === 'explained' ? 'incomplete' : entry.status;
      changed = true;
    }
  }
  return changed ? repository.save() : undefined;
}

function unsupportedInterpretation(meta) {
  return {
    kind: 'unsupported', documentId: meta.id, capabilities: [], unresolved: [], unknown: [],
    notes: [{ code: 'format-unsupported', document: meta.id, path: meta.path, reason: `format "${meta.format}" has no interpreter` }],
    status: 'incomplete'
  };
}
