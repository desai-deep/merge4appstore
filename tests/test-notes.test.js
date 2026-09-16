import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTestNotes } from '../lib/test-notes.js';

test('extracts case-insensitive test notes at every Markdown heading level', () => {
  for (let level = 1; level <= 6; level += 1) {
    const heading = '#'.repeat(level);
    assert.equal(extractTestNotes([
      'Unrelated description',
      `${heading} tEsT NoTeS ###`,
      '',
      'Verify playback.',
      '- Try pausing.',
      '',
      `${heading} Implementation`,
      'Private implementation details',
    ].join('\r\n')), 'Verify playback.\n- Try pausing.');
  }
});

test('includes nested headings and stops at a parent heading', () => {
  assert.equal(extractTestNotes([
    '## Test notes',
    'Check playback.',
    '### Offline',
    'Enable airplane mode.',
    '# Other details',
    'Do not include.',
  ].join('\n')), 'Check playback.\n### Offline\nEnable airplane mode.');
});

test('ignores headings inside code fences and preserves code in instructions', () => {
  assert.equal(extractTestNotes([
    '```markdown',
    '# Test notes',
    'An example, not instructions.',
    '```',
    '## Test Notes',
    'Run:',
    '~~~sh',
    '# A shell comment',
    'echo test',
    '~~~',
    '## Other',
    'Excluded.',
  ].join('\n')), 'Run:\n~~~sh\n# A shell comment\necho test\n~~~');
});

test('combines multiple test notes sections in document order', () => {
  assert.equal(extractTestNotes('# Test notes\nFirst\n# Other\nExcluded\n## Test Notes\nSecond'), 'First\n\nSecond');
});

test('preserves indentation when a section starts with a code block', () => {
  assert.equal(extractTestNotes('## Test notes\n\n    first command\n    second command\n\n'), '    first command\n    second command');
});

test('returns no instructions for absent, empty, or differently named sections', () => {
  for (const body of [undefined, null, '', 'General description', '# Testing\nDetails', '## Test notes\n\n## Other\nDetails', '## Test notes']) {
    assert.equal(extractTestNotes(body), '');
  }
});
