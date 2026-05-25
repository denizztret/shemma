import {
  BaseFrameLikeShapeUtil,
  SVGContainer,
  getColorValue,
  useColorMode,
} from "tldraw";
import type { Editor } from "tldraw";
import {
  DEFAULT_SCHEMA_CONTAINER_PROPS,
  type SchemaContainerShape,
  schemaContainerShapeProps,
} from "./SchemaContainerShape";

export class SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil<SchemaContainerShape> {
  static override type = "schema-container" as const;
  static override props = schemaContainerShapeProps;

  override getDefaultProps() {
    return { ...DEFAULT_SCHEMA_CONTAINER_PROPS };
  }

  override component(shape: SchemaContainerShape) {
    return shape.props.titlePosition === "outside"
      ? renderOutsideTitle(shape, this.editor)
      : renderInsideTitle(shape, this.editor);
  }

  override getIndicatorPath(shape: SchemaContainerShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

function renderInsideTitle(shape: SchemaContainerShape, editor: Editor) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const colorMode = useColorMode();
  const { w, h, name, color, fill, dash } = shape.props;
  const theme = editor.getCurrentTheme();
  const colors = theme.colors[colorMode];
  const colorCss = getColorValue(colors, color, "solid");
  const fillCss =
    fill === "none"
      ? "transparent"
      : fill === "solid"
        ? colorCss
        : getColorValue(colors, color, "semi");
  const strokeDasharray =
    dash === "dashed" ? "8 4" : dash === "dotted" ? "1 4" : undefined;

  return (
    <SVGContainer style={{ pointerEvents: "all" }}>
      <rect
        width={w}
        height={h}
        fill={fillCss}
        stroke={colorCss}
        strokeWidth={2}
        strokeDasharray={strokeDasharray}
        rx={4}
        ry={4}
      />
      <text
        x={w / 2}
        y={28}
        textAnchor="middle"
        fontSize={20}
        fontWeight={500}
        fill={colorCss}
        style={{ userSelect: "none" }}
      >
        {name}
      </text>
    </SVGContainer>
  );
}

function renderOutsideTitle(shape: SchemaContainerShape, editor: Editor) {
  // Placeholder — replaced в Task 7. Fallback to inside.
  return renderInsideTitle(shape, editor);
}
