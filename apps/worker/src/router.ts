import type { Env } from "./env";

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler = (c: RouteContext) => Promise<Response> | Response;

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Route {
  method: Method;
  parts: string[];
  handler: RouteHandler;
}

/** Minimal dependency-free router with `:param` path segments. */
export class Router {
  private readonly routes: Route[] = [];

  private add(method: Method, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: RouteHandler): void {
    this.add("POST", pattern, handler);
  }
  put(pattern: string, handler: RouteHandler): void {
    this.add("PUT", pattern, handler);
  }
  delete(pattern: string, handler: RouteHandler): void {
    this.add("DELETE", pattern, handler);
  }

  /** Returns a Response when a route matches, otherwise null. */
  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      if (route.parts.length !== segments.length) continue;

      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.parts.length; i++) {
        const part = route.parts[i]!;
        const seg = segments[i]!;
        if (part.startsWith(":")) {
          params[part.slice(1)] = decodeURIComponent(seg);
        } else if (part !== seg) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      return route.handler({ request, env, ctx, params, url });
    }
    return null;
  }
}
