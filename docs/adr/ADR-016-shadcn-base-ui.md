# ADR-016: shadcn/ui sobre Base UI como camada exclusiva de primitivos

| Campo                 | Valor                                                            |
| --------------------- | ---------------------------------------------------------------- |
| Status                | Aceito                                                           |
| Data                  | 2026-08-01                                                       |
| Owner                 | Líder técnico de frontend                                        |
| Decisor da stack      | Usuário responsável pelo produto, por autorização explícita      |
| Aprovadores do gate   | Líder técnico, Produto/UX, QA e security champion                |
| Gate limite           | Fase 2                                                           |
| Documentos normativos | `SDD.md` 1.4 e `PLANO_MESTRE_OTIMIZACAO_E_CIBERSEGURANCA.md` 1.5 |

## Contexto e problema

O frontend usa componentes shadcn/ui historicamente baseados em Radix e configurados no estilo legado `new-york`. A aplicação precisa de uma única fronteira reutilizável para evitar APIs concorrentes, diferenças de acessibilidade, dependências duplicadas e imports de primitivos espalhados por features e rotas.

O inventário atual encontrou 38 wrappers dormentes. `sheet` e `alert-dialog` serão promovidos a uso ativo; os outros 36 serão excluídos. O catálogo final contém somente `alert-dialog`, `badge`, `button`, `card`, `input`, `label`, `select`, `sheet`, `sonner` e `textarea`.

`cmdk` e `vaul` mantêm Radix no grafo e, por isso, não são especialistas elegíveis. Sonner não constitui stack concorrente e é o único especialista inicialmente aprovado, sempre atrás de wrapper local.

### Baseline registrada

- `npm ci` conclui com sucesso.
- Typecheck e build passam.
- O check do Prettier falha em 27 arquivos.
- O lint falha com 625 achados, principalmente de formatação, incluindo 7 warnings.
- `npm audit` registra um advisory transitivo de severidade alta em `brace-expansion`.
- Na captura da baseline original não existia metadata Git no workspace. Essa limitação foi encerrada com o repositório privado, branch `main` e commit inicial `db09f5d`; conexão Lovable, branch protection e rollback por artifact continuam em DSO-023.

As falhas de formatação/lint e o advisory compõem a baseline, não podem ser atribuídos automaticamente à migração e continuam sujeitos aos gates gerais do projeto.

## Fontes e autoridade

A orientação oficial do shadcn para migração progressiva está em [Base UI as the Default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default). A API e os requisitos da fundação são consultados na [documentação Base UI](https://base-ui.com/react/overview/quick-start), incluindo [acessibilidade](https://base-ui.com/react/overview/accessibility) e [CSP Provider](https://base-ui.com/react/utils/csp-provider) quando aplicável.

O `llms.txt` local ainda descreve shadcn/ui como baseado em Radix. Esse arquivo é auxiliar, está desatualizado para esta decisão e não é normativo. Em caso de divergência, prevalecem SDD 1.4, este ADR, o Plano Mestre 1.5 e a documentação oficial atual.

## Forças e restrições

- A escolha de shadcn/ui sobre Base UI está fixada por DD-013 e não é reaberta neste ADR.
- A migração deve ser incremental e manter a aplicação verificável por onda.
- API local, comportamento, acessibilidade, CSP, SSR/hydration, estilos e tokens do produto devem ser preservados.
- O estilo `new-york` não possui contraparte Base; regeneração integral por outro preset é proibida.
- Nenhum novo Radix pode ser introduzido durante a transição.
- npm e `package-lock.json` são as fontes autoritativas de instalação e dependências.
- Rollback por commit e artifact usa o repositório privado atual sem reescrever histórico publicado no Lovable.

## Decisão fixa

1. shadcn/ui implementado sobre Base UI é a camada exclusiva de primitivos reutilizáveis.
2. Aplicação, features e rotas importam UI somente por `@/components/ui`.
3. Apenas `src/components/ui` pode importar `@base-ui/react`.
4. Elementos HTML semânticos nativos usados pelas implementações oficiais shadcn Base, como `label`, `input`, `button` e `textarea`, são conformes; não são exceções à decisão.
5. Especialistas exigem wrapper local, aprovação explícita e allowlist, e não podem formar uma stack concorrente. A allowlist inicial contém somente Sonner.
6. `@radix-ui/*` e `radix-ui` são proibidos no source mantido e no grafo direto/transitivo de produção após a Fase 2.
7. `cmdk` e `vaul` devem ser removidos porque retêm Radix.
8. A exceção Radix durante a migração é fechada, não aceita novos itens e expira no gate da Fase 2.

## Escopo e fronteiras de import

| Origem                      | Import permitido                                                                    | Import proibido                                             |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Aplicação, features e rotas | `@/components/ui` e seus módulos locais                                             | `@base-ui/react`, Radix e especialistas diretamente         |
| `src/components/ui`         | `@base-ui/react`, código local e especialista allowlisted no wrapper correspondente | Radix, stacks concorrentes e especialista fora da allowlist |
| `src/components/ui/sonner`  | Sonner e dependências locais necessárias                                            | Qualquer segunda stack de primitivos                        |

Componentes específicos de feature podem compor os wrappers locais e elementos semânticos, mas não criar uma segunda biblioteca reutilizável de primitivos nem contornar a fronteira.

## Política de pacotes

- npm é o único package manager; `package-lock.json` é a lockfile autoritativa.
- `bun.lock` e `bunfig.toml` são removidos durante a execução.
- O gate inspeciona dependências de produção diretas e transitivas, não apenas `package.json`.
- O grafo de produção final deve conter zero `@radix-ui/*`, `radix-ui`, `cmdk` e `vaul`.
- Sonner permanece allowlisted somente enquanto encapsulado por `src/components/ui/sonner` e sem introduzir stack concorrente.
- Nova dependência especialista exige avaliação de necessidade, acessibilidade, CSP/SSR, supply chain, impacto de bundle, owner, testes, atualização deste ADR ou ADR sucessor e aprovação dos papéis do gate.

## Estratégia de migração

A execução segue a orientação progressiva do shadcn. Cada onda possui escopo fechado, relatório de arquivos afetados, evidência e rollback antes da próxima.

| Onda                      | Escopo                                                                                              | Saída obrigatória                                       |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 0 - Baseline e freeze     | Registrar consumidores, wrappers, dependências e inventário Radix fechado                           | Nenhum novo import, arquivo ou pacote Radix pode entrar |
| 1 - Fronteira e toolchain | Implantar regras de import, encapsular Sonner e tornar npm/lockfile autoritativos                   | Checks de fronteira e não crescimento passam            |
| 2 - Transformação         | Migrar in-place os dez wrappers retidos para Base UI, por wrapper ou família pequena                | Typecheck, build e paridade por wrapper passam          |
| 3 - Adoção e limpeza      | Promover `sheet`/`alert-dialog`, remover os outros 36 dormentes, `cmdk`, `vaul` e Radix             | Catálogo exato e grafo npm de produção limpo            |
| 4 - Metadata e gate       | Alterar `components.json` para `base-nova` somente para futuras adições e executar a suíte agregada | Todos os critérios de aceite deste ADR passam           |

## Preservação de estilo

Os wrappers existentes são transformados in-place. Classes, variantes, tokens, CSS variables, espaçamento, tipografia, cores e comportamento visual do produto são preservados salvo correção aprovada e evidenciada.

`components.json` não muda antes da conclusão da migração. A mudança posterior de `new-york` para `base-nova` registra a base para futuras adições; não autoriza reexecutar `init`, substituir tokens ou regenerar os dez wrappers aprovados com defaults do preset.

## Comportamento, acessibilidade, CSP e SSR

Cada wrapper migrado deve preservar ou melhorar:

- Contratos públicos locais necessários aos consumidores mantidos.
- Teclado, ordem de tabulação, foco inicial, focus trap quando aplicável, Escape e retorno de foco.
- Nome, descrição, estado, erro, disabled e semântica de formulário expostos à tecnologia assistiva.
- Portals, layering, bloqueio de scroll, pointer/touch e viewport mobile.
- Renderização SSR determinística e hydration sem mismatch ou dependência indevida de APIs do navegador.
- CSP bloqueante sem adicionar `unsafe-inline`, `unsafe-eval` ou relaxamento global para acomodar o componente.
- Aparência, tokens e estados visuais do produto.

Testes automatizados não substituem validação manual de teclado, NVDA e VoiceOver nas jornadas críticas.

## Enforcement automatizado

A CI deve falhar quando:

- Um consumidor fora de `src/components/ui` importa `@base-ui/react`, Radix ou especialista diretamente.
- `src/components/ui` importa Radix ou especialista não allowlisted.
- O inventário Radix temporário cresce antes de expirar.
- Após a Fase 2, source mantido, `package-lock.json` ou grafo npm de produção contém `@radix-ui/*`, `radix-ui`, `cmdk` ou `vaul`.
- Arquivo Bun permanece ou a instalação reproduzível não usa npm/`package-lock.json`.
- O catálogo difere dos dez wrappers aprovados ou algum dos 36 descartados volta sem nova decisão de governança.
- Typecheck, build, testes de componente/E2E, a11y, CSP ou SSR/hydration relevantes falham.

O check do grafo deve combinar inspeção do lockfile com resolução npm de produção para evitar falso negativo por dependência transitiva.

## Opções de execução consideradas

A stack de primitivos não foi colocada em votação. Foram consideradas apenas estratégias de execução:

| Opção                            | Resultado                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Migração incremental por wrapper | Escolhida; limita blast radius, permite evidência e rollback por onda                                                    |
| Migração big bang                | Rejeitada; amplia regressões simultâneas e dificulta localizar diferenças de API/comportamento                           |
| Codemod ou regeneração integral  | Rejeitada como estratégia principal; não preserva de forma confiável customizações `new-york`, tokens e contratos locais |
| Coexistência indefinida          | Rejeitada; viola a decisão de stack exclusiva e mantém custo, risco e Radix transitivo                                   |

## Consequências

Consequências positivas:

- Uma única API local para features e rotas.
- Menor superfície de dependências e de auditoria.
- Evolução de componentes centralizada e verificável.
- Remoção de wrappers dormentes e stacks duplicadas.

Consequências negativas:

- Diferenças entre APIs Radix e Base UI exigem adaptação manual e testes de comportamento.
- Coexistência temporária aumenta o grafo durante a migração.
- A conexão do repositório privado ao projeto Lovable e a prova final de rollback por artifact ainda pertencem ao DSO-023.
- O preset de metadata futuro não pode ser aplicado mecanicamente ao catálogo customizado.

## Segurança e privacidade

- Nenhuma migração pode relaxar CSP, encoding, sanitização ou fronteiras de conteúdo.
- Componentes não devem registrar conteúdo de campos, dados financeiros, PII ou credenciais.
- Portals e overlays devem manter isolamento visual, foco e prevenção de interação indevida com conteúdo subjacente.
- Dependências novas passam pelos controles de supply chain, licença, vulnerabilidade e scripts de instalação do SDD.
- Este ADR não altera finalidade, retenção ou compartilhamento de dados; mudança nesses aspectos exige revisão de privacidade separada.

## Riscos e mitigação

| Risco                                    | Mitigação                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Regressão silenciosa de props ou eventos | Migrar por wrapper, mapear consumidores e executar testes de interação antes do avanço |
| Regressão de foco/teclado em overlays    | Promover `sheet`/`alert-dialog` com testes manuais e automatizados dedicados           |
| Drift visual                             | Preservar classes/tokens e comparar estados/viewport por onda                          |
| Radix transitivo remanescente            | Inspecionar `package-lock.json` e grafo npm de produção; remover `cmdk`/`vaul`         |
| Especialista virar stack paralela        | Allowlist fechada, wrapper local e ADR para mudança futura                             |
| Rollback incompleto                      | Commit imutável, artifact rastreável e restauração testada antes de cada release       |

## Rollback por onda

Antes de cada onda, o executor registra arquivos e pacotes afetados em commit imutável e mantém artifact restaurável fora do workspace. Histórico publicado não pode ser reescrito.

| Onda | Rollback                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Restaurar somente artefatos de inventário/check se impedirem trabalho legítimo; o freeze de novos Radix permanece normativo                                        |
| 1    | Restaurar em conjunto regras de import e lockfile da baseline; não adicionar Radix além do inventário fechado                                                      |
| 2    | Restaurar wrapper e consumidores da onda a partir do snapshot, mantendo as demais ondas aprovadas intactas                                                         |
| 3    | Restaurar apenas item comprovadamente necessário e sua entrada original no inventário temporário; corrigir a onda antes do gate, sem prorrogar a exceção           |
| 4    | Restaurar metadata/lockfile anterior e bloquear release; após o gate da Fase 2, rollback usa artifact Base UI anterior ou forward fix, nunca reintrodução de Radix |

## Aceite

ADR-016 está implementado somente quando houver evidência de que:

- Aplicação, features e rotas importam UI exclusivamente por `@/components/ui`.
- Apenas `src/components/ui` importa `@base-ui/react`; Sonner é o único especialista e permanece encapsulado.
- O catálogo contém exatamente os dez wrappers aprovados, `sheet`/`alert-dialog` estão ativos e os outros 36 dormentes foram removidos.
- npm/`package-lock.json` são exclusivos e nenhum arquivo Bun permanece.
- Source mantido e grafo direto/transitivo de produção contêm zero `@radix-ui/*`, `radix-ui`, `cmdk` e `vaul`.
- Typecheck, build, testes de componente/E2E, acessibilidade, CSP e SSR/hydration passam.
- Estilos e tokens do produto foram preservados, e `base-nova` foi aplicado somente como metadata para futuras adições.
- A exceção temporária Radix foi encerrada no gate da Fase 2.

## Governança futura

Trocar Base UI, permitir outra camada de primitivos, ampliar a allowlist especialista, alterar a fronteira de import ou mudar o catálogo reutilizável exige nova versão do SDD e do Plano Mestre, rastreabilidade, análise de dependências/segurança/acessibilidade e ADR novo ou sucessor. Uma mudança futura não pode ser tratada como simples execução do CLI.
