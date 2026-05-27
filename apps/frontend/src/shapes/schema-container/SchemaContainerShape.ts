import {
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  T,
  TLBaseShape,
} from "tldraw";
import type {
  TLDefaultColorStyle,
  TLDefaultDashStyle,
  TLDefaultFillStyle,
} from "tldraw";

// RecordProps is re-exported via tldraw → @tldraw/editor → @tldraw/tlschema
import type { RecordProps } from "tldraw";

// Module augmentation: register schema-container in the global tldraw shape map
// so that SchemaContainerShape satisfies the TLBaseBoxShape constraint.
declare module "tldraw" {
  interface TLGlobalShapePropsMap {
    "schema-container": SchemaContainerProps;
  }
}

export type SchemaContainerDirection = "TB" | "LR" | "BT" | "RL" | "custom";
// SchemaContainerTitlePosition canonically lives в title-position.ts;
// re-export сохраняем для обратной совместимости старых import-сайтов.
export type { SchemaContainerTitlePosition } from "./title-position";
import type { SchemaContainerTitlePosition } from "./title-position";

export interface SchemaContainerProps {
  w: number;
  h: number;
  name: string;
  direction: SchemaContainerDirection;
  titlePosition: SchemaContainerTitlePosition;
  color: TLDefaultColorStyle;
  fill: TLDefaultFillStyle;
  dash: TLDefaultDashStyle;
}

export type SchemaContainerShape = TLBaseShape<
  "schema-container",
  SchemaContainerProps
>;

export const schemaContainerShapeProps: RecordProps<SchemaContainerShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  name: T.string,
  direction: T.literalEnum("TB", "LR", "BT", "RL", "custom"),
  titlePosition: T.literalEnum(
    "outside-frame",
    "outside-banner",
    "inside-center",
    "inside-left",
  ),
  color: DefaultColorStyle,
  fill: DefaultFillStyle,
  dash: DefaultDashStyle,
};

export const DEFAULT_SCHEMA_CONTAINER_PROPS: SchemaContainerProps = {
  w: 300,
  h: 200,
  name: "Container",
  direction: "TB",
  titlePosition: "inside-center",
  color: "grey",
  fill: "semi",
  dash: "dashed",
};
