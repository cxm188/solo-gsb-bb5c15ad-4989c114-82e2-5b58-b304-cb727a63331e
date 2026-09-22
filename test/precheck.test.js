'use strict';

const assert = require('assert');
const { precheckGeoJSON, unifyDate } = require('../src/precheck');

function fc(...features) {
  return { type: 'FeatureCollection', features };
}
function feature(props, geometry) {
  return { type: 'Feature', properties: props || {}, geometry };
}
function ring(coords) {
  return { type: 'Polygon', coordinates: [coords] };
}
const SQUARE_CLOSED = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
const square = () => ring(SQUARE_CLOSED.map((p) => [...p]));
const goodProps = () => ({ name: 'A', layer: '土建', start: '2026-10-01', end: '2026-11-01' });

// ---------- 1. 完全合法的要素：无错误无警告 ----------
let report = precheckGeoJSON(fc(feature(goodProps(), square())));
assert.strictEqual(report.summary.total, 1);
assert.strictEqual(report.summary.valid, 1);
assert.strictEqual(report.summary.importable, 1);
assert.strictEqual(report.summary.errorCount, 0);
assert.strictEqual(report.summary.warningCount, 0);
assert.deepStrictEqual(report.features[0].status, 'valid');
assert.ok(report.normalized.features[0].geometry);

// ---------- 2. 环未闭合 → 警告 + 自动补闭合点 ----------
const unclosed = SQUARE_CLOSED.slice(0, 4).map((p) => [...p]);
report = precheckGeoJSON(fc(feature(goodProps(), ring(unclosed))));
assert.strictEqual(report.summary.invalid, 0);
assert.strictEqual(report.features[0].status, 'warning');
assert.ok(report.features[0].warnings.some((w) => w.code === 'ring-not-closed'));
const fixed = report.normalized.features[0].geometry.coordinates[0];
assert.strictEqual(fixed.length, 5);
assert.deepStrictEqual(fixed[4], fixed[0], '规范化后首末点应一致');

// ---------- 3. 重复闭合点 / 连续重复顶点 → 警告 + 去重 ----------
const withDup = [[0, 0], [0, 0], [1, 0], [1, 1], [0, 1], [0, 0], [0, 0]];
report = precheckGeoJSON(fc(feature(goodProps(), ring(withDup))));
assert.strictEqual(report.features[0].status, 'warning');
assert.ok(report.features[0].warnings.some((w) => w.code === 'duplicate-vertex'));
const deduped = report.normalized.features[0].geometry.coordinates[0];
assert.strictEqual(deduped.length, 5);

// ---------- 4. 顶点数量不足 → 错误，不可导入 ----------
report = precheckGeoJSON(fc(feature(goodProps(), ring([[0, 0], [1, 0], [0, 0]]))));
assert.strictEqual(report.features[0].status, 'error');
assert.strictEqual(report.features[0].importable, false);
assert.ok(report.features[0].errors.some((e) => e.code === 'too-few-vertices' || e.code === 'degenerate-ring'));
assert.strictEqual(report.summary.importable, 0);
assert.strictEqual(report.normalized.features.length, 0);

// ---------- 5. 自相交 → 错误，路径定位到具体环 ----------
const bowtie = [[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]];
report = precheckGeoJSON(fc(feature(goodProps(), ring(bowtie))));
assert.strictEqual(report.features[0].status, 'error');
const si = report.features[0].errors.find((e) => e.code === 'self-intersection');
assert.ok(si, '应报告自相交');
assert.ok(si.path.includes('geometry.coordinates[0]'), `路径应定位到环: ${si.path}`);
assert.strictEqual(report.features[0].normalized, null);

// ---------- 6. 时间字段：缺失 / 非法 / 结束早于开始 ----------
report = precheckGeoJSON(fc(feature({ start: '2026-10-01' }, square())));
assert.ok(report.features[0].errors.some((e) => e.code === 'missing-end'));
assert.ok(report.features[0].errors[0].path.includes('properties.end'));

report = precheckGeoJSON(fc(feature({ start: 'not-a-date', end: '2026-11-01' }, square())));
assert.ok(report.features[0].errors.some((e) => e.code === 'invalid-start'));

report = precheckGeoJSON(fc(feature({ start: '2026-12-01', end: '2026-11-01' }, square())));
assert.ok(report.features[0].errors.some((e) => e.code === 'invalid-time-range'));

// 伪日期（2 月 31 日）应判为非法
report = precheckGeoJSON(fc(feature({ start: '2026-02-31', end: '2026-11-01' }, square())));
assert.ok(report.features[0].errors.some((e) => e.code === 'invalid-start'));

// ---------- 7. 时间字段别名与日期格式统一 ----------
report = precheckGeoJSON(fc(feature(
  { name: 'A', startTime: '2026/10/1', endTime: '2026年11月1日' },
  square()
)));
assert.strictEqual(report.features[0].status, 'warning');
assert.ok(report.features[0].warnings.some((w) => w.code === 'time-field-alias'));
const np = report.normalized.features[0].properties;
assert.strictEqual(np.start, '2026-10-01');
assert.strictEqual(np.end, '2026-11-01');
assert.strictEqual(np.startTime, undefined, '旧别名字段应被移除');
assert.strictEqual(np.endTime, undefined);

// 含时间的写法统一为完整 ISO
assert.strictEqual(unifyDate('2026-10-01T08:30:00+08:00').value, '2026-10-01T00:30:00.000Z');
assert.strictEqual(unifyDate('2026-10-01').value, '2026-10-01');
assert.strictEqual(unifyDate('bad').ok, false);

// ---------- 8. 资源字段：字符串拆分、去空白、去重 ----------
report = precheckGeoJSON(fc(feature(
  { name: 'A', start: '2026-10-01', end: '2026-11-01', resources: ['塔吊', ' 挖掘机 ', '塔吊'] },
  square()
)));
assert.strictEqual(report.features[0].status, 'warning');
assert.deepStrictEqual(report.normalized.features[0].properties.resources, ['塔吊', '挖掘机']);

report = precheckGeoJSON(fc(feature(
  { ...goodProps(), resources: '塔吊，挖掘机、泵车' },
  square()
)));
assert.deepStrictEqual(report.normalized.features[0].properties.resources, ['塔吊', '挖掘机', '泵车']);

// ---------- 9. 几何类型不支持 / 缺失几何 → 错误 ----------
report = precheckGeoJSON(fc(feature(goodProps(), { type: 'Point', coordinates: [0, 0] })));
assert.ok(report.features[0].errors.some((e) => e.code === 'unsupported-geometry'));

report = precheckGeoJSON(fc(feature(goodProps(), null)));
assert.ok(report.features[0].errors.some((e) => e.code === 'missing-geometry'));

// 非 Feature 元素
report = precheckGeoJSON(fc({ type: 'Point', coordinates: [0, 0] }));
assert.ok(report.features[0].errors.some((e) => e.code === 'invalid-feature'));

// ---------- 10. JSONPath 定位 ----------
report = precheckGeoJSON(fc(
  feature(goodProps(), square()),
  feature(goodProps(), ring([[0, 0], [1, 0], [0, 0]]))
));
assert.strictEqual(report.features[0].path, '$.features[0]');
assert.strictEqual(report.features[1].path, '$.features[1]');
const pathIssue = report.features[1].errors.find((e) => e.code === 'too-few-vertices' || e.code === 'degenerate-ring');
assert.ok(pathIssue.path.startsWith('$.features[1].geometry.coordinates[0]'));

// 数组形态的路径基址
report = precheckGeoJSON([feature(goodProps(), square())]);
assert.strictEqual(report.features[0].path, '$[0]');

// 单 Feature 形态
report = precheckGeoJSON(feature(goodProps(), square()));
assert.strictEqual(report.features[0].path, '$');

// ---------- 11. 混合批量：错误项不进 normalized，可导入项保留原索引映射 ----------
report = precheckGeoJSON(fc(
  feature(goodProps(), square()),                            // 0 valid
  feature({ start: '2026-10-01' }, square()),                // 1 error（缺 end）
  feature({ ...goodProps(), resources: '塔吊，塔吊' }, square()) // 2 warning（资源可修复）
));
assert.strictEqual(report.summary.total, 3);
assert.strictEqual(report.summary.valid, 1);
assert.strictEqual(report.summary.invalid, 1);
assert.strictEqual(report.summary.withWarnings, 1);
assert.strictEqual(report.summary.importable, 2);
assert.deepStrictEqual(report.importableIndexes, [0, 2]);
assert.strictEqual(report.normalized.features.length, 2);

// ---------- 12. MultiPolygon 检查与孔洞路径 ----------
const multi = {
  type: 'MultiPolygon',
  coordinates: [
    [SQUARE_CLOSED.map((p) => [...p])],
    [SQUARE_CLOSED.map((p) => [p[0] + 2, p[1]])],
  ],
};
report = precheckGeoJSON(fc(feature(goodProps(), multi)));
assert.strictEqual(report.summary.invalid, 0);
assert.strictEqual(report.normalized.features[0].geometry.type, 'MultiPolygon');

// 第二个多边形坏 → 路径定位到 coordinates[1]
const multiBad = {
  type: 'MultiPolygon',
  coordinates: [
    [SQUARE_CLOSED.map((p) => [...p])],
    [bowtie.map((p) => [...p])],
  ],
};
report = precheckGeoJSON(fc(feature(goodProps(), multiBad)));
assert.ok(report.features[0].errors.some((e) => e.path.includes('coordinates[1][0]')));

// ---------- 13. 缺失 name/layer 的自动补全（警告 + 规范化） ----------
report = precheckGeoJSON(fc(
  feature({ start: '2026-10-01', end: '2026-11-01' }, square())
));
assert.strictEqual(report.features[0].status, 'warning');
const nf = report.normalized.features[0].properties;
assert.strictEqual(nf.name, '区域 1');
assert.strictEqual(nf.layer, '默认图层');

// ---------- 14. 经纬度越界 / 非法坐标 ----------
report = precheckGeoJSON(fc(feature(goodProps(), ring([[200, 0], [201, 0], [201, 1], [200, 1], [200, 0]]))));
assert.ok(report.features[0].errors.some((e) => e.code === 'coordinate-out-of-range'));
report = precheckGeoJSON(fc(feature(goodProps(), ring([['x', 0], [1, 0], [1, 1], [0, 1], ['x', 0]]))));
assert.ok(report.features[0].errors.some((e) => e.code === 'invalid-coordinate'));

console.log('✅ 预检全部测试通过');
