import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Home,
  Package,
  PlusCircle,
  Wallet,
  Scale,
  LineChart,
  Stethoscope,
  Tag,
  Menu,
  LogOut,
  Sparkles,
  Receipt,
} from "lucide-react";
import { globalSignOut } from "@/lib/auth-client";
import { useSessionUser } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type NavItem = { to: string; label: string; icon: typeof Home; highlight?: boolean };
const NAV: NavItem[] = [
  { to: "/inicio", label: "Início", icon: Home },
  { to: "/produtos", label: "Meus Produtos", icon: Package },
  { to: "/novo-produto", label: "Novo Produto", icon: PlusCircle, highlight: true },
  { to: "/precos", label: "Preços de Compra", icon: Tag },
  { to: "/despesas", label: "Minhas Despesas", icon: Wallet },
  { to: "/vendas", label: "Vendas", icon: Receipt },
  { to: "/ponto-equilibrio", label: "Ponto de Equilíbrio", icon: Scale },
  { to: "/simulacoes", label: "Simulações", icon: LineChart },
  { to: "/diagnostico", label: "Diagnóstico", icon: Stethoscope },
];

function SidebarContent({
  email,
  pathname,
  logout,
  onNavigate,
}: {
  email: string;
  pathname: string;
  logout: () => Promise<void>;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col p-5">
      <Link
        to="/inicio"
        preload="intent"
        className="mb-8 flex items-center gap-3"
        onClick={onNavigate}
      >
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <div className="font-bold leading-tight">Preço que Dá Lucro</div>
          <div className="text-xs opacity-70">seu consultor financeiro</div>
        </div>
      </Link>

      <nav className="flex-1 space-y-1">
        {NAV.map((item) => {
          const active = pathname === item.to;
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              preload="intent"
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition motion-reduce:transition-none",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                item.highlight && !active && "ring-1 ring-sidebar-primary/40",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 space-y-2 border-t border-sidebar-border pt-4">
        <div className="truncate px-3 text-xs opacity-70">{email}</div>
        <Button
          variant="ghost"
          onClick={logout}
          className="w-full justify-start gap-2 text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <LogOut className="h-4 w-4" /> Sair
        </Button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  // Sessão vem do provider compartilhado (get-session único): sem refetch de
  // getSession a cada mount do shell.
  const user = useSessionUser();
  const email = user?.email ?? "";

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  async function logout() {
    await globalSignOut();
    queryClient.clear();
    await router.navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-40 flex items-center justify-between border-b bg-card px-4 py-3">
        <Link to="/inicio" preload="intent" className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="font-bold text-sm">Preço que Dá Lucro</span>
        </Link>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={<Button variant="ghost" size="icon" aria-label="Abrir menu de navegação" />}
          >
            <Menu className="h-5 w-5" />
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-72 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-72"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Menu principal</SheetTitle>
              <SheetDescription>Navegação principal do aplicativo.</SheetDescription>
            </SheetHeader>
            <SidebarContent
              email={email}
              pathname={location.pathname}
              logout={logout}
              onNavigate={() => setOpen(false)}
            />
          </SheetContent>
        </Sheet>
      </header>

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 shrink-0 bg-sidebar text-sidebar-foreground lg:sticky lg:top-0 lg:block lg:h-screen">
          <SidebarContent email={email} pathname={location.pathname} logout={logout} />
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-10">{children}</div>
        </main>
      </div>
    </div>
  );
}
