# Sampling

Philosophy: Because an application often has the full context of what's going on in the system, and the spans in a Node app are fairly small objects that are probably still in memory in some form anyway pending GC, why not keep them around for a little longer to help give us better insight into what matters & make better decisions about what we actually need to send over the wire?

This approach is better suited for monolithic applications (my preference), if your tail-based trace sampling decisions need to depend on spans generated from a bunch of different services or microservices, you might want to something more sophisticated like [Honeycomb.io's Refinery](https://github.com/honeycombio/refinery)

## Overview

Telemetry sampling controls how many spans your application exports. Without sampling, high-throughput services can generate enormous volumes of trace data, overwhelming backends and inflating costs. The right sampling strategy balances observability with resource usage.

opinionated-telemetry provides three composable sampling modes:

- **Head-based sampling**: lightweight, immediate drop/keep decisions at trace start
- **Tail-based sampling**: buffers all spans until the root ends, then decides with full trace context
- **EMA burst protection**: automatically throttles per-key span rates using an exponential moving average

These modes compose together. You can use any combination: head alone, tail alone, burst alone, head+burst, tail+burst, or all three. When combined, their sample rates multiply, and `mustKeepSpan` always clamps the final rate to 1 (always keep).

## Head-Based Sampling

Head-based sampling makes a keep/drop decision once per trace, at root span creation time. It is the lightest-weight option: no buffering, no memory overhead per trace.

### Algorithm

1. When a root span starts, `head.sample(attrs, spanName)` is called. It returns a 1-in-N rate (e.g. `10` means keep 1 in 10 traces).
2. When any span in the trace ends, the decision is evaluated deterministically using CRC32 of the traceId (see [Deterministic Keep/Drop](#deterministic-keepdrop)).
3. If the trace is sampled out (rate > 1 and CRC32 check fails), the span is dropped immediately.

### `mustKeepSpan` Rescue Semantics

Sometimes a span within a sampled-out trace is too important to drop (e.g. an error, a slow query). The `mustKeepSpan` callback enables rescuing individual spans:

- When `mustKeepSpan(span)` returns `true` on a span in a sampled-out trace, that span is **rescued**.
- The rescued span is reparented directly to the root span (skipping any intermediate dropped spans).
- Both the rescued span and the root span receive `SampleRate=1` and `opin_tel.meta.incomplete_trace=true`.
- Other spans in the trace that are sampled out continue to be dropped.
- The root span is guaranteed to be exported when it ends, so the rescued span has a valid parent.

### When to Use

Head sampling is best when:

- You need minimal memory overhead
- Your sampling decision can be made from root span attributes and name alone
- You can tolerate losing trace context (rescued spans only see root + themselves)

## Tail-Based Sampling

Tail-based sampling buffers all spans in a trace until the root span ends, then makes a single keep/drop decision with the full trace available for inspection.

### Buffer Architecture

Every span in a trace is buffered in a `TailBufferEntry` until the root span ends. The entry tracks:

- All buffered spans
- Error count and whether any error occurred
- Whether `mustKeepSpan` flagged the trace
- The head sample rate (used as fallback during eviction)
- Creation timestamp for age-based eviction

When the root span ends, `tail.sample(rootAttrs, traceSummary)` is called with a `TraceSummary`:

```ts
interface TraceSummary {
  spans: ReadableSpan[]
  errorCount: number
  hasError: boolean
  durationMs: number
  rootSpan: ReadableSpan
  spanCount: number
}
```

The returned rate determines whether the entire trace is kept or dropped.

### `mustKeepSpan` in Tail Mode

Unlike head sampling, tail's `mustKeepSpan` does **not** immediately rescue the span. Instead:

1. When `mustKeepSpan(span)` returns `true`, the trace is flagged as `mustKeep`.
2. Buffering continues until the root span ends (so `tail.sample` has full context).
3. When the root ends, the `mustKeep` flag clamps the final rate to 1 -- the trace is always kept regardless of what `tail.sample` returns.

This gives you the best of both worlds: full trace context for the sample function, with a guarantee that important traces are never dropped.

### Eviction Strategy

Three safety valves prevent unbounded memory growth:

| Trigger                                    | Behavior                                  | Rate Used                                                |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------- |
| `maxTraces` exceeded (default: 1000)       | Oldest trace evicted (by insertion order) | `headSampleRate` (or 1 if `mustKeep`)                    |
| `maxAgeMs` exceeded (default: 120,000ms)   | Trace flushed on periodic eviction check  | `headSampleRate` (or 1 if `mustKeep`)                    |
| `maxSpansPerTrace` exceeded (default: 500) | Trace flushed immediately                 | Rate = 1 (always keep -- large traces are "interesting") |

Eviction uses `headSampleRate` as a fallback because the root hasn't ended yet, so `tail.sample` can't be called. This means if you combine head+tail sampling, the head rate acts as a safety net for evicted traces.

Flushed entries remain in the buffer for a 30-second grace period so that late-arriving child spans can still be processed with the same decision.

### Memory Considerations

Tail sampling buffers every span object in memory. For high-throughput services:

- Set `maxTraces` to bound total buffer size
- Set `maxAgeMs` to flush long-running traces before they accumulate too many spans
- Set `maxSpansPerTrace` to flush unusually large traces early
- Monitor your process memory to tune these values

## EMA Burst Protection

Burst protection uses an exponential moving average (EMA) to detect and throttle sudden spikes in span volume per key. It operates independently of head/tail sampling and is applied multiplicatively.

### Algorithm

The EMA tracks a smoothed rate (spans/second) per key:

```
alpha = 1 - exp(-dt / halfLife)
rate = alpha * instantRate + (1 - alpha) * prevRate
```

Where:

- `dt` is the time since the last event for this key
- `instantRate = 1000 / dt` (the instantaneous spans/sec implied by the gap)
- `halfLife` controls how quickly the EMA responds to changes

When the smoothed rate exceeds `rateThreshold` (default: 100 spans/sec), a sample rate is computed:

```
sampleRate = min(ceil(emaRate / threshold), maxSampleRate)
```

### Why EMA Over Fixed Windows

Fixed-window rate limiting (e.g. "100 spans per second") has bucket boundary problems: a burst straddling two windows can slip through at 2x the limit. EMA avoids this entirely -- there are no windows or boundaries. The rate decays gradually, and every event updates the estimate.

### Half-Life Parameter

The `halfLifeMs` parameter (default: 10,000ms) controls responsiveness:

- **Shorter half-life** (e.g. 2,000ms): responds quickly to bursts, but also reacts to brief spikes that may not warrant throttling
- **Longer half-life** (e.g. 30,000ms): smoother rate estimate, slower to activate and deactivate throttling

### Stale Key Cleanup

EMA state for a key is evicted after 3x the half-life has elapsed since the last event. At the default 10s half-life, a key is cleaned up after 30s of inactivity.

## Deterministic Keep/Drop

All sampling decisions use a deterministic function:

```ts
function shouldKeep(traceId: string, rate: number): boolean {
  if (rate <= 1) return true
  return (crc32(traceId) >>> 0) % rate === 0
}
```

CRC32 of the traceId, interpreted as an unsigned 32-bit integer, modulo the sample rate. If the result is 0, the span is kept.

### Why Deterministic

- **Consistency**: all spans in a trace get the same decision without coordination. No per-trace state needed for the keep/drop check itself.
- **Cross-service**: if two services share a traceId and use the same rate, they make the same decision independently.
- **Stateless**: the function is pure -- no maps, no counters, no synchronization.

## SampleRate Attribute

opinionated-telemetry follows the [Honeycomb convention](https://docs.honeycomb.io/manage-data-volume/sample/): a `SampleRate=N` attribute on a span means "this span represents N spans." Backends like Honeycomb use this to reconstruct accurate counts and statistics from sampled data.

### Rate Composition

When multiple sampling modes are active, rates compose multiplicatively:

| Combination         | Final Rate                                   |
| ------------------- | -------------------------------------------- |
| Head only           | `headRate`                                   |
| Burst only          | `burstRate`                                  |
| Tail only           | `tailRate`                                   |
| Head + Burst        | `headRate * burstRate`                       |
| Tail + Burst        | `tailRate * burstRate`                       |
| Head + Tail + Burst | `tailRate * burstRate` (tail overrides head) |

### Special Cases

- **Rescued spans** (head `mustKeepSpan`): `SampleRate=1` -- always represents exactly itself
- **Rate = 1**: no `SampleRate` attribute is set. Backends treat the absence of `SampleRate` as 1.
- **`opin_tel.meta.incomplete_trace=true`**: set on rescued spans and their root spans to indicate partial trace data

## Composition

### Head + Tail

When both are configured, tail overrides head for the sampling decision. However, head still plays a role:

- `head.sample` is called at root start and its rate is stored as `headSampleRate` on the tail buffer entry.
- If the tail buffer entry is evicted (due to `maxTraces` or `maxAgeMs`), the `headSampleRate` is used as the fallback rate since `tail.sample` cannot be called without a completed root span.
- When the root ends normally, `tail.sample` determines the rate and `headSampleRate` is ignored.

### Head + Burst

Rates multiply. A head rate of 10 and a burst rate of 5 yields a final rate of 50. The deterministic check uses the combined rate.

### Tail + Burst

Rates multiply. The tail decision rate is multiplied by the burst rate at flush time.

### All Three

Tail decides the base rate (overriding head), multiplied by burst. Head's rate is only used as a fallback if the tail entry is evicted before the root ends.

### `mustKeepSpan` Across Modes

In all modes, `mustKeepSpan` returning `true` clamps the decided rate to 1. This means:

- In head mode: the span is rescued immediately with `SampleRate=1`
- In tail mode: the trace is flagged, and when the root ends the rate is forced to 1 regardless of what `tail.sample` returns
- Burst protection rates are still applied multiplicatively, but since the base rate is clamped to 1, burst alone determines whether the trace is kept

## Design Decisions

### Why Not the OTel Sampler Interface

The OTel SDK provides a `Sampler` interface, but it has fundamental incompatibilities with this library's goals:

- **`NOT_RECORD` creates no-op shells**: when a Sampler returns `NOT_RECORD`, the SDK creates a non-recording span. No attributes can be set, no status, no events. This makes `mustKeepSpan` impossible -- there is nothing to inspect.
- **Decision at start time only**: Samplers decide before the span has any meaningful data. Tail sampling requires waiting until the trace is complete.
- **No attribute injection**: Samplers cannot add `SampleRate` attributes to kept spans. The processor must do this.

By implementing sampling in the `SpanProcessor.onEnd` path, spans are fully formed with all their attributes, enabling both inspection (`mustKeepSpan`) and annotation (`SampleRate`).

### Why Head Doesn't Buffer

Head sampling is designed to be lightweight. Buffering would negate its primary advantage over tail sampling. Spans are either exported immediately or dropped. The trade-off is that `mustKeepSpan` can only rescue individual spans (reparented to root), not reconstruct the full trace.

### Why Tail `mustKeepSpan` Waits for Root

Even though `mustKeepSpan` flags a trace as must-keep, the trace continues buffering until the root span ends. This is because:

1. `tail.sample` receives the full `TraceSummary` -- it may want to log, emit metrics, or make other decisions based on the complete trace even if the outcome (keep) is predetermined.
2. All spans in the trace are flushed together with a consistent `SampleRate`, maintaining trace integrity.
3. The `mustKeep` flag is just a clamp -- it sets the floor at rate=1 but doesn't bypass the normal flush path.

### Trade-offs Summary

| Mode  | Advantage                                     | Disadvantage                                                         |
| ----- | --------------------------------------------- | -------------------------------------------------------------------- |
| Head  | Low memory, immediate decisions               | Cannot see full trace context; rescued spans lose intermediate spans |
| Tail  | Full trace context for decisions              | Memory cost proportional to active traces; latency before export     |
| Burst | Automatic, per-key, no configuration of rates | Per-key not per-trace; adds complexity to rate composition           |
