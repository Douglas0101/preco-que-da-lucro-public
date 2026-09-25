# Brief de decisão Q-021 — política para `.pi/`

Data: 2026-08-27
Status: `⛔ DECISION` — não aplicado por este brief
Escopo: retenção, versionamento e sanitização dos artefatos `.pi/`.

## Contexto

O worktree contém `.pi/` não rastreado, preservado como evidência de execução e
com artefatos de tarefas. O SDD v5.1-EXEC determina que raw `.pi/` não seja
commitado antes de uma política humana. O arquivo pode conter dados de contexto,
saídas de ferramentas ou identificadores que não devem entrar na história do
repositório.

O fato de `.pi/` existir no checkout é `LOCAL-VERIFIED`; o conteúdo não é
promovido a evidência normativa nem a artefato publicável.

## Opções

| Opção                           | Benefício                                                              | Custo/risco                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Gitignore + template sanitizado | Evita commitar raw; mantém formato reproduzível para futuras execuções | Exige disciplina para exportar somente evidência sanitizada                                     |
| Commitar raw `.pi/`             | Máxima reprodução literal do agente                                    | Risco de segredo, dado pessoal, contexto interno ou artefato não auditado entrar no repositório |
| Remover `.pi/`                  | Elimina o risco de publicação                                          | Destrói o artefato local antes de uma política de retenção e reduz rastreabilidade              |

## Recomendação

Recomenda-se **gitignore + template sanitizado**, mantendo o diretório raw
localmente até a conclusão da auditoria desta rodada. O template deve conter
somente schema mínimo, IDs anonimizados, timestamps, comandos sem segredos,
status e caminhos de artefatos; saídas brutas devem ser exportadas para
`docs/evidence/` apenas após revisão de segredo e classificação.

## Rollback

Se a política for considerada inadequada, remover o template e restaurar a
regra de retenção anterior em um commit novo; não apagar o `.pi/` raw sem uma
decisão explícita de descarte. Se um artefato sanitizado for publicado por
engano, retirar apenas o artefato confirmado como sensível e registrar o
incidente, sem reescrever história publicada.

## Evidência anexada

- `git status --short --untracked-files=all` — `.pi/` aparece como não rastreado,
  `LOCAL-VERIFIED`;
- §8.3 do SDD v5.1-EXEC — exige caminho de security-fix e não autoriza raw
  `.pi/`;
- Q-021 no SDD v5.1-EXEC — decisão humana ainda pendente.
