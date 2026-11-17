import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SlidingWindowLimiter,
  buildOtpAuthUri,
  computeAuditHash,
  computeSha256,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  isIpAllowed,
  sanitizeText,
  validatePasswordStrength,
  verifyPassword,
  verifyTotpToken,
} from '../src/lib/security.ts';

test('PBKDF2-SHA256 password hashing and constant-time verification succeed and reject wrong passwords', async () => {
  const hash = await hashPassword('Aegis#Secure2026');
  assert.ok(hash.startsWith('pbkdf2_sha256$100000$'));
  assert.equal(await verifyPassword('Aegis#Secure2026', hash), true);
  assert.equal(await verifyPassword('WrongPass#2026', hash), false);
  assert.equal(await verifyPassword('Aegis#Secure2026', null), false);
});

test('SHA-256 helper produces deterministic lowercase hex digests', async () => {
  const d1 = await computeSha256('aegis-token');
  const d2 = await computeSha256('aegis-token');
  const d3 = await computeSha256('aegis-token-2');
  assert.equal(d1.length, 64);
  assert.equal(d1, d2);
  assert.notEqual(d1, d3);
});

test('TOTP RFC 6238 generation and verification succeed within time window', async () => {
  const secret = generateTotpSecret();
  assert.ok(secret.length >= 16);
  const uri = buildOtpAuthUri('admin@company.com', secret);
  assert.ok(uri.startsWith('otpauth://totp/'));

  const now = 1_700_000_000_000;
  const code = await generateTotpCode(secret, now);
  assert.match(code, /^\d{6}$/);
  assert.equal(await verifyTotpToken(secret, code, now), true);
  assert.equal(await verifyTotpToken(secret, code, now + 30_000, 1), true);
  assert.equal(await verifyTotpToken(secret, '000000', now, 0), code === '000000');
  assert.equal(await verifyTotpToken(secret, 'invalid', now), false);
});

test('Audit hash chain detects tampering deterministically', async () => {
  const basePayload = {
    prevHash: 'GENESIS',
    actorEmail: 'ops@example.com',
    action: 'user.suspend',
    module: 'users',
    targetType: 'user',
    targetId: '42',
    details: { reason: 'abuse' },
    status: 'success',
    createdAtIso: '2026-11-16T00:00:00.000Z',
  };
  const hash1 = await computeAuditHash(basePayload);
  const hash2 = await computeAuditHash(basePayload);
  const tampered = await computeAuditHash({ ...basePayload, action: 'user.activate' });

  assert.equal(hash1, hash2);
  assert.notEqual(hash1, tampered);
});

test('IP allowlist matches exact, wildcard subnet, and IPv4-mapped IPv6 addresses', () => {
  assert.equal(isIpAllowed('10.0.0.5', []), true);
  assert.equal(isIpAllowed('::ffff:192.168.1.45', ['192.168.1.*']), true);
  assert.equal(isIpAllowed('203.0.113.9', ['192.168.1.*', '10.0.0.1']), false);
});

test('Password policy validates complexity rules', () => {
  const policy = {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: true,
  };
  assert.equal(validatePasswordStrength('weak', policy).valid, false);
  assert.equal(validatePasswordStrength('StrongPass#2026', policy).valid, true);
});

test('SlidingWindowLimiter blocks after threshold and resets after window', () => {
  const limiter = new SlidingWindowLimiter(2, 1000);
  assert.equal(limiter.consume('ip1', 100).allowed, true);
  assert.equal(limiter.consume('ip1', 200).allowed, true);
  assert.equal(limiter.consume('ip1', 300).allowed, false);
  assert.equal(limiter.consume('ip1', 1200).allowed, true);
});

test('sanitizeText strips ASCII control chars and truncates safely', () => {
  assert.equal(sanitizeText('  hello\u0000world  ', 8), 'hellowor');
});
