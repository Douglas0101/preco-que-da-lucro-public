# Plano de migração M-02

1. registrar estado e baseline no M02-0, distinguindo 13 sites transacionais de 21
   arquivos alcançáveis com persistência;
2. congelar decisões e matriz no M02-1;
3. extrair products e pricing com adapters no M02-2;
4. extrair contratos/adapters de chat no M02-3; Memory/Event completo permanece em M-05/M-04;
5. migrar autoridade de cálculo e paridade no M02-4;
6. ativar enforcement no M02-5;
7. fechar suite, ledger e publicação autorizada no M02-6.

Cada etapa mantém os exports antigos como adapters até a paridade e um ciclo de
compatibilidade. Nenhuma mudança de comportamento financeiro é justificada apenas por
mudança de camada.
