import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { UserFacingError } from '../../core/errors.js';

const BLOCKED_MESSAGE = 'That URL is not allowed.';

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }
  const [a, b] = parts;
  if (a === undefined || b === undefined) {
    return true;
  }
  // 0.0.0.0/8, loopback, RFC1918, link-local, carrier-grade NAT, multicast/reserved
  if (a === 0 || a === 10 || a === 127 || a === 224 || a >= 240) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') {
    return true;
  }
  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  ) {
    return true;
  }
  // IPv4-mapped IPv6
  if (normalized.includes('.')) {
    const mapped = normalized.replace(/^:+/u, '').split(':').at(-1);
    if (mapped && isIP(mapped) === 4) {
      return isBlockedIpv4(mapped);
    }
  }
  return false;
}

export function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isBlockedIpv4(address);
  }
  if (version === 6) {
    return isBlockedIpv6(address);
  }
  return true;
}

/**
 * Validates that a media URL is http(s) and does not resolve to private/loopback/link-local hosts.
 */
export async function assertSafeMediaUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UserFacingError(
      'Provide a YouTube/SoundCloud URL or a direct http(s) audio URL.',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UserFacingError(
      'Provide a YouTube/SoundCloud URL or a direct http(s) audio URL.',
    );
  }

  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  if (host.length === 0) {
    throw new UserFacingError(BLOCKED_MESSAGE);
  }

  if (isIP(host) !== 0) {
    if (isBlockedIpAddress(host)) {
      throw new UserFacingError(BLOCKED_MESSAGE);
    }
    return parsed;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UserFacingError('Could not resolve that URL host.');
  }

  if (addresses.length === 0) {
    throw new UserFacingError('Could not resolve that URL host.');
  }

  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) {
      throw new UserFacingError(BLOCKED_MESSAGE);
    }
  }

  return parsed;
}
