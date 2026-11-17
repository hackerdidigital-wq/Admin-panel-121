import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidEmail,
  isValidRepoName,
  isValidSlug,
  parsePaginationQuery,
  slugify,
} from '../src/lib/validation';

test('parsePaginationQuery enforces safe bounds and allowlisted sort columns', () => {
  const params = parsePaginationQuery(
    { page: '0', pageSize: '500', sortBy: 'malicious_sql;DROP', sortDir: 'asc', search: '  alice ' },
    ['createdAt', 'email'],
    'createdAt'
  );
  assert.equal(params.page, 1);
  assert.equal(params.pageSize, 100);
  assert.equal(params.sortBy, 'createdAt');
  assert.equal(params.sortDir, 'asc');
  assert.equal(params.search, 'alice');
});

test('validation helpers check emails, slugs, and GitHub owner/repo names', () => {
  assert.equal(isValidEmail('admin@enterprise.io'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidSlug('release-v2-notes'), true);
  assert.equal(isValidSlug('Bad Slug!'), false);
  assert.equal(slugify('Enterprise Release 2.0!'), 'enterprise-release-2-0');
  assert.equal(isValidRepoName('octocat/hello-world'), true);
  assert.equal(isValidRepoName('invalid repo'), false);
});
