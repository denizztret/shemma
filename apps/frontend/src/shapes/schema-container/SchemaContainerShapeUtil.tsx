import {
  BaseFrameLikeShapeUtil,
  Group2d,
  Rectangle2d,
  SVGContainer,
  getColorValue,
  useColorMode,
} from "tldraw";
import type { Editor, Geometry2d } from "tldraw";
import {
  DEFAULT_SCHEMA_CONTAINER_PROPS,
  type SchemaContainerShape,
  schemaContainerShapeProps,
} from "./SchemaContainerShape";

const INSIDE_LABEL_HEIGHT = 36;
const OUTSIDE_LABEL_HEIGHT = 28;

export class SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil<SchemaContainerShape> {
  static override type = "schema-container" as const;
  static override props = schemaContainerShapeProps;

  override getDefaultProps() {
    return { ...DEFAULT_SCHEMA_CONTAINER_PROPS };
  }

  // DRW-165: frame-like semantics — children keep their bounds when the
  // container is resized. Base `ShapeUtil.canResizeChildren` defaults to true
  // (would scale all descendants proportionally with the container).
  override canResizeChildren(_shape: SchemaContainerShape): boolean {
    return false;
  }

  // DRW-164: tldraw `getShapeAtPoint` для frame-like shapes делает
  // `(geometry as Group2d).children` — default `BaseBoxShapeUtil.getGeometry`
  // возвращает `Rectangle2d` без children → `E.children is not iterable` crash
  // на pointer move. Возвращаем Group2d с body + label rectangle (как FrameShapeUtil).
  override getGeometry(shape: SchemaContainerShape): Geometry2d {
    const { w, h, titlePosition } = shape.props;
    const body = new Rectangle2d({ width: w, height: h, isFilled: false });
    const labelHeight = titlePosition === "outside" ? OUTSIDE_LABEL_HEIGHT : INSIDE_LABEL_HEIGHT;
    const label = new Rectangle2d({
      x: 0,
      y: titlePosition === "outside" ? -labelHeight : 0,
      width: w,
      height: labelHeight,
      isFilled: true,
      isLabel: true,
      excludeFromShapeBounds: true,
    });
    return new Group2d({ children: [body, label] });
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
  const BAR_HEIGHT = 28;

  return (
    <SVGContainer style={{ pointerEvents: "all" }}>
      {/* Outside title bar — rendered ABOVE the shape body (y negative) */}
      <rect
        x={0}
        y={-BAR_HEIGHT}
        width={w}
        height={BAR_HEIGHT}
        fill={colorCss}
        rx={4}
        ry={4}
      />
      <text
        x={w / 2}
        y={-BAR_HEIGHT / 2 + 6}
        textAnchor="middle"
        fontSize={16}
        fontWeight={500}
        fill="#fff"
        style={{ userSelect: "none" }}
      >
        {name}
      </text>
      {/* Body */}
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
    </SVGContainer>
  );
}
