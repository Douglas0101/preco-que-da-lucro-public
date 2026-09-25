import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createSale } from "@/lib/sales.functions";
import { productsListQueryOptions, salesListQueryOptions } from "@/lib/query-options";
import { brl, num } from "@/lib/format";
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

export const Route = createFileRoute("/_authenticated/vendas")({
  head: () => ({
    meta: [
      { title: "Vendas · Preço que Dá Lucro" },
      { name: "description", content: "Registre vendas reais e acompanhe o faturamento." },
    ],
  }),
  component: Vendas,
});

type SaleRow = {
  id: string;
  occurred_at: string;
  gross_amount: string;
  net_amount: string;
  channel: string;
  created_at: string;
  items: Array<{
    id: string;
    product_id: string;
    product_name: string | null;
    quantity: string;
    unit_price: string;
    total_amount: string;
  }>;
};

function Vendas() {
  const queryClient = useQueryClient();
  const productsQuery = useQuery(productsListQueryOptions());
  const salesQuery = useQuery(salesListQueryOptions());

  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [channel, setChannel] = useState("Venda direta");

  const products = productsQuery.data ?? [];
  const sales = salesQuery.data ?? [];
  const selectedProductId =
    productId && products.some((product) => product.id === productId)
      ? productId
      : (products[0]?.id ?? "");

  const errorReference = useMemo(
    () => (productsQuery.isError ? createErrorReference("VND") : null),
    [productsQuery.isError],
  );

  const createSaleMutation = useMutation({
    mutationFn: () =>
      createSale({
        data: {
          occurred_at: new Date(`${occurredAt}T12:00:00Z`).toISOString(),
          channel: channel.trim() || "Venda direta",
          items: [
            {
              product_id: selectedProductId,
              quantity: toApiDecimal(quantity) ?? "0",
              unit_price: toApiDecimal(unitPrice) ?? "0",
            },
          ],
        },
      }),
    onSuccess: async () => {
      toast.success("Venda registrada");
      setQuantity("");
      setUnitPrice("");
      await queryClient.invalidateQueries({ queryKey: ["sales", "list"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard", "summary"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Não foi possível registrar a venda"),
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedProductId) {
      toast.error("Cadastre um produto antes de registrar uma venda");
      return;
    }
    const parsedQuantity = toApiDecimal(quantity);
    const parsedPrice = toApiDecimal(unitPrice);
    if (
      parsedQuantity === null ||
      Number(parsedQuantity) <= 0 ||
      parsedPrice === null ||
      Number(parsedPrice) < 0
    ) {
      toast.error("Informe quantidade e preço unitário válidos");
      return;
    }
    createSaleMutation.mutate();
  }

  if (productsQuery.isPending) {
    return <VendasSkeleton />;
  }

  if (productsQuery.isError) {
    return (
      <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 p-4">
        <p className="font-medium">Não foi possível carregar os produtos cadastrados.</p>
        {errorReference && (
          <p className="text-xs text-muted-foreground">
            Referência de atendimento: {errorReference}
          </p>
        )}
        <Button type="button" variant="outline" onClick={() => window.location.reload()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-black">Vendas</h1>
        <p className="text-muted-foreground">
          Registre vendas reais. Só dado factual entra no faturamento do dashboard.
        </p>
      </div>

      {products.length === 0 ? (
        <output className="text-muted-foreground">
          Cadastre um produto para registrar a primeira venda.
        </output>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Registrar venda</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid max-w-2xl gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="venda-produto">Produto</Label>
                <Select value={selectedProductId} onValueChange={setProductId}>
                  <SelectTrigger id="venda-produto">
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
                <Label htmlFor="venda-data">Data da venda</Label>
                <Input
                  id="venda-data"
                  type="date"
                  value={occurredAt}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(event) => setOccurredAt(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="venda-quantidade">Quantidade</Label>
                <Input
                  id="venda-quantidade"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="venda-preco-unitario">Preço unitário (R$)</Label>
                <Input
                  id="venda-preco-unitario"
                  inputMode="decimal"
                  value={unitPrice}
                  onChange={(event) => setUnitPrice(event.target.value)}
                />
              </div>
              <div className="space-y-1 md:col-span-2">
                <Label htmlFor="venda-canal">Canal</Label>
                <Input
                  id="venda-canal"
                  maxLength={40}
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
                />
              </div>
              <div className="md:col-span-2">
                <Button type="submit" disabled={createSaleMutation.isPending}>
                  {createSaleMutation.isPending ? "Registrando..." : "Registrar venda"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            Vendas recentes
            <Badge variant="secondary" className="uppercase">
              {sales.length} registrada(s)
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {salesQuery.isPending && <Skeleton className="h-16 w-full" />}
          {salesQuery.isError && (
            <p role="alert" className="text-sm text-muted-foreground">
              Não foi possível carregar as vendas recentes.
            </p>
          )}
          {salesQuery.isSuccess && sales.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhuma venda registrada.</p>
          )}
          {salesQuery.isSuccess &&
            sales.map((sale: SaleRow) => (
              <div key={sale.id} className="rounded-xl border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {formatDate(sale.occurred_at)} · {sale.channel}
                  </span>
                  <span className="font-bold">{brl(sale.net_amount)}</span>
                </div>
                <ul className="mt-1 text-sm text-muted-foreground">
                  {sale.items.map((item) => (
                    <li key={item.id}>
                      {item.product_name ?? "Produto"} — {num(item.quantity, 0)} un. ×{" "}
                      {brl(item.unit_price)} = {brl(item.total_amount)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function VendasSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <Card>
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-64 max-w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
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
