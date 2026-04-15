import { trace, Tracer } from '@opentelemetry/api';

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}
