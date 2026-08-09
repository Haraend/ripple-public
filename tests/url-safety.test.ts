import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/core/errors.js';
import { assertSafeMediaUrl, isBlockedIpAddress } from '../src/modules/music/url-safety.js';

describe('isBlockedIpAddress', () => {
  it('blocks loopback and private IPv4 ranges', () => {
    expect(isBlockedIpAddress('127.0.0.1')).toBe(true);
    expect(isBlockedIpAddress('10.0.0.5')).toBe(true);
    expect(isBlockedIpAddress('192.168.1.1')).toBe(true);
    expect(isBlockedIpAddress('172.16.0.1')).toBe(true);
    expect(isBlockedIpAddress('169.254.169.254')).toBe(true);
  });

  it('allows public IPv4 addresses', () => {
    expect(isBlockedIpAddress('1.1.1.1')).toBe(false);
    expect(isBlockedIpAddress('8.8.8.8')).toBe(false);
  });

  it('blocks loopback and ULA IPv6', () => {
    expect(isBlockedIpAddress('::1')).toBe(true);
    expect(isBlockedIpAddress('fc00::1')).toBe(true);
    expect(isBlockedIpAddress('fe80::1')).toBe(true);
  });
});

describe('assertSafeMediaUrl', () => {
  it('rejects non-http protocols', async () => {
    await expect(assertSafeMediaUrl('ftp://example.com/a.mp3')).rejects.toBeInstanceOf(
      UserFacingError,
    );
  });

  it('rejects literal private IPs', async () => {
    await expect(assertSafeMediaUrl('http://127.0.0.1/audio.mp3')).rejects.toBeInstanceOf(
      UserFacingError,
    );
    await expect(assertSafeMediaUrl('http://192.168.0.10/a.mp3')).rejects.toBeInstanceOf(
      UserFacingError,
    );
    await expect(assertSafeMediaUrl('http://169.254.169.254/latest')).rejects.toBeInstanceOf(
      UserFacingError,
    );
  });

  it('allows a public https URL that resolves publicly', async () => {
    const url = await assertSafeMediaUrl('https://example.com/sample.mp3');
    expect(url.hostname).toBe('example.com');
  });
});
