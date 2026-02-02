/**
 * Commitlint configuration for conventional commits
 * Works with cz-git for standardized commit messages
 */

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',      // A new feature
        'fix',       // A bug fix
        'docs',      // Documentation changes
        'style',     // Code style changes (formatting, etc)
        'refactor',  // Code refactoring
        'perf',      // Performance improvements
        'test',      // Test changes
        'chore',     // Build, dependencies, tooling
        'ci',        // CI/CD changes
        'build',     // Build system changes
      ],
    ],
    'type-case': [2, 'always', 'lowercase'],
    'type-empty': [2, 'never'],
    'scope-empty': [0],
    'scope-case': [2, 'always', 'lowercase'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'subject-case': [0],
    'subject-exclamation-mark': [0],
    'header-max-length': [2, 'always', 100],
  },
};
