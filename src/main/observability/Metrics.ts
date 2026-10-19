/**
 * Process-local counters and latency aggregates. Nothing here is sampled or
 * exported off-device; snapshots are appended to the session trace JSONL so a
 * diagnostics export can show how a run actually behaved.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly samples = new Map<string, { count: number; sum: number; max: number; min: number }>();
  private readonly startedAt = Date.now();

  increment(name: string, value = 1): void {
    if (!Number.isFinite(value) || value === 0) return;
    this.counters.set(name, (this.counters.get(name) || 0) + value);
  }

  /** Record one latency/size observation; non-finite or negative values are ignored. */
  observe(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const current = this.samples.get(name) || { count: 0, sum: 0, max: 0, min: Number.POSITIVE_INFINITY };
    current.count += 1;
    current.sum += value;
    current.max = Math.max(current.max, value);
    current.min = Math.min(current.min, value);
    this.samples.set(name, current);
  }

  snapshot(): Record<string, number> {
    const output: Record<string, number> = {};
    for (const [name, value] of this.counters) output[name] = value;
    for (const [name, sample] of this.samples) {
      if (!sample.count) continue;
      output[`${name}_count`] = sample.count;
      output[`${name}_sum`] = Math.round(sample.sum);
      output[`${name}_max`] = Math.round(sample.max);
      output[`${name}_min`] = Math.round(sample.min);
      output[`${name}_avg`] = Math.round(sample.sum / sample.count);
    }
    output.uptime_ms = Date.now() - this.startedAt;
    return output;
  }

  reset(): void {
    this.counters.clear();
    this.samples.clear();
  }
}
