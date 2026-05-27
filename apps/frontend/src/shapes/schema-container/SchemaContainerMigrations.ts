// apps/frontend/src/shapes/schema-container/SchemaContainerMigrations.ts
//
// tldraw 5.x shape-props migrations для schema-container.
//
// API: `createShapePropsMigrationSequence` re-exported из `tldraw` (через
// @tldraw/editor → @tldraw/tlschema). Sequence запускается при загрузке shape'а
// из persisted store ДО validator'а; поэтому здесь же coerce'им unknown values
// — иначе T.literalEnum зарежет load.
//
// tldraw enforces sequence id format `com.tldraw.shape.<type>/<n>` — попытка
// использовать собственный namespace (`com.shemma.*`) валится на validateMigrationId
// при первой загрузке shape'а.
//
// История версий:
// - /1 (DRW-186 phase 1): titlePosition `"inside"` → `"inside-center"`;
//   unknown → default.
// - /2 (DRW-186 phase 2): расщепление `"outside"` → `"outside-banner"`. После
//   /1 в store может лежать только `"outside" | "inside-center" | "inside-left"`,
//   поэтому /2 заботится только об `"outside"` → `"outside-banner"`. Дополнительно
//   запускаем `migrateTitlePosition` ещё раз — defensive coerce на случай прихода
//   валидного нового значения из будущей сессии (forward-compat).

import { createShapePropsMigrationSequence } from "tldraw";
import { migrateTitlePosition } from "./title-position";

export const schemaContainerMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: "com.tldraw.shape.schema-container/1",
      up: (props: Record<string, unknown>) => {
        // Phase 1 — legacy `"inside"` → `"inside-center"`. Здесь
        // migrateTitlePosition уже умеет и `"outside"` → `"outside-banner"`,
        // но это эквивалентно: для `/1` оба `"outside"` и `"outside-banner"`
        // считаются валидными (см. /2 step ниже).
        if (props.titlePosition === "inside") {
          props.titlePosition = "inside-center";
        }
      },
    },
    {
      id: "com.tldraw.shape.schema-container/2",
      up: (props: Record<string, unknown>) => {
        if (props.titlePosition === "outside") {
          props.titlePosition = "outside-banner";
        }
        // Final defensive coerce — после обоих steps значение должно стать
        // canonical 4-value enum или fallback к default.
        props.titlePosition = migrateTitlePosition(props.titlePosition);
      },
    },
  ],
});
