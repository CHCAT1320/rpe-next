import tseslint from 'typescript-eslint';

// ESLint 9 loads this TypeScript flat config through `jiti` (a dev dependency).
// The project keeps its TypeScript sources free of explicit `any`, including the
// published mod API declaration, which uses `unknown` for mod-provided payloads.
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'assets/mods/**', 'tmp-probe/**', '.kilo/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
];
