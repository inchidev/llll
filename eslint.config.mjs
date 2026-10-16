import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    ignores: [
      '**/.admin-release/**',
      '**/.bundle/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/dist/**',
      '**/worker-configuration.d.ts',
      'apps/desktop/www/**',
      'apps/extension/www/**',
      'apps/mobile/www/**',
    ],
  },
  {
  rules: {
    'vue/multi-word-component-names': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
  },
  },
)
