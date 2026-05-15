export type CanvasState = {
  version: 1;
  nodes: Node[];
  edges: Edge[];
  groups: Group[];
};

export type Node = {
  id: string;
  kind:
    | "rect"
    | "ellipse"
    | "diamond"
    | "sticky"
    | "text"
    | "image"
    | "freeform";
  label?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  style?: NodeStyle;
  meta?: Record<string, unknown>;
};

export type NodeStyle = {
  color?: string;
  fill?: string;
  stroke?: string;
  fontSize?: number;
  rotation?: number;
};

export type Endpoint =
  | { kind: "node"; id: string }
  | { kind: "point"; x: number; y: number };

export type Edge = {
  id: string;
  from: Endpoint;
  to: Endpoint;
  label?: string;
  style?: EdgeStyle;
  meta?: Record<string, unknown>;
};

export type EdgeStyle = {
  color?: string;
  dashed?: boolean;
  arrow?: "none" | "to" | "both";
};

export type Group = {
  id: string;
  kind: "frame" | "group";
  children: string[];
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  style?: { fill?: string; stroke?: string };
  collapsed?: boolean;
};

export type Target = "node" | "edge" | "group";

export type PatchOp =
  | { op: "add"; target: "node"; value: Node }
  | { op: "add"; target: "edge"; value: Edge }
  | { op: "add"; target: "group"; value: Group }
  | { op: "update"; target: "node"; id: string; set: Partial<Node> }
  | { op: "update"; target: "edge"; id: string; set: Partial<Edge> }
  | { op: "update"; target: "group"; id: string; set: Partial<Group> }
  | { op: "delete"; target: Target; id: string };

export type Prompt = {
  id: string;
  selection: string[];
  text: string;
  createdAt: number;
  status: "pending" | "resolved" | "dismissed";
  response?: string;
  resolvedAt?: number;
};

export type RoomId = string;

export type OpLogEntry = {
  ops: PatchOp[];
  source: "ai" | "user";
  version: number;
  at: number;
  clientOpId?: string;
};

export type RoomState = {
  canvas: CanvasState;
  opLog: OpLogEntry[];
  prompts: Prompt[];
  version: number;
  dirty: boolean;
  lastTouched: number;
};

export type WsMessage =
  | { kind: "hello"; version: number }
  | {
      kind: "patch";
      source: "ai" | "user";
      ops: PatchOp[];
      version: number;
      originClientId?: string;
    }
  | { kind: "prompt-created"; prompt: Prompt }
  | { kind: "prompt-resolved"; id: string; response?: string };
