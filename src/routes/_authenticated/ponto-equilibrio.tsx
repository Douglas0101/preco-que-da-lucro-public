import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { listProductsWithMetrics } from "@/lib/products.functions";
import { calculateBreakEvenSummary, type BreakEvenServiceResult } from "@/lib/break-even";
import { expensesQueryOptions, productsWithMetricsQueryOptions } from "@/lib/query-options";
import { brl, pct, num } from "@/lib/format";
import { toDecimalString } from "@/lib/financial-values";
import { Button } from "@/components/ui/button";
import { CalcExplainer } from "@/components/ui/calc-explainer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/ponto-equilibrio")({
  head: () => ({
    meta: [
      { title: "Ponto de Equilíbrio · Preço que Dá Lucro" },
      {
        name: "description",
        content: "Descubra quanto você precisa vender para cobrir suas despesas.",
      },
    ],
  }),
  // Prefetch não-bloqueante (T2): base do cálculo em paralelo (Promise.all).
  // Erros deglutidos para o estado de erro com retry continuar no componente.
  // Dynamic import — e não os símbolos estáticos do topo: os imports do topo
  // servem o componente, que é code-split, e o plugin do router os apaga do
  // módulo de referência. Só o dinâmico mantém query-options (+ *.functions/zod)
  // FORA do grafo inicial (orçamento de bundle §17.7) — loaders não são
  // code-split.
  loader: async ({ context }) => {
    const { expensesQueryOptions, productsWithMetricsQueryOptions } =
      await import("@/lib/query-options");
    return Promise.all([
      context.queryClient.ensureQueryData(productsWithMetricsQueryOptions()).catch(() => null),
      context.queryClient.ensureQueryData(expensesQueryOptions()).catch(() => null),
    ]);
  },
  pendingComponent: PontoEquilibrioSkeleton,
  component: PontoEquilibrio,
});

type ProductDetail = Awaited<ReturnType<typeof listProductsWithMetrics>>[number];
type ProductMetricsOk = Extract<ProductDetail["metrics"], { status: "ok" }>;
type CalculationStatus = "idle" | "incomplete" | "invalid" | "ok";
type BreakEvenData = BreakEvenServiceResult;

function PontoEquilibrio() {
  const [productId, setProductId] = useState<string>("");
  const [profitTarget, setProfitTarget] = useState("");
  const [productsQuery, expensesQuery] = useQueries({
    queries: [productsWithMetricsQueryOptions(), expensesQueryOptions()],
  });

  const details = productsQuery.data ?? [];
  const products = details.map((detail) => detail.product);
  const selectedProductId =
    productId && products.some((product) => product.id === productId)
      ? productId
      : (products[0]?.id ?? "");
  const selectedDetail = details.find((detail) => detail.product.id === selectedProductId);
  const fixedExpenseAmounts = (expensesQuery.data ?? [])
    .filter((expense) => expense.type === "fixa")
    .map((expense) => expense.amount);
  const metrics =
    selectedDetail?.metrics.status === "ok"
      ? selectedDetail.metrics
      : (null as ProductMetricsOk | null);
  const selectedPrice = selectedDetail?.product.current_price ?? null;
  const calculationStatus: CalculationStatus = selectedDetail?.metrics.status ?? "idle";

  const breakEvenInput = createBreakEvenInput(
    metrics,
    selectedPrice,
    fixedExpenseAmounts,
    profitTarget,
  );
  // T1: exibição calculada client-side (0 RT) com a MESMA função pura usada
  // pelo server fn de persistência — paridade por construção. unknown/inválido
  // retorna status explícito (nunca NaN formatado como zero).
  const breakEven = breakEvenInput ? calculateBreakEvenSummary(breakEvenInput) : null;

  if (productsQuery.isPending || expensesQuery.isPending) {
    return <PontoEquilibrioSkeleton />;
  }
  if (productsQuery.isError || expensesQuery.isError) {
    return (
      <PontoErrorState
        onRetry={() => {
          void productsQuery.refetch();
          void expensesQuery.refetch();
        }}
      />
    );
  }
  return (
    <PontoView
      products={products}
      productId={selectedProductId}
      onProductChange={setProductId}
      fixedExpenses={breakEven?.fixedExpenses}
      metrics={metrics}
      selectedPrice={selectedPrice}
      calculationStatus={calculationStatus}
      breakEven={breakEven}
      profitTarget={profitTarget}
      onProfitTargetChange={setProfitTarget}
    />
  );
}

function createBreakEvenInput(
  metrics: ProductMetricsOk | null,
  selectedPrice: string | null,
  fixedExpenses: string[],
  profitTarget: string,
) {
  if (!metrics || selectedPrice === null) return null;
  return {
    fixedExpenses,
    price: selectedPrice,
    contributionMargin: toDecimalString(metrics.value.contributionMargin, 8),
    contributionMarginPct: toDecimalString(metrics.value.contributionMarginPct, 8),
    desiredProfit: profitTarget.trim() === "" ? null : toApiDecimal(profitTarget),
    unitMode: "discrete" as const,
  };
}

function PontoEquilibrioSkeleton() {
  return (
    <LoadingSkeleton className="space-y-6">
      <div>
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="mt-2 h-6 w-96 max-w-full" />
      </div>
      <Card>
        <CardContent className="grid gap-4 p-5 md:grid-cols-2">
          <div className="space-y-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((metric) => (
          <Card key={metric}>
            <CardContent className="p-5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-1 h-7 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-56" />
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-9 w-40" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-40" />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-80 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-9 w-64 max-w-full" />
        </CardContent>
      </Card>
    </LoadingSkeleton>
  );
}

function PontoErrorState({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <Card role="alert" className="border-destructive/40">
      <CardContent className="space-y-3 p-5">
        <p>Não foi possível carregar os dados do ponto de equilíbrio.</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          Tentar novamente
        </Button>
      </CardContent>
    </Card>
  );
}

function PontoView({
  products,
  productId,
  onProductChange,
  fixedExpenses,
  metrics,
  selectedPrice,
  calculationStatus,
  breakEven,
  profitTarget,
  onProfitTargetChange,
}: Readonly<{
  products: ProductDetail["product"][];
  productId: string;
  onProductChange: (value: string) => void;
  fixedExpenses: string | null | undefined;
  metrics: ProductMetricsOk | null;
  selectedPrice: string | null;
  calculationStatus: CalculationStatus;
  breakEven: BreakEvenData | null;
  profitTarget: string;
  onProfitTargetChange: (value: string) => void;
}>) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black">Ponto de Equilíbrio</h1>
        <p className="text-muted-foreground">
          Quanto você precisa vender para cobrir suas despesas fixas.
        </p>
      </div>
      <Card>
        <CardContent className="grid gap-4 p-5 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ponto-equilibrio-produto">Produto</Label>
            <Select value={productId} onValueChange={onProductChange}>
              <SelectTrigger id="ponto-equilibrio-produto">
                <SelectValue placeholder="Escolha um produto" />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.id} value={product.id}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ponto-equilibrio-despesas-fixas">Despesas fixas / mês</Label>
            <Input id="ponto-equilibrio-despesas-fixas" value={brl(fixedExpenses)} readOnly />
          </div>
        </CardContent>
      </Card>
      {metrics ? (
        <PontoMetrics
          metrics={metrics}
          selectedPrice={selectedPrice}
          breakEven={breakEven}
          profitTarget={profitTarget}
          onProfitTargetChange={onProfitTargetChange}
        />
      ) : (
        <CalculationState status={calculationStatus} />
      )}
    </div>
  );
}

function CalculationState({ status }: Readonly<{ status: CalculationStatus }>) {
  const message = {
    invalid: "Erro de cálculo. Revise os valores numéricos do produto.",
    incomplete: "Dados incompletos. Preencha os campos financeiros do produto.",
    idle: "Cadastre um produto para calcular.",
    ok: "Cadastre um produto para calcular.",
  }[status];
  return (
    <div
      role={status === "invalid" ? "alert" : undefined}
      className={status === "invalid" ? "text-destructive" : "text-muted-foreground"}
    >
      {message}
    </div>
  );
}

function PontoMetrics({
  metrics,
  selectedPrice,
  breakEven,
  profitTarget,
  onProfitTargetChange,
}: Readonly<{
  metrics: ProductMetricsOk;
  selectedPrice: string | null;
  breakEven: BreakEvenData | null;
  profitTarget: string;
  onProfitTargetChange: (value: string) => void;
}>) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Preço de venda" value={brl(selectedPrice)} />
        <Metric label="Custo unitário" value={brl(metrics.value.unitCost)} />
        <Metric
          label="Margem de contribuição"
          value={`${brl(metrics.value.contributionMargin)} (${pct(metrics.value.contributionMarginPct)})`}
        />
      </div>
      <BreakEvenCard result={breakEven} />
      <ProfitTargetCard
        result={breakEven}
        profitTarget={profitTarget}
        onProfitTargetChange={onProfitTargetChange}
      />
    </>
  );
}

function BreakEvenCard({ result }: Readonly<{ result: PontoMetricsProps["breakEven"] }>) {
  const unitsLabel = breakEvenUnitsLabel(result);
  const revenueLabel = breakEvenRevenueLabel(result);
  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle>Seu ponto de equilíbrio</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-muted-foreground">Você precisa vender</div>
          <div className="text-3xl font-black">{unitsLabel}</div>
          {result?.units.status === "reachable" && (
            <div className="text-sm text-muted-foreground">
              Resultado bruto: {num(result.units.rawUnits, 2)}; arredondado para venda inteira.
            </div>
          )}
        </div>
        <div>
          <div className="text-xs uppercase text-muted-foreground">Faturamento necessário</div>
          <div className="text-3xl font-black">{revenueLabel}</div>
        </div>
        <p className="md:col-span-2 text-sm text-muted-foreground">
          Considerando os dados informados, sua empresa precisa atingir esse volume de vendas
          mensais para cobrir despesas fixas e chegar ao ponto de equilíbrio.
        </p>
        <CalcExplainer className="md:col-span-2">
          <p>
            O ponto de equilíbrio usa a margem de contribuição do produto selecionado e as despesas
            fixas mensais cadastradas.
          </p>
          <p>
            <span className="font-medium">Fórmula:</span> unidades = despesas fixas ÷ margem de
            contribuição por unidade; faturamento = despesas fixas ÷ margem de contribuição
            percentual.
          </p>
          <p>
            Se a margem por unidade não cobre as despesas fixas em volume viável, o resultado é
            exibido como &ldquo;Não atingível&rdquo;.
          </p>
        </CalcExplainer>
      </CardContent>
    </Card>
  );
}

function breakEvenUnitsLabel(result: PontoMetricsProps["breakEven"]): string {
  if (result?.units.status === "reachable") return `${num(result.units.roundedUnits, 0)} un.`;
  if (result?.units.status === "unreachable") return "Não atingível";
  return "Erro de cálculo";
}

function breakEvenRevenueLabel(result: PontoMetricsProps["breakEven"]): string {
  if (result?.units.status === "unreachable") return "Não atingível";
  return brl(result?.revenue);
}

type PontoMetricsProps = Parameters<typeof PontoMetrics>[0];

function ProfitTargetCard({
  result,
  profitTarget,
  onProfitTargetChange,
}: Readonly<{
  result: PontoMetricsProps["breakEven"];
  profitTarget: string;
  onProfitTargetChange: (value: string) => void;
}>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quanto preciso vender para atingir meu lucro?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-w-xs space-y-1">
          <Label htmlFor="ponto-equilibrio-lucro-desejado">Lucro desejado / mês (R$)</Label>
          <Input
            id="ponto-equilibrio-lucro-desejado"
            inputMode="decimal"
            value={profitTarget}
            onChange={(event) => onProfitTargetChange(event.target.value)}
            placeholder="Ex: 3000"
          />
        </div>
        {result?.targetUnits?.status === "reachable" && (
          <div className="rounded-xl bg-secondary p-4">
            Para obter <strong>{brl(profitTarget)}</strong> de lucro / mês, você precisa vender
            aproximadamente <strong>{num(result.targetUnits.roundedUnits, 0)} unidades</strong>{" "}
            (faturamento de <strong>{brl(result.targetRevenue)}</strong>).
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-black">{value}</div>
      </CardContent>
    </Card>
  );
}

function toApiDecimal(value: string): string {
  return value.trim().replace(",", ".");
}
