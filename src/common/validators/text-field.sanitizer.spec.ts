import { describe, expect, it } from 'vitest';
import { sanitizeTextField } from './text-field.sanitizer';

describe('sanitizeTextField', () => {
  it('trims leading and trailing whitespace', () => {
    expect(sanitizeTextField('  hello  ')).toBe('hello');
  });

  it('collapses internal multiple spaces to one', () => {
    expect(sanitizeTextField('hello   world')).toBe('hello world');
  });

  it('collapses tabs and newlines to a single space', () => {
    expect(sanitizeTextField('foo\t\nbar')).toBe('foo bar');
  });

  it('returns an empty string unchanged', () => {
    expect(sanitizeTextField('')).toBe('');
  });

  it('returns a clean string unchanged', () => {
    expect(sanitizeTextField('Acme Corp')).toBe('Acme Corp');
  });

  it('handles a string that is only whitespace', () => {
    expect(sanitizeTextField('   ')).toBe('');
  });
});
