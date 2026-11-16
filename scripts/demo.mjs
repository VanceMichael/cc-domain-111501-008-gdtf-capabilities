import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { Repository } from '../src/repository.mjs';
import { collect } from '../src/collector.mjs';

const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await createSource({ scenario: 'feature' });
try {
  const repository = await new Repository(directory).open();
  const first = await collect({ base: source.base, repository, mode: 'managed' });
  // 重复投递：内容未变，条件请求应命中 304，身份不膨胀。
  const repeated = await collect({ base: source.base, repository, mode: 'managed' });
  // 固件修订：head-2 偏移变化，只重新解释描述文件并保留旧版地址解释。
  source.state.round = 2;
  const revised = await collect({ base: source.base, repository, mode: 'managed' });
  const snapshot = repository.snapshot();
  const gdtfVersions = Object.values(snapshot.interpretations)
    .filter(entry => entry.kind === 'gdtf-interpretation')
    .map(entry => ({
      versionKey: entry.versionKey,
      sourceRevision: entry.sourceRevision,
      head2Dimmer: entry.capabilities.find(c => c.id === 'PixelMode:head-2:dimmer')?.addresses
    }));
  console.log(JSON.stringify({
    first,
    repeated: { complete: repeated.complete, pending: repeated.pending },
    revised: { complete: revised.complete, versions: revised.versions, failures: revised.failures },
    records: repository.records(),
    gdtfVersions,
    interpretationVersions: Object.keys(snapshot.interpretations),
    evidence: snapshot.evidence,
    requests: source.requests
  }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
