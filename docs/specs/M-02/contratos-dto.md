# Contratos DTO M-02

## Resultado financeiro

```ts
type CalculationStatus = "valid" | "incomplete" | "notApplicable" | "invalid";

interface CalculationResult<T> {
  status: CalculationStatus;
  value?: T;
  issues: Array<{ code: string; message: string; field?: string }>;
  warnings: Array<{ code: string; message: string; field?: string }>;
}
```

O adapter legado pode expor `ok`, `missing` e `errors` temporariamente, mas novos
services usam o contrato acima.

## Diagnóstico

`DiagnosticDTO` deve incluir `productId`, custo unitário, break-even, formação de preço,
alertas, premissas, proveniência, `engineVersion`, `rulesVersion` e `CalculationResult`.
Valores monetários permanecem strings com escala 4; percentuais permanecem frações.

## Snapshot

O envelope tipado contém `calculationType`, `entityType`, `entityId`, `inputs`, `outputs`,
`engineVersion`, `rulesVersion`, `roundingPolicy`, `currency`, `timezone`, `period`,
`origin`, `issues` e `warnings`.
