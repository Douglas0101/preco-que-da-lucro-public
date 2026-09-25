import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveSimulation } from "@/lib/financial.functions";
import {
  expensesQueryOptions,
  financialSimulationQueryOptions,
  productsWithMetricsQueryOptions,
  savedSimulationsQueryOptions,
  type FinancialSimulationInput,
} from "@/lib/query-options";
import {
  sumFiniteNumbers,
  type FeeRow,
  type ProductComputation,
  type ResolvedVolumeSource,
} from "@/lib/finance";
import { scenarioExplanation, type ScenarioEcho } from "@/lib/calc-explanation";
import { brl, decimalInput, num, pct } from "@/lib/format";
import { CalcExplainer } from "@/components/ui/calc-explainer";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/simulacoes")({
  head: () => ({
    meta: [
      { title: "Simulações · Preço que Dá Lucro" },
      { name: "description", content: "Simule preço, custo, despesas e volume." },
    ],
  }),
  // `Simulacoes` NÃO pode ser exportado: o code splitter do router só separa
  // `component` quando o binding não é exportado (`autoCodeSplitting` §17.6).
  // Exportá-lo inlina a tela inteira — e com ela `@/lib/query-options`, os
  // primitivos de UI e `@/lib/format` — no módulo de referência que o
  // `routeTree.gen.ts` importa estaticamente, ou seja, no grafo inicial.
  // Os testes alcançam a tela por `Route.options.component`.
  component: Simulacoes,
});

type LoadStatus = "loading" | "ready" | "empty" | "error" | "invalid";
type ProductStatus = "idle" | "loading" | "incomplete" | "invalid" | "error" | "ok";

export type ProductBaseline = ProductComputation & {
  name: string;
  price: number;
  taxRate: number | null;
  fees: FeeRow[];
};

type SimulationForm = {
  productId: string;
  price: string;
  unitCost: string;
  fixed: string;
  volume: string;
  volumeSource: SimulationVolumeSource;
};

/* eslint-disable react-refresh/only-export-components */
/**
 * Origens de volume oferecidas na UI. `real` vem do domínio de vendas (o BFF
 * de simulação a recusa) e `unknown` é o estado vazio — nenhuma das duas é
 * selecionável aqui.
 */
export type SimulationVolumeSource = Extract<
  ResolvedVolumeSource,
  "manual_simulation" | "forecast"
>;

export const SIMULATION_VOLUME_SOURCES: readonly SimulationVolumeSource[] = [
  "manual_simulation",
  "forecast",
];

interface VolumeSourceDisplay {
  cardTitle: string;
  headerHint: string;
  optionLabel: string;
  optionHint: string;
  /** O volume é a origem declarada: chamá-lo de simulado seria falso numa projeção. */
  volumeFieldLabel: string;
  badge: string;
  badgeTitle: string;
  /** A persistência (`simulation.service.ts`) aceita apenas `manual_simulation`. */
  persistable: boolean;
}

/**
 * Fontes diferentes têm rótulos diferentes: um cenário hipotético informado à
 * mão é uma simulação; uma projeção de volume é uma estimativa. O motor calcula
 * as duas com a mesma matemática — o que muda é a origem declarada do volume e
 * o direito de ser salva.
 */
export const VOLUME_SOURCE_DISPLAY: Record<SimulationVolumeSource, VolumeSourceDisplay> = {
  manual_simulation: {
    cardTitle: "Simulação manual",
    headerHint: "O volume e os resultados abaixo são hipotéticos e não alimentam KPIs factuais.",
    optionLabel: "Simulação manual",
    optionHint: "Volume informado por você como hipótese. Pode ser salva.",
    volumeFieldLabel: "Vendas simuladas (unidades)",
    badge: "Simulação",
    badgeTitle: "Resultado hipotético: não é dado factual e não alimenta KPIs.",
    persistable: true,
  },
  forecast: {
    cardTitle: "Estimativa de volume",
    headerHint:
      "A estimativa e os resultados abaixo são hipotéticos: partem do volume projetado que você informa e não alimentam KPIs factuais.",
    optionLabel: "Estimativa (projeção)",
    optionHint: "Volume projetado por você. Não é persistida nesta versão.",
    volumeFieldLabel: "Vendas estimadas (unidades)",
    badge: "Estimativa",
    badgeTitle:
      "Projeção de volume informada por você: não é dado factual, não alimenta KPIs e ainda não é persistida.",
    persistable: false,
  },
};

/**
 * Rótulos da origem do volume exibida junto do resultado. O valor vem do eco do
 * motor (`ResolvedVolumeSource`), por isso o mapa é total: `real` existe só para
 * o tipo fechar e nunca é devolvido pelo BFF de simulação.
 */
const VOLUME_ORIGIN_LABELS: Record<ResolvedVolumeSource, string> = {
  real: "Vendas reais",
  manual_simulation: "Informado manualmente",
  forecast: "Estimativa informada (projeção)",
};

/**
 * Origem do volume por extenso, no "Como calculamos?" do resultado. A
 * estimativa é uma projeção INFORMADA por quem usa o app: o motor não tem série
 * histórica nem modelo estatístico, e calcula a projeção com a mesma matemática
 * da simulação manual — o que muda é só a origem declarada do volume (§18.1).
 */
export const VOLUME_ORIGIN_EXPLANATION: Record<ResolvedVolumeSource, string> = {
  real: "soma das vendas registradas; nenhuma projeção entra aqui.",
  manual_simulation: "volume hipotético informado por você como premissa do cenário.",
  forecast:
    "projeção de volume informada por você — não é previsão estatística: o motor não usa série histórica nem modelo. A matemática é a mesma da simulação manual; muda apenas a origem declarada do volume.",
};

/**
 * Id do aviso que explica por que uma estimativa não pode ser salva. Fica
 * ligado ao botão por `aria-describedby` (o motivo não pode depender de o
 * usuário adivinhar).
 */
const SIMULATION_SAVE_BLOCKED_NOTE_ID = "simulacao-origem-nao-persistivel";

// T5: debounce da simulação manual — runSimulation não dispara a cada tecla.
// Exportado para o teste de race; os contratos da UI (origem de volume, display,
// debounce) vivem junto da rota que os usa.
export const SIMULATION_DEBOUNCE_MS = 400;

/**
 * Race guard do debounce (T5): cada agendamento ganha uma geração; o timer só
 * aplica se ainda for a geração mais recente (o cleanup do effect cancela o
 * timer anterior). Combinado com a cache key por input do react-query, uma
 * resposta lenta antiga NUNCA sobrescreve a exibição atual.
 */
export function createDebounceScheduler(delayMs: number) {
  let generation = 0;
  return {
    schedule(apply: () => void): () => void {
      generation += 1;
      const scheduled = generation;
      const timer = window.setTimeout(() => {
        if (scheduled === generation) apply();
      }, delayMs);
      return () => window.clearTimeout(timer);
    },
  };
}

const EMPTY_SIMULATION_INPUT: FinancialSimulationInput = {
  price: null,
  unitCost: null,
  fixedExpenses: null,
  volume: null,
  taxRate: null,
  fees: [],
  volumeSource: "manual_simulation",
};

/**
 * Mapeamento puro formulário → input do server fn. Campo vazio vira null
 * (unknown ≠ zero, INV-006/009): nenhum volume padrão é presumido.
 */
export function buildSimulationInput(
  form: SimulationForm,
  base: ProductBaseline | null,
): FinancialSimulationInput {
  return {
    price: toApiDecimal(form.price),
    unitCost: toApiDecimal(form.unitCost),
    fixedExpenses: toApiDecimal(form.fixed),
    volume: toApiDecimal(form.volume),
    taxRate: base?.taxRate == null ? null : String(base.taxRate),
    fees:
      base?.fees.map((fee) => ({
        percentage: fee.percentage == null ? null : String(fee.percentage),
      })) ?? [],
    volumeSource: form.volumeSource,
  };
}

function Simulacoes() {
  const queryClient = useQueryClient();
  const [productId, setProductId] = useState("");
  const [sim, setSim] = useState<SimulationForm>({
    productId: "",
    price: "",
    unitCost: "",
    fixed: "",
    volume: "",
    volumeSource: "manual_simulation",
  });
  const [simulationName, setSimulationName] = useState("");
  const [productsQuery, expensesQuery, savedSimulationsQuery] = useQueries({
    queries: [
      productsWithMetricsQueryOptions(),
      expensesQueryOptions(),
      savedSimulationsQueryOptions(),
    ],
  });

  const details = productsQuery.data ?? [];
  const products = details.map((detail) => detail.product);
  const selectedProductId =
    productId && products.some((product) => product.id === productId)
      ? productId
      : (products[0]?.id ?? "");
  const selectedDetail = details.find((detail) => detail.product.id === selectedProductId);
  const fixed = sumFiniteNumbers(
    (expensesQuery.data ?? [])
      .filter((expense) => expense.type === "fixa")
      .map((expense) => Number(expense.amount)),
  );
  const loadStatus: LoadStatus =
    productsQuery.isPending || expensesQuery.isPending
      ? "loading"
      : productsQuery.isError || expensesQuery.isError
        ? "error"
        : !Number.isFinite(fixed)
          ? "invalid"
          : details.length === 0
            ? "empty"
            : "ready";
  const errorReference = useMemo(
    () => (loadStatus === "error" || !selectedDetail ? createErrorReference("SIM") : null),
    [loadStatus, selectedDetail],
  );
  const base = useMemo<ProductBaseline | null>(() => {
    if (loadStatus !== "ready" || !selectedDetail || selectedDetail.metrics.status !== "ok") {
      return null;
    }
    const product = selectedDetail.product;
    return {
      ...selectedDetail.metrics.value,
      name: product.name,
      price: Number(product.current_price),
      taxRate: product.tax_rate == null ? null : Number(product.tax_rate) * 100,
      fees: selectedDetail.fees.map((fee) => ({
        percentage: Number(fee.percentage) * 100,
      })) satisfies FeeRow[],
    };
  }, [loadStatus, selectedDetail]);
  const productStatus: ProductStatus =
    loadStatus !== "ready" || !selectedProductId
      ? "idle"
      : !selectedDetail
        ? "error"
        : selectedDetail.metrics.status;
  const currentSim: SimulationForm =
    sim.productId === selectedProductId
      ? sim
      : {
          productId: selectedProductId,
          price: base ? decimalInput(base.price) : "",
          unitCost: base ? decimalInput(base.unitCost) : "",
          fixed: decimalInput(fixed),
          volume: "",
          volumeSource: sim.volumeSource,
        };
  const updateSim = (patch: Partial<Omit<SimulationForm, "productId">>) => {
    setSim({ ...currentSim, ...patch, productId: selectedProductId });
  };

  const [debouncedSim, setDebouncedSim] = useState<SimulationForm | null>(null);
  const scheduler = useMemo(() => createDebounceScheduler(SIMULATION_DEBOUNCE_MS), []);
  const latestSimRef = useRef(currentSim);
  latestSimRef.current = currentSim;
  const debouncedSimKey = [
    currentSim.productId,
    currentSim.price,
    currentSim.unitCost,
    currentSim.fixed,
    currentSim.volume,
    currentSim.volumeSource,
    base === null ? "idle" : "ready",
  ].join("|");

  useEffect(
    () => scheduler.schedule(() => setDebouncedSim(latestSimRef.current)),
    [scheduler, debouncedSimKey],
  );

  const debouncedInput =
    debouncedSim !== null && base !== null && debouncedSim.productId === selectedProductId
      ? buildSimulationInput(debouncedSim, base)
      : null;
  // Race safety (T5): cada input tem sua própria cache key; a resposta da key
  // antiga escreve só na entrada antiga e a exibição lê a key ATUAL — fora de
  // ordem, o dado stale nunca aparece.
  const simulationQuery = useQuery({
    ...financialSimulationQueryOptions(debouncedInput ?? EMPTY_SIMULATION_INPUT),
    enabled: debouncedInput !== null,
  });
  const simulated = simulationQuery.data ?? null;
  const simulationErrorReference = useMemo(
    () => (simulationQuery.isError ? createErrorReference("SIM") : null),
    [simulationQuery.isError],
  );

  const missingFields =
    simulated?.status === "incomplete" ? simulated.missing.map((missing) => missing.field) : [];
  const invalidFields =
    simulated?.status === "invalid"
      ? simulated.errors.flatMap((error) => (error.field ? [error.field] : []))
      : [];
  const issueDescriptionId = "simulation-field-message";
  const describesIssue = (field: string) =>
    missingFields.includes(field) || invalidFields.includes(field);
  const onlyVolumeIsMissing = missingFields.length === 1 && missingFields[0] === "volume";

  const saveSimulationMutation = useMutation({
    mutationFn: () =>
      saveSimulation({
        data: {
          product_id: selectedProductId || null,
          name: simulationName.trim(),
          params: debouncedInput ?? EMPTY_SIMULATION_INPUT,
        },
      }),
    onSuccess: async () => {
      toast.success("Simulação salva");
      setSimulationName("");
      await queryClient.invalidateQueries({ queryKey: ["simulations", "saved"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Não foi possível salvar a simulação"),
  });

  const saveSimulationLabel = saveSimulationMutation.isPending ? "Salvando..." : "Salvar simulação";
  const sourceDisplay = VOLUME_SOURCE_DISPLAY[currentSim.volumeSource];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black">Simulações</h1>
        <p className="text-muted-foreground">
          Teste uma hipótese informada por você. Sem vendas registradas, nenhum cenário é tratado
          como atual ou factual.
        </p>
      </div>

      {loadStatus === "loading" && <SimulacoesSkeleton />}

      {loadStatus === "error" && (
        <RemoteErrorState
          message="Não foi possível carregar os dados financeiros."
          reference={errorReference}
        />
      )}

      {loadStatus === "invalid" && (
        <div role="alert" className="rounded-xl border border-destructive/40 p-4 font-medium">
          Erro de cálculo. Revise os valores numéricos das despesas fixas.
        </div>
      )}

      {loadStatus === "empty" && (
        <output className="text-muted-foreground">
          Cadastre um produto para criar uma simulação manual.
        </output>
      )}

      {products.length > 0 && loadStatus !== "error" && (
        <Card>
          <CardContent className="p-5">
            <div className="max-w-md space-y-1">
              <Label htmlFor="simulacoes-produto">Produto</Label>
              <Select value={selectedProductId} onValueChange={setProductId}>
                <SelectTrigger id="simulacoes-produto">
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
          </CardContent>
        </Card>
      )}

      {loadStatus === "ready" && !base && (
        <ProductState status={productStatus} errorReference={errorReference} />
      )}

      {base && (
        <div className="grid gap-6 lg:grid-cols-2">
          <ProductCard data={base} />
          <Card>
            <CardHeader className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{sourceDisplay.cardTitle}</CardTitle>
                <Badge
                  variant="secondary"
                  className="shrink-0 uppercase"
                  title={sourceDisplay.badgeTitle}
                >
                  {sourceDisplay.badge}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{sourceDisplay.headerHint}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {simulationQuery.isError && (
                <RemoteErrorState
                  message="Não foi possível calcular a simulação."
                  reference={simulationErrorReference}
                />
              )}
              <VolumeSourceSelector
                value={currentSim.volumeSource}
                onChange={(volumeSource) => updateSim({ volumeSource })}
              />
              <Field
                id="simulacao-preco-venda"
                label="Preço de venda simulado (R$)"
                value={currentSim.price}
                describedBy={describesIssue("price") ? issueDescriptionId : undefined}
                invalid={invalidFields.includes("price")}
                onChange={(value) => updateSim({ price: value })}
              />
              <Field
                id="simulacao-custo-unitario"
                label="Custo unitário simulado (R$)"
                value={currentSim.unitCost}
                describedBy={describesIssue("unitCost") ? issueDescriptionId : undefined}
                invalid={invalidFields.includes("unitCost")}
                onChange={(value) => updateSim({ unitCost: value })}
              />
              <Field
                id="simulacao-despesas-fixas"
                label="Despesas fixas no escopo simulado (R$)"
                value={currentSim.fixed}
                describedBy={describesIssue("fixedExpenses") ? issueDescriptionId : undefined}
                invalid={invalidFields.includes("fixedExpenses")}
                onChange={(value) => updateSim({ fixed: value })}
              />
              <Field
                id="simulacao-volume-vendas"
                label={sourceDisplay.volumeFieldLabel}
                value={currentSim.volume}
                describedBy={describesIssue("volume") ? issueDescriptionId : undefined}
                invalid={invalidFields.includes("volume")}
                onChange={(value) => updateSim({ volume: value })}
              />

              {simulated?.status === "incomplete" && (
                <div
                  id={issueDescriptionId}
                  aria-live="polite"
                  className="mt-3 rounded-xl border p-4 text-sm text-muted-foreground"
                >
                  {onlyVolumeIsMissing
                    ? `Informe o volume ${currentSim.volumeSource === "forecast" ? "estimado" : "da simulação"} para calcular. Nenhum volume padrão é presumido.`
                    : "Preencha os campos indicados da simulação para calcular."}
                </div>
              )}

              {simulated?.status === "invalid" && (
                <div
                  id={issueDescriptionId}
                  role="alert"
                  className="mt-3 rounded-xl border border-destructive/40 p-4 text-sm font-medium"
                >
                  Erro de cálculo. Revise os valores numéricos da simulação.
                </div>
              )}

              {simulated?.status === "ok" && (
                <>
                  <output
                    aria-live="polite"
                    className="mt-3 space-y-1 rounded-xl bg-secondary p-4 text-sm"
                  >
                    <Row
                      label="Origem do volume"
                      value={VOLUME_ORIGIN_LABELS[simulated.value.volumeSource]}
                    />
                    <Row label="Volume simulado" value={`${num(simulated.value.volume, 0)} un.`} />
                    <Row
                      label="Margem de contribuição"
                      value={`${brl(simulated.value.contributionMargin)} (${pct(simulated.value.contributionMarginPct)})`}
                    />
                    <Row label="Faturamento simulado" value={brl(simulated.value.revenue)} />
                    <Row
                      label="Resultado operacional simulado dentro do escopo informado"
                      value={brl(simulated.value.result)}
                      accent={simulated.value.resultSign === "negative" ? "destructive" : "success"}
                    />
                  </output>
                  <ScenarioExplanation result={simulated.value} />
                  <div className="mt-3 space-y-2">
                    <div className="space-y-1">
                      <Label htmlFor="simulacao-nome" className="text-xs">
                        Nome da simulação
                      </Label>
                      <Input
                        id="simulacao-nome"
                        maxLength={160}
                        value={simulationName}
                        placeholder="Ex.: Margem-alvo de 25%"
                        onChange={(event) => setSimulationName(event.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      onClick={() => saveSimulationMutation.mutate()}
                      disabled={
                        saveSimulationMutation.isPending ||
                        simulationName.trim() === "" ||
                        !sourceDisplay.persistable
                      }
                      aria-describedby={
                        sourceDisplay.persistable ? undefined : SIMULATION_SAVE_BLOCKED_NOTE_ID
                      }
                    >
                      {saveSimulationLabel}
                    </Button>
                    {/* Região viva sempre presente: trocar a origem anuncia o motivo. */}
                    <div aria-live="polite">
                      {sourceDisplay.persistable ? (
                        <p className="text-xs text-muted-foreground">
                          O servidor recalcula o cenário antes de salvar; o resultado enviado não é
                          reutilizado (INV-009).
                        </p>
                      ) : (
                        <p id={SIMULATION_SAVE_BLOCKED_NOTE_ID} className="text-xs font-medium">
                          Salvar está indisponível para estimativas: a persistência aceita apenas a
                          origem «simulação manual» — guardar projeções está previsto para a v2. O
                          cálculo acima continua válido e nada é convertido em simulação manual em
                          segundo plano.
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            Simulações salvas
            <Badge
              variant="secondary"
              className="shrink-0 uppercase"
              title="Simulações persistidas como hipótese, nunca dado factual."
            >
              {savedSimulationsQuery.data?.length ?? 0} registro(s)
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {savedSimulationsQuery.isPending && <Skeleton className="h-16 w-full" />}
          {savedSimulationsQuery.isError && (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              Não foi possível carregar as simulações salvas.
            </p>
          )}
          {savedSimulationsQuery.isSuccess && (savedSimulationsQuery.data?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              Nenhuma simulação salva. Registre uma hipótese acima para revisitar depois.
            </p>
          )}
          {savedSimulationsQuery.isSuccess &&
            (savedSimulationsQuery.data ?? []).map((saved) => (
              <div key={saved.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{saved.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatSavedDate(saved.created_at)} · {saved.engine_version}
                  </span>
                </div>
                {saved.result != null &&
                  saved.result.status === "ok" &&
                  typeof saved.result.value === "object" &&
                  saved.result.value !== null &&
                  "revenue" in saved.result.value &&
                  typeof saved.result.value.revenue === "string" && (
                    <div className="mt-1 text-sm text-muted-foreground">
                      Faturamento simulado: {brl(saved.result.value.revenue)}
                    </div>
                  )}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function SimulacoesSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <Card>
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-64 max-w-full" />
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-52" />
          </CardHeader>
          <CardContent className="space-y-3">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-4 w-full" />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-3">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="flex items-center justify-between gap-4">
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-9 w-36" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProductState({
  status,
  errorReference,
}: Readonly<{
  status: ProductStatus;
  errorReference: string | null;
}>) {
  const invalid = status === "invalid";
  const error = status === "error";
  if (error) {
    return (
      <RemoteErrorState
        message="Não foi possível carregar os dados do produto."
        reference={errorReference}
      />
    );
  }
  const message = productStateMessage(status);
  if (invalid) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/40 p-4 font-medium">
        {message}
      </div>
    );
  }
  return <output className="text-muted-foreground">{message}</output>;
}

function productStateMessage(status: ProductStatus): string {
  if (status === "incomplete") {
    return "Dados incompletos. Preencha os campos financeiros do produto para simular.";
  }
  return "Carregando dados do produto...";
}

function ProductCard({ data }: Readonly<{ data: ProductBaseline }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Dados unitários do produto</CardTitle>
        <p className="text-sm text-muted-foreground">{data.name}</p>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <Row label="Preço informado" value={brl(data.price)} />
        <Row label="Custo unitário" value={brl(data.unitCost)} />
        <Row label="Custo variável unitário" value={brl(data.variableCost)} />
        <Row
          label="Margem de contribuição unitária"
          value={`${brl(data.contributionMargin)} (${pct(data.contributionMarginPct)})`}
        />
        <div className="mt-4 rounded-xl border p-4 text-muted-foreground">
          Volume real: —. Registre vendas reais antes de usar volume em um KPI factual.
        </div>
      </CardContent>
    </Card>
  );
}

function Row({
  label,
  value,
  accent,
}: Readonly<{
  label: string;
  value: string;
  accent?: "success" | "destructive";
}>) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={accent ? "font-bold text-foreground" : "font-medium"}>{value}</span>
    </div>
  );
}

/**
 * "Como calculamos?" do resultado: as fórmulas na ordem em que o motor as
 * aplica e a origem declarada do volume. Os valores são o eco do motor (§18.3).
 */
function ScenarioExplanation({ result }: Readonly<{ result: ScenarioEcho }>) {
  return (
    <CalcExplainer className="mt-3">
      <p>
        O motor calcula este cenário nesta ordem e nada é refeito na tela: cada valor abaixo é o eco
        do próprio motor.
      </p>
      <ul className="space-y-1">
        {scenarioExplanation(result).map((step) => (
          <li key={step.field}>
            <span className="font-medium">{step.label}:</span> {step.formula} = {step.value}
          </li>
        ))}
      </ul>
      <p>
        <span className="font-medium">Origem do volume:</span>{" "}
        {VOLUME_ORIGIN_EXPLANATION[result.volumeSource]}
      </p>
    </CalcExplainer>
  );
}

/**
 * Seletor radio nativo: Tab alcança o grupo, as setas trocam a opção e cada
 * opção tem rótulo e dica próprios — o estado (`checked`) e o motivo da escolha
 * são anunciados sem JS extra.
 */
function VolumeSourceSelector({
  value,
  onChange,
}: Readonly<{
  value: SimulationVolumeSource;
  onChange: (source: SimulationVolumeSource) => void;
}>) {
  return (
    <fieldset className="space-y-2 rounded-xl border p-4">
      <legend className="px-1 text-xs font-medium">Origem do volume simulado</legend>
      <div className="flex flex-wrap gap-4">
        {SIMULATION_VOLUME_SOURCES.map((source) => {
          const optionId = `simulacao-origem-${source}`;
          const hintId = `${optionId}-dica`;
          return (
            <div key={source} className="flex items-start gap-2">
              <Input
                type="radio"
                id={optionId}
                name="simulacao-origem-volume"
                value={source}
                checked={value === source}
                onChange={() => onChange(source)}
                aria-describedby={hintId}
                className="mt-0.5 h-4 w-4 shrink-0 border-0 bg-transparent p-0 shadow-none accent-primary"
              />
              <div className="space-y-0.5">
                <Label htmlFor={optionId} className="text-sm font-normal">
                  {VOLUME_SOURCE_DISPLAY[source].optionLabel}
                </Label>
                <p id={hintId} className="text-xs text-muted-foreground">
                  {VOLUME_SOURCE_DISPLAY[source].optionHint}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function Field({
  id,
  label,
  value,
  describedBy,
  invalid,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  describedBy?: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}>) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
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

function createErrorReference(prefix: string): string {
  const token =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Date.now().toString(36);
  return `${prefix}-${token}`.toUpperCase();
}

function toApiDecimal(value: string): string | null {
  const normalized = value.trim().replace(",", ".");
  return normalized === "" ? null : normalized;
}

function formatSavedDate(value: string): string {
  return new Date(value).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
