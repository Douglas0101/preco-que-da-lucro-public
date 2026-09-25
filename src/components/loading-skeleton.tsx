import type { ReactNode } from "react";

/**
 * Região de carregamento das rotas (plano mestre §18.5).
 *
 * O corpo visual é `aria-hidden` — mesma convenção dos skeletons já existentes
 * no app — e o anúncio vive numa região `role="status"` com o texto `sr-only`
 * "Carregando...", a string usada pelos estados de carregamento das rotas.
 * O anúncio fica FORA do bloco `aria-hidden`, senão seria suprimido do
 * leitor de tela; por isso a marcação mora aqui, num único lugar.
 */
function LoadingSkeleton({
  className,
  children,
}: Readonly<{ className?: string; children: ReactNode }>) {
  return (
    <div role="status">
      <span className="sr-only">Carregando...</span>
      <div aria-hidden="true" className={className}>
        {children}
      </div>
    </div>
  );
}

export { LoadingSkeleton };
