import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteExpense, listExpenses, upsertExpense } from "@/lib/expenses.functions";
import { sumFiniteNumbers } from "@/lib/finance";
import { toDecimalString, type DecimalString } from "@/lib/financial-values";
import { expensesQueryOptions } from "@/lib/query-options";
import { brl } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Wallet, PlusCircle, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";

export const Route = createFileRoute("/_authenticated/despesas")({
  head: () => ({
    meta: [
      { title: "Minhas Despesas · Preço que Dá Lucro" },
      { name: "description", content: "Cadastre e acompanhe suas despesas mensais." },
    ],
  }),
  // Prefetch não-bloqueante (T2): mesmas options/queryKey de query-options.ts;
  // erro deglutido para o estado de erro com retry continuar no componente.
  // Dynamic import — e não o símbolo estático do topo: o import do topo serve o
  // componente, que é code-split, e o plugin do router o apaga do módulo de
  // referência. Só o dinâmico mantém query-options (+ *.functions/zod) FORA do
  // grafo inicial (orçamento de bundle §17.7) — loaders não são code-split.
  loader: async ({ context }) => {
    const { expensesQueryOptions } = await import("@/lib/query-options");
    return context.queryClient.ensureQueryData(expensesQueryOptions()).catch(() => null);
  },
  pendingComponent: () => <output className="text-muted-foreground">Carregando...</output>,
  component: Despesas,
});

const CATEGORIES = [
  "Aluguel",
  "Pró-labore",
  "Salários",
  "Contabilidade",
  "Internet",
  "Telefone",
  "Energia",
  "Água",
  "Sistemas",
  "Marketing",
  "Transporte",
  "Manutenção",
  "Impostos",
  "Taxas",
  "Outros",
];

type ExpenseRow = Awaited<ReturnType<typeof listExpenses>>[number];
type ExpenseMutationInput = {
  name: string;
  amount: DecimalString;
  category: string;
  type: "fixa" | "variavel";
};

function Despesas() {
  const queryClient = useQueryClient();
  const expensesQuery = useQuery(expensesQueryOptions());
  const list: ExpenseRow[] = expensesQuery.data ?? [];
  const [form, setForm] = useState({
    name: "",
    amount: "",
    category: "Outros",
    type: "fixa" as "fixa" | "variavel",
  });
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const saveExpenseMutation = useMutation({
    mutationFn: (data: ExpenseMutationInput) => upsertExpense({ data }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["expenses"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard", "summary"] }),
      ]);
      toast.success("Despesa adicionada");
      setForm({ name: "", amount: "", category: "Outros", type: "fixa" });
    },
    onError: () => toast.error("Não foi possível salvar a despesa"),
  });
  const deleteExpenseMutation = useMutation({
    mutationFn: (id: string) => deleteExpense({ data: { id } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["expenses"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard", "summary"] }),
      ]);
      setPendingDeleteId(null);
    },
    onError: () => toast.error("Não foi possível excluir a despesa"),
  });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const rawAmount = form.amount.replace(",", ".").trim();
    const amount = Number(rawAmount);
    if (!form.name.trim() || rawAmount === "" || !Number.isFinite(amount) || amount < 0)
      return toast.error("Preencha nome e valor válido");
    saveExpenseMutation.mutate({
      name: form.name,
      amount: toDecimalString(rawAmount, 4),
      category: form.category,
      type: form.type,
    });
  }

  const fixed = sumFiniteNumbers(
    list.filter((expense) => expense.type === "fixa").map((expense) => Number(expense.amount)),
  );
  const variable = sumFiniteNumbers(
    list.filter((expense) => expense.type === "variavel").map((expense) => Number(expense.amount)),
  );

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-black">Minhas Despesas</h1>
          <p className="text-muted-foreground">
            Cadastre as contas da sua empresa para calcular o ponto de equilíbrio.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardContent className="p-5">
              <div className="text-xs uppercase text-muted-foreground">Despesas fixas / mês</div>
              <div className="mt-1 text-2xl font-black">{brl(fixed)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <div className="text-xs uppercase text-muted-foreground">
                Despesas variáveis / mês
              </div>
              <div className="mt-1 text-2xl font-black">{brl(variable)}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="p-5">
            <form onSubmit={add} className="grid gap-3 md:grid-cols-5">
              <div className="md:col-span-2 space-y-1">
                <Label htmlFor="despesa-nome">Nome</Label>
                <Input
                  id="despesa-nome"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex: Aluguel"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="despesa-valor">Valor (R$)</Label>
                <Input
                  id="despesa-valor"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  placeholder="0,00"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="despesa-categoria">Categoria</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm({ ...form, category: v })}
                >
                  <SelectTrigger id="despesa-categoria">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="despesa-tipo">Tipo</Label>
                <Select
                  value={form.type}
                  onValueChange={(value) => {
                    if (value === "fixa" || value === "variavel") {
                      setForm({ ...form, type: value });
                    }
                  }}
                >
                  <SelectTrigger id="despesa-tipo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixa">Fixa</SelectItem>
                    <SelectItem value="variavel">Variável</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="md:col-span-5">
                <Button type="submit" disabled={saveExpenseMutation.isPending} className="gap-2">
                  <PlusCircle className="h-4 w-4" /> Adicionar despesa
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <ExpenseListState
          isPending={expensesQuery.isPending}
          isError={expensesQuery.isError}
          list={list}
          onRetry={() => void expensesQuery.refetch()}
          onDelete={setPendingDeleteId}
        />
      </div>

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir despesa?</AlertDialogTitle>
            <AlertDialogDescription>
              A despesa selecionada será excluída permanentemente. Esta ação não poderá ser
              desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDeleteId !== null) deleteExpenseMutation.mutate(pendingDeleteId);
              }}
            >
              Excluir despesa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ExpenseListState({
  isPending,
  isError,
  list,
  onRetry,
  onDelete,
}: Readonly<{
  isPending: boolean;
  isError: boolean;
  list: ExpenseRow[];
  onRetry: () => void;
  onDelete: (id: string) => void;
}>) {
  if (isPending) {
    return (
      <div className="space-y-2" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <Card key={row}>
            <CardContent className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-1/4" />
              </div>
              <Skeleton className="h-4 w-24" />
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
          <p>Não foi possível carregar as despesas.</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (list.length === 0) {
    return (
      <Card>
        <CardContent className="grid place-items-center gap-2 p-12 text-center text-muted-foreground">
          <Wallet className="h-8 w-8" /> Nenhuma despesa cadastrada ainda.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {list.map((expense) => (
        <Card key={expense.id}>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{expense.name}</div>
              <div className="text-xs text-muted-foreground">
                {expense.category} · {expense.type === "fixa" ? "Fixa" : "Variável"}
              </div>
            </div>
            <div className="text-right">
              <div className="font-black">{brl(Number(expense.amount))}</div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onDelete(expense.id)}
              aria-label={`Excluir ${expense.name}`}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
