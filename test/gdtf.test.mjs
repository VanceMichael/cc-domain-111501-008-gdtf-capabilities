import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretGdtf, interpretManifest, parseXml } from '../src/gdtf.mjs';

const META = { id: 'doc', path: 'description.xml', revision: 1 };

test('referenced template produces one capability set per instance, never a template channel', () => {
  const raw = `<GDTF DataVersion="1.2"><FixtureType Name="F"><Geometries>`
    + `<Geometry Name="Root"><GeometryReference Name="a" Geometry="T"><Break DMXBreak="1" DMXOffset="1"/></GeometryReference>`
    + `<GeometryReference Name="b" Geometry="T"><Break DMXBreak="1" DMXOffset="5"/></GeometryReference></Geometry>`
    + `<Geometry Name="T"/></Geometries><DMXModes><DMXMode Name="M" Geometry="Root"><DMXChannels>`
    + `<DMXChannel DMXBreak="1" Offset="1,2" Geometry="T"><LogicalChannel Attribute="Dimmer">`
    + `<ChannelFunction Name="dimmer" DMXFrom="0/2" PhysicalFrom="0" PhysicalTo="1"/></LogicalChannel></DMXChannel>`
    + `</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const result = interpretGdtf(raw, META);
  assert.equal(result.status, 'explained');
  assert.deepEqual(result.capabilities.map(c => c.id).sort(), ['M:a:dimmer', 'M:b:dimmer']);
  assert.deepEqual(result.capabilities.find(c => c.instance === 'a').addresses, [1, 2]);
  assert.deepEqual(result.capabilities.find(c => c.instance === 'b').addresses, [5, 6]);
  assert.ok(result.capabilities.every(c => c.dmxBreak === 1));
  // 模板 T 自身没有任何记录，模板通道没有被复制成“第三台灯”。
  assert.ok(!result.capabilities.some(c => c.instance === 'T'));
});

test('DMXFrom keeps byte precision and channel function switching conditions survive', () => {
  const raw = `<GDTF DataVersion="1.2"><FixtureType Name="F"><Geometries><Geometry Name="Root">`
    + `<GeometryReference Name="a" Geometry="T"><Break DMXBreak="1" DMXOffset="1"/></GeometryReference></Geometry>`
    + `<Geometry Name="T"/></Geometries><DMXModes><DMXMode Name="M" Geometry="Root"><DMXChannels>`
    + `<DMXChannel DMXBreak="1" Offset="3" Geometry="T"><LogicalChannel Attribute="Strobe">`
    + `<ChannelFunction Name="off" DMXFrom="0/1"/><ChannelFunction Name="run" DMXFrom="16/1" ModeMaster="ControlMode" ModeFrom="1/1"/>`
    + `</LogicalChannel></DMXChannel></DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const result = interpretGdtf(raw, META);
  const run = result.capabilities.find(c => c.functionName === 'run');
  assert.deepEqual(run.range.from, { raw: '16/1', numerator: 16, bytes: 1, max: 255 });
  assert.deepEqual(run.switching, { modeMaster: 'ControlMode', modeFrom: '1/1' });
  const twoByte = interpretGdtf(raw.replace('Offset="3"', 'Offset="1,2"').replaceAll('/1', '/2'), META);
  assert.equal(twoByte.capabilities[0].range.from.bytes, 2);
  assert.equal(twoByte.capabilities[0].range.from.max, 65535);
});

test('address conflicts retain both sides as uncertain instead of overwriting', () => {
  const raw = `<GDTF DataVersion="1.2"><FixtureType Name="F"><Geometries><Geometry Name="Root">`
    + `<GeometryReference Name="a" Geometry="T"><Break DMXBreak="1" DMXOffset="1"/></GeometryReference></Geometry>`
    + `<Geometry Name="T"/></Geometries><DMXModes><DMXMode Name="M" Geometry="Root"><DMXChannels>`
    + `<DMXChannel DMXBreak="1" Offset="1" Geometry="T"><LogicalChannel Attribute="Pan"><ChannelFunction Name="pan" DMXFrom="0/1"/></LogicalChannel></DMXChannel>`
    + `<DMXChannel DMXBreak="1" Offset="1" Geometry="T"><LogicalChannel Attribute="Dimmer"><ChannelFunction Name="dimmer" DMXFrom="0/1"/></LogicalChannel></DMXChannel>`
    + `</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const result = interpretGdtf(raw, META);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.capabilities.every(c => c.status === 'conflict'));
  const reasons = result.notes.filter(n => n.code === 'address-conflict');
  assert.equal(reasons.length, 1);
  assert.match(reasons[0].reason, /pan/);
  assert.match(reasons[0].reason, /dimmer/);
});

test('missing geometry references and missing breaks stay unresolved with source locations', () => {
  const raw = `<GDTF DataVersion="1.2"><FixtureType Name="F"><Geometries><Geometry Name="Root">`
    + `<GeometryReference Name="ghost" Geometry="Absent"><Break DMXBreak="1" DMXOffset="20"/></GeometryReference></Geometry>`
    + `<Geometry Name="T"/></Geometries><DMXModes><DMXMode Name="M" Geometry="Root"><DMXChannels>`
    + `<DMXChannel DMXBreak="2" Offset="1" Geometry="T"><LogicalChannel Attribute="Fog"><ChannelFunction Name="fog" DMXFrom="0/1"/></LogicalChannel></DMXChannel>`
    + `</DMXChannels></DMXMode></DMXModes></FixtureType></GDTF>`;
  const result = interpretGdtf(raw, META);
  assert.ok(result.notes.some(n => n.code === 'geometry-reference-missing' && n.target === 'Absent'));
  assert.ok(result.notes.some(n => n.code === 'channel-geometry-unresolved' || n.code === 'geometry-not-instantiated'));
  assert.equal(result.unresolved.length, 1);
});

test('unknown elements and attributes are isolated rather than interpreted', () => {
  const raw = `<GDTF DataVersion="1.2" CustomFlag="x"><FixtureType Name="F"><Geometries>`
    + `<Geometry Name="Root" Color="red"><VendorNote>hidden</VendorNote></Geometry></Geometries>`
    + `<DMXModes><DMXMode Name="M" Geometry="Root"><DMXChannels/></DMXMode></DMXModes>`
    + `</FixtureType></GDTF>`;
  const result = interpretGdtf(raw, META);
  assert.equal(result.status, 'incomplete');
  assert.ok(result.unknown.some(u => u.attribute === 'CustomFlag'));
  assert.ok(result.unknown.some(u => u.attribute === 'Color'));
  assert.ok(result.unknown.some(u => u.tag === 'VendorNote'));
});

test('firmware manifest interpretation records revision evidence and missing fields', () => {
  const ok = interpretManifest(JSON.stringify({ fixture: 'F', revision: 'fw-9', file: 'description.xml' }), META);
  assert.equal(ok.status, 'explained');
  assert.equal(ok.revision, 'fw-9');
  const bad = interpretManifest('{not json', META);
  assert.equal(bad.status, 'incomplete');
  assert.equal(bad.notes[0].code, 'manifest-invalid-json');
  const partial = interpretManifest(JSON.stringify({ fixture: 'F' }), META);
  assert.ok(partial.notes.some(n => n.code === 'manifest-field-missing'));
});

test('parser rejects external definitions and malformed xml', () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x/>'), /external definitions/);
  assert.throws(() => parseXml('<GDTF><FixtureType></GDTF>'), /unmatched closing tag/);
});
