import { describe, expect, it } from "vitest";
import { auditEvents, idempotencyRecords, toolExecutions } from "@/db/schema";
import { sanitizeToolInput } from "@/lib/ai/tool-payload";
import { runRegisteredTool } from "@/lib/ai/tool-runner";
import { FakeTransaction, fakeContext, usageId } from "./helpers/tool-runner-fakes";

function hasLoneSurrogate(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

describe("persistência da tool execution (§14.3)", () => {
  it("grava tool_call_id, input validado e usage_id na execução", async () => {
    const transaction = new FakeTransaction();
    const result = await runRegisteredTool({
      context: fakeContext(transaction),
      name: "create_product",
      rawArguments: JSON.stringify({ name: "Bolo persistido" }),
      idempotencyKey: "conversation:call-1",
      toolCallId: "call-1",
      usageId,
    });

    expect(result.ok).toBe(true);
    const [execution] = transaction.insertsFor(toolExecutions);
    expect(execution).toMatchObject({
      toolName: "create_product",
      input: { name: "Bolo persistido" },
      toolCallId: "call-1",
      usageId,
      status: "pending",
    });
    const [updated] = transaction.updatesFor(toolExecutions);
    expect(updated).toMatchObject({ status: "succeeded" });
    expect(transaction.insertsFor(auditEvents)).toHaveLength(1);
  });

  it("grava input null e mantém o trace quando o JSON é inválido", async () => {
    const transaction = new FakeTransaction();
    const result = await runRegisteredTool({
      context: fakeContext(transaction),
      name: "create_product",
      rawArguments: "{não-é-json",
      idempotencyKey: "conversation:call-2",
      toolCallId: "call-2",
      usageId,
    });

    expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR", replayed: false });
    const [rejected] = transaction.insertsFor(toolExecutions);
    expect(rejected).toMatchObject({
      status: "failed",
      errorCode: "VALIDATION_ERROR",
      input: null,
      toolCallId: "call-2",
      usageId,
    });
  });

  it("redige chaves sensíveis no input de uma rejeição", async () => {
    const transaction = new FakeTransaction();
    const result = await runRegisteredTool({
      context: fakeContext(transaction, ["viewer"]),
      name: "create_product",
      rawArguments: JSON.stringify({
        name: "Sem permissão",
        authorization: "Bearer super-secret",
        api_key: "chave-secreta",
        cookie: "session=abc",
        pricing: "preservado",
      }),
      idempotencyKey: "conversation:call-3",
      toolCallId: "call-3",
      usageId,
    });

    expect(result).toEqual({ ok: false, code: "AUTHORIZATION_ERROR", replayed: false });
    const [rejected] = transaction.insertsFor(toolExecutions);
    expect(rejected.input).toEqual({
      name: "Sem permissão",
      authorization: "[REDACTED]",
      api_key: "[REDACTED]",
      cookie: "[REDACTED]",
      pricing: "preservado",
    });
  });

  it("persiste input sem lone surrogates mesmo com escapes no JSON de entrada", async () => {
    const transaction = new FakeTransaction();
    const result = await runRegisteredTool({
      context: fakeContext(transaction),
      name: "create_product",
      rawArguments: '{"name":"Bolo \\ud83d com low \\udc00 e par \\ud83d\\ude00"}',
      idempotencyKey: "conversation:call-surrogate",
      toolCallId: "call-surrogate",
      usageId,
    });

    expect(result.ok).toBe(true);
    const [execution] = transaction.insertsFor(toolExecutions);
    expect(execution.input).toEqual({ name: "Bolo  com low  e par 😀" });
    expect(hasLoneSurrogate(JSON.stringify(execution.input))).toBe(false);
  });
});

describe("admissão por rate limit (§20.5)", () => {
  it("devolve RATE_LIMIT sem ocupar a chave de idempotência", async () => {
    const transaction = new FakeTransaction();
    transaction.denyRateLimit();

    const result = await runRegisteredTool({
      context: fakeContext(transaction),
      name: "create_product",
      rawArguments: JSON.stringify({ name: "Bolo throttled" }),
      idempotencyKey: "conversation:call-throttled",
      toolCallId: "call-throttled",
      usageId,
    });

    expect(result).toEqual({ ok: false, code: "RATE_LIMIT", replayed: false });
    expect(transaction.insertsFor(idempotencyRecords)).toHaveLength(0);
    const [rejected] = transaction.insertsFor(toolExecutions);
    expect(rejected).toMatchObject({
      toolName: "create_product",
      status: "failed",
      errorCode: "RATE_LIMIT",
      toolCallId: "call-throttled",
      usageId,
    });
  });

  it("ocupa a chave de idempotência quando o bucket aprova", async () => {
    const transaction = new FakeTransaction();

    const result = await runRegisteredTool({
      context: fakeContext(transaction),
      name: "create_product",
      rawArguments: JSON.stringify({ name: "Bolo aceito" }),
      idempotencyKey: "conversation:call-accepted",
    });

    expect(result.ok).toBe(true);
    expect(transaction.insertsFor(idempotencyRecords)).toHaveLength(1);
  });
});

describe("sanitizeToolInput", () => {
  it("redige somente chaves sensíveis estritas", () => {
    expect(
      sanitizeToolInput({
        authorization: "Bearer x",
        Cookie: "a=1",
        token: "t",
        secret: "s",
        password: "p",
        api_key: "k",
        access_token: "não-redige",
        pricing: "não-redige",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      Cookie: "[REDACTED]",
      token: "[REDACTED]",
      secret: "[REDACTED]",
      password: "[REDACTED]",
      api_key: "[REDACTED]",
      access_token: "não-redige",
      pricing: "não-redige",
    });
  });

  it("aplica os limites de string, array, chave, profundidade e número de chaves", () => {
    const longKey = "k".repeat(130);
    const wide = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`chave_${index}`, index]),
    );
    const sanitized = sanitizeToolInput({
      text: "x".repeat(9_000),
      list: Array.from({ length: 150 }, (_, index) => index),
      [longKey]: "valor",
      wide,
      infinite: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
    });

    expect(sanitized?.text).toHaveLength(8_000);
    expect(sanitized?.list).toHaveLength(100);
    expect(Object.keys(sanitized?.wide ?? {})).toHaveLength(100);
    expect(Object.keys(sanitized ?? {}).find((key) => key.startsWith("kkk"))).toHaveLength(120);
    expect(sanitized?.infinite).toBeNull();
    expect(sanitized?.nan).toBeNull();

    let deep: unknown = "fim";
    for (let level = 0; level < 11; level += 1) deep = { level: deep };
    let cursor: unknown = sanitizeToolInput(deep);
    let levels = 0;
    while (cursor && typeof cursor === "object" && "level" in cursor) {
      cursor = (cursor as { level: unknown }).level;
      levels += 1;
    }
    expect(levels).toBe(9);
    expect(cursor).toBeNull();
  });

  it("remove lone surrogates e preserva pares válidos", () => {
    const sanitized = sanitizeToolInput({
      high: "antes \ud83d depois",
      low: "antes \udc00 depois",
      pair: "antes \u{1F680} depois",
    });

    expect(sanitized).toEqual({
      high: "antes  depois",
      low: "antes  depois",
      pair: "antes 🚀 depois",
    });
    expect(hasLoneSurrogate(JSON.stringify(sanitized))).toBe(false);
  });

  it("não corta par surrogate no limite de 8000 unidades UTF-16", () => {
    const sanitized = sanitizeToolInput({
      fits: "a".repeat(7_998) + "🚀",
      cuts: "a".repeat(7_999) + "🚀b",
    });

    expect(sanitized?.fits).toHaveLength(8_000);
    expect((sanitized?.fits as string).endsWith("🚀")).toBe(true);
    expect(sanitized?.cuts).toHaveLength(7_999);
    expect(hasLoneSurrogate(sanitized?.fits as string)).toBe(false);
    expect(hasLoneSurrogate(sanitized?.cuts as string)).toBe(false);
  });

  it("retorna null para payload que não é objeto JSON", () => {
    expect(sanitizeToolInput(null)).toBeNull();
    expect(sanitizeToolInput("texto")).toBeNull();
    expect(sanitizeToolInput([1, 2, 3])).toBeNull();
    expect(sanitizeToolInput(42)).toBeNull();
  });
});
