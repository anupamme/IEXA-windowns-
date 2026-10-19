'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Metrics } = require('../dist/main/observability/Metrics');

test('metrics aggregate counters and latency samples', () => {
  const metrics = new Metrics();
  metrics.increment('runs_started');
  metrics.increment('tools_succeeded', 3);
  metrics.observe('tool_duration_ms', 10);
  metrics.observe('tool_duration_ms', 30);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.runs_started, 1);
  assert.equal(snapshot.tools_succeeded, 3);
  assert.equal(snapshot.tool_duration_ms_count, 2);
  assert.equal(snapshot.tool_duration_ms_sum, 40);
  assert.equal(snapshot.tool_duration_ms_min, 10);
  assert.equal(snapshot.tool_duration_ms_max, 30);
  assert.equal(snapshot.tool_duration_ms_avg, 20);
  assert.ok(snapshot.uptime_ms >= 0);
});

test('metrics ignore non-finite and negative observations', () => {
  const metrics = new Metrics();
  metrics.increment('x', 0);
  metrics.increment('x', Number.NaN);
  metrics.observe('lat', -1);
  metrics.observe('lat', Number.POSITIVE_INFINITY);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.x, undefined);
  assert.equal(snapshot.lat_count, undefined);
});

test('reset clears counters and samples but keeps uptime', () => {
  const metrics = new Metrics();
  metrics.increment('a', 2);
  metrics.observe('lat', 5);
  metrics.reset();
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.a, undefined);
  assert.equal(snapshot.lat_count, undefined);
  assert.ok(snapshot.uptime_ms >= 0);
});
