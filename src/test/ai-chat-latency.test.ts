import "./helpers/otel-metrics";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelCaller } from "@/lib/chat-execution.server";
import {
  captureStructuredLogs,
  contentResponse,
  installFakeDatabase,
  recordAiLatencyMetrics,
  restoreFakeDatabase,
  runFakeChat,
  toolCallResponse,
} from "./helpers/chat-execution-fakes";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
  restoreFakeDatabase();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

/** Relógio controlado: cada round avança o tempo simulado do gateway. */
function controlledClock(startAt = 1_000) {
  let current = startAt;
  vi.spyOn(performance, "now").mockImplementation(() => current);
  return {
    advance(ms: number): void {
      current += ms;
    },
  };
}

function finishedSpans(name: string) {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

describe("§29: fases de latência do chat não-streaming", () => {
  it("chat sem tool: acknowledge, first_content e final no mesmo round", async () => {
    installFakeDatabase();
    const clock = controlledClock();
    const records = recordAiLatencyMetrics();
    const logs = captureStructuredLogs();
    const modelCaller: ModelCaller = async () => {
      clock.advance(75);
      return contentResponse();
    };

    const result = await runFakeChat(modelCaller);

    expect(result).toMatchObject({ kind: "complete", content: "Pronto!" });
    expect(records.acknowledge).toEqual([75]);
    expect(records.firstContent).toEqual([75]);
    expect(records.final).toEqual([75]);

    const completed = logs.find((event) => event.event === "ai.chat_completed");
    expect(completed).toMatchObject({
      rounds: 1,
      timeToAcknowledgeMs: 75,
      timeToFirstContentMs: 75,
      timeToFinalMs: 75,
    });

    const sendSpan = finishedSpans("ai.chat.send");
    expect(sendSpan).toHaveLength(1);
    expect(sendSpan[0].attributes).toMatchObject({
      "app.ai.max_rounds": 8,
      "app.ai.outcome": "success",
    });
    expect(sendSpan[0].status.code).toBe(SpanStatusCode.OK);

    const roundSpans = finishedSpans("ai.chat.round");
    expect(roundSpans).toHaveLength(1);
    expect(roundSpans[0].attributes).toMatchObject({
      "app.ai.round_no": 0,
      "app.ai.outcome": "success",
    });
  });

  it("chat com uma tool: acknowledge mede só o primeiro round e first_content == final", async () => {
    installFakeDatabase();
    const clock = controlledClock();
    const records = recordAiLatencyMetrics();
    let call = 0;
    const modelCaller: ModelCaller = async () => {
      call += 1;
      if (call === 1) {
        clock.advance(120);
        return toolCallResponse();
      }
      clock.advance(200);
      return contentResponse("Feito");
    };

    await runFakeChat(modelCaller);

    expect(records.acknowledge).toEqual([120]);
    expect(records.firstContent).toEqual([320]);
    expect(records.final).toEqual([320]);

    const roundSpans = finishedSpans("ai.chat.round");
    expect(roundSpans.map((span) => span.attributes["app.ai.round_no"])).toEqual([0, 1]);
    expect(roundSpans.map((span) => span.attributes["app.ai.outcome"])).toEqual([
      "tool_round",
      "success",
    ]);
  });

  it("independência de round: acknowledge é registrado uma única vez em 4 rounds", async () => {
    installFakeDatabase();
    const clock = controlledClock();
    const records = recordAiLatencyMetrics();
    let call = 0;
    const modelCaller: ModelCaller = async () => {
      call += 1;
      clock.advance(call * 10);
      return call < 4 ? toolCallResponse() : contentResponse();
    };

    await runFakeChat(modelCaller);

    expect(records.acknowledge).toEqual([10]);
    expect(records.acknowledge).toHaveLength(1);
    expect(records.firstContent).toEqual([100]);
    expect(records.final).toEqual([100]);
    expect(finishedSpans("ai.chat.round")).toHaveLength(4);
  });

  it("gateway indisponível: nenhuma fase registrada e span ai.chat.send em ERROR", async () => {
    installFakeDatabase();
    const records = recordAiLatencyMetrics();
    const modelCaller: ModelCaller = async () => {
      throw new Error("gateway down");
    };

    await expect(runFakeChat(modelCaller)).rejects.toThrow("gateway down");

    expect(records.acknowledge).toEqual([]);
    expect(records.firstContent).toEqual([]);
    expect(records.final).toEqual([]);

    const sendSpan = finishedSpans("ai.chat.send");
    expect(sendSpan).toHaveLength(1);
    expect(sendSpan[0].status.code).toBe(SpanStatusCode.ERROR);
    const roundSpans = finishedSpans("ai.chat.round");
    expect(roundSpans).toHaveLength(1);
    expect(roundSpans[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});
