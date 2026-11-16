import { isIP } from 'node:net';

/** The request headers this module reads (a `Headers`, or what `headers()` returns). */
export interface HeaderSource {
  get(name: string): string | null;
}

function valid(value: string | null | undefined): string | null {
  const ip = value?.trim();
  return ip && isIP(ip) !== 0 ? ip : null;
}

/**
 * The visitor's IP, as the API's per-IP rate limit wants it in `X-Client-IP`: the first
 * `X-Forwarded-For` address (Vercel sets it to the client's), else `X-Real-IP`; null when neither
 * holds an IP address.
 */
export function clientIpFrom(headers: HeaderSource): string | null {
  const forwarded = headers.get('x-forwarded-for');
  return valid(forwarded?.split(',')[0]) ?? valid(headers.get('x-real-ip'));
}
