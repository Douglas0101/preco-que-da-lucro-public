import { afterEach, describe, expect, it, vi } from "vitest";
import { callModelForTests, retryDelayMsForTests } from "@/lib/chat.functions";
import { GATEWAY_TOOLS } from "@/lib/ai/tool-registry";

const messages = [{ role: "user" as const, content: "Olá" }];

function successResponse(): Response {
  return Response.json({ choices: [{ message: { content: "Tudo bem" } }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_MODEL_MAX_ATTEMPTS;
});

describe("limites do gateway de IA", () => {
  it("repete somente uma falha transitória e limita a duas tentativas", async () => {
    process.env.AI_GATEWAY_API_KEY = crypto.randomUUID();
    process.env.AI_MODEL_MAX_ATTEMPTS = "2";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callModelForTests(messages, GATEWAY_TOOLS, new AbortController().signal),
    ).resolves.toMatchObject({
      choices: [{ message: { content: "Tudo bem" } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("não repete quota ou rate limit", async () => {
    process.env.AI_GATEWAY_API_KEY = crypto.randomUUID();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callModelForTests(messages, GATEWAY_TOOLS, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "RATE_LIMIT",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propaga cancelamento como AI_TIMEOUT", async () => {
    process.env.AI_GATEWAY_API_KEY = crypto.randomUUID();
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );

    await expect(
      callModelForTests(messages, GATEWAY_TOOLS, controller.signal),
    ).rejects.toMatchObject({
      code: "AI_TIMEOUT",
      retryable: true,
    });
  });
});
