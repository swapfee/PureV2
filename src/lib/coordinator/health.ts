import type { CoordinatorMetricsSnapshot } from "./metrics.ts";
import type { J2cMetricsSnapshot } from "../j2c/metrics.ts";

export type ReadinessComponent =
  | "coordinatorMongo"
  | "moduleLoaders"
  | "restProxy"
  | "workerStartup"
  | "workerMongo"
  | "workerHeartbeats"
  | "gatewayManager"
  | "gatewayShards"
  | "queueOverflow"
  | "poisonEvents"
  | "shutdown"
  | "j2c";

export interface ComponentStatus {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly ok: boolean;
  readonly phase: "foundation" | "j2c";
  readonly j2cReady: boolean;
  readonly components: Readonly<Record<ReadinessComponent, ComponentStatus>>;
  readonly metrics: CoordinatorMetricsSnapshot & { readonly j2c?: J2cMetricsSnapshot };
}

export interface HealthStatusProvider {
  isLive(): boolean;
  report(): ReadinessReport;
}

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly status: HealthStatusProvider;
}

export interface HealthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
  readonly port: number;
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  let server: ReturnType<typeof Bun.serve> | undefined;

  return {
    get url(): string {
      const port = server?.port ?? options.port;
      return `http://${options.host}:${port}`;
    },

    get port(): number {
      return server?.port ?? options.port;
    },

    async start(): Promise<void> {
      if (server) return;

      server = Bun.serve({
        hostname: options.host,
        port: options.port,
        fetch(request): Response {
          const path = new URL(request.url).pathname;
          if (path === "/healthz") {
            return Response.json({ ok: options.status.isLive() }, { status: options.status.isLive() ? 200 : 503 });
          }
          if (path === "/readyz") {
            const report = options.status.report();
            return Response.json(report, { status: report.ok ? 200 : 503 });
          }
          if (path === "/metrics") {
            return Response.json(options.status.report().metrics);
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });
    },

    async stop(): Promise<void> {
      if (!server) return;
      await server.stop(true);
      server = undefined;
    },
  };
}

export function allComponentsHealthy(components: Readonly<Record<ReadinessComponent, ComponentStatus>>): boolean {
  return Object.values(components).every((component) => component.ok);
}
