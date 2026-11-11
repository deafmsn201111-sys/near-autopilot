import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { ALLOWED, LOCATIONS, TEST_ALLOWED } from './boundaries.config.mjs';

const ALL_PACKAGES = Object.keys(ALLOWED);

const TESTING = {
  name: '@near-autopilot/core/testing',
  message: 'Test doubles must not be imported by production code',
};

/**
 * ESLint replaces (does not merge) rule options between config blocks, so every block below is
 * generated with its COMPLETE restriction list for the files it matches.
 */
function restrictions(name, { production, isCoreRuntime }) {
  const allowed = new Set([...ALLOWED[name], ...(production ? [] : (TEST_ALLOWED[name] ?? []))]);
  const forbidden = ALL_PACKAGES.filter((p) => p !== name && !allowed.has(p));
  const message = (p) => `${name} may not depend on ${p} (see boundaries.config.mjs)`;
  return [
    'error',
    {
      paths: [
        ...forbidden.map((p) => ({ name: p, message: message(p) })),
        ...(production ? [TESTING] : []),
      ],
      patterns: [
        ...forbidden.map((p) => ({ group: [`${p}/*`], message: message(p) })),
        {
          group: ['@near-autopilot/*/src/*'],
          message: 'Import from the package entry point, not its internals',
        },
        ...(isCoreRuntime
          ? [
              {
                group: ['node:*'],
                message: 'core must stay isomorphic (node: imports only in hash.ts)',
              },
            ]
          : []),
      ],
    },
  ];
}

const boundaryRules = Object.entries(LOCATIONS).flatMap(([name, location]) => {
  const isCore = name === '@near-autopilot/core';
  const testFiles = [`${location}/**/test/**/*.ts`, `${location}/**/*.test.ts`];
  const blocks = [
    // Production source: full restrictions, including "no test doubles".
    {
      files: [`${location}/**/*.{ts,tsx}`],
      ignores: [
        ...testFiles,
        ...(isCore ? [`${location}/src/hash.ts`, `${location}/src/testing.ts`] : []),
      ],
      rules: {
        'no-restricted-imports': restrictions(name, { production: true, isCoreRuntime: isCore }),
      },
    },
    // Tests may use test doubles but obey the same layering.
    {
      files: testFiles,
      rules: {
        'no-restricted-imports': restrictions(name, { production: false, isCoreRuntime: false }),
      },
    },
  ];
  if (isCore) {
    blocks.push({
      files: [`${location}/src/hash.ts`, `${location}/src/testing.ts`],
      rules: {
        'no-restricted-imports': restrictions(name, { production: false, isCoreRuntime: false }),
      },
    });
  }
  return blocks;
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.mjs',
      '**/next-env.d.ts',
      'packages/db/drizzle/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      // Port implementations are often async by contract without awaiting anything.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      'no-console': ['error', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  ...boundaryRules,
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['packages/db/src/migrate-cli.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
