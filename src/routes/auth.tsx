import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { authClient } from "@/lib/auth-client";

type AuthMode = "signin" | "signup" | "forgot" | "reset";

const modeTitles: Record<AuthMode, string> = {
  signin: "Bem-vindo de volta",
  signup: "Vamos começar juntos",
  forgot: "Recuperar acesso",
  reset: "Definir nova senha",
};

const submitLabels: Record<AuthMode, string> = {
  signin: "Entrar",
  signup: "Criar conta",
  forgot: "Enviar instruções",
  reset: "Redefinir senha",
};

const PASSWORD_AUTOCOMPLETE = "current-password";

function safeRedirect(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : undefined;
}

async function submitAuthForm({
  mode,
  token,
  email,
  password,
  name,
  redirect,
  navigate,
  setMode,
  setPassword,
}: Readonly<{
  mode: AuthMode;
  token?: string;
  email: string;
  password: string;
  name: string;
  redirect?: string;
  navigate: ReturnType<typeof useNavigate>;
  setMode: (mode: AuthMode) => void;
  setPassword: (password: string) => void;
}>): Promise<void> {
  if (mode === "forgot") {
    await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/auth`,
    });
    toast.success("Se a conta existir, enviaremos as instruções de recuperação.");
    setMode("signin");
    return;
  }
  if (mode === "reset") {
    if (!token) throw new Error("Link de recuperação inválido.");
    const result = await authClient.resetPassword({ newPassword: password, token });
    if (result.error) throw new Error(result.error.message ?? "Não foi possível redefinir.");
    toast.success("Senha redefinida. Entre novamente.");
    setMode("signin");
    setPassword("");
    return;
  }
  if (mode === "signup") {
    const result = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: `${window.location.origin}${redirect ?? "/inicio"}`,
    });
    if (result.error) throw new Error(result.error.message ?? "Não foi possível criar a conta.");
    toast.success("Conta criada! Confirme seu e-mail para entrar.");
    setMode("signin");
    return;
  }
  const result = await authClient.signIn.email({ email, password });
  if (result.error) throw new Error(result.error.message ?? "Credenciais inválidas.");
  await navigate({ to: redirect ?? "/inicio", replace: true });
}

async function signInWithGoogle(redirect?: string): Promise<void> {
  const result = await authClient.signIn.social({
    provider: "google",
    callbackURL: `${window.location.origin}${redirect ?? "/inicio"}`,
  });
  if (result.error) throw new Error("Não foi possível entrar com Google.");
}

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Entrar · Preço que Dá Lucro" },
      { name: "description", content: "Entre ou crie sua conta para começar." },
    ],
  }),
  validateSearch: (search): { redirect?: string; token?: string } => ({
    redirect: safeRedirect(search.redirect),
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: Auth,
});

function Auth() {
  const navigate = useNavigate();
  const { redirect, token } = useSearch({ from: "/auth" });
  const [mode, setMode] = useState<AuthMode>(token ? "reset" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    void authClient.getSession().then(({ data }) => {
      if (active && data?.session) void navigate({ to: redirect ?? "/inicio", replace: true });
    });
    return () => {
      active = false;
    };
  }, [navigate, redirect]);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    void submitAuthForm({
      mode,
      token,
      email,
      password,
      name,
      redirect,
      navigate,
      setMode,
      setPassword,
    })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Não foi possível concluir.");
      })
      .finally(() => setLoading(false));
  }

  function handleGoogle() {
    setLoading(true);
    void signInWithGoogle(redirect).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : "Não foi possível entrar com Google.");
      setLoading(false);
    });
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <Sparkles className="h-7 w-7" />
          </div>
          <h1 className="mt-4 text-2xl font-black">Preço que Dá Lucro</h1>
          <p className="mt-1 text-sm text-muted-foreground">{modeTitles[mode]}</p>
        </div>

        <div className="rounded-2xl border bg-card p-6 shadow-[var(--shadow-soft)]">
          {(mode === "signin" || mode === "signup") && (
            <>
              <Button
                type="button"
                variant="outline"
                className="w-full gap-2"
                onClick={handleGoogle}
                disabled={loading}
              >
                <GoogleIcon /> Continuar com Google
              </Button>
              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">ou</span>
                </div>
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-2">
                <Label htmlFor="name">Como podemos te chamar?</Label>
                <Input
                  id="name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            )}
            {mode !== "reset" && (
              <div className="space-y-2">
                <Label htmlFor="email">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            )}
            {mode !== "forgot" && (
              <div className="space-y-2">
                <Label htmlFor="password">{mode === "reset" ? "Nova senha" : "Senha"}</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  minLength={10}
                  autoComplete={mode === "signin" ? PASSWORD_AUTOCOMPLETE : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Aguarde..." : submitLabels[mode]}
            </Button>
          </form>

          <div className="mt-4 space-y-2 text-center text-sm text-muted-foreground">
            {mode === "signin" && (
              <>
                <p>
                  Ainda não tem conta?{" "}
                  <ModeButton onClick={() => setMode("signup")}>Cadastre-se</ModeButton>
                </p>
                <ModeButton onClick={() => setMode("forgot")}>Esqueci minha senha</ModeButton>
              </>
            )}
            {mode !== "signin" && (
              <ModeButton onClick={() => setMode("signin")}>Voltar para entrar</ModeButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  children,
  onClick,
}: Readonly<{ children: React.ReactNode; onClick: () => void }>) {
  return (
    <Button type="button" variant="link" className="h-auto p-0 font-semibold" onClick={onClick}>
      {children}
    </Button>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
