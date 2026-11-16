import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { collect } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';

const anomalyConfig = JSON.parse(await readFile(new URL('../fixtures/anomaly.json', import.meta.url)));

async function session(scenario, run) {
  const directory = await mkdtemp(join(tmpdir(), 'managed-anomaly-'));
  const source = await createSource({ scenario });
  try {
    await run(source, await new Repository(directory).open(), directory);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function managed(source, repository) {
  return collect({ base: source.base, repository, mode: 'managed' });
}

test('cross-file intake links geometry instances, breaks, multi-byte offsets and function ranges', async () => {
  await session('anomaly', async (source, repository) => {
    const result = await managed(source, repository);
    assert.equal(result.complete, false); // 异常资料存在缺引用与冲突，不能宣称完成
    const records = repository.records();
    const head1Dimmer = records.find(r => r.id === 'PixelMode:head-1:dimmer');
    const head2Dimmer = records.find(r => r.id === 'PixelMode:head-2:dimmer');
    assert.deepEqual(head1Dimmer.addresses, [1, 2]);
    assert.deepEqual(head2Dimmer.addresses, [9, 10]);
    assert.equal(head1Dimmer.range.from.bytes, 2); // 16 位端点未退化成 8 位
    assert.equal(head1Dimmer.range.from.max, 65535);
    assert.ok(head1Dimmer.channelSets.some(set => set.from.raw === '32768/2'));
    // 第二个 break 的实例地址独立计算。
    const macro2 = records.find(r => r.id === 'PixelMode:head-2:macro');
    assert.equal(macro2.dmxBreak, 2);
    assert.deepEqual(macro2.addresses, [3]);
    // 功能切换条件随功能一起保留，并能回溯到来源位置。
    const strobeRun = records.find(r => r.functionName === 'strobe-run');
    assert.deepEqual(strobeRun.switching, { modeMaster: 'ControlMode', modeFrom: '1/1' });
    assert.match(strobeRun.provenance.location, /DMXMode\[@Name=PixelMode\]/);
    // 固件清单为解释提供模式证据。
    const interpretations = repository.interpretations();
    const gdtf = Object.values(interpretations).find(i => i.kind === 'gdtf-interpretation');
    assert.deepEqual(gdtf.firmware, { document: 'anomaly-firmware', revision: 'fw-7', describes: 'anomaly-description.xml' });
  });
});

test('missing references and conflicting addresses retain uncertainty instead of picking a winner', async () => {
  await session('anomaly', async (source, repository) => {
    await managed(source, repository);
    const records = repository.records();
    // ExtendedMode 中 Yoke 模板没有实例引用：保留未决，不虚构实例。
    const unresolved = Object.values(repository.interpretations())
      .flatMap(i => i.unresolved ?? []);
    assert.ok(unresolved.some(u => u.channelGeometry === 'Yoke' && u.mode === 'ExtendedMode'));
    assert.ok(!records.some(r => r.instance === 'Yoke'));
    // ghost 引用了不存在的模板，留下带位置的诊断。
    const notes = repository.snapshot().notes;
    assert.ok(notes.some(n => n.code === 'geometry-reference-missing' && n.target === 'MissingTemplate'));
    // 同字节冲突的两条功能都标记为 conflict，范围均保留。
    const conflicts = records.filter(r => r.status === 'conflict');
    const names = new Set(conflicts.map(r => r.functionName));
    assert.ok(names.has('strobe-off'));
    assert.ok(names.has('strobe-run'));
    // head-1 没有 break-2，macro 不能编造地址。
    const macro1 = records.find(r => r.id === 'PixelMode:head-1:macro');
    assert.equal(macro1.status, 'uncertain');
    assert.deepEqual(macro1.addresses, [{ uncertain: true, raw: '1' }]);
    // fog 使用未声明的 break-3，同样保留不确定范围。
    assert.ok(records.filter(r => r.functionName === 'fog').every(r => r.status === 'uncertain'));
  });
});

test('temporary failure keeps confirmed explanations and resumes only the missing document', async () => {
  await session('anomaly', async (source, repository) => {
    await managed(source, repository);
    const before = repository.records().length;
    const evidenceBefore = Object.keys(repository.snapshot().evidence).sort();
    source.state.failDoc = anomalyConfig.documents[0].id; // 描述文件临时 503
    const degraded = await managed(source, repository);
    assert.equal(degraded.complete, false);
    assert.ok(degraded.failures.some(f => f.document === anomalyConfig.documents[0].id));
    // 已确认的关系没有因失败消失。
    assert.equal(repository.records().length, before);
    source.state.failDoc = null;
    const resumed = await managed(source, repository);
    assert.equal(resumed.pending.length, 0);
    assert.deepEqual(Object.keys(repository.snapshot().evidence).sort(), evidenceBefore);
    assert.equal(repository.records().length, before);
  });
});

test('a missing document stays pending and is explained once delivered', async () => {
  await session('anomaly', async (source, repository) => {
    source.state.missingDoc = anomalyConfig.documents[1].id; // 固件清单 404
    const first = await managed(source, repository);
    assert.equal(first.complete, false);
    assert.ok(first.pending.includes('anomaly-firmware'));
    const gdtf = Object.values(repository.interpretations()).find(i => i.kind === 'gdtf-interpretation');
    assert.equal(gdtf.firmware, null); // 缺固件证据时不伪造关联
    source.state.missingDoc = null;
    const second = await managed(source, repository);
    assert.ok(second.pending.length === 0 || !second.pending.includes('anomaly-firmware'));
    const linked = Object.values(repository.interpretations()).find(i => i.kind === 'gdtf-interpretation');
    assert.equal(linked.firmware.revision, 'fw-7');
  });
});

test('firmware revision adds a new mode and keeps the previous address explanation versioned', async () => {
  await session('anomaly', async (source, repository) => {
    await managed(source, repository);
    const before = Object.values(repository.interpretations());
    const oldVersion = before.find(i => i.kind === 'gdtf-interpretation');
    const oldHead2 = oldVersion.capabilities.find(c => c.instance === 'head-2' && c.functionName === 'dimmer');
    assert.deepEqual(oldHead2.addresses, [9, 10]);

    source.state.round = 2; // 固件修订：head-2 偏移 9->13，并新增 StudioMode
    const revised = await managed(source, repository);
    assert.ok(revised.versions.length >= 2);
    const all = Object.values(repository.interpretations());
    // 旧版本解释连同原始证据仍可读。
    const kept = all.find(i => i.versionKey === oldVersion.versionKey);
    assert.ok(kept);
    assert.deepEqual(kept.capabilities.find(c => c.instance === 'head-2' && c.functionName === 'dimmer').addresses, [9, 10]);
    assert.ok(repository.snapshot().evidence[kept.digest]);
    // 当前记录切到新地址，且只重新解释了变化的描述文件。
    const current = repository.records();
    assert.deepEqual(current.find(r => r.id === 'PixelMode:head-2:dimmer').addresses, [13, 14]);
    assert.ok(current.some(r => r.mode === 'StudioMode'));
    assert.ok(!kept.capabilities.some(c => c.mode === 'StudioMode'));
    const requests = source.requests.filter(r => r.path.startsWith('/raw/'));
    // 固件清单内容未变，应通过条件请求走 304 而不是重复下载正文。
    const firmwareRequests = requests.filter(r => r.path === '/raw/anomaly-firmware.json');
    assert.ok(firmwareRequests.length >= 1);
    const unchanged = await fetch(source.base + '/raw/anomaly-firmware.json', {
      headers: { 'if-none-match': repository.indexEntry('anomaly-firmware').etag }
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
  });
});

test('crash between raw retention and interpretation is recovered on restart without fixed answers', async () => {
  await session('anomaly', async (source, repository, directory) => {
    // 直接驱动持久化边界：先取目录并留存原始字节，再模拟进程终止。
    const catalog = await (await fetch(source.base + anomalyConfig.entry)).json();
    const doc = catalog.documents[0];
    const response = await fetch(source.base + doc.href);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = await repository.retain(doc.path, bytes, { etag: response.headers.get('etag'), revision: doc.revision });
    await repository.indexDocument(doc.id, {
      id: doc.id, path: doc.path, format: doc.format, href: doc.href,
      revision: doc.revision, etag: response.headers.get('etag'), digest
    });
    await repository.markPending(doc.id, { stage: 'retained-not-interpreted', digest, path: doc.path });

    // 新进程重开同一存储，待完成工作可被识别并继续。
    const reopened = await new Repository(directory).open();
    assert.deepEqual(Object.keys(reopened.pendingEntries()), [doc.id]);
    await managed(source, reopened);
    assert.deepEqual(reopened.pendingEntries(), {});
    const ids = reopened.records().map(r => r.id);
    assert.ok(ids.includes('PixelMode:head-1:dimmer'));
    assert.ok(ids.includes('PixelMode:head-2:dimmer'));
    // 原始证据与规范化记录没有错位。
    assert.ok(reopened.snapshot().evidence[digest]);
    assert.ok(reopened.records().every(r => r.digest === digest || r.provenance.document !== doc.id));
  });
});

test('reopen and repeated delivery do not inflate identities or lose evidence', async () => {
  await session('anomaly', async (source, repository, directory) => {
    await managed(source, repository);
    const ids = repository.records().map(r => r.id).sort();
    const evidence = Object.keys(repository.snapshot().evidence);
    const reopened = await new Repository(directory).open();
    await managed(source, reopened);
    assert.deepEqual(reopened.records().map(r => r.id).sort(), ids);
    assert.ok(evidence.every(digest => reopened.snapshot().evidence[digest]));
    assert.deepEqual(reopened.pendingEntries(), {});
  });
});
