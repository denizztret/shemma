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
import { schemaContainerMigrations } from "./SchemaContainerMigrations";
import { resolveBoardTitlePosition } from "./title-position-board";
import { resolveContainerFill } from "./fill";
import { SchemaContainerLabel } from "./SchemaContainerLabel";
import { isOutsideVariant } from "./title-position";

const INSIDE_LABEL_HEIGHT = 36;
const OUTSIDE_LABEL_HEIGHT = 28;
const CORNER_RADIUS = 4;

export class SchemaContainerShapeUtil extends BaseFrameLikeShapeUtil<SchemaContainerShape> {
  static override type = "schema-container" as const;
  static override props = schemaContainerShapeProps;
  static override migrations = schemaContainerMigrations;

  // DRW-186 Task 5: board-default titlePosition inheritance.
  // `BaseBoxShapeTool` (через `Pointing.complete`/`Pointing.onPointerMove`)
  // дёргает `getDefaultProps()` в момент создания shape'а, поэтому это
  // единственный clean hook для инъекции значения из room-meta. Static дефолт
  // `inside-center` остаётся fallback'ом, если meta не выставлен.
  override getDefaultProps() {
    return {
      ...DEFAULT_SCHEMA_CONTAINER_PROPS,
      titlePosition: resolveBoardTitlePosition(this.editor),
    };
  }

  // DRW-165: frame-like semantics — children keep their bounds when the
  // container is resized. Base `ShapeUtil.canResizeChildren` defaults to true
  // (would scale all descendants proportionally with the container).
  override canResizeChildren(_shape: SchemaContainerShape): boolean {
    return false;
  }

  // DRW-186 Task 10: inline label edit on double-click. Per probe Task 3 —
  // `canEdit() => true` is the ONLY override required. tldraw's SelectTool
  // calls `canEditShape()` and routes double-click to `editor.setEditingShape`
  // automatically; the HTML overlay (SchemaContainerLabel) reacts to
  // `useIsEditing(shape.id)` and switches between static label and <input>.
  // НЕ переопределяем `onDoubleClick` — иначе tldraw перестанет вызывать
  // `startEditingShape` (см. SelectTool/childStates/Idle.ts:419-452).
  override canEdit(_shape: SchemaContainerShape): boolean {
    return true;
  }

  // DRW-164: tldraw `getShapeAtPoint` для frame-like shapes делает
  // `(geometry as Group2d).children` — default `BaseBoxShapeUtil.getGeometry`
  // возвращает `Rectangle2d` без children → `E.children is not iterable` crash
  // на pointer move. Возвращаем Group2d с body + label rectangle (как FrameShapeUtil).
  //
  // DRW-186 phase 2: для обоих outside вариантов (frame / banner) используется
  // ОДИН и тот же label-rect выше body — геометрия совпадает, отличается только
  // визуальный рендер.
  override getGeometry(shape: SchemaContainerShape): Geometry2d {
    const { w, h, titlePosition } = shape.props;
    const outside = isOutsideVariant(titlePosition);
    const body = new Rectangle2d({ width: w, height: h, isFilled: false });
    const labelHeight = outside ? OUTSIDE_LABEL_HEIGHT : INSIDE_LABEL_HEIGHT;
    const label = new Rectangle2d({
      x: 0,
      y: outside ? -labelHeight : 0,
      width: w,
      height: labelHeight,
      isFilled: true,
      isLabel: true,
      excludeFromShapeBounds: true,
    });
    return new Group2d({ children: [body, label] });
  }

  override component(shape: SchemaContainerShape) {
    switch (shape.props.titlePosition) {
      case "outside-frame":
        return renderOutsideFrame(shape, this.editor);
      case "outside-banner":
        return renderOutsideBanner(shape, this.editor);
      case "inside-left":
      case "inside-center":
      default:
        return renderInside(shape, this.editor);
    }
  }

  override getIndicatorPath(shape: SchemaContainerShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

// ---------------------------------------------------------------------------
// Render variants (DRW-186 phase 2)
// ---------------------------------------------------------------------------
//
// Все варианты возвращают `<SVGContainer>` + `<SchemaContainerLabel>` overlay.
// Различие — в SVG-структуре (отдельный rect vs monolith paths) и в variant'е
// label'а (цвет + bg policy).

function renderInside(shape: SchemaContainerShape, editor: Editor) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const colorMode = useColorMode();
  const { w, h, color, fill, dash, titlePosition } = shape.props;
  const theme = editor.getCurrentTheme();
  const colors = theme.colors[colorMode];
  const colorCss = getColorValue(colors, color, "solid");
  // DRW-186 Task 12: fill rendering parity с native rect — `fill='solid'` маппится
  // на palette.semi (pastel), `fill='semi'` — на top-level theme.solid. См. fill.ts.
  const fillCss = resolveContainerFill(colors, color, fill);
  const strokeDasharray =
    dash === "dashed" ? "8 4" : dash === "dotted" ? "1 4" : undefined;

  // DRW-186 Task 11: label рендерится HTML-оверлеем (`SchemaContainerLabel`)
  // через `<HTMLContainer>` — даёт font parity с Frame (var(--tl-font-sans))
  // и единый компонент для read/edit режимов. SchemaContainerLabel сам
  // обрабатывает `align="left"` (text-align + padding-left: 12).
  const align: "left" | "center" =
    titlePosition === "inside-left" ? "left" : "center";

  return (
    <>
      <SVGContainer style={{ pointerEvents: "all" }}>
        <rect
          width={w}
          height={h}
          fill={fillCss}
          stroke={colorCss}
          strokeWidth={2}
          strokeDasharray={strokeDasharray}
          rx={CORNER_RADIUS}
          ry={CORNER_RADIUS}
        />
      </SVGContainer>
      <SchemaContainerLabel
        shape={shape}
        labelX={0}
        labelY={0}
        labelW={w}
        labelH={INSIDE_LABEL_HEIGHT}
        color={colorCss}
        align={align}
        variant="inside"
      />
    </>
  );
}

/**
 * Native Frame parity: label-as-floating-text над body, без encompassing outline.
 *
 * User feedback (image 29): tldraw Frame рисует ТОЛЬКО body с его собственным
 * stroke'ом, а label плавает выше как plain text (без bg, без рамки). Поэтому
 * здесь — единственный `<rect>` для body + HTML overlay для label с
 * прозрачным фоном.
 *
 * Никакого monolith outline'а вокруг combined area (banner + body) — это
 * ключевое отличие от renderOutsideBanner.
 */
function renderOutsideFrame(shape: SchemaContainerShape, editor: Editor) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const colorMode = useColorMode();
  const { w, h, color, fill, dash } = shape.props;
  const theme = editor.getCurrentTheme();
  const colors = theme.colors[colorMode];
  const colorCss = getColorValue(colors, color, "solid");
  const fillCss = resolveContainerFill(colors, color, fill);
  const strokeDasharray =
    dash === "dashed" ? "8 4" : dash === "dotted" ? "1 4" : undefined;
  const BAR_HEIGHT = OUTSIDE_LABEL_HEIGHT;

  return (
    <>
      <SVGContainer style={{ pointerEvents: "all" }}>
        <rect
          width={w}
          height={h}
          fill={fillCss}
          stroke={colorCss}
          strokeWidth={2}
          strokeDasharray={strokeDasharray}
          rx={CORNER_RADIUS}
          ry={CORNER_RADIUS}
        />
      </SVGContainer>
      <SchemaContainerLabel
        shape={shape}
        labelX={0}
        labelY={-BAR_HEIGHT}
        labelW={w}
        labelH={BAR_HEIGHT}
        color="var(--tl-color-text)"
        align="left"
        variant="outside-frame"
      />
    </>
  );
}

/**
 * Coloured banner — saturated shape color above body, white text centered.
 * Monolith corners: верхние углы скруглены только на баннере, нижние — только
 * на body. Стык между ними рисуется прямой линией (square corners) — gap
 * исчезает. Единый outer stroke с rx=4 завершает картину.
 */
function renderOutsideBanner(shape: SchemaContainerShape, editor: Editor) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const colorMode = useColorMode();
  const { w, h, color, fill, dash } = shape.props;
  const theme = editor.getCurrentTheme();
  const colors = theme.colors[colorMode];
  const colorCss = getColorValue(colors, color, "solid");
  const fillCss = resolveContainerFill(colors, color, fill);
  const strokeDasharray =
    dash === "dashed" ? "8 4" : dash === "dotted" ? "1 4" : undefined;
  const BAR_HEIGHT = OUTSIDE_LABEL_HEIGHT;

  return (
    <>
      <SVGContainer style={{ pointerEvents: "all" }}>
        <path
          d={monolithBannerPath(w, BAR_HEIGHT)}
          fill={colorCss}
        />
        <path d={monolithBodyPath(w, h)} fill={fillCss} />
        <rect
          x={0}
          y={-BAR_HEIGHT}
          width={w}
          height={h + BAR_HEIGHT}
          fill="none"
          stroke={colorCss}
          strokeWidth={2}
          strokeDasharray={strokeDasharray}
          rx={CORNER_RADIUS}
          ry={CORNER_RADIUS}
        />
      </SVGContainer>
      <SchemaContainerLabel
        shape={shape}
        labelX={0}
        labelY={-BAR_HEIGHT}
        labelW={w}
        labelH={BAR_HEIGHT}
        color="#fff"
        align="center"
        variant="outside-banner"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Monolith SVG path helpers (DRW-186 phase 2)
// ---------------------------------------------------------------------------
//
// User feedback: phase-1 outside рендерился как ДВА independent rect'а с
// rx=4 — между ними образовывался "gap" с double-rounded edges. Решение —
// рисовать banner+body как два path'а, скруглённых только на внешних углах:
// banner top-left/top-right + body bottom-left/bottom-right. Стык в y=0 —
// прямой. Сверху на это накладывается единый rect-outline с rx=4 для
// объединяющего stroke'а.

/** Banner shape: верхние углы скруглены (rx=CORNER_RADIUS), нижние — square. */
function monolithBannerPath(w: number, barHeight: number): string {
  const r = CORNER_RADIUS;
  const top = -barHeight;
  // M(r, top) → L(w-r, top) → Q(w, top, w, top+r) → L(w, 0) → L(0, 0)
  // → L(0, top+r) → Q(0, top, r, top) → Z
  return [
    `M ${r} ${top}`,
    `L ${w - r} ${top}`,
    `Q ${w} ${top} ${w} ${top + r}`,
    `L ${w} 0`,
    `L 0 0`,
    `L 0 ${top + r}`,
    `Q 0 ${top} ${r} ${top}`,
    "Z",
  ].join(" ");
}

/** Body shape: нижние углы скруглены, верхние — square (стык с banner). */
function monolithBodyPath(w: number, h: number): string {
  const r = CORNER_RADIUS;
  // M(0, 0) → L(w, 0) → L(w, h-r) → Q(w, h, w-r, h)
  // → L(r, h) → Q(0, h, 0, h-r) → L(0, 0) → Z
  return [
    `M 0 0`,
    `L ${w} 0`,
    `L ${w} ${h - r}`,
    `Q ${w} ${h} ${w - r} ${h}`,
    `L ${r} ${h}`,
    `Q 0 ${h} 0 ${h - r}`,
    `L 0 0`,
    "Z",
  ].join(" ");
}
