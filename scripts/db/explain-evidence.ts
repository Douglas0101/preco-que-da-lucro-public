/**
 * Evidência EXPLAIN para as queries críticas (plano mestre §16.4).
 *
 * Para cada query crítica, captura o plano ANTES (sem o índice dedicado) e
 * DEPOIS (com o índice), com latência real (EXPLAIN ANALYZE, BUFFERS),
 * contra o banco local. O índice é removido dentro de uma transação que faz
 * rollback, então o estado final do banco não é alterado.
 *
 * Uso:
 *   DATABASE_ADMIN_URL=<url admin do Postgres local, conforme docker-compose.yml> \
 *     npx tsx scripts/db/explain-evidence.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { MEMORY_TRAIL_TABLES } from "./purge-fixtures";

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error("DATABASE_ADMIN_URL é obrigatória");

const tenantId = "70000000-0000-4000-8000-000000000701";
const userId = "70000000-0000-4000-8000-000000000702";
const PRODUCTS = 2000;
const INGREDIENTS_PER_PRODUCT = 5;
const HISTORY_PER_INGREDIENT = 10;

type PlanRow = { "QUERY PLAN": string };

async function explain(client: Client, sql: string, params: unknown[]): Promise<string> {
  const result = await client.query<PlanRow>(
    `explain (analyze, buffers, format text) ${sql}`,
    params,
  );
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/** Executa `operation` sem o índice informado e restaura tudo no final (rollback). */
async function withoutIndexes(
  client: Client,
  indexes: string[],
  operation: () => Promise<void>,
): Promise<void> {
  await client.query("begin");
  try {
    for (const index of indexes) {
      await client.query(`drop index if exists ${index}`);
    }
    await operation();
  } finally {
    await client.query("rollback");
  }
}

function extractLine(plan: string, pattern: RegExp): string {
  const line = plan.split("\n").find((candidate) => pattern.test(candidate));
  return line?.trim() ?? "(não encontrado)";
}

const SCAN_NODE =
  /(Seq Scan|Index (?:Only )?Scan(?: Backward)?|Bitmap Heap Scan|Bitmap Index Scan)(?: on| using) [\w.]+/;

async function main(): Promise<void> {
  const client = new Client(adminUrl);
  await client.connect();

  // ---------------------------------------------------------------- seed
  await client.query("begin");
  for (const table of MEMORY_TRAIL_TABLES) {
    // pi-lens-ignore: no-sql-in-code
    await client.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
  }
  await client.query(`delete from users where id = $1`, [userId]);
  await client.query(`delete from tenants where id = $1`, [tenantId]);
  await client.query(
    `insert into users (id, name, email, email_verified) values ($1, 'Explain', 'explain@example.test', true)`,
    [userId],
  );
  await client.query(
    `insert into tenants (id, name, slug) values ($1, 'Explain Tenant', 'explain-tenant')`,
    [tenantId],
  );
  await client.query(
    `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`,
    [tenantId, userId],
  );
  await client.query(
    `
    insert into products (id, tenant_id, user_id, name, current_price, tax_rate)
    select gen_random_uuid(), $1, $2, 'Produto ' || g, '12.3400', '0.060000'
    from generate_series(1, ${PRODUCTS}) g
  `,
    [tenantId, userId],
  );
  await client.query(
    `
    insert into product_ingredients (product_id, tenant_id, user_id, name, used_qty, used_unit)
    select p.id, p.tenant_id, p.user_id, 'Ingrediente ' || g, '0.500000', 'kg'
    from products p cross join generate_series(1, ${INGREDIENTS_PER_PRODUCT}) g
    where p.tenant_id = $1
  `,
    [tenantId],
  );
  await client.query(
    `
    insert into purchase_price_history (
      tenant_id, user_id, subject_type, subject_id, ingredient_id,
      price, quantity, unit, valid_from, recorded_at
    )
    select
      i.tenant_id, i.user_id, 'ingredient', i.id, i.id,
      '10.0000'::numeric + h, '1.000000', 'kg',
      now() - make_interval(days => h), now() - make_interval(days => h)
    from product_ingredients i cross join generate_series(1, ${HISTORY_PER_INGREDIENT}) h
    where i.tenant_id = $1
  `,
    [tenantId],
  );
  await client.query(
    `
    insert into expenses (id, tenant_id, user_id, name, amount, type)
    select gen_random_uuid(), $1, $2, 'Despesa ' || g, '100.0000', 'fixa'
    from generate_series(1, 30) g
  `,
    [tenantId, userId],
  );
  await client.query("commit");

  const firstIngredient = await client.query<{ id: string }>(
    `select id from product_ingredients where tenant_id = $1 order by created_at limit 1`,
    [tenantId],
  );
  const ingredientId = firstIngredient.rows[0]!.id;

  const criticalQueries = [
    {
      name: "products.list (listagem ativa por tenant)",
      sql: `select * from products where tenant_id = $1 and archived_at is null order by created_at desc`,
      params: [tenantId],
      indexesDroppedForBefore: ["products_tenant_active_idx", "products_tenant_created_idx"],
      metricPattern: SCAN_NODE,
    },
    {
      name: "purchasePrice.latest (último preço por insumo)",
      sql: `select * from purchase_price_history
            where tenant_id = $1 and ingredient_id = $2
            order by valid_from desc, recorded_at desc limit 1`,
      params: [tenantId, ingredientId],
      indexesDroppedForBefore: ["purchase_price_history_tenant_ingredient_valid_idx"],
      metricPattern: SCAN_NODE,
    },
    {
      name: "dashboard.productIngredients (insumos por produto)",
      sql: `select * from product_ingredients where tenant_id = $1 and product_id = any($2)`,
      params: [tenantId, [ingredientId]],
      indexesDroppedForBefore: ["product_ingredients_tenant_product_idx"],
      metricPattern: SCAN_NODE,
    },
  ];

  const sections: string[] = [];
  for (const query of criticalQueries) {
    let beforePlan = "";
    await withoutIndexes(client, query.indexesDroppedForBefore, async () => {
      beforePlan = await explain(client, query.sql, query.params);
    });
    const afterPlan = await explain(client, query.sql, query.params);

    const beforeScan = extractLine(beforePlan, query.metricPattern);
    const afterScan = extractLine(afterPlan, query.metricPattern);
    const beforeTime = extractLine(beforePlan, /Execution Time/);
    const afterTime = extractLine(afterPlan, /Execution Time/);

    sections.push(`### ${query.name}

**SQL**

\`\`\`sql
${query.sql}
\`\`\`

**Índices removidos no cenário "antes":** ${query.indexesDroppedForBefore.join(", ")}

**Antes (sem índice)**

\`\`\`text
${beforeScan}
${beforeTime}
\`\`\`

**Depois (com índice)**

\`\`\`text
${afterScan}
${afterTime}
\`\`\`

<details><summary>Plano completo antes</summary>

\`\`\`text
${beforePlan}
\`\`\`

</details>

<details><summary>Plano completo depois</summary>

\`\`\`text
${afterPlan}
\`\`\`

</details>
`);
    console.log(`${query.name}: OK`);
    console.log(`  antes : ${beforeScan} | ${beforeTime}`);
    console.log(`  depois: ${afterScan} | ${afterTime}`);
  }

  // ------------------------------------------------------------- cleanup
  await client.query("begin");
  await client.query(`delete from purchase_price_history where tenant_id = $1`, [tenantId]);
  await client.query(`delete from product_ingredients where tenant_id = $1`, [tenantId]);
  await client.query(`delete from expenses where tenant_id = $1`, [tenantId]);
  await client.query(`delete from products where tenant_id = $1`, [tenantId]);
  for (const table of MEMORY_TRAIL_TABLES) {
    // pi-lens-ignore: no-sql-in-code
    await client.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
  }
  await client.query(`delete from tenant_memberships where tenant_id = $1`, [tenantId]);
  await client.query(`delete from tenants where id = $1`, [tenantId]);
  await client.query(`delete from users where id = $1`, [userId]);
  await client.query("commit");
  await client.end();

  const today = new Date().toISOString().slice(0, 10);
  const evidencePath = resolve(process.cwd(), `docs/evidence/explain-critical-queries-${today}.md`);
  await mkdir(resolve(process.cwd(), "docs/evidence"), { recursive: true });
  const markdown = `# Evidência EXPLAIN — queries críticas (${today})

Fonte: plano mestre §16.4 ("Queries críticas devem possuir evidence file:
before plan / after plan / before latency / after latency").

Ambiente: PostgreSQL 17 local (docker-compose), dataset sintético
(${PRODUCTS} produtos, ${PRODUCTS * INGREDIENTS_PER_PRODUCT} insumos,
${PRODUCTS * INGREDIENTS_PER_PRODUCT * HISTORY_PER_INGREDIENT} registros de histórico de preços,
30 despesas, 1 tenant). Planos capturados com \`EXPLAIN (ANALYZE, BUFFERS)\`
sob o papel \`app_runtime\` com \`app.current_tenant_id\` definido.
O cenário "antes" remove os índices dentro de uma transação com rollback —
o estado final do banco permanece intacto.

${sections.join("\n")}

Gerado por \`scripts/db/explain-evidence.ts\`.
`;
  await writeFile(evidencePath, markdown);
  console.log(`Evidência gravada em docs/evidence/explain-critical-queries-${today}.md`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
