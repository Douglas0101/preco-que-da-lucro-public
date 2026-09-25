# 01 — SPEC · SDD-20260924-e2e-flake-investigation

- **ID:** `SDD-20260924-e2e-flake-investigation`
- **Status:** `SPEC` — **aguardando aprovação humana** (nada implementado; investigação estruturada)
- **Data:** 2026-09-24
- **Origem:** decisão humana `E2E_FLAKE_DECISION=known-limitation`, registrada no journal `L168` e em
  `docs/sdd/SDD-20260923-local-ci-hardening/07-evidence.md`

## 1. Problema

O tier de e2e do `local-ci` apresentou **1 falha transitória em 30 testes** sob carga. Como
`playwright.config.ts` tem **`retries: 0`**, um único transiente **reprova a rodada inteira** — o que
transforma um evento raro em custo de ciclo (≈6 min por re-execução) e, pior, em risco de **fadiga de
alarme**: um vermelho que "às vezes acontece" é o começo de um gate que se aprende a ignorar.

## 2. O que foi **medido** (e uma correção de premissa)

| Fato                       | Medição                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A falha                    | `[mobile] › e2e/ui-stack.spec.ts:92 › authentication controls keep accessible names` — após o login a página permaneceu em `/auth` em vez de `/inicio` (timeout de 5 s em `toHaveURL`) |
| Frequência                 | **1 em 30**, numa única rodada de 6 executadas                                                                                                                                         |
| Correlação aparente        | exata **com n=1**: as 4 rodadas com `db:test` **pulado** tiveram e2e verde; a única com o tier de banco executado teve e2e vermelho                                                    |
| **Experimento controlado** | `db:test` seguido de e2e **no mesmo container efêmero** ⇒ **30/30 verde**                                                                                                              |
| Re-execução                | a selagem seguinte passou com `db:test` **e** e2e verdes                                                                                                                               |
| Conclusão                  | a hipótese "o tier de banco quebra o e2e" está **REFUTADA**                                                                                                                            |

> **Correção de premissa, declarada:** a versão inicial deste despacho afirmava que _"a falha ocorreu
> apenas quando `db:test` rodou antes do e2e"_. Isso descreve a **correlação observada (n=1)**, não a
> causa — e o experimento controlado a **refutou**. Registrar a correlação como causa teria enviado a
> investigação futura atrás de um mecanismo inexistente. Este SDD parte do fato medido: **a falha é
> transiente e não reproduzida**.

**Hipótese remanescente (não testada, declarada como hipótese):** pressão de memória. Horas depois, a
máquina local entrou em **OOM e congelou**, exigindo reinício bruto. O e2e roda com o webServer de build

- Chromium + (quando `db=true`) o tier de banco no mesmo host; contenção de memória é compatível com um
  timeout de 5 s num redirect. **Não** foi medido — é candidata prioritária da investigação.

## 3. Contexto

- O `local-ci` roda o e2e contra **PG17 efêmero** em `127.0.0.1:55432`, com `NO_COLOR`/`FORCE_COLOR`
  removidos (adaptação declarada) — o ambiente **não** é idêntico ao do CI, que usa container de serviço.
- O Item 5 passou a **preservar diagnóstico** em falha (`test-results/` e `playwright-report/` sob
  `artifacts/`: trace, screenshot, vídeo, error-context). Isso muda o custo de investigar: a próxima
  ocorrência chega com evidência, não com especulação.
- O repo tem precedente de investigação com instrumento próprio (`src/test/m02-ci-tiers.test.ts` executa
  o script real extraído do YAML).

## 4. Objetivo

**Identificar a causa raiz — ou declarar fundamentadamente que ela é indeterminada — e propor uma
solução que não mascare falha real.** O objetivo **não** é "fazer o e2e parar de falhar": é fazer a
falha ser **explicada**, para que um vermelho continue significando algo.

## 5. Não objetivos

- **Adicionar retry automático sem ADR.** Retry é afrouxamento de orçamento de verificação e, sem
  medição, é indistinguível de mascaramento.
- Silenciar a falha (timeout maior sem métrica, `test.fixme`, `--retries` escondido em config).
- Reabrir o Item 5 — ele está fechado no escopo aprovado.
- Investigar flakiness de testes **unitários** (fenômeno diferente, sem ocorrência registrada).

## 6. Restrições

1. Nenhuma alteração de contrato de gate sem **ADR**.
2. Nenhuma dependência nova.
3. Nenhuma mutação remota; nenhum push.
4. `retries` permanece **0** até que uma decisão explícita mude isso.
5. Toda conclusão precisa de **evidência capturada**, não de plausibilidade.

## 7. Requisitos

- **REQ-01 — captura automática na próxima ocorrência.** Toda falha de e2e preserva trace, screenshot,
  vídeo, `error-context` e o log do webServer, com o **estado de recursos** do host no momento (memória
  disponível, carga) anexado ao diagnóstico.
- **REQ-02 — instrumentação de latência sem mudança de comportamento.** Medir o tempo do redirect de
  login e o tempo de resposta do webServer, **sem** alterar timeout nem asserção (observar ≠ afrouxar).
- **REQ-03 — série, não ponto.** A taxa de falha é lida como série entre execuções; uma ocorrência
  isolada não conclui causa, e a ausência de ocorrências em N execuções não prova ausência de causa.
- **REQ-04 — controle negativo do diagnóstico.** Provar que a captura de REQ-01 **funciona**: injetar
  uma falha artificial e verificar que os artefatos aparecem. Diagnóstico que nunca foi exercitado é
  diagnóstico que pode não existir quando for preciso.
- **REQ-05 — hipótese de memória testável.** Se a contenção de memória for a causa, deve existir um
  experimento que a **isole** (ex.: rodar o e2e com o host sob carga controlada) e um resultado
  esperado declarado **antes** da medição.
- **REQ-06 — nenhuma solução sem mecanismo.** Qualquer proposta precisa nomear o mecanismo que explica
  a falha; "aumentar o timeout" sem mecanismo é mascaramento e deve ser **rejeitado**.

## 8. Riscos (resumo — detalhe em `05-risk.md`)

- Retry pode mascarar falha real (RISK-01).
- Isolamento pode não reproduzir o problema (RISK-02).
- A investigação pode não encontrar causa raiz (RISK-03) — e a resposta honesta é declarar
  indeterminação **com evidência**, não escolher uma causa conveniente.
- A solução pode introduzir novo flake (RISK-04).
- **RISK-05 (novo):** o próprio diagnóstico pode alterar o timing e esconder a falha (efeito
  observador). Mitigação: instrumentar **sem** mudar timeout/asserção e comparar a taxa antes/depois.

## 9. Dependências e aprovações

- **Aprovação humana** para: qualquer implementação de solução, qualquer alteração de contrato de gate
  (exige ADR), e a decisão de manter `retries: 0` caso a causa não seja encontrada.
- **Ambiente:** capacidade de reproduzir a carga (o host local já a produziu uma vez).
- Nenhuma dependência de rede, plataforma ou banco externo.
