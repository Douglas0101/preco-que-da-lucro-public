# 03 — Design · SDD-20260924-e2e-flake-investigation

Quatro abordagens foram consideradas. **Nenhuma está aprovada**; cada uma traz o risco que a desqualifica
sozinha, e o desenho recomendado é a **combinação D + B**, com A **apenas** se houver ADR.

## Abordagem A — Retry limitado com diagnóstico

- 1 tentativa extra **apenas** no e2e, coletando trace/screenshot/vídeo em cada tentativa.
- Registrar se a falha foi transitória (passou na 2ª) ou determinística (falhou nas duas).

**Risco:** mascara falha real — e o mascaramento é **silencioso por construção**, porque o veredicto
final fica verde. Se a taxa real for 1 em 30, um retry a esconde quase por completo.
**Posição:** **rejeitada sem ADR.** Retry é afrouxamento de orçamento de verificação; a regra do repo é
explícita ("never delete, skip, or loosen a test… to force a green").

## Abordagem B — Isolamento de recursos

- `db:test` e e2e em containers **separados** (hoje compartilham o PG17 efêmero em `:55432`).
- Garantir que não há estado compartilhado entre os tiers.

**Risco:** pode não reproduzir o problema — **e já há evidência nesse sentido**: o experimento
controlado com `db:test` antes do e2e deu **30/30 verde**, ou seja, o compartilhamento de estado **não**
produziu a falha. O isolamento é boa higiene, mas **não** é a correção de um mecanismo identificado.
**Posição:** recomendada como **higiene**, explicitamente **não** como correção da causa.

## Abordagem C — Aumento de timeout

- Elevar o timeout do e2e sob carga e coletar métricas de latência.

**Risco:** mascara problema de performance e **não nomeia mecanismo**. Se a causa for contenção de
memória, um timeout maior apenas torna a falha mais rara — o pior resultado possível, porque destrói a
série de dados sem corrigir nada.
**Posição:** **rejeitada** (viola REQ-06).

## Abordagem D — Investigação observacional (recomendada)

- **Instrumentar sem alterar comportamento:** medir o tempo do redirect de login, o tempo de resposta do
  webServer e o **estado de recursos do host** (memória disponível, carga) no momento de cada execução.
- Coletar a série em múltiplas execuções e analisar correlação **apenas** com N suficiente.
- Nenhum timeout, asserção ou `retries` muda durante a coleta.

**Risco:** pode não encontrar causa raiz. **Mitigação:** nesse caso o entregável é o **detector** — a
próxima ocorrência chega com trace, screenshot, vídeo e estado de recursos, e a investigação deixa de
depender de sorte.

**Posição:** **recomendada.** É a única que não pode piorar o gate: observa sem afrouxar.

## Por que D + B e não D sozinho

D responde "qual é o mecanismo"; B remove uma variável de confusão **depois** que o mecanismo for
nomeado. Fazer B antes de D seria otimizar o que não se mediu — e o experimento controlado já mostrou
que o compartilhamento de estado não é, por si, a causa.

## Desenho do detector (REQ-01 + REQ-04)

```
falha de e2e
  ├─ test-results/**            (trace.zip, screenshot, video, error-context)  ← já preservado no Item 5
  ├─ playwright-report/**
  ├─ webServer.log
  └─ host-resources.txt         (memória disponível, carga, PIDs do Chromium/webServer)
```

O `host-resources.txt` é o acréscimo que a hipótese de memória exige. **Controle negativo (AC-06):**
injetar uma falha artificial e provar que os cinco artefatos aparecem — diagnóstico não exercitado é
diagnóstico que pode não existir na hora em que importa.
