import type { SpaceRecord } from "@shemma/spaces";

declare module "hono" {
  interface ContextVariableMap {
    space: SpaceRecord;
  }
}
