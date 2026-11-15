// eslint.config.mjs
import tsparser from '@typescript-eslint/parser';
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';

export default defineConfig([
  {
    ignores: ['main.js', 'node_modules/**', 'dist/**', 'package.json', 'src/vendor/**'],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' },
      globals: {
        ...globals.browser,
        ...globals.node,
        NodeJS: 'readonly',
      },
    },
    plugins: {
      jsdoc,
    },
    rules: {
      /* '@typescript-eslint/naming-convention': 'error', */
      'obsidianmd/ui/sentence-case': [
        'error',
        {
          brands: [
            'LLM',
            'PureChatLLM',
            'Voice Agent',
            'Google',
            'Google Cloud',
            'Generative Language API',
            'OAuth',
            'Pure Chat LLM',
            'API',
            'Pure Chat LLM',
            'OpenAI',
            'ChatGPT',
            'DALL-E',
            'api.openai.com',
            'HTML',
            'YAML',
            'AI',
            'GPT-Live',
            'Gemini',
            'Grok',
            'Google Search',
            'JavaScript',
            'Streamable HTTP',
            'BCP-47',
            'X',
            'djs',
            'TypeScript',
            'QuickJS',
            'WebAssembly',
            'Web Worker',
            'Meta',
            'Muse',
          ],
          acronyms: ['OK', 'MCP', 'VAD', 'HTTP', 'SKILL.md'],
          enforceCamelCaseLower: true,
        },
      ],
      /*       'jsdoc/require-jsdoc': [
        'error',
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
        },
      ],
      'jsdoc/require-param-description': 'warn',
      'jsdoc/require-returns-description': 'warn',
      'jsdoc/check-param-names': 'error',
      'jsdoc/require-param': 'error',
      'jsdoc/require-returns': 'error',
 */ 'prefer-const': 'error',
    },
  },
]);
