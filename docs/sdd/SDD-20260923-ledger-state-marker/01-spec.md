# 01 — SPEC · SDD-20260923-ledger-state-marker

- **ID:** `SDD-20260923-ledger-state-marker`
- **Status:** `EXECUTADO` (execução registrada em `07-evidence.md` e `08-report.md`)
- **Data:** 2026-09-23
- **Dono:** agente supervisionado

## 1. Problema

`npm run m02:state:check` está **VERMELHO** em `develop`. O ledger `EXECUTION-STATE-PROGRAM.md` carrega,
como último marcador parent-pinned, o SHA `41e776b85e264565ebcac2abfc62ff8e6ac2b0ce` — que é o
**primeiro** commit do range local, enquanto o HEAD é `8683c2dbe46a98eb98be7a734cbc951e00cfa6b5`.
A defasagem é de **5 commits**.

Medição de abertura (verbatim do check):

```text
Ledger M-02 desatualizado: registre HEAD 8683c2dbe46a98eb98be7a734cbc951e00cfa6b5 ou o
parent-pinned marker 2edb55b6ac11284a86075dff20a8f5e387563cfd antes de prosseguir.
```

O check aceita duas formas: a âncora exata `` `HEAD` = `<sha>` `` ou a linha
`Latest state marker parent = <parent-do-HEAD>`.

## 2. Contexto

O protocolo de boot do repo (`AGENTS.md` § Session boot) exige validar o marcador parent-pinned
**antes de agir**. O ledger já registrou esta mesma classe de defeito **duas vezes** (`INV-006` e o ciclo
de `a0d1f38`, este último com a lição escrita: _"o marcador é parte do commit, não um passo posterior"_).

Agravante estrutural: `m02:state:check` **não pertence a nenhum pipeline** — não está na cadeia
`npm run check`, não é passo do `ui-stack.yml` nem do `ci-light.yml`. É passo manual do protocolo de
boot. Por isso a defasagem atravessou 5 commits sem que gate nenhum reprovasse.

## 3. Objetivo

Fazer o boot limpo voltar a verde **sem reescrever história**, preservando os commits locais já validados.

## 4. Não objetivos

- Não corrigir por `--amend`, `rebase`, `reset --hard` ou qualquer reescrita (proibido pelo §3.6 do
  contrato e por `AGENTS.md`).
- Não alterar o comportamento do `m02:state:check` nem enfraquecer a exigência.
- Não tornar o check bloqueante no CI neste ciclo (isso é escopo do item 6 / hardening).
- Não fazer push.

## 5. Restrições

- Commits novos apenas; append-only.
- Nenhum push; nenhum acesso a billing; nenhuma ação remota.
- A superfície viva de prosa (`m02:temporal-guard`) tem de continuar verde: âncora em crases que seja
  hex de 7–40 com ao menos uma letra **precisa resolver** como objeto do git, e data válida depois de
  verbo de prazo não pode estar no passado.

## 6. Requisitos

- **REQ-01** — o ledger deve conter `Latest state marker parent = ` apontando para o **parent** do HEAD
  resultante, de modo que `m02:state:check` retorne exit 0 no novo HEAD.
- **REQ-02** — a correção é **aditiva**: um bloco novo no fim do ledger; nenhuma linha histórica é
  reescrita.
- **REQ-03** — os SHA citados no bloco novo resolvem como objeto do git (REQ do guard temporal).
- **REQ-04** — a intenção é registrada no journal **antes** da mutação (linha `▶`), e o resultado
  **depois** (linha `✔`), append-only.
- **REQ-05** — nenhum push, nenhuma mutação remota, nenhum acesso a billing.

## 7. Critérios de aceite

Ver `02-acceptance.md`.

## 8. Plano de teste

1. `npm run m02:state:check` no novo HEAD ⇒ exit 0 (antes: exit 1).
2. `npm run m02:temporal-guard` ⇒ exit 0 (o bloco novo entra no recorte "último bloco").
3. `npm run format:check` ⇒ exit 0 (o ledger é markdown formatado pelo prettier).
4. `./scripts/local-ci.sh` no novo HEAD ⇒ a etapa `m02:state:check` passa de `failure` para `success`.

## 9. Plano de reversão

`git revert <commit-da-correcao>` — commit novo que desfaz a adição, sem reescrever história. Como o
bloco é aditivo e não altera código, o revert não tem efeito sobre runtime.

## 10. Riscos

Ver `05-risk.md`.

## 11. Dependências

- Nenhuma dependência de rede, banco, coleta ou plataforma.
- Executável inteiramente local — **não** depende do desbloqueio de billing.

## 12. Aprovações necessárias

- **Nenhuma** para a correção em si (edição documental local + commit local).
- **Humana explícita** para qualquer push (não executado).
