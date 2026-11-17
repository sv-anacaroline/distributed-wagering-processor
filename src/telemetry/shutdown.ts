import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { flushTelemetry, log, stopTelemetry } from './otel.js';

@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(signal?: string): Promise<void> {
    log('info', 'runtime.shutdown', { signal: signal ?? 'unspecified' });
    await flushTelemetry();
    await stopTelemetry();
  }
}
