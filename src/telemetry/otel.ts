/**
 * OpenTelemetry Protocol (OTLP/HTTP JSON) instrumentation for Bun.
 *
 * Zero runtime dependencies: OTLP is the standard wire protocol. All
 * network exporters are best-effort and never gate financial SQL commits.
 * All identifiers used as metric labels are LOW cardinality; individual
 * wallet, transaction and event IDs appear only in trace/log attributes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

export type TelemetryAttribute = string | number | boolean;
export type Attributes = Record<string, TelemetryAttribute | null | undefined>;
interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}
interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: AttributeRecord[];
  status: { code: number; message?: string };
}
interface AttributeRecord {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean; doubleValue?: number };
}
interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: AttributeRecord[];
  traceId?: string;
  spanId?: string;
}

const context = new AsyncLocalStorage<TraceContext>();
const instanceId = randomUUID();
let service = process.env.OTEL_SERVICE_NAME ?? 'wager-api';
let started = false;
let timer: ReturnType<typeof setInterval> | undefined;
let pendingSpans: SpanRecord[] = [];
let pendingLogs: LogRecord[] = [];
let dropped = 0;
const counterStart = epochNanos();
const counters = new Map<string, { name: string; labels: Attributes; value: number }>();
const distributions = new Map<
  string,
  { name: string; labels: Attributes; count: number; sum: number; bins: number[] }
>();
const gauges = new Map<string, { name: string; labels: Attributes; value: number }>();
const boundaries = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function epochNanos(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}
function active(): boolean {
  return process.env.OTEL_ENABLED === 'true';
}
/** Never export secrets or raw financial amounts from log or span attributes. */
export function sanitizedAttributes(values: Attributes): Attributes {
  const blocked = /(?:^|[._-])(?:authorization|token|password|secret|cookie|api[_-]?key|payload|body|money|amount|balance)(?:$|[._-])/i;
  return Object.fromEntries(Object.entries(values).filter(([key]) => !blocked.test(key)));
}
function attributes(values: Attributes = {}): AttributeRecord[] {
  return Object.entries(sanitizedAttributes(values))
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (typeof value === 'boolean') return { key, value: { boolValue: value } };
      if (typeof value === 'number') {
        return {
          key,
          value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
        };
      }
      return { key, value: { stringValue: String(value) } };
    });
}
function resource(): { attributes: AttributeRecord[] } {
  return {
    attributes: attributes({
      'service.name': service,
      'service.instance.id': instanceId,
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
  };
}
function boundedPush<T>(list: T[], item: T): void {
  if (list.length < 50_000) list.push(item);
  else dropped++;
}
function traceId(): string {
  return randomBytes(16).toString('hex');
}
function spanId(): string {
  return randomBytes(8).toString('hex');
}

export function currentTraceparent(): string | null {
  const ctx = context.getStore();
  return ctx ? `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}` : null;
}
export function traceContext(): { traceId: string; spanId: string } | null {
  const ctx = context.getStore();
  return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : null;
}
export function parseTraceparent(value: string | undefined | null): TraceContext | null {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-(0[01])$/i.exec(value ?? '');
  if (!match || /^0+$/.test(match[1] ?? '') || /^0+$/.test(match[2] ?? '')) return null;
  return {
    traceId: (match[1] ?? '').toLowerCase(),
    spanId: (match[2] ?? '').toLowerCase(),
    sampled: match[3] === '01',
  };
}
export function startSpan(
  name: string,
  values: Attributes = {},
  remoteTraceparent?: string | null,
  kind = 1,
): {
  run<T>(fn: () => T): T;
  end(extra?: Attributes, error?: unknown): void;
  traceId: string;
  spanId: string;
} {
  const parent = parseTraceparent(remoteTraceparent) ?? context.getStore();
  const ctx: TraceContext = {
    traceId: parent?.traceId ?? traceId(),
    spanId: spanId(),
    sampled: true,
  };
  const startedAt = epochNanos();
  let ended = false;
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    run<T>(fn: () => T): T {
      return context.run(ctx, fn);
    },
    end(extra: Attributes = {}, error?: unknown) {
      if (ended) return;
      ended = true;
      if (!active()) return;
      const isError = error !== undefined;
      boundedPush(pendingSpans, {
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name,
        kind,
        startTimeUnixNano: startedAt,
        endTimeUnixNano: epochNanos(),
        attributes: attributes({
          ...values,
          ...extra,
          ...(isError
            ? { 'error.type': error instanceof Error ? error.name : 'UnknownError' }
            : {}),
        }),
        status: isError
          ? { code: 2, message: error instanceof Error ? error.name : 'UnknownError' }
          : { code: 1 },
      });
    },
  };
}
export async function withSpan<T>(
  name: string,
  values: Attributes,
  fn: () => Promise<T>,
  parent?: string | null,
): Promise<T> {
  const span = startSpan(name, values, parent);
  return span.run(async () => {
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (error: unknown) {
      log('error', 'trace.span.failed', {
        span_name: name,
        error_type: error instanceof Error ? error.name : 'UnknownError',
      });
      span.end({}, error);
      throw error;
    }
  });
}

/** Never log secrets, raw request bodies, JWTs or payment amounts. */
export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  values: Attributes = {},
): void {
  const ctx = traceContext();
  const content = {
    timestamp: new Date().toISOString(),
    level,
    service,
    message,
    ...(ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {}),
    ...Object.fromEntries(Object.entries(sanitizedAttributes(values)).filter(([, v]) => v !== undefined && v !== null)),
  };
  if (
    process.env.OTEL_LOG_STDOUT === 'true' ||
    (process.env.OTEL_LOG_STDOUT !== 'false' && process.env.NODE_ENV !== 'test')
  ) {
    const line = JSON.stringify(content);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  }
  if (!active()) return;
  boundedPush(pendingLogs, {
    timeUnixNano: epochNanos(),
    severityNumber: { debug: 5, info: 9, warn: 13, error: 17 }[level],
    severityText: level.toUpperCase(),
    body: { stringValue: JSON.stringify(content) },
    attributes: attributes({ 'event.name': message, level, ...sanitizedAttributes(values) }),
    ...(ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
  });
}

/** Labels MUST be bounded sets (route templates, status, operation and event type only). */
export function count(name: string, labels: Attributes = {}, amount = 1): void {
  if (!active()) return;
  const key = JSON.stringify([name, Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))]);
  const item = counters.get(key) ?? { name, labels, value: 0 };
  item.value += amount;
  counters.set(key, item);
}
/** Latest measured dependency state; unlike counters, gauge values may decrease. */
export function gauge(name: string, value: number, labels: Attributes = {}): void {
  if (!active()) return;
  const key = JSON.stringify([name, Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))]);
  gauges.set(key, { name, labels, value });
}
export function duration(name: string, milliseconds: number, labels: Attributes = {}): void {
  if (!active()) return;
  const key = JSON.stringify([name, Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))]);
  const item = distributions.get(key) ?? {
    name,
    labels,
    count: 0,
    sum: 0,
    bins: Array.from({ length: boundaries.length + 1 }, () => 0),
  };
  item.count++;
  item.sum += milliseconds;
  const index = boundaries.findIndex((bound) => milliseconds <= bound);
  item.bins[index < 0 ? boundaries.length : index]!++;
  distributions.set(key, item);
}
function metricsPayload(): unknown {
  const now = epochNanos();
  return {
    resourceMetrics: [
      {
        resource: resource(),
        scopeMetrics: [
          {
            scope: { name: 'wagering-processor.manual-otlp' },
            metrics: [
              ...[...counters.values()].map((v) => ({
                name: v.name,
                unit: '1',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: attributes(v.labels),
                      startTimeUnixNano: counterStart,
                      timeUnixNano: now,
                      asInt: String(v.value),
                    },
                  ],
                },
              })),
              ...[...gauges.values()].map((v) => ({
                name: v.name,
                unit: '1',
                gauge: {
                  dataPoints: [
                    { attributes: attributes(v.labels), timeUnixNano: now, asDouble: v.value },
                  ],
                },
              })),
              ...[...distributions.values()].map((v) => ({
                name: v.name,
                unit: 'ms',
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    {
                      attributes: attributes(v.labels),
                      startTimeUnixNano: counterStart,
                      timeUnixNano: now,
                      count: String(v.count),
                      sum: v.sum,
                      bucketCounts: v.bins.map((n) => String(n)),
                      explicitBounds: boundaries,
                    },
                  ],
                },
              })),
              {
                name: 'wager_telemetry_dropped_total',
                unit: '1',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    { startTimeUnixNano: counterStart, timeUnixNano: now, asInt: String(dropped) },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
async function publish(kind: 'traces' | 'logs' | 'metrics', payload: unknown): Promise<void> {
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318').replace(
    /\/$/,
    '',
  );
  const response = await fetch(`${endpoint}/v1/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(2800),
  });
  if (!response.ok) throw new Error(`OTLP ${kind} export returned HTTP ${response.status}`);
}
let flushing = false;
export async function flushTelemetry(): Promise<void> {
  if (!active() || flushing) return;
  flushing = true;
  const spans = pendingSpans;
  pendingSpans = [];
  const logs = pendingLogs;
  pendingLogs = [];
  const tasks: Promise<void>[] = [publish('metrics', metricsPayload())];
  if (spans.length)
    tasks.push(
      publish('traces', {
        resourceSpans: [
          {
            resource: resource(),
            scopeSpans: [{ scope: { name: 'wagering-processor.manual-otlp' }, spans }],
          },
        ],
      }),
    );
  if (logs.length)
    tasks.push(
      publish('logs', {
        resourceLogs: [
          {
            resource: resource(),
            scopeLogs: [{ scope: { name: 'wagering-processor.manual-otlp' }, logRecords: logs }],
          },
        ],
      }),
    );
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'rejected') {
      // Do not crash or mutate financial state on a telemetry outage.
      console.warn(
        JSON.stringify({
          level: 'warn',
          service,
          message: 'otel.export.failed',
          error: String(result.reason).slice(0, 256),
        }),
      );
    }
  }
  flushing = false;
}
export function startTelemetry(name: string): void {
  if (started) return;
  started = true;
  service = name;
  if (!active()) return;
  log('info', 'otel.started', { exporter: 'otlp-http-json', 'service.name': service });
  timer = setInterval(() => {
    void flushTelemetry();
  }, 3000);
  timer.unref();
}
export async function stopTelemetry(): Promise<void> {
  if (timer) clearInterval(timer);
  await flushTelemetry();
}
