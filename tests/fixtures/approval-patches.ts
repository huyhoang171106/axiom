// tests/fixtures/approval-patches.ts - Valid unified diffs ready for C7 integration tests.
export const LONG_APPROVAL_PATCH = [
  '--- a/.github/example.yml', '+++ b/.github/example.yml', '@@ -1 +1,36 @@', '-old',
  ...Array.from({ length: 36 }, (_, i) => `+line-${i + 1}${i === 35 ? '-FINAL-DIFF-LINE' : ''}`), '',
].join('\n');
export const MULTI_FILE_APPROVAL_PATCH = Array.from({ length: 6 }, (_, i) =>
  `--- a/file-${i}.txt\n+++ b/file-${i}.txt\n@@ -1 +1 @@\n-old\n+new\n`).join('');
