import tseslint from 'typescript-eslint';

// The project keeps its TypeScript sources free of explicit `any`. The published
// mod API declaration is intentionally permissive (`any` for mod-provided
// payloads), so it opts out of the rule.
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
  {
    files: ['schemas/**/*.d.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
