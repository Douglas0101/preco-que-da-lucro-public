import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      "playwright-report",
      "test-results",
      ".worktree-*",
      ".p0-closeout-docker",
    ],
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,ts}", "e2e/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
          patterns: [
            {
              group: ["@radix-ui/*", "radix-ui", "radix-ui/*"],
              message: "Radix is prohibited. Use the local shadcn/Base UI wrappers.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
            {
              name: "sonner",
              message: "Import toast and Toaster from @/components/ui/sonner.",
            },
          ],
          patterns: [
            {
              group: ["@base-ui/react", "@base-ui/react/*"],
              message: "Base UI may only be imported by src/components/ui wrappers.",
            },
            {
              group: ["@radix-ui/*", "radix-ui", "radix-ui/*"],
              message: "Radix is prohibited. Use @/components/ui.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/routes/**/*.tsx", "src/components/**/*.tsx"],
    ignores: ["src/components/ui/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='button']",
          message: "Use @/components/ui/button instead of a raw button.",
        },
        {
          selector: "JSXOpeningElement[name.name='input']",
          message: "Use @/components/ui/input instead of a raw input.",
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use @/components/ui/select instead of a raw select.",
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message: "Use @/components/ui/textarea instead of a raw textarea.",
        },
        {
          selector: "CallExpression[callee.name='confirm']",
          message: "Use @/components/ui/alert-dialog instead of confirm().",
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='confirm']",
          message: "Use @/components/ui/alert-dialog instead of window.confirm().",
        },
      ],
    },
  },
  {
    files: ["src/components/ui/label.tsx"],
    rules: {
      "jsx-a11y/label-has-associated-control": "off",
    },
  },
  {
    files: [
      "src/components/ui/badge.tsx",
      "src/components/ui/button.tsx",
      "src/components/ui/sonner.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  eslintPluginPrettier,
);
