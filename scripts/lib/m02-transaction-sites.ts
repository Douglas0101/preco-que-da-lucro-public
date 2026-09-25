import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Scanner puro dos *transaction sites* da matriz M-02, extraído de
 * `scripts/m02-matrix.ts` para poder ser testado sem regravar a matriz.
 *
 * Semântica declarada (substitui a busca textual `/(request|context)\.transaction/`,
 * que contava comentários, literais de string e `src/test/**`, e colapsava N
 * instruções em 1 quando o handle era apelidado):
 *
 * 1. O site nasce de uma **expressão de valor** no AST (`context.transaction` /
 *    `request.transaction`). Comentário não é nó do AST, literal de string é
 *    `StringLiteral` e `typeof context.transaction` é posição de tipo, então
 *    nenhum dos três conta.
 * 2. `const tx = <handle>.transaction` (ou `let`/`var`) é um *alias*: em vez de 1
 *    ocorrência lexical, o alias contribui com **uma entrada por referência de
 *    valor a `tx`** no seu escopo léxico — ou seja, por instrução que roda
 *    dentro da transação. Alias sem referência contribui com 0 entradas (não
 *    executa instrução alguma).
 *    - Referência em **posição de tipo** não conta: `typeof tx` é asserção de
 *      tipo, não leitura de valor. A cláusula 1 vale para a referência ao
 *      *alias*, não apenas para o handle.
 *      **Limite declarado:** o mesmo teste descarta `class A extends tx {}`,
 *      cuja leitura é de runtime (o nó `ExpressionWithTypeArguments` é `TypeNode`
 *      no AST). O handle sempre foi descartado pelo mesmo motivo, então o
 *      comportamento é consistente — mas é um falso negativo, não uma virtude.
 *    - **Sombreamento é respeitado** para as ligações que este scanner modela:
 *      um bloco que declara `tx` no próprio escopo poda a subárvore **inteira**
 *      — `const`/`let`/`class` por TDZ (a sombra vale inclusive para as
 *      referências escritas **antes** da sombreadora), `function` por hoisting.
 *      Parâmetro, `catch`, cabeçalho de `for`, `import` e declaração homônima de
 *      função/classe sombreiam a subárvore em que aparecem.
 *    - **Limites declarados do modelo de escopo** — medidos ausentes da árvore
 *      hoje, deliberadamente **fora** desta correção e candidatos a WP próprio:
 *      (i) `var` é *function-scoped* na linguagem e o scanner o trata como
 *      escopado ao bloco mais próximo, então um `var tx` em bloco aninhado perde
 *      as referências fora do bloco e não sombreia o alias externo lá fora;
 *      (ii) o nome de um **método ou campo de classe** homônimo poda a subárvore
 *      como se fosse ligação de valor, embora não ligue o nome no corpo;
 *      (iii) um `namespace` não delimita escopo aqui. Nenhum destes é coberto
 *      por teste hoje.
 * 3. `src/test/**` é código de teste, não caminho de runtime: fica fora da
 *    varredura (o gerador enumera `src/**`).
 * 4. A classificação deixa de ser prefixo de caminho puro: o *shape* do site é
 *    evidência de runtime e tem precedência, e um arquivo só-tipo (sem instrução
 *    de valor) não produz site nenhum, logo não recebe rótulo de runtime.
 *    - `executor-fallback`: o handle só preenche o executor padrão de um
 *      parâmetro (`executor: Executor = context.transaction`) ou o **lado
 *      direito** de `??`, `||`, `??=` ou `||=`; não abre transação, herda a do
 *      chamador. À **esquerda** o handle é o primário, não o default, e o site
 *      não é fallback.
 *    - `auth-allowlist`: módulo no prefixo que `scripts/m02-boundaries.ts`
 *      permite direto (`src/server/auth/**`).
 *    - `repository-fallback`: módulo de repositório consumindo o handle do
 *      contexto.
 *    - `compatibility-facade`: fachada/adapter que estreita o handle neutro.
 */

export type TransactionSiteClassification =
  "auth-allowlist" | "repository-fallback" | "compatibility-facade";

export type TransactionSiteExpression = "request.transaction" | "context.transaction";

/** Como o handle aparece no site. Ver semântica declarada no topo do módulo. */
export type TransactionSiteShape = "direct-use" | "binding-alias" | "executor-fallback";

export type TransactionSite = {
  path: string;
  line: number;
  expression: TransactionSiteExpression;
  classification: TransactionSiteClassification;
};

/** Unidade de entrada do scanner: caminho normalizado (`src/...`) + fonte. */
export type TransactionSiteSource = {
  path: string;
  source: string;
};

const HANDLE_NAMES = ["context", "request"] as const;
const AUTH_ALLOWLIST_PREFIX = "src/server/auth/";
const REPOSITORY_PREFIX = "src/server/repositories/";
const TEST_PREFIX = "src/test/";

function handleBase(expression: ts.PropertyAccessExpression): TransactionSiteExpression | null {
  if (!ts.isIdentifier(expression.expression)) return null;
  if (expression.name.text !== "transaction") return null;
  const base = expression.expression.text;
  if (!HANDLE_NAMES.includes(base as (typeof HANDLE_NAMES)[number])) return null;
  return `${base}.transaction` as TransactionSiteExpression;
}

/** Desembrulha `as T`, `(expr)` e `expr!` para achar o hospedeiro sintático. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    (ts.isAsExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent as ts.Expression;
  }
  return current;
}

/**
 * `true` quando o handle aparece em posição de **tipo** (`typeof context.transaction`):
 * não é instrução de runtime, logo não é site.
 */
function inTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
    current = current.parent;
  }
  return false;
}

/** Operadores cujo **lado direito** é o fallback do executor. */
const FALLBACK_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);

/** `true` quando `node` está na subárvore de `ancestor`. */
function isWithin(ancestor: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function siteShape(host: ts.Node, handle: ts.Node): TransactionSiteShape {
  if (ts.isVariableDeclaration(host) && ts.isIdentifier(host.name)) return "binding-alias";
  if (ts.isParameter(host)) return "executor-fallback";
  if (ts.isBinaryExpression(host) && FALLBACK_OPERATORS.has(host.operatorToken.kind)) {
    // Só o lado DIREITO é fallback. À esquerda o handle é o primário: rotulá-lo
    // de fallback inverteria a leitura de quem paga a transação.
    return isWithin(host.right, handle) ? "executor-fallback" : "direct-use";
  }
  return "direct-use";
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    // `{ tx: other }` liga `other`; `{ tx }` liga `tx`; `[a]` liga `a`.
    if (ts.isOmittedExpression(element)) continue;
    names.push(...bindingNames(element.name));
  }
  return names;
}

/** Nome introduzido por declarações que criam ligação de valor. */
function declaredName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return node.name?.text;
  }
  if (
    (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  return undefined;
}

function declaredParameters(node: ts.Node): readonly ts.ParameterDeclaration[] {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.parameters;
  }
  return [];
}

/**
 * `true` quando o nó introduz uma ligação homônima e portanto sombreia o alias
 * alvo em toda a sua subárvore (parâmetro, variável, função, classe, `catch`,
 * import).
 */
/** `true` quando alguma declaração da lista liga `name`. */
function declarationListDeclaresName(list: ts.VariableDeclarationList, name: string): boolean {
  return list.declarations.some((declaration) => bindingNames(declaration.name).includes(name));
}

function declaresName(node: ts.Node, name: string): boolean {
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return true;
  if (declaredName(node) === name) return true;
  for (const parameter of declaredParameters(node)) {
    if (bindingNames(parameter.name).includes(name)) return true;
  }
  if (ts.isVariableDeclaration(node) && bindingNames(node.name).includes(name)) return true;
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    return bindingNames(node.variableDeclaration.name).includes(name);
  }
  // `for (const tx of …)`: o cabeçalho é o escopo do laço, então sombreia o
  // corpo e o próprio cabeçalho — podar a subárvore inteira do `for` é correto.
  const loopInitializer: ts.Node | undefined =
    ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      ? node.initializer
      : undefined;
  if (loopInitializer && ts.isVariableDeclarationList(loopInitializer)) {
    return declarationListDeclaresName(loopInitializer, name);
  }
  return false;
}

/** `true` quando o identificador é leitura de valor da ligação (não nome de propriedade). */
function isValueReference(node: ts.Identifier, name: string): boolean {
  if (node.text !== name) return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  // Posição de tipo não é leitura de valor: `type H = typeof tx` não executa
  // instrução alguma. A cláusula vale para a referência ao alias, não só para o
  // handle (que já é filtrado em `sitesForModule`).
  if (inTypePosition(node)) return false;
  return true;
}

/**
 * O bloco mais próximo delimita o alias. Vale para **todas** as declarações que
 * este scanner reconhece, inclusive `var` — que é *function-scoped* na
 * linguagem e portanto um limite declarado do modelo (ver o cabeçalho).
 */
function enclosingScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isSourceFile(current) ||
      ts.isBlock(current) ||
      ts.isModuleBlock(current) ||
      ts.isCaseBlock(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

/** Contêineres cujo corpo é um escopo léxico com lista de instruções própria. */
function isScopeContainer(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)
  );
}

function statementsOf(container: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isSourceFile(container) || ts.isBlock(container) || ts.isModuleBlock(container)) {
    return container.statements;
  }
  if (ts.isCaseBlock(container)) {
    return container.clauses.flatMap((clause) => clause.statements);
  }
  return undefined;
}

/**
 * `true` quando a instrução introduz `name` **no escopo em que aparece**. Não
 * desce em blocos nem em corpos de função: esses são outros escopos.
 */
function statementDeclaresName(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return declarationListDeclaresName(statement.declarationList, name);
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return true;
  }
  if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) return true;
  // Sem caso de `for` aqui: o cabeçalho de um laço escopa só o próprio laço, não
  // o bloco em volta — quem poda a subárvore do laço é `declaresName`.
  return false;
}

/**
 * `true` quando o escopo de `container` declara `name` **fora do próprio
 * alias** — logo o alias está sombreado em toda a subárvore de `container`.
 *
 * Podar a subárvore **inteira** (e não só o que vem depois da declaração
 * sombreadora) é o que a linguagem faz: `const`/`let`/`class` deixam o nome em
 * TDZ desde o topo do bloco e `function` sofre hoisting, então uma referência
 * escrita antes do sombreador também pertence ao sombreador.
 */
function scopeShadowsName(
  container: ts.Node,
  name: string,
  declaration: ts.VariableDeclaration,
): boolean {
  const statements = statementsOf(container);
  if (!statements) return false;
  for (const statement of statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.includes(declaration)
    ) {
      // O próprio alias não sombreia a si mesmo; um irmão do mesmo `const` sombrearia.
      for (const sibling of statement.declarationList.declarations) {
        if (sibling !== declaration && bindingNames(sibling.name).includes(name)) return true;
      }
      continue;
    }
    if (statementDeclaresName(statement, name)) return true;
  }
  return false;
}

/**
 * Referências de valor à ligação criada por `declaration`, em ordem léxica. O
 * próprio `declaration` (nome e inicializador) não conta.
 */
function bindingReferences(declaration: ts.VariableDeclaration, name: string): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  // O caminho até o próprio alias nunca é podado. Sem esta guarda, um alias que
  // nasce no cabeçalho de um `for` seria podado por `declaresName` (que
  // reconhece o inicializador do laço) e perderia as suas próprias referências.
  const lineage = new Set<ts.Node>();
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    lineage.add(current);
  }
  const visit = (node: ts.Node): void => {
    if (node === declaration) return;
    if (!lineage.has(node)) {
      // 1. Sombra de escopo: o bloco declara o nome no próprio escopo, então
      //    nada abaixo dele pertence ao alias externo.
      if (isScopeContainer(node) && scopeShadowsName(node, name, declaration)) return;
      // 2. Sombra local: parâmetro, `catch`, `for`, função/classe/import homônimo.
      if (declaresName(node, name)) return;
    }
    if (ts.isIdentifier(node) && isValueReference(node, name)) references.push(node);
    ts.forEachChild(node, visit);
  };
  visit(enclosingScope(declaration));
  return references;
}

export function classifyTransactionSite(input: {
  path: string;
  shape: TransactionSiteShape;
}): TransactionSiteClassification {
  if (input.shape === "executor-fallback") return "repository-fallback";
  if (input.path.startsWith(AUTH_ALLOWLIST_PREFIX)) return "auth-allowlist";
  if (input.path.startsWith(REPOSITORY_PREFIX)) return "repository-fallback";
  return "compatibility-facade";
}

function lineAt(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function sitesForModule({ path, source }: TransactionSiteSource): TransactionSite[] {
  if (!path.startsWith("src/") || path.startsWith(TEST_PREFIX)) return [];
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const sites: TransactionSite[] = [];
  const push = (
    expression: TransactionSiteExpression,
    line: number,
    shape: TransactionSiteShape,
  ) => {
    sites.push({
      path,
      line,
      expression,
      classification: classifyTransactionSite({ path, shape }),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && !inTypePosition(node)) {
      const expression = handleBase(node);
      if (expression) {
        const host = unwrap(node).parent;
        const shape = siteShape(host, node);
        if (
          shape === "binding-alias" &&
          ts.isVariableDeclaration(host) &&
          ts.isIdentifier(host.name)
        ) {
          for (const reference of bindingReferences(host, host.name.text)) {
            push(expression, lineAt(parsed, reference), shape);
          }
        } else {
          push(expression, lineAt(parsed, node), shape);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return sites.sort((a, b) => a.line - b.line);
}

/**
 * Varredura determinística: a ordem da saída depende só de `path`+`line`, nunca
 * da ordem do array de entrada.
 */
export function transactionSites(sources: readonly TransactionSiteSource[]): TransactionSite[] {
  return sources
    .flatMap(sitesForModule)
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * Guarda de entrypoint: `true` quando o módulo roda como script, `false` quando
 * é apenas importado — importar `scripts/m02-matrix.ts` não pode regravar a
 * matriz.
 */
export function isEntrypoint(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const canonical = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return canonical(fileURLToPath(importMetaUrl)) === canonical(argv1);
}
