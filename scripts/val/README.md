# Validação navegacional do frontend

Este diretório contém o roteiro V1 do trilho produto para a validação navegacional autenticada. O script usa o Playwright já instalado no repositório, não adiciona dependências e não prepara banco, cria fixtures ou executa operações de domínio.

## Pré-condições

- O servidor do frontend deve estar em execução e acessível pela `BASE_URL`.
- `BASE_URL` é opcional; o padrão é `http://localhost:3000`.
- A conta usada deve ser uma credencial de teste já existente no ambiente. O script não cria conta nem executa preparação de E2E.
- `E2E_AUTH_EMAIL` e `E2E_AUTH_PASSWORD` devem existir somente no ambiente de execução. Não coloque os valores em arquivos, no README, em logs, em evidências ou no repositório.
- O pacote `@playwright/test` e os browsers necessários devem estar disponíveis em `node_modules`.
- O servidor precisa responder `HTTP 200` tanto em `/api/health/live` quanto em `/api/health/ready`. O script aguarda respostas `200`; timeout, erro de rede ou outro status encerra com código `3`.

Antes de executar em um ambiente compartilhado, confirme que a conta e o banco são de teste. A navegação não deve ser usada contra uma conta ou base de produção.

## Execução

Com o servidor já iniciado, injete os valores apenas na sessão atual do shell:

```bash
read -r -p "E-mail de teste: " E2E_AUTH_EMAIL
read -r -s -p "Senha de teste: " E2E_AUTH_PASSWORD
printf '\n'
export E2E_AUTH_EMAIL E2E_AUTH_PASSWORD

# BASE_URL pode ser exportada aqui; sem ela, usa http://localhost:3000.
node scripts/val/validate-navigation.mjs
codigo=$?

unset E2E_AUTH_EMAIL E2E_AUTH_PASSWORD
exit "$codigo"
```

O arquivo também possui shebang para execução direta:

```bash
./scripts/val/validate-navigation.mjs
```

O script cria `scripts/val/out/` e salva, ao final de cada navegação, uma captura em:

```text
scripts/val/out/inicio.png
scripts/val/out/produtos.png
scripts/val/out/precos.png
scripts/val/out/ponto-equilibrio.png
scripts/val/out/despesas.png
scripts/val/out/simulacoes.png
scripts/val/out/diagnostico.png
```

O e-mail exibido pelo shell autenticado é mascarado nas capturas. O script não grava senha, cookie, token ou cabeçalho de autenticação em arquivo.

## O que o script verifica

1. Presença das duas variáveis de credencial, com falha rápida e código `2` quando alguma está ausente.
2. Disponibilidade de `/api/health/live` e `/api/health/ready`, exigindo `HTTP 200`.
3. Login pela tela `/auth`, usando os rótulos `E-mail`, `Senha` e o botão `Entrar`.
4. Redirecionamento para `/inicio` e presença do shell autenticado (`Olá! 👋`).
5. Navegação direta, na mesma sessão autenticada, por `/inicio`, `/produtos`, `/precos`, `/ponto-equilibrio`, `/despesas`, `/simulacoes` e `/diagnostico`.
6. Para cada rota, URL final, status da resposta principal, heading esperado, `console.error`, `pageerror`, respostas HTTP `>= 400`, falhas de requisição e sucesso da captura PNG.
7. Tabela-resumo no terminal, detalhes das falhas e a lista de arquivos gerados.

Nenhuma tela de chat/IA é aberta, nenhum prompt é digitado e nenhuma mensagem é submetida. Também não há preenchimento ou clique em formulários de produto, preço, despesa, simulação ou diagnóstico: não é criada despesa sentinela e não são executadas mutações de dados. O login necessário é a única submissão deliberada do roteiro.

## Códigos de saída

| Código | Significado                                                                                                                        |
| -----: | ---------------------------------------------------------------------------------------------------------------------------------- |
|    `0` | Health, login e todas as rotas ficaram verdes, sem erros observados.                                                               |
|    `1` | Falha de login, navegação, heading, URL, resposta principal, console, JavaScript da página, rede, resposta `>= 400` ou screenshot. |
|    `2` | `E2E_AUTH_EMAIL` ou `E2E_AUTH_PASSWORD` ausente.                                                                                   |
|    `3` | Health inacessível, expirado ou diferente de `HTTP 200`; também cobre `BASE_URL` inválida.                                         |

## Runbook manual V2 e evidência

O operador deve registrar a execução manual em um diretório com o padrão `docs/evidence/manual-val-*/`. Esta implementação não cria nem modifica esse diretório.

Capturar, sem qualquer segredo:

- data, hora, fuso e identificação do ambiente/build; registrar `BASE_URL` sem credenciais embutidas;
- a saída dos dois health checks, com os status observados, e o código de saída do script;
- a tabela-resumo completa, incluindo URL final, resposta principal, contagens de erros e resultado por rota;
- os sete PNGs de `scripts/val/out/`, com seus nomes e, se a evidência exigir integridade, os respectivos `sha256sum`;
- qualquer detalhe de `console.error`, `pageerror`, resposta `>= 400`, falha de rede, timeout ou screenshot, preservando a mensagem literal e o endpoint sem query sensível;
- uma declaração do operador de que o fluxo não abriu chat/IA, não digitou prompt, não submeteu mensagem e não executou mutação de dados.

Não capturar nem anexar senha, e-mail real, cookies, tokens, cabeçalhos de autorização, URLs de conexão, dumps de banco ou conteúdo de mensagens. Se a validação manual precisar revisar dados exibidos na tela, redija a evidência antes de armazená-la.

Se o health check retornar `503` ou não responder, registrar a execução como bloqueada pelo ambiente (`exit 3`) e não prosseguir com login ou navegação. Um servidor vivo sem readiness não é resultado verde.
