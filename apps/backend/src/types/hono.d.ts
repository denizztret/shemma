import type { SpaceRecord } from "@shemma/spaces";
import type { BundleResolver } from "../routes/_space-context";

declare module "hono" {
  interface ContextVariableMap {
    space: SpaceRecord;
    /**
     * DRW-116 Task 11: injected by `installBundleResolver` middleware so any
     * `/api/*` handler can call `bundleForRequest(c)` to obtain its space's
     * `Rooms` + `scheduleSave` without closure capture or import cycles.
     */
    __shemma_bundle_resolver__: BundleResolver;
  }
}
