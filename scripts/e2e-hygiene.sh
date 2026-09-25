#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'E2E não iniciado: %s\n' "$1" >&2
  exit 2
}

[[ -f package.json ]] || fail 'execute este wrapper na raiz do repositório (package.json ausente).'
[[ -d node_modules ]] || fail 'dependências ausentes; execute npm ci antes do E2E.'
[[ -x node_modules/.bin/playwright ]] || fail 'Playwright ausente; execute npm ci antes do E2E.'

required_env=(
  DATABASE_URL
  DATABASE_ADMIN_URL
  E2E_AUTH_EMAIL
  E2E_AUTH_PASSWORD
)

for name in "${required_env[@]}"; do
  [[ -n "${!name:-}" ]] || fail "variável obrigatória ausente: ${name}."
done

[[ "${E2E_AUTH_EMAIL}" == *@* ]] || fail 'E2E_AUTH_EMAIL deve conter um endereço válido.'
[[ ${#E2E_AUTH_PASSWORD} -ge 10 ]] || fail 'E2E_AUTH_PASSWORD deve ter pelo menos 10 caracteres.'

printf 'Executando E2E com NO_COLOR removido do ambiente.\n'
exec env -u NO_COLOR npm run test:e2e "$@"
