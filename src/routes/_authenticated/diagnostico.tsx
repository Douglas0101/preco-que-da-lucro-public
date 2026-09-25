import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getDiagnostic } from "@/lib/diagnostic.functions";
import { expensesQueryOptions, productsListQueryOptions } from "@/lib/query-options";
import type {
  BreakEvenResult,
  CalculationResult,
  FeeRow,
  ProductComputation,
  ProductCostComputation,
} from "@/lib/finance";
import { brl, num, pct } from "@/lib/format";
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
import { AlertTriangle, Info, TrendingUp } from "lucide-react";

type DiagnosticAlert = { level: "warn" | "info" | "danger"; text: string };
type LoadStatus = "loading" | "ready" | "empty" | "error";
type ProductStatus = "idle" | "loading" | "incomplete" | "invalid" | "error" | "ok";
type DiagnosticView = Awaited<ReturnType<typeof getDiagnostic>>;

interface CurrentAnalysis {
  computation: ProductComputation;
  price: number;
  breakEvenUnits: BreakEvenResult;
  alerts: DiagnosticAlert[];
}

type DiagnosticAssumptions = {
  productId: string;
  nonPercentageVariableUnitCost: string;
  targetContributionRate: string;
};

export const Route = createFileRoute("/_authenticated/diagnostico")({
  head: () => ({
    meta: [
      { title: "Diagnóstico · Preço que Dá Lucro" },
      { name: "description", content: "Diagnóstico financeiro completo do seu produto." },
    ],
  }),
  validateSearch: (search): { produto?: string } => ({
    produto: typeof search.produto === "string" ? search.produto : undefined,
  }),
  component: Diagnostico,
});

// T5-style debounce: o diagnóstico server-side não dispara a cada tecla das
// premissas (cada key de query emite uma chamada BFF).
const DIAGNOSTIC_DEBOUNCE_MS = 400;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function Diagnostico() {
  const { produto } = Route.useSearch();
  const [productId, setProductId] = useState(produto ?? "");
  const [assumptions, setAssumptions] = useState<DiagnosticAssumptions>({
    productId: "",
    nonPercentageVariableUnitCost: "",
    targetContributionRate: "",
  });
  const [productsQuery, expensesQuery] = useQueries({
    queries: [productsListQueryOptions(), expensesQueryOptions()],
  });

  const products = productsQuery.data ?? [];
  const selectedProductId =
    productId && products.some((product) => product.id === productId)
      ? productId
      : (products[0]?.id ?? "");
  const expenses = expensesQuery.data ?? [];
  const hasUnallocatedVariableExpenses = expenses.some((expense) => expense.type === "variavel");
  const loadStatus: LoadStatus =
    productsQuery.isPending || expensesQuery.isPending
      ? "loading"
      : productsQuery.isError || expensesQuery.isError
        ? "error"
        : products.length === 0
          ? "empty"
          : "ready";
  const currentAssumptions = useMemo<DiagnosticAssumptions>(
    () =>
      assumptions.productId === selectedProductId
        ? assumptions
        : {
            productId: selectedProductId,
            nonPercentageVariableUnitCost: "",
            targetContributionRate: "",
          },
    [assumptions, selectedProductId],
  );
  const updateAssumptions = (patch: Partial<DiagnosticAssumptions>) => {
    setAssumptions({ ...currentAssumptions, ...patch, productId: selectedProductId });
  };

  const debouncedAssumptions = useDebouncedValue(currentAssumptions, DIAGNOSTIC_DEBOUNCE_MS);
  const diagnosticQuery = useQuery({
    queryKey: [
      "diagnostic",
      selectedProductId,
      debouncedAssumptions.nonPercentageVariableUnitCost,
      debouncedAssumptions.targetContributionRate,
    ],
    queryFn: () =>
      getDiagnostic({
        data: {
          product_id: selectedProductId,
          non_percentage_variable_unit_cost:
            parseOptionalNumber(debouncedAssumptions.nonPercentageVariableUnitCost) == null
              ? null
              : toApiDecimal(debouncedAssumptions.nonPercentageVariableUnitCost),
          target_contribution_rate:
            parseOptionalNumber(debouncedAssumptions.targetContributionRate) == null
              ? null
              : toApiDecimal(debouncedAssumptions.targetContributionRate),
        },
      }),
    enabled: loadStatus === "ready" && selectedProductId !== "",
    retry: false,
    staleTime: 30_000,
  });
  const diagnostic = diagnosticQuery.data as DiagnosticView | undefined;
  const diagnosticErrorReference = useMemo(
    () => (diagnosticQuery.isError ? createErrorReference("DIAG") : null),
    [diagnosticQuery.isError],
  );

  const productStatus: ProductStatus =
    loadStatus !== "ready" || !selectedProductId
      ? "idle"
      : diagnosticQuery.isPending
        ? "loading"
        : diagnosticQuery.isError
          ? "error"
          : (diagnostic?.currentStatus ?? "idle");

  const priceFormation = diagnostic?.priceFormation ?? null;

  const assumptionStatusId = "price-formation-assumptions-status";
  const variableCostHasIssue =
    priceFormation != null &&
    (resultHasField(priceFormation.minimumSustainablePrice, "nonPercentageVariableUnitCost") ||
      resultHasField(priceFormation.targetMarginPrice, "nonPercentageVariableUnitCost"));
  const targetRateHasIssue =
    priceFormation != null &&
    resultHasField(priceFormation.targetMarginPrice, "targetContributionRate");
  const variableCostIsInvalid =
    priceFormation?.minimumSustainablePrice.status === "invalid" &&
    resultHasField(priceFormation.minimumSustainablePrice, "nonPercentageVariableUnitCost");
  const targetRateIsInvalid =
    priceFormation?.targetMarginPrice.status === "invalid" &&
    resultHasField(priceFormation.targetMarginPrice, "targetContributionRate");
  const hasInvalidPriceFormation =
    priceFormation?.minimumSustainablePrice.status === "invalid" ||
    priceFormation?.targetMarginPrice.status === "invalid";
  const hasIncompletePriceFormation =
    priceFormation?.minimumSustainablePrice.status === "incomplete" ||
    priceFormation?.targetMarginPrice.status === "incomplete";
  const hasInvalidMarketReference = priceFormation?.marketReference.status === "invalid";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black">Meu Diagnóstico</h1>
        <p className="text-muted-foreground">
          Cálculos e simulações com as premissas financeiras informadas.
        </p>
      </div>

      {loadStatus === "loading" && <DiagnosticoSkeleton />}
      {loadStatus === "error" && (
        <RemoteErrorState
          message="Não foi possível carregar os dados do diagnóstico."
          reference={null}
        />
      )}
      {loadStatus === "empty" && (
        <output className="text-muted-foreground">
          Cadastre um produto para gerar o diagnóstico.
        </output>
      )}

      {products.length > 0 && loadStatus !== "error" && (
        <Card>
          <CardContent className="max-w-md p-5">
            <Label htmlFor="diagnostico-produto" className="sr-only">
              Produto para diagnóstico
            </Label>
            <Select value={selectedProductId} onValueChange={setProductId}>
              <SelectTrigger id="diagnostico-produto">
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
          </CardContent>
        </Card>
      )}

      {loadStatus === "ready" && !diagnostic && (
        <ProductState status={productStatus} errorReference={diagnosticErrorReference} />
      )}

      {diagnostic && priceFormation && (
        <>
          {diagnostic.currentStatus === "invalid" && (
            <div role="alert" className="rounded-xl border border-destructive/40 p-4 font-medium">
              Erro no diagnóstico do preço atual. Revise os valores numéricos deste produto.
            </div>
          )}
          {diagnostic.currentStatus === "incomplete" && (
            <output className="rounded-xl border p-4 text-muted-foreground">
              O diagnóstico do preço atual está incompleto, mas os custos conhecidos e a referência
              de mercado continuam disponíveis abaixo.
            </output>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Premissas da formação de preço</CardTitle>
              <p className="text-sm text-muted-foreground">
                Simulação não salva. Os campos começam vazios e são limpos ao trocar de produto.
              </p>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <AssumptionField
                id="diagnostico-custo-variavel-unitario"
                label="Outros custos variáveis por unidade (R$)"
                help="Informe somente um valor já conhecido por unidade; não use o total mensal. Digite 0 apenas se tiver confirmado que não existem outros custos unitários."
                value={currentAssumptions.nonPercentageVariableUnitCost}
                describedBy={variableCostHasIssue ? assumptionStatusId : undefined}
                invalid={variableCostIsInvalid}
                onChange={(value) => updateAssumptions({ nonPercentageVariableUnitCost: value })}
              />
              <AssumptionField
                id="diagnostico-margem-alvo"
                label="Margem de contribuição alvo (%)"
                help="Informe uma meta explícita. Nenhuma margem padrão é presumida."
                value={currentAssumptions.targetContributionRate}
                describedBy={targetRateHasIssue ? assumptionStatusId : undefined}
                invalid={targetRateIsInvalid}
                onChange={(value) => updateAssumptions({ targetContributionRate: value })}
              />
              {hasInvalidPriceFormation && (
                <div
                  id={assumptionStatusId}
                  role="alert"
                  className="rounded-xl border border-destructive/40 p-4 font-medium md:col-span-2"
                >
                  Erro de cálculo. Revise os custos, as taxas e a margem alvo informada.
                </div>
              )}
              {!hasInvalidPriceFormation && hasIncompletePriceFormation && (
                <div
                  id={assumptionStatusId}
                  aria-live="polite"
                  className="rounded-xl border p-4 text-sm text-muted-foreground md:col-span-2"
                >
                  Complete as premissas manuais e os dados financeiros necessários para liberar cada
                  cálculo. Valores ausentes não são tratados como zero.
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <Kpi
              label="Custo unitário calculado"
              value={formatCostResult(diagnostic.cost)}
              description="Cálculo do motor financeiro"
              explain={
                <>
                  <p>
                    Soma o custo dos ingredientes e das embalagens/materiais de cada unidade e
                    divide pelo rendimento cadastrado do produto.
                  </p>
                  <p>
                    <span className="font-medium">Fórmula:</span> (ingredientes + embalagens) ÷
                    rendimento.
                  </p>
                </>
              }
            />
            <Kpi
              label="Preço atual informado"
              value={brl(diagnostic.currentPrice)}
              description="Valor praticado cadastrado"
              explain={
                <p>
                  Este valor não é calculado: é o preço de venda que você cadastrou para o produto.
                  Ele serve de base para a margem de contribuição e os alertas.
                </p>
              }
            />
            <Kpi
              label="Preço mínimo para custos unitários"
              value={formatPriceResult(priceFormation.minimumSustainablePrice)}
              description="Cálculo no escopo informado"
              explain={
                <>
                  <p>
                    Preço que cobre o custo unitário, os outros custos variáveis por unidade,
                    impostos e taxas percentuais — sem embutir lucro.
                  </p>
                  <p>
                    <span className="font-medium">Fórmula:</span> custo total por unidade ÷ [1 −
                    (impostos + taxas) ÷ 100].
                  </p>
                </>
              }
            />
            <Kpi
              label="Preço para margem-alvo"
              value={formatPriceResult(priceFormation.targetMarginPrice)}
              description="Simulação não salva"
              explain={
                <>
                  <p>
                    Preço que além de cobrir custos, impostos e taxas, ainda garante a margem de
                    contribuição alvo que você informou nas premissas.
                  </p>
                  <p>
                    <span className="font-medium">Fórmula:</span> custo total por unidade ÷ [1 −
                    (impostos + taxas + margem alvo) ÷ 100].
                  </p>
                </>
              }
            />
            <Kpi
              label="Preço médio de mercado informado"
              value={formatPriceResult(priceFormation.marketReference)}
              description="Referência externa sem fonte estruturada"
              explain={
                <p>
                  Valor de referência informado por você sobre o mercado. Não participa dos
                  cálculos; serve apenas para comparação no diagnóstico.
                </p>
              }
            />
          </div>

          {hasInvalidMarketReference && (
            <div role="alert" className="rounded-xl border border-destructive/40 p-4 font-medium">
              A referência de mercado informada contém um valor numérico inválido.
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Escopo dos preços calculados</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                O preço mínimo cobre somente o custo unitário, os outros custos variáveis por
                unidade informados, impostos e taxas percentuais cadastradas. Ele não garante a
                cobertura das despesas fixas do negócio.
              </p>
              {hasUnallocatedVariableExpenses && (
                <p className="rounded-xl border border-warning/40 bg-warning/5 p-3 text-foreground">
                  Existem despesas variáveis periódicas cadastradas que não entram nestes preços:
                  falta um volume ou direcionador confiável para convertê-las em custo por unidade.
                </p>
              )}
              <p>
                A referência de mercado é contexto informado, não recomendação. Posicionamento,
                qualidade, capacidade e estratégia continuam sendo decisões do usuário.
              </p>
            </CardContent>
          </Card>

          {diagnostic.cost.status === "ok" && (
            <Card>
              <CardHeader>
                <CardTitle>Estrutura financeira</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm md:grid-cols-2">
                <Line
                  label="Custo dos ingredientes"
                  value={brl(diagnostic.cost.value.recipeCost)}
                />
                <Line
                  label="Custo de embalagem/materiais"
                  value={brl(diagnostic.cost.value.packagingCost)}
                />
                <Line label="Custo unitário" value={brl(diagnostic.cost.value.unitCost)} />
                <Line label="Despesas fixas cadastradas" value={brl(diagnostic.fixedExpenses)} />
                <Line
                  label="Margem de contribuição atual"
                  value={
                    diagnostic.currentAnalysis
                      ? `${brl(diagnostic.currentAnalysis.computation.contributionMargin)} (${pct(diagnostic.currentAnalysis.computation.contributionMarginPct)})`
                      : "—"
                  }
                />
                <Line
                  label="Ponto de equilíbrio do preço atual"
                  value={
                    diagnostic.currentAnalysis
                      ? diagnostic.currentAnalysis.breakEvenUnits.status === "reachable"
                        ? `${num(diagnostic.currentAnalysis.breakEvenUnits.roundedUnits, 0)} un. (bruto ${num(diagnostic.currentAnalysis.breakEvenUnits.rawUnits, 2)})`
                        : diagnostic.currentAnalysis.breakEvenUnits.status === "unreachable"
                          ? "Não atingível"
                          : "Erro de cálculo"
                      : "—"
                  }
                />
              </CardContent>
            </Card>
          )}

          {diagnostic.currentAnalysis &&
            (diagnostic.currentAnalysis.alerts.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-warning" /> Alertas e interpretações
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {diagnostic.currentAnalysis.alerts.map((alert) => (
                    <div
                      key={`${alert.level}-${alert.text}`}
                      className={`flex gap-3 rounded-xl border p-3 text-sm ${
                        alert.level === "danger"
                          ? "border-destructive/40 bg-destructive/5"
                          : alert.level === "warn"
                            ? "border-warning/40 bg-warning/10"
                            : "border-primary/30 bg-secondary"
                      }`}
                    >
                      {alert.level === "danger" ? (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                      ) : alert.level === "warn" ? (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                      ) : (
                        <Info className="h-4 w-4 shrink-0 text-primary" />
                      )}
                      <span>{alert.text}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : (
              <Card className="border-success/30">
                <CardContent className="flex items-center gap-3 p-5">
                  <TrendingUp className="h-5 w-5 text-success" />
                  <span>
                    Nenhum alerta foi identificado pelas regras atuais. Continue monitorando os
                    dados e o contexto de mercado.
                  </span>
                </CardContent>
              </Card>
            ))}
        </>
      )}
    </div>
  );
}

function DiagnosticoSkeleton() {
  return (
    <LoadingSkeleton className="space-y-6">
      <div>
        <Skeleton className="h-9 w-64 max-w-full" />
        <Skeleton className="mt-2 h-6 w-80 max-w-full" />
      </div>
      <Card>
        <CardContent className="max-w-md p-5">
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
      <DiagnosticoDataSkeleton />
    </LoadingSkeleton>
  );
}

function DiagnosticoDataSkeleton() {
  return (
    <>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-64 max-w-full" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((field) => (
            <div key={field} className="space-y-2">
              <Skeleton className="h-5 w-56 max-w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-4 w-72 max-w-full" />
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((kpi) => (
          <Card key={kpi}>
            <CardContent className="p-5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-1 h-7 w-24" />
              <Skeleton className="mt-1 h-4 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

function ProductState({
  status,
  errorReference,
}: Readonly<{ status: ProductStatus; errorReference: string | null }>) {
  if (status === "error") {
    return (
      <RemoteErrorState
        message="Não foi possível carregar os dados do produto."
        reference={errorReference}
      />
    );
  }
  if (status === "loading") {
    return (
      <LoadingSkeleton className="space-y-6">
        <DiagnosticoDataSkeleton />
      </LoadingSkeleton>
    );
  }
  return (
    <output
      role={status === "invalid" ? "alert" : undefined}
      className={
        status === "invalid"
          ? "rounded-xl border border-destructive/40 p-4 font-medium"
          : "text-muted-foreground"
      }
    >
      {status === "invalid"
        ? "Erro de cálculo. Revise os valores numéricos do produto."
        : status === "incomplete"
          ? "Dados incompletos. Os resultados disponíveis serão apresentados separadamente."
          : "Carregando dados do produto..."}
    </output>
  );
}

function AssumptionField({
  id,
  label,
  help,
  value,
  describedBy,
  invalid,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  help: string;
  value: string;
  describedBy?: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}>) {
  const helpId = `${id}-help`;
  const descriptionIds = [helpId, describedBy].filter(Boolean).join(" ");
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        aria-describedby={descriptionIds}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={helpId} className="text-xs text-muted-foreground">
        {help}
      </p>
    </div>
  );
}

function Kpi({
  label,
  value,
  description,
  explain,
}: Readonly<{
  label: string;
  value: string;
  description: string;
  explain?: ReactNode;
}>) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-black">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        {explain && <CalcExplainer className="mt-3">{explain}</CalcExplainer>}
      </CardContent>
    </Card>
  );
}

function Line({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex justify-between gap-3 border-b py-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function RemoteErrorState({
  message,
  reference,
}: Readonly<{ message: string; reference: string | null }>) {
  return (
    <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 p-4">
      <p className="font-medium">{message}</p>
      {reference && (
        <p className="text-xs text-muted-foreground">Referência de atendimento: {reference}</p>
      )}
      <Button type="button" variant="outline" onClick={() => window.location.reload()}>
        Tentar novamente
      </Button>
    </div>
  );
}

function resultHasField(result: CalculationResult<number>, field: string): boolean {
  return result.status === "incomplete"
    ? result.missing.some((missing) => missing.field === field)
    : result.status === "invalid"
      ? result.errors.some((error) => error.field === field)
      : false;
}

function formatCostResult(result: CalculationResult<ProductCostComputation>): string {
  return result.status === "ok"
    ? brl(result.value.unitCost)
    : result.status === "invalid"
      ? brl(Number.NaN)
      : brl(null);
}

function formatPriceResult(result: CalculationResult<number>): string {
  return result.status === "ok"
    ? brl(result.value)
    : result.status === "invalid"
      ? brl(Number.NaN)
      : brl(null);
}

function parseOptionalNumber(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toApiDecimal(value: string): string | null {
  const normalized = value.trim().replace(",", ".");
  return normalized === "" ? null : normalized;
}

function createErrorReference(prefix: string): string {
  const token =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Date.now().toString(36);
  return `${prefix}-${token}`.toUpperCase();
}
