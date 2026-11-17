import type { WorkerContext } from './types.ts';

export type RouteHandler = (ctx: WorkerContext) => Promise<Response>;

interface RouteEntry {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class WorkerRouter {
  private readonly routes: RouteEntry[] = [];

  private add(method: string, path: string, handler: RouteHandler): void {
    const clean = path.replace(/^\/+|\/+$/g, '');
    const segments = clean ? clean.split('/') : [];
    this.routes.push({ method: method.toUpperCase(), segments, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }
  post(path: string, handler: RouteHandler): void {
    this.add('POST', path, handler);
  }
  put(path: string, handler: RouteHandler): void {
    this.add('PUT', path, handler);
  }
  patch(path: string, handler: RouteHandler): void {
    this.add('PATCH', path, handler);
  }
  delete(path: string, handler: RouteHandler): void {
    this.add('DELETE', path, handler);
  }

  match(
    method: string,
    pathname: string
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const clean = pathname.replace(/^\/+|\/+$/g, '');
    const pathSegments = clean ? clean.split('/') : [];
    const upperMethod = method.toUpperCase();

    for (const route of this.routes) {
      if (route.method !== upperMethod) continue;
      if (route.segments.length !== pathSegments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i++) {
        const expected = route.segments[i];
        const actual = pathSegments[i];
        if (expected.startsWith(':')) {
          params[expected.slice(1)] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          matched = false;
          break;
        }
      }

      if (matched) {
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}
