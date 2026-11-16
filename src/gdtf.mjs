// GDTF 1.2 profile 解释器（本项目只实现 protocol.md 声明使用到的节点）。
// 输入为已经由来源网关展开的 XML 文本；不接触 ZIP、不渲染、不向设备发指令。
// 输出是模式可解释的控制地址与功能依据，以及缺引用/冲突/未决的留痕。

const KNOWN = {
  GDTF: ['DataVersion'],
  FixtureType: ['Name'],
  Geometries: [],
  Geometry: ['Name'],
  GeometryReference: ['Name', 'Geometry'],
  Break: ['DMXBreak', 'DMXOffset'],
  DMXModes: [],
  DMXMode: ['Name', 'Geometry'],
  DMXChannels: [],
  DMXChannel: ['DMXBreak', 'Offset', 'Geometry'],
  LogicalChannel: ['Attribute'],
  ChannelFunction: ['Name', 'Attribute', 'DMXFrom', 'PhysicalFrom', 'PhysicalTo', 'ModeMaster', 'ModeFrom'],
  ChannelSet: ['Name', 'DMXFrom', 'PhysicalFrom', 'PhysicalTo']
};

const GEOMETRY_TAGS = new Set(['Geometry', 'GeometryReference']);

export function parseXml(raw) {
  const text = String(raw);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('external definitions not supported');
  const document = { tag: '#root', attributes: {}, children: [], text: '' };
  const stack = [document];
  let cursor = 0;
  const length = text.length;
  while (cursor < length) {
    const open = text.indexOf('<', cursor);
    if (open === -1) {
      appendText(stack[stack.length - 1], text.slice(cursor));
      break;
    }
    appendText(stack[stack.length - 1], text.slice(cursor, open));
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close === -1) throw new Error('unterminated comment');
      cursor = close + 3;
      continue;
    }
    if (text[open + 1] === '?') {
      const close = text.indexOf('?>', open + 2);
      if (close === -1) throw new Error('unterminated declaration');
      cursor = close + 2;
      continue;
    }
    const close = text.indexOf('>', open);
    if (close === -1) throw new Error('unterminated element');
    const head = text.slice(open + 1, close);
    cursor = close + 1;
    if (head.startsWith('/')) {
      const name = head.slice(1).trim();
      if (stack.length <= 1 || stack[stack.length - 1].tag !== name) {
        throw new Error(`unmatched closing tag ${name}`);
      }
      stack.pop();
      continue;
    }
    const selfClosing = head.endsWith('/');
    const body = selfClosing ? head.slice(0, -1) : head;
    const node = elementFrom(body, open);
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`unclosed element ${stack[stack.length - 1].tag}`);
  return document;
}

function elementFrom(body, position) {
  const match = body.match(/^([\w:.-]+)([\s\S]*)$/);
  if (!match) throw new Error(`malformed element at ${position}`);
  const node = { tag: match[1], attributes: {}, children: [], text: '' };
  const attributeText = match[2];
  for (const found of attributeText.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    node.attributes[found[1]] = decodeEntities(found[2]);
  }
  return node;
}

function appendText(node, chunk) {
  const value = chunk.trim();
  if (value) node.text += decodeEntities(value);
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function children(node, tag) {
  return node.children.filter(child => child.tag === tag);
}

function findChild(node, tag) {
  return node.children.find(child => child.tag === tag);
}

// 把 "1,2" 这样的相对偏移拆成每字节一项；非法值原样保留并标为未决。
function parseOffsets(spec, location, notes) {
  const offsets = [];
  for (const part of String(spec ?? '').split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const value = Number(token);
    if (!Number.isInteger(value) || value < 1) {
      notes.push({ code: 'offset-invalid', location, reason: `DMX offset "${token}" is not a positive integer`, value: token });
      offsets.push({ uncertain: true, raw: token });
    } else {
      offsets.push(value);
    }
  }
  return offsets;
}

// DMXFrom="128/1" 这类分数端点不能退化成 8 位整数：保留原始字符串与字节精度。
function dmxValue(raw, bytes, location, notes) {
  const source = raw === undefined || raw === null || raw === '' ? '0/1' : String(raw);
  const match = source.match(/^(\d+)\/(\d+)$/);
  if (!match) {
    notes.push({ code: 'dmx-value-invalid', location, reason: `DMX value "${source}" is not numerator/byte form`, value: source });
    return { raw: source, numerator: null, bytes, max: bytes === null ? null : 2 ** (8 * bytes) - 1, uncertain: true };
  }
  const numerator = Number(match[1]);
  const precision = Number(match[2]);
  if (!Number.isInteger(numerator) || !Number.isInteger(precision) || precision < 1) {
    notes.push({ code: 'dmx-value-invalid', location, reason: `DMX value "${source}" uses non-integer components`, value: source });
  }
  return { raw: source, numerator, bytes: precision, max: 2 ** (8 * precision) - 1 };
}

export function interpretGdtf(raw, documentMeta = {}) {
  const notes = [];
  const unknown = [];
  const document = parseXml(raw);
  const gdtfNode = findChild(document, 'GDTF');
  const fixtureType = gdtfNode && children(gdtfNode, 'FixtureType')[0];
  if (!fixtureType) throw new Error('GDTF FixtureType unavailable');
  const fixtureName = fixtureType.attributes.Name ?? null;
  collectUnknown(gdtfNode, 'GDTF', unknown);
  collectUnknown(fixtureType, 'FixtureType', unknown);

  const geometriesNode = findChild(fixtureType, 'Geometries');
  const geometryNames = new Set();
  const references = [];
  if (geometriesNode) {
    collectUnknown(geometriesNode, 'Geometries', unknown);
    // 模板几何可能在实例引用之后声明，先注册全部几何名称，再解析引用目标。
    registerGeometryNames(geometriesNode, geometryNames);
    walkGeometries(geometriesNode, [], geometryNames, references, unknown, notes);
  } else {
    notes.push({ code: 'geometries-missing', location: 'FixtureType/Geometries', reason: 'Geometries node is absent' });
  }
  const modesNode = findChild(fixtureType, 'DMXModes');
  const modes = [];
  if (modesNode) {
    collectUnknown(modesNode, 'DMXModes', unknown);
    for (const modeNode of children(modesNode, 'DMXMode')) {
      collectUnknown(modeNode, `DMXModes/DMXMode(${modeNode.attributes.Name ?? '?'})`, unknown);
      modes.push(interpretMode(modeNode, unknown, notes));
    }
  } else {
    notes.push({ code: 'modes-missing', location: 'FixtureType/DMXModes', reason: 'DMXModes node is absent' });
  }

  const capabilities = [];
  const unresolved = [];
  for (const mode of modes) {
    for (const channel of mode.channels) {
      const targets = resolveReferences(channel, references, geometryNames, notes, unresolved, mode.name);
      for (const target of targets) {
        emitCapabilities({ mode, channel, target, capabilities, notes, documentMeta, fixtureName });
      }
    }
  }
  flagConflicts(capabilities, notes, documentMeta);
  const recordIds = new Set();
  for (const capability of capabilities) {
    let id = `${capability.mode}:${capability.instance}:${capability.functionName}`;
    let suffix = 2;
    while (recordIds.has(id)) {
      id = `${capability.mode}:${capability.instance}:${capability.functionName}#${suffix++}`;
    }
    recordIds.add(id);
    capability.id = id;
  }

  const hasUnresolved = unresolved.length > 0;
  const hasConflict = capabilities.some(capability => capability.status === 'conflict');
  const hasUncertain = capabilities.some(capability => capability.status === 'uncertain')
    || notes.some(note => note.code === 'offset-invalid' || note.code === 'dmx-value-invalid');
  return {
    kind: 'gdtf-interpretation',
    documentId: documentMeta.id ?? null,
    fixture: fixtureName,
    modes: modes.map(mode => ({ name: mode.name, geometry: mode.geometry })),
    geometryReferences: references.map(reference => ({
      name: reference.name, target: reference.target, breaks: reference.breaks
    })),
    capabilities,
    unresolved,
    unknown,
    notes: notes.map(note => ({ ...note, document: documentMeta.id ?? null, path: documentMeta.path ?? null })),
    status: hasUnresolved || hasConflict || hasUncertain || unknown.length > 0 ? 'incomplete' : 'explained'
  };
}

function registerGeometryNames(node, names) {
  for (const child of node.children) {
    if (!GEOMETRY_TAGS.has(child.tag)) continue;
    if (child.attributes.Name) names.add(child.attributes.Name);
    registerGeometryNames(child, names);
  }
}

function walkGeometries(node, lineage, geometryNames, references, unknown, notes) {
  for (const child of node.children) {
    if (child.tag === 'Break') {
      const ownerName = node.attributes.Name ?? '?';
      collectUnknown(child, `GeometryReference(${ownerName})/Break`, unknown);
      const dmxBreak = Number(child.attributes.DMXBreak ?? '1');
      const location = `GeometryReference(${ownerName})/Break(${child.attributes.DMXBreak ?? '1'})`;
      const offsets = parseOffsets(child.attributes.DMXOffset, location, notes);
      const existing = references.find(reference => reference.name === node.attributes.Name);
      if (existing) existing.breaks.push({ dmxBreak: Number.isInteger(dmxBreak) ? dmxBreak : null, offsets, raw: child.attributes.DMXOffset ?? null });
      continue;
    }
    if (!GEOMETRY_TAGS.has(child.tag)) {
      unknown.push({ location: lineage.join('/') + '/?', tag: child.tag, reason: 'element outside the implemented profile' });
      continue;
    }
    collectUnknown(child, `Geometries/${lineage.concat(child.attributes.Name ?? '?').join('/')}`, unknown);
    const name = child.attributes.Name;
    if (name) geometryNames.add(name);
    if (child.tag === 'Geometry') {
      walkGeometries(child, lineage.concat(name ?? '?'), geometryNames, references, unknown, notes);
    } else {
      const target = child.attributes.Geometry ?? null;
      const breaks = [];
      if (!target || !geometryNames.has(target)) {
        notes.push({
          code: 'geometry-reference-missing',
          location: `GeometryReference(${name ?? '?'})`,
          reason: target ? `referenced geometry "${target}" is not defined` : 'Geometry attribute is absent',
          target
        });
      }
      references.push({ name: name ?? null, target, breaks, lineage: lineage.slice() });
      walkGeometries(child, lineage.concat(name ?? '?'), geometryNames, references, unknown, notes);
    }
  }
}

function interpretMode(modeNode, unknown, notes) {
  const mode = {
    name: modeNode.attributes.Name ?? null,
    geometry: modeNode.attributes.Geometry ?? null,
    channels: []
  };
  const channelsNode = findChild(modeNode, 'DMXChannels');
  if (!channelsNode) return mode;
  collectUnknown(channelsNode, `DMXMode(${mode.name})/DMXChannels`, unknown);
  for (const channelNode of children(channelsNode, 'DMXChannel')) {
    const location = `DMXMode(${mode.name})/DMXChannel(${channelNode.attributes.Geometry ?? '?'})`;
    collectUnknown(channelNode, location, unknown);
    const channel = {
      geometry: channelNode.attributes.Geometry ?? null,
      dmxBreak: Number(channelNode.attributes.DMXBreak ?? '1'),
      offsetSpec: channelNode.attributes.Offset ?? null,
      offsets: parseOffsets(channelNode.attributes.Offset, location, notes),
      functions: []
    };
    for (const logicalNode of children(channelNode, 'LogicalChannel')) {
      collectUnknown(logicalNode, `${location}/LogicalChannel`, unknown);
      for (const functionNode of children(logicalNode, 'ChannelFunction')) {
        const functionLocation = `${location}/ChannelFunction(${functionNode.attributes.Name ?? '?'})`;
        collectUnknown(functionNode, functionLocation, unknown);
        const bytes = channel.offsets.length;
        const functionRecord = {
          name: functionNode.attributes.Name ?? null,
          attribute: functionNode.attributes.Attribute ?? logicalNode.attributes.Attribute ?? null,
          from: dmxValue(functionNode.attributes.DMXFrom, bytes, functionLocation, notes),
          physicalFrom: functionNode.attributes.PhysicalFrom ?? null,
          physicalTo: functionNode.attributes.PhysicalTo ?? null,
          // 功能切换条件：ModeMaster 指向主控通道，ModeFrom 是进入该功能的门槛。
          switching: functionNode.attributes.ModeMaster !== undefined
            ? { modeMaster: functionNode.attributes.ModeMaster, modeFrom: functionNode.attributes.ModeFrom ?? null }
            : null,
          sets: children(functionNode, 'ChannelSet').map(setNode => {
            collectUnknown(setNode, `${functionLocation}/ChannelSet(${setNode.attributes.Name ?? '?'})`, unknown);
            return {
              name: setNode.attributes.Name ?? null,
              from: dmxValue(setNode.attributes.DMXFrom, bytes, functionLocation, notes),
              physicalFrom: setNode.attributes.PhysicalFrom ?? null,
              physicalTo: setNode.attributes.PhysicalTo ?? null
            };
          })
        };
        channel.functions.push(functionRecord);
      }
    }
    mode.channels.push(channel);
  }
  return mode;
}

// 模板通道属于被引用的几何：找出引用了该几何（或其祖先）的实例。
// 引用了不存在的模板时保留未决项，不虚构模板通道。
function resolveReferences(channel, references, geometryNames, notes, unresolved, modeName) {
  const wanted = channel.geometry;
  if (!wanted) {
    notes.push({ code: 'channel-geometry-missing', location: `DMXMode(${modeName})`, reason: 'DMXChannel has no Geometry attribute' });
    return [];
  }
  const direct = references.filter(reference => reference.name === wanted);
  if (direct.length) return direct.map(reference => ({ reference, matchedBy: 'reference-name' }));
  if (!geometryNames.has(wanted)) {
    const item = {
      mode: modeName, channelGeometry: wanted,
      reason: `channel geometry "${wanted}" is neither a template nor a reference in this fixture`,
      status: 'uncertain'
    };
    unresolved.push(item);
    notes.push({ code: 'channel-geometry-unresolved', location: `DMXMode(${modeName})/DMXChannel(${wanted})`, reason: item.reason });
    return [];
  }
  const matched = references.filter(reference => reference.target === wanted
    || (reference.lineage && reference.lineage.includes(wanted)));
  if (matched.length === 0) {
    const item = {
      mode: modeName, channelGeometry: wanted,
      reason: `no GeometryReference instantiates template "${wanted}"`,
      status: 'uncertain'
    };
    unresolved.push(item);
    notes.push({ code: 'geometry-not-instantiated', location: `DMXMode(${modeName})/DMXChannel(${wanted})`, reason: item.reason });
  }
  return matched.map(reference => ({ reference, matchedBy: 'template-reference' }));
}

function emitCapabilities({ mode, channel, target, capabilities, notes, documentMeta, fixtureName }) {
  const reference = target.reference;
  const breakBase = reference.breaks.find(entry => entry.dmxBreak === channel.dmxBreak);
  const baseLocation = `DMXMode(${mode.name})/GeometryReference(${reference.name ?? '?'})`;
  if (!breakBase) {
    notes.push({
      code: 'break-missing',
      location: baseLocation,
      reason: `reference does not declare DMXBreak ${channel.dmxBreak} used by the mode channel`,
      dmxBreak: channel.dmxBreak
    });
  }
  const baseOffsets = breakBase ? breakBase.offsets : [];
  const firstBase = baseOffsets[0];
  // Break DMXOffset 是该 break 首字节的一基地址；通道 Offset 序号从 1 开始，
  // 实例字节地址 = break 基址 + (Offset 序号 - 1)，粗字节在前、细字节在后。
  const uncertainAddress = !breakBase
    || channel.offsets.some(offset => typeof offset !== 'number')
    || baseOffsets.some(offset => typeof offset !== 'number')
    || baseOffsets.length === 0;
  const addresses = channel.offsets.map((offset) => {
    if (typeof offset !== 'number') return { uncertain: true, raw: offset.raw ?? null };
    if (typeof firstBase !== 'number') return { uncertain: true, raw: String(offset) };
    return firstBase + offset - 1;
  });

  for (const fn of channel.functions) {
    capabilities.push({
      id: null,
      fixture: fixtureName,
      mode: mode.name,
      instance: reference.name,
      geometryTemplate: reference.target,
      matchedBy: target.matchedBy,
      dmxBreak: channel.dmxBreak,
      // 粗字节在前、细字节在后，保持模板 Offset 声明的字节顺序。
      addresses,
      attribute: fn.attribute,
      functionName: fn.name,
      range: {
        from: fn.from,
        physicalFrom: fn.physicalFrom,
        physicalTo: fn.physicalTo
      },
      channelSets: fn.sets,
      switching: fn.switching,
      provenance: {
        document: documentMeta.id ?? null,
        path: documentMeta.path ?? null,
        revision: documentMeta.revision ?? null,
        location: `DMXModes/DMXMode[@Name=${mode.name}]/DMXChannel[@Geometry=${channel.geometry}]/ChannelFunction[@Name=${fn.name}]`
      },
      status: uncertainAddress ? 'uncertain' : 'ok',
      diagnostics: []
    });
  }
}

// 同一模式、同一 break、同一字节地址被多个功能解释时属于来源冲突：
// 双方都保留为不确定范围，不能任选一条覆盖另一条。
function flagConflicts(capabilities, notes, documentMeta) {
  const seen = new Map();
  const logged = new Set();
  for (const capability of capabilities) {
    if (capability.status === 'uncertain') continue;
    for (const byte of capability.addresses) {
      const key = `${capability.mode}|${capability.dmxBreak}|${byte}`;
      const owner = seen.get(key);
      if (owner) {
        const reason = `address byte ${byte} of break ${capability.dmxBreak} in mode ${capability.mode} is claimed by both "${owner.functionName}" (${owner.instance}) and "${capability.functionName}" (${capability.instance})`;
        for (const record of [owner, capability]) {
          record.status = 'conflict';
          record.diagnostics.push({ code: 'address-conflict', reason, byte });
        }
        const noteKey = `${owner.provenance.location}|${capability.provenance.location}`;
        if (!logged.has(noteKey)) {
          logged.add(noteKey);
          notes.push({ code: 'address-conflict', location: record_location(owner, capability), reason, document: documentMeta.id ?? null, path: documentMeta.path ?? null });
        }
      } else {
        seen.set(key, capability);
      }
    }
  }
}

function record_location(a, b) {
  return `${a.provenance.location} <> ${b.provenance.location}`;
}

function collectUnknown(node, location, unknown) {
  const allowed = KNOWN[node.tag];
  if (allowed) {
    for (const attribute of Object.keys(node.attributes)) {
      if (!allowed.includes(attribute)) {
        unknown.push({ location, attribute, value: node.attributes[attribute], reason: 'attribute outside the implemented profile' });
      }
    }
  }
  for (const child of node.children) {
    if (!KNOWN[child.tag] && child.tag !== '#text') {
      unknown.push({ location: `${location}/${child.tag}`, tag: child.tag, reason: 'element outside the implemented profile' });
    }
  }
}

// 固件描述文件只提供模式证据（修订号、关联的描述文件名等），不产生通道地址。
export function interpretManifest(raw, documentMeta = {}) {
  const notes = [];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    notes.push({ code: 'manifest-invalid-json', location: documentMeta.path ?? null, reason: error.message, document: documentMeta.id ?? null });
    return {
      kind: 'firmware-manifest', documentId: documentMeta.id ?? null,
      revision: null, describes: null, fields: [], notes, status: 'incomplete'
    };
  }
  const fields = Object.keys(value);
  for (const required of ['revision', 'file']) {
    if (!(required in value)) {
      notes.push({ code: 'manifest-field-missing', location: documentMeta.path ?? null, reason: `firmware manifest lacks "${required}"`, document: documentMeta.id ?? null });
    }
  }
  return {
    kind: 'firmware-manifest',
    documentId: documentMeta.id ?? null,
    revision: value.revision ?? null,
    describes: value.file ?? null,
    fixture: value.fixture ?? null,
    fields,
    provenance: { document: documentMeta.id ?? null, path: documentMeta.path ?? null, revision: documentMeta.revision ?? null },
    notes,
    status: notes.length ? 'incomplete' : 'explained'
  };
}
