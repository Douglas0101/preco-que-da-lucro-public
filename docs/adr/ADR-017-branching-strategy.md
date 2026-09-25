# ADR-017: Estratégia de branches develop (trabalho) e main (release via PR)

| Campo                 | Valor                                                            |
| --------------------- | ---------------------------------------------------------------- |
| Status                | Aceito                                                           |
| Data                  | 2026-08-07                                                       |
| Owner                 | plataforma/frontend                                              |
| Documentos normativos | `SDD.md` 1.4 e `PLANO_MESTRE_OTIMIZACAO_E_CIBERSEGURANCA.md` 1.6 |

## Contexto e problema

O projeto operava com branch única `main`, misturando trabalho diário de desenvolvimento, engenharia e cibersegurança com o conteúdo candidato a release. A SDD exige checkout limpo, commit imutável, SHA rastreável e branch protection para release, e o `AGENTS.md` proíbe reescrita de histórico publicado. É necessário separar o fluxo de trabalho do fluxo de release sem violar essas restrições.

Esclarecimento de 2026-08-07: não existe conexão ativa com o Lovable. O projeto é um export de código-fonte obtido para aprimoramento e otimização de engenharia. As menções a sincronização Lovable neste ADR valem apenas como precaução para uma eventual conexão futura.

## Decisão

- `develop` é a branch de trabalho diário: desenvolvimento, engenharia e cibersegurança. Commits diretos são permitidos e todo push dispara a workflow `ui-stack` completa.
- `main` é a branch de release e permanece a default do repositório. Recebe conteúdo exclusivamente via PR `develop → main` com CI verde. Não há conexão ativa com o Lovable; se uma conexão for estabelecida no futuro, `main` é a branch a conectar.
- Nenhuma branch publicada sofre force-push, rebase ou amend de commits já enviados, conforme a restrição Lovable em `AGENTS.md`.
- A proteção formal de branch (reviews obrigatórias, checks obrigatórios) permanece pendente de GitHub Pro ou repositório público; até lá, CI verde no PR é exigida por convenção registrada neste ADR.

## Consequências

- `.github/workflows/ui-stack.yml` dispara em push para `main` e `develop` e em todo `pull_request`.
- Os gates de release da SDD (checkout limpo, SHA rastreável, artifacts, rollback) continuam valendo para `main` inalterados.
- Sem conexão Lovable ativa, nenhum push sincroniza com editor externo. Caso uma conexão seja estabelecida no futuro, somente `main` sincronizaria; trabalho em `develop` permaneceria fora do editor até o merge via PR.
- Reavaliar a default branch e a proteção formal quando houver GitHub Pro, repositório público ou uma eventual conexão Lovable (DSO-023).
