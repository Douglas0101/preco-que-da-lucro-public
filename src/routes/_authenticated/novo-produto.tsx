import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { sendChatMessage, clearChatHistory } from "@/lib/chat.functions";
import { chatHistoryQueryOptions } from "@/lib/query-options";
import { renderChatMarkdown } from "@/lib/chat-markdown";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, RotateCcw, Send, Bot, User } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { chatStatusLabel, isChatBusy, transitionChatState, type ChatState } from "@/lib/chat-fsm";

export const Route = createFileRoute("/_authenticated/novo-produto")({
  head: () => ({
    meta: [
      { title: "Novo Produto · Preço que Dá Lucro" },
      { name: "description", content: "Cadastre um produto conversando com a IA." },
    ],
  }),
  component: NovoProduto,
});

interface Msg {
  id?: string;
  role: "user" | "assistant";
  content: string;
}

function NovoProduto() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const send = useServerFn(sendChatMessage);
  const clear = useServerFn(clearChatHistory);
  const historyQuery = useQuery(chatHistoryQueryOptions());
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [chatState, setChatState] = useState<ChatState>("idle");
  const loading = isChatBusy(chatState);
  const [currentProductId, setCurrentProductId] = useState<string | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const history = historyQuery.data;
    if (!history) {
      if (historyQuery.isError) {
        setMessages([
          {
            role: "assistant",
            content: "⚠️ Não foi possível restaurar o histórico da conversa.",
          },
        ]);
      }
      return;
    }
    const restored = history.messages.reduce<Msg[]>((messages, message) => {
      if (message.role === "user" || message.role === "assistant") {
        messages.push({ id: message.id, role: message.role, content: message.content });
      }
      return messages;
    }, []);

    if (restored.length === 0) {
      setMessages([
        {
          role: "assistant",
          content:
            "Olá! Sou seu consultor financeiro. Vamos descobrir juntos quanto realmente custa produzir e vender seu produto. **Qual produto ou receita você gostaria de analisar primeiro?**",
        },
      ]);
    } else {
      setMessages(restored);
    }
    setCurrentProductId(history.currentProductId);
    inputRef.current?.focus();
  }, [historyQuery.data, historyQuery.isError]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setChatState((state) => transitionChatState(state, { type: "SUBMIT" }));
    try {
      const res = await send({ data: { message: text, currentProductId } });
      setMessages((m) => [...m, { role: "assistant", content: res.content }]);
      if (res.currentProductId) setCurrentProductId(res.currentProductId);
      await queryClient.invalidateQueries({ queryKey: ["chat", "history"] });
      setChatState((state) => transitionChatState(state, { type: "ASSISTANT_RESPONSE" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao enviar";
      toast.error(msg);
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${msg}` }]);
      setChatState((state) => transitionChatState(state, { type: "FAIL" }));
    } finally {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function reset() {
    try {
      await clear();
      await queryClient.invalidateQueries({ queryKey: ["chat", "history"] });
      setMessages([
        {
          role: "assistant",
          content: "Novo começo! Qual produto você gostaria de cadastrar agora?",
        },
      ]);
      setCurrentProductId(null);
      setChatState((state) => transitionChatState(state, { type: "RESET" }));
    } catch {
      toast.error("Não foi possível recomeçar a conversa.");
    }
  }

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col lg:h-[calc(100vh-6rem)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black md:text-3xl">Cadastro conversacional</h1>
          <p className="text-sm text-muted-foreground">
            Converse como se estivesse falando com um consultor.
          </p>
        </div>
        <div className="flex gap-2">
          {currentProductId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate({ to: "/diagnostico", search: { produto: currentProductId } })
              }
            >
              Ver produto
            </Button>
          )}
          <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
            <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="gap-2" />}>
              <RotateCcw className="h-4 w-4" /> Recomeçar
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Iniciar uma nova conversa?</AlertDialogTitle>
                <AlertDialogDescription>
                  Todo o histórico da conversa atual será apagado permanentemente.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => void reset()}>
                  Apagar e recomeçar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded-2xl border bg-card p-4 md:p-6 shadow-[var(--shadow-soft)]">
        <div className="space-y-4" role="log" aria-live="polite" aria-relevant="additions text">
          {messages.map((m, i) => (
            <MessageBubble key={m.id ?? i} role={m.role} content={m.content} />
          ))}
          {loading && (
            <output
              className="flex items-start gap-3"
              aria-live="polite"
              aria-label={chatStatusLabel(chatState) ?? "Consultor respondendo"}
            >
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                <Bot className="h-4 w-4" />
              </div>
              <div className="rounded-2xl bg-secondary px-4 py-2.5 text-sm text-muted-foreground">
                <span className="inline-flex gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
                </span>
              </div>
            </output>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={submit}
        className="mt-4 flex items-end gap-2 rounded-2xl border bg-card p-3 shadow-[var(--shadow-soft)]"
      >
        <Label htmlFor="novo-produto-mensagem" className="sr-only">
          Mensagem para o consultor
        </Label>
        <Textarea
          id="novo-produto-mensagem"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Escreva sua resposta..."
          rows={1}
          className="min-h-[44px] resize-none border-0 shadow-none focus-visible:ring-0"
          disabled={loading}
        />
        <Button type="submit" size="icon" disabled={loading || !input.trim()} aria-label="Enviar">
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

function MessageBubble({
  role,
  content,
}: Readonly<{ role: "user" | "assistant"; content: string }>) {
  if (role === "user") {
    return (
      <div className="flex items-start justify-end gap-3">
        <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {content}
        </div>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-primary">
          <User className="h-4 w-4" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed">
        {renderChatMarkdown(content)}
      </div>
    </div>
  );
}
