import { describe, it, expect } from 'vitest';
import { timeAgo } from './time';

describe('timeAgo', () => {
  it('returns "just now" for 30 seconds ago', () => {
    const date = new Date(Date.now() - 30 * 1000).toISOString();
    expect(timeAgo(date)).toBe('just now');
  });

  it('returns "5m ago" for 5 minutes ago', () => {
    const date = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(timeAgo(date)).toBe('5m ago');
  });

  it('returns "1h ago" for 90 minutes ago (floors to hours)', () => {
    const date = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    expect(timeAgo(date)).toBe('1h ago');
  });

  it('returns "3h ago" for 3 hours ago', () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(date)).toBe('3h ago');
  });

  it('returns "2d ago" for 2 days ago', () => {
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(date)).toBe('2d ago');
  });

  it('returns "1mo ago" for 45 days ago', () => {
    const date = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(date)).toBe('1mo ago');
  });

  it('returns "just now" for a future date', () => {
    const date = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(timeAgo(date)).toBe('just now');
  });

  it('returns "just now" for an invalid date string', () => {
    expect(timeAgo('not-a-date')).toBe('just now');
  });
});
