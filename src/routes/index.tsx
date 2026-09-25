import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { buttonVariants } from "@/components/ui/button";
import { Sparkles, MessageCircle, Calculator, Scale, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Preço que Dá Lucro — avalie preços sustentáveis para seu produto" },
      {
        name: "description",
        content:
          "Ferramenta financeira conversacional para pequenos empreendedores. Cadastre produtos por chat, calcule custo, margem e ponto de equilíbrio.",
      },
      { property: "og:title", content: "Preço que Dá Lucro" },
      {
        property: "og:description",
        content: "Descubra por quanto vender seu produto conversando com uma IA.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    let active = true;
    // T6: reutiliza a query de sessão compartilhada (["auth","session"]) —
    // mesmo get-session único do layout autenticado; import dinâmico mantém o
    // auth client fora do grafo SSR da landing.
    void import("@/lib/session-context")
      .then(async ({ sessionQueryOptions, SessionUnavailableError }) => {
        try {
          const user = await queryClient.fetchQuery(sessionQueryOptions());
          if (active && user) await navigate({ to: "/inicio", replace: true });
        } catch (error) {
          // Visitante anônimo: permanece na landing (comportamento atual).
          if (!(error instanceof SessionUnavailableError)) throw error;
        }
      })
      .catch((error: unknown) => {
        if (active) console.error("Could not validate the server session", error);
      });

    return () => {
      active = false;
    };
  }, [navigate, queryClient]);

  return (
    <div className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles className="h-5 w-5" />
          </div>
          <span className="font-bold">Preço que Dá Lucro</span>
        </div>
        <Link to="/auth" className={buttonVariants({ variant: "ghost" })}>
          Entrar
        </Link>
      </header>

      <section className="mx-auto max-w-6xl px-6 pt-8 pb-20 md:pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
            <Sparkles className="h-3 w-3" /> IA que conversa como um consultor
          </span>
          <h1 className="mt-6 text-4xl font-black leading-tight tracking-tight md:text-6xl">
            Entenda a <span className="text-primary">faixa de preço</span> do seu produto
            conversando.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Vamos descobrir juntos quanto custa o seu produto, qual preço faz sentido para o seu
            negócio e quanto você precisa vender para começar a ter lucro.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to="/auth" className={buttonVariants({ size: "lg", className: "gap-2" })}>
              Começar agora <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <div className="mx-auto mt-16 grid max-w-4xl gap-4 md:grid-cols-3">
          {[
            {
              icon: MessageCircle,
              title: "Cadastro por conversa",
              desc: "Escreva a receita do seu jeito. A IA organiza tudo para você.",
            },
            {
              icon: Calculator,
              title: "Cálculos precisos",
              desc: "Custo, margem de contribuição e preços calculados com premissas explícitas.",
            },
            {
              icon: Scale,
              title: "Ponto de equilíbrio",
              desc: "Saiba exatamente quanto vender para parar de ter prejuízo.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-soft)]"
            >
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-secondary text-primary">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-bold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
