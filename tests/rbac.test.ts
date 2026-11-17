import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PERMISSIONS,
  SYSTEM_ROLES,
  canManageRole,
  hasPermission,
  resolveEffectivePermissions,
} from '../src/lib/rbac';

test('super_admin resolves all system permissions unless explicitly denied', () => {
  const perms = resolveEffectivePermissions([], [], 'super_admin');
  assert.equal(perms.size, SYSTEM_PERMISSIONS.length);
  assert.equal(hasPermission(perms, 'database.inspect'), true);

  const restricted = resolveEffectivePermissions([], [{ key: 'database.inspect', granted: false }], 'super_admin');
  assert.equal(hasPermission(restricted, 'database.inspect'), false);
});

test('admin role excludes database.inspect by default unless granted via override', () => {
  const adminRole = SYSTEM_ROLES.find((r) => r.slug === 'admin')!;
  const perms = resolveEffectivePermissions(adminRole.permissions, [], 'admin');
  assert.equal(hasPermission(perms, 'users.read'), true);
  assert.equal(hasPermission(perms, 'database.inspect'), false);

  const elevated = resolveEffectivePermissions(
    adminRole.permissions,
    [{ key: 'database.inspect', granted: true }],
    'admin'
  );
  assert.equal(hasPermission(elevated, 'database.inspect'), true);
});

test('hasPermission supports single key and array OR checks', () => {
  const perms = resolveEffectivePermissions(['users.read', 'support.write']);
  assert.equal(hasPermission(perms, 'users.read'), true);
  assert.equal(hasPermission(perms, ['users.delete', 'support.write']), true);
  assert.equal(hasPermission(perms, ['users.delete', 'finance.manage']), false);
});

test('role hierarchy enforces strict subordination for non-super-admins', () => {
  assert.equal(canManageRole(80, 60, false), true);
  assert.equal(canManageRole(80, 80, false), false);
  assert.equal(canManageRole(80, 100, false), false);
  assert.equal(canManageRole(100, 100, true), true);
});
