import { type Span, SpanStatusCode } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";

const errorConclusions = new Set(["failure", "timed_out", "startup_failure"]);

function recordConclusion(span: Span, conclusion: string | null | undefined) {
  if (conclusion && errorConclusions.has(conclusion)) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(ATTR_ERROR_TYPE, conclusion);
  }
}

export { recordConclusion };
