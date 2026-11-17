export interface PaginationParams {
  page: number;
  pageSize: number;
  search: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
}

export function parsePaginationQuery(
  query: Record<string, unknown>,
  allowedSortColumns: string[],
  defaultSort = 'createdAt'
): PaginationParams {
  const rawPage = Number(query.page);
  const rawSize = Number(query.pageSize);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.min(100, Math.floor(rawSize)) : 20;
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 120) : '';
  const requestedSort = typeof query.sortBy === 'string' ? query.sortBy.trim() : defaultSort;
  const sortBy = allowedSortColumns.includes(requestedSort) ? requestedSort : defaultSort;
  const sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';

  return { page, pageSize, search, sortBy, sortDir };
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim());
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function isValidRepoName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim());
}

export function isValidUserStatus(status: string): status is 'active' | 'inactive' | 'suspended' | 'banned' | 'deleted' {
  return ['active', 'inactive', 'suspended', 'banned', 'deleted'].includes(status);
}

export function isValidTicketPriority(priority: string): priority is 'low' | 'medium' | 'high' | 'urgent' {
  return ['low', 'medium', 'high', 'urgent'].includes(priority);
}

export function isValidTicketStatus(status: string): status is 'open' | 'pending' | 'resolved' | 'closed' {
  return ['open', 'pending', 'resolved', 'closed'].includes(status);
}
