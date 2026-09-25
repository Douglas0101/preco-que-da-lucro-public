import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("preco-que-da-lucro", "1.0.0");

export function setHttpResponseStatus(
  span: Pick<Span, "setAttribute" | "setStatus">,
  status: number,
): void {
  span.setAttribute("http.response.status_code", status);
  span.setStatus({ code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
}

export function withHttpRequestSpan<T>(
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan("http.request", { attributes }, async (span) => {
    try {
      return await operation(span);
    } catch (error) {
      if (error instanceof Error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
