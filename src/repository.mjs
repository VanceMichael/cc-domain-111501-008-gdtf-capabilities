import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = { records: {}, cursors: {}, evidence: {}, notes: [], index: {}, interpretations: {}, pending: {} };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      this.state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // 旧存储可能没有结构化接入使用的桶；补齐默认值，不改动既有记录。
    this.state.index ??= {};
    this.state.interpretations ??= {};
    this.state.pending ??= {};
    this.state.notes ??= [];
    this.state.evidence ??= {};
    this.state.records ??= {};
    this.state.cursors ??= {};
    return this;
  }

  async save() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, join(this.directory, 'state.json'));
  }

  async put(record) {
    if (!record.id) throw new Error('record id required');
    this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  async retain(origin, body, metadata = {}) {
    const bytes = Buffer.from(body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'raw', digest), bytes);
    this.state.evidence[digest] = { origin, ...metadata, size: bytes.length };
    await this.save();
    return digest;
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    this.state.notes.push(structuredClone(value));
    await this.save();
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  async indexDocument(id, entry) {
    this.state.index[id] = structuredClone(entry);
    await this.save();
  }

  indexEntry(id) {
    return this.state.index[id] ? structuredClone(this.state.index[id]) : null;
  }

  indexEntries() {
    return structuredClone(this.state.index);
  }

  async markPending(id, value) {
    this.state.pending[id] = structuredClone(value);
    await this.save();
  }

  async clearPending(id) {
    delete this.state.pending[id];
    await this.save();
  }

  pendingEntries() {
    return structuredClone(this.state.pending);
  }

  // 解释结果按“文档 + 内容摘要 + 源修订”版本化保存；固件更新只新增版本，
  // 旧版地址解释连同其原始证据继续可读。
  // 同一文档的新版本解释生效时，撤下该文档旧的当前记录；
  // 旧版本解释仍保留在 interpretations 中可追溯。
  async replaceRecordsForDocument(documentId, records) {
    for (const [id, record] of Object.entries(this.state.records)) {
      if (record.provenance?.document === documentId) delete this.state.records[id];
    }
    for (const record of records) this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  async saveInterpretation(id, entry) {
    this.state.interpretations[id] = structuredClone(entry);
    await this.save();
  }

  interpretation(id) {
    return this.state.interpretations[id] ? structuredClone(this.state.interpretations[id]) : null;
  }

  interpretations() {
    return structuredClone(this.state.interpretations);
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
