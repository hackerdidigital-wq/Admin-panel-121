// Pure Web Crypto security primitives compatible with both Cloudflare Workers and Node.js 22+
const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function computeSha256(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return toHex(new Uint8Array(digest));
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function generateUid(prefix = 'usr'): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${toHex(bytes)}`;
}

// PBKDF2-SHA256 password hashing (100,000 iterations — Cloudflare Workers & Web Crypto native)
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt.buffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(derived))}`;
}

export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash || !password) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;

  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);
  if (!Number.isFinite(iterations) || iterations < 10_000 || salt.length < 8 || expected.length !== 32) {
    return false;
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const saltCopy = new Uint8Array(salt.byteLength);
  saltCopy.set(salt);

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltCopy.buffer,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return constantTimeEqual(new Uint8Array(derived), expected);
}

// Base32 + RFC 6238 TOTP (Web Crypto HMAC-SHA1)
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(byteLength = 20): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.replace(/=+$/g, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export async function generateTotpCode(
  secretBase32: string,
  timestampMs = Date.now(),
  stepSeconds = 30
): Promise<string> {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const keyBytes = decodeBase32(secretBase32);
  const keyCopy = new Uint8Array(keyBytes.byteLength);
  keyCopy.set(keyBytes);

  const key = await crypto.subtle.importKey(
    'raw',
    keyCopy.buffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf.buffer));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, '0');
}

export async function verifyTotpToken(
  secretBase32: string,
  code: string,
  timestampMs = Date.now(),
  windowSteps = 1
): Promise<boolean> {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;

  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const candidate = await generateTotpCode(secretBase32, timestampMs + offset * 30_000);
    if (constantTimeEqual(encoder.encode(candidate), encoder.encode(normalized))) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(email: string, secret: string, issuer = 'AegisConsole'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

// SHA-256 Tamper-Evident Audit Hash Chaining
export interface AuditHashPayload {
  prevHash: string;
  actorEmail: string;
  action: string;
  module: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
  status: string;
  createdAtIso: string;
}

export async function computeAuditHash(payload: AuditHashPayload): Promise<string> {
  const canonical = JSON.stringify([
    payload.prevHash,
    payload.actorEmail,
    payload.action,
    payload.module,
    payload.targetType,
    payload.targetId,
    payload.details,
    payload.status,
    payload.createdAtIso,
  ]);
  return computeSha256(canonical);
}

// IP allowlist evaluation (supports exact IP, IPv4 wildcard suffix e.g. 10.0.*, or empty allowlist)
export function isIpAllowed(clientIp: string, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const cleanIp = clientIp.replace(/^::ffff:/, '').trim();
  if (!cleanIp) return false;
  return allowlist.some((rule) => {
    const cleanRule = rule.trim();
    if (!cleanRule) return false;
    if (cleanRule === '*') return true;
    if (cleanRule.endsWith('.*')) {
      const prefix = cleanRule.slice(0, -1);
      return cleanIp.startsWith(prefix);
    }
    if (cleanRule.endsWith('/24')) {
      const octets = cleanRule.replace('/24', '').split('.');
      if (octets.length === 4) {
        return cleanIp.startsWith(`${octets[0]}.${octets[1]}.${octets[2]}.`);
      }
    }
    return cleanIp === cleanRule;
  });
}

// Password policy enforcement
export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
}

export function validatePasswordStrength(
  password: string,
  policy: PasswordPolicy = {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: true,
  }
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters.`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain an uppercase letter.');
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain a lowercase letter.');
  }
  if (policy.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain a number.');
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain a special symbol.');
  }
  return { valid: errors.length === 0, errors };
}

// Sliding window rate limiter
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  consume(key: string, nowMs = Date.now()): { allowed: boolean; remaining: number; resetMs: number } {
    const cutoff = nowMs - this.windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (timestamps.length >= this.maxRequests) {
      this.hits.set(key, timestamps);
      const oldest = timestamps[0] ?? nowMs;
      return {
        allowed: false,
        remaining: 0,
        resetMs: Math.max(0, oldest + this.windowMs - nowMs),
      };
    }
    timestamps.push(nowMs);
    this.hits.set(key, timestamps);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      resetMs: this.windowMs,
    };
  }
}

export function sanitizeText(value: unknown, maxLength = 2000): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, maxLength);
}
