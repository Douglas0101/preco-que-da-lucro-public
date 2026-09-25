# ADR-018: Decimal exato, unidades e arredondamento financeiro

| Campo                 | Valor                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Status                | Aceito                                                               |
| Data                  | 2026-08-12                                                           |
| Owner                 | domínio financeiro                                                   |
| Documentos normativos | Diretriz V7 §8; Plano Mestre FIN-006, FIN-007 e Financial Engine 2.0 |

## Contexto

O motor usava `number` em todas as operações, convertia unidades incompatíveis em custo zero e transportava `Infinity` como ponto de equilíbrio não atingível. Esses comportamentos violam `Unknown ≠ Zero`, impedem auditoria do arredondamento e não são contratos seguros para PostgreSQL/JSON.

## Decisão

- `decimal.js` é a implementação aritmética do motor, com precisão 40 e `ROUND_HALF_UP`.
- As fronteiras BFF/PostgreSQL usam strings decimais canônicas; strings formatadas nunca entram no motor.
- Persistência usa:
  - dinheiro: `NUMERIC(19,4)`;
  - intermediários: `NUMERIC(24,8)`;
  - percentual em fração: `NUMERIC(9,6)`, entre `0` e `1`;
  - quantidade: `NUMERIC(24,6)`.
- Quantidade sempre possui valor, unidade e dimensão (`mass`, `volume`, `count`, `production` ou `commercial`).
- Massa, volume e contagem possuem conversões seguras em suas próprias dimensões. Unidade comercial ou conversão entre dimensões exige fator contextual identificado e confirmado.
- Ausência desse fator produz `incomplete`; unidade desconhecida produz `invalid`; nenhum dos casos produz custo zero.
- Ponto de equilíbrio usa `BreakEvenResult`: preserva `rawUnits`, fornece `roundedUnits` com `ceil` para unidade discreta e expressa contribuição não positiva como `unreachable`, sem `Infinity`.

As APIs numéricas antigas permanecem temporariamente em `number` apenas na camada de compatibilidade das telas. O BFF deve serializar `Money`, `Percent` e `Quantity` pelos contratos de `financial-values.ts`.

## Consequências

- Cálculos conhecidos ficam reprodutíveis e não dependem de aritmética binária intermediária.
- O arredondamento operacional fica separado do resultado bruto auditável.
- Cadastros com `pacote`, `caixa`, `colher` ou `xícara` precisam armazenar contexto de conversão antes de o produto ficar completo.
- Migrations PostgreSQL devem aplicar as escalas e constraints desta decisão.

## Rollback

Reverter este ADR exige restaurar conjuntamente o contrato anterior do motor, as telas e os golden tests. Não é permitido reintroduzir custo zero para conversão desconhecida nem `Infinity` nas fronteiras.
