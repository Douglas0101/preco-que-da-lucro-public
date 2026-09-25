import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { updatePurchasePrice } from "@/lib/products.functions";
import { purchasePricesQueryOptions } from "@/lib/query-options";
import { toDecimalString } from "@/lib/financial-values";
import { brl, decimalInput, qty } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Package, RefreshCw, CalendarClock, AlertTriangle } from "lucide-react";
import { toast } from "@/components/ui/sonner";

export const Route = createFileRoute("/_authenticated/precos")({
  head: () => ({
    meta: [
      { title: "Atualizar Preços de Compra · Preço que Dá Lucro" },
      {
        name: "description",
        content:
          "Atualize o preço de compra dos seus insumos e embalagens e acompanhe a data da última atualização.",
      },
      { property: "og:title", content: "Atualizar Preços de Compra" },
      {
        property: "og:description",
        content: "Mantenha os custos dos seus produtos sempre atualizados.",
      },
    ],
  }),
  component: Precos,
});

type Item = {
  id: string;
  product_id: string;
  name: string;
  package_price: string | null;
  package_qty: string | null;
  package_unit: string | null;
  price_updated_at: string | null;
  kind: "ingrediente" | "embalagem";
  detail: string;
};

const DIAS_ALERTA = 30;

function diasDesde(iso: string | null) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function dataBR(iso: string | null) {
  if (!iso) return "nunca atualizado";
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function ageLabel(days: number | null): string {
  if (days == null || days <= 0) return "";
  if (days === 1) return ` (há ${days} dia)`;
  return ` (há ${days} dias)`;
}

function Precos() {
  const save = useServerFn(updatePurchasePrice);
  const pricesQuery = useQuery(purchasePricesQueryOptions());
  const [products, setProducts] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  useEffect(() => {
    const res = pricesQuery.data;
    if (!res) return;
    setProducts(res.products);
    const all: Item[] = [
      ...res.ingredients.map((i) => ({
        id: i.id,
        product_id: i.product_id,
        name: i.name,
        package_price: i.package_price,
        package_qty: i.package_qty,
        package_unit: i.package_unit,
        price_updated_at: i.price_updated_at,
        kind: "ingrediente" as const,
        detail:
          i.package_qty && i.package_unit
            ? `embalagem de ${qty(i.package_qty, i.package_unit)}`
            : "insumo",
      })),
      ...res.packaging.map((p) => ({
        id: p.id,
        product_id: p.product_id,
        name: p.name,
        package_price: p.package_price,
        package_qty: p.units_per_package,
        package_unit: "unidade",
        price_updated_at: p.price_updated_at,
        kind: "embalagem" as const,
        detail: `pacote com ${qty(p.units_per_package, "unidade(s)")}`,
      })),
    ];
    setItems(all);
    setDrafts(Object.fromEntries(all.map((i) => [i.id, decimalInput(i.package_price)])));
  }, [pricesQuery.data]);

  const desatualizados = useMemo(
    () =>
      items.filter((i) => {
        const d = diasDesde(i.price_updated_at);
        return d === null || d > DIAS_ALERTA;
      }).length,
    [items],
  );

  const grupos = useMemo(
    () =>
      products
        .map((p) => ({ ...p, itens: items.filter((i) => i.product_id === p.id) }))
        .filter((g) => g.itens.length > 0),
    [products, items],
  );

  async function salvar(item: Item) {
    const raw = (drafts[item.id] ?? "").replace(",", ".").trim();
    const valor = Number(raw);
    if (raw === "" || !Number.isFinite(valor) || valor < 0) {
      toast.error("Informe um preço válido");
      return;
    }
    if (!item.package_qty || !item.package_unit) {
      toast.error("Informe a quantidade e a unidade da embalagem antes de registrar o preço");
      return;
    }
    setSavingId(item.id);
    try {
      const packagePrice = toDecimalString(raw, 4);
      const res = await save({
        data: {
          id: item.id,
          kind: item.kind,
          package_price: packagePrice,
          package_qty: toDecimalString(item.package_qty, 6),
          package_unit: item.package_unit,
        },
      });
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? { ...i, package_price: packagePrice, price_updated_at: res.price_updated_at }
            : i,
        ),
      );
      toast.success(`Preço de ${item.name} atualizado`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao atualizar o preço");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black">Atualizar Preços de Compra</h1>
        <p className="text-muted-foreground">
          Quando o preço de um insumo muda, atualize aqui. Seus custos e margens são recalculados
          automaticamente.
        </p>
      </div>

      {!pricesQuery.isPending && items.length > 0 && desatualizados > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            <strong>{desatualizados}</strong> item(ns) com preço sem atualização há mais de{" "}
            {DIAS_ALERTA} dias. Vale conferir se o valor ainda está correto.
          </span>
        </div>
      )}

      <PurchasePriceContent
        isPending={pricesQuery.isPending}
        isError={pricesQuery.isError}
        groups={grupos}
        drafts={drafts}
        savingId={savingId}
        onRetry={() => void pricesQuery.refetch()}
        onDraftChange={(id, value) => setDrafts((current) => ({ ...current, [id]: value }))}
        onSave={salvar}
      />
    </div>
  );
}

type PriceGroup = { id: string; name: string; itens: Item[] };

function PurchasePriceContent({
  isPending,
  isError,
  groups,
  drafts,
  savingId,
  onRetry,
  onDraftChange,
  onSave,
}: Readonly<{
  isPending: boolean;
  isError: boolean;
  groups: PriceGroup[];
  drafts: Record<string, string>;
  savingId: string | null;
  onRetry: () => void;
  onDraftChange: (id: string, value: string) => void;
  onSave: (item: Item) => Promise<void>;
}>) {
  if (isPending) {
    return (
      <div className="space-y-4" aria-hidden="true">
        {[0, 1].map((group) => (
          <Card key={group}>
            <CardHeader>
              <Skeleton className="h-5 w-44" />
            </CardHeader>
            <CardContent className="space-y-3">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center justify-between gap-4">
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-9 w-36" />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <Card role="alert" className="border-destructive/40">
        <CardContent className="space-y-3 p-5">
          <p>Não foi possível carregar os preços.</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="grid place-items-center gap-3 p-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-primary">
            <Package className="h-6 w-6" />
          </div>
          <div className="font-semibold">Nenhum insumo cadastrado ainda</div>
          <p className="text-sm text-muted-foreground">
            Cadastre um produto pelo chat para começar a acompanhar os preços de compra.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <Card key={group.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Package className="h-4 w-4 text-primary" /> {group.name}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {group.itens.map((item) => (
              <PurchasePriceRow
                key={item.id}
                item={item}
                draft={drafts[item.id] ?? ""}
                saving={savingId === item.id}
                onDraftChange={onDraftChange}
                onSave={onSave}
              />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function PurchasePriceRow({
  item,
  draft,
  saving,
  onDraftChange,
  onSave,
}: Readonly<{
  item: Item;
  draft: string;
  saving: boolean;
  onDraftChange: (id: string, value: string) => void;
  onSave: (item: Item) => Promise<void>;
}>) {
  const days = diasDesde(item.price_updated_at);
  const stale = days === null || days > DIAS_ALERTA;
  const inputId = `preco-${item.kind}-${item.id}`;
  const dayLabel = ageLabel(days);
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border p-3">
      <div className="min-w-[10rem] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{item.name}</span>
          <Badge variant="secondary" className="text-[10px] uppercase">
            {item.kind}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">{item.detail}</div>
        <div
          className={`mt-1 flex items-center gap-1 text-xs ${
            stale ? "text-warning" : "text-muted-foreground"
          }`}
        >
          <CalendarClock className="h-3 w-3" />
          Última atualização: {dataBR(item.price_updated_at)}
          {dayLabel}
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div>
          <Label htmlFor={inputId} className="mb-1 block text-xs text-muted-foreground">
            Preço de compra
          </Label>
          <Input
            id={inputId}
            inputMode="decimal"
            className="w-32"
            value={draft}
            onChange={(event) => onDraftChange(item.id, event.target.value)}
          />
        </div>
        <Button
          className="gap-2"
          onClick={() => void onSave(item)}
          disabled={
            saving ||
            Number(draft.replace(",", ".")) ===
              (item.package_price == null ? Number.NaN : Number(item.package_price))
          }
        >
          <RefreshCw className={`h-4 w-4 ${saving ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </div>
      <div className="w-full text-xs text-muted-foreground sm:w-auto">
        Valor atual: {item.package_price === null ? "—" : brl(Number(item.package_price))}
      </div>
    </div>
  );
}
