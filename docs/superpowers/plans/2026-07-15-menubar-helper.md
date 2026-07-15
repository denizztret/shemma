# Menubar Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Менюбар-хелпер для shemma: команда `shemma menubar` (render/do/install/uninstall/status) внутри CLI + тонкий SwiftBar-shim, по спеке `docs/superpowers/specs/2026-07-15-menubar-helper-design.md`.

**Architecture:** Вся логика — TypeScript в `packages/shemma-cli/src/menubar/`; `render` — чистая функция «данные → строки SwiftBar-меню», данные собираются внутренними вызовами (`collectProfileStatuses`, `runDoctorChecks`, `listSpaces`, `checkUpdateAvailable` с файловым кешем). В plugin-папке SwiftBar лежит только shim `shemma.<interval>.sh`, который exec'ает `shemma menubar`.

**Tech Stack:** Bun + TypeScript strict, bun:test (unit + subprocess-integration), bash только в shim, Swift-скрипт разово генерит PNG-иконки.

**Ветка:** `feature/menubar-helper` (уже создана, спека закоммичена).

---

## Контекст кодовой базы (прочитай перед стартом)

| Что | Где | Зачем |
|---|---|---|
| Диспетчер CLI + usage() | `packages/shemma-cli/src/index.ts` | wiring новой команды (Task 12) |
| `ProfileStatus`, cmdPs | `packages/shemma-cli/src/ps.ts` | источник статусов профилей |
| `CheckResult`, cmdDoctor | `packages/shemma-cli/src/doctor.ts` | doctor-чеки для меню |
| `ensure/stop/stopAll/status` | `packages/shemma-cli/src/daemon.ts` | lifecycle-действия |
| `resolveCurrentVersion` (приватная), cmdUpdateCheck, cmdUpdate | `packages/shemma-cli/src/update.ts` | версия + update-badge |
| `Profile`, `portFor`, `logFile` | `packages/shemma-cli/src/profile.ts` | порт :8787, лог `~/.claude/.shemma-release.log` |
| `openBrowser(url)` | `packages/shemma-cli/src/browser.ts` | открытие доски/space |
| `listSpaces(): SpaceRecord[]` | `packages/shemma-spaces/src/registry.ts` | сабменю Spaces |
| `ConfigFile`, `readConfig/writeConfig/configFilePath` | `apps/backend/src/config.ts` (строки 194-257) | ключ `menubar.label` |
| `SUPPORTED_KEYS`, cmdConfigSet/Get/Unset | `packages/shemma-cli/src/config.ts` | регистрация ключа |
| Subprocess-тест паттерн (`Bun.spawn` + `XDG_CONFIG_HOME`) | `packages/shemma-cli/tests/cli-spaces.test.ts` | образец integration-тестов |
| Иконки madstudio (образец генератора) | `~/Projects/madstudio-helper/scripts/gen-icons.swift` | Task 1 |

Конвенция state-файлов CLI: `~/.claude/.shemma-*` (config `~/.claude/.shemma-config.json`, лог `~/.claude/.shemma-release.log`, lock `~/.claude/.shemma-port-8787.lock`). Menubar-файлы следуют ей: `~/.claude/.shemma-menubar-error`, `~/.claude/.shemma-menubar-update.json`.

Формат SwiftBar-меню: первая строка — title (`Label | image=<base64>`), `---` — разделитель, префикс `-- ` — сабменю, параметры пункта после `|`: `sfimage=<sf-symbol>` (иконка пункта, template), `bash="<path>" param1=... param2=...`, `terminal=false`, `refresh=true`, `color=gray`, `href=<url>`. SwiftBar передаёт запущенному плагину env `SWIFTBAR_PLUGIN_PATH` — путь shim'а для самовызова в action-строках.

Все команды ниже запускать из `packages/shemma-cli/`, если не сказано иное.

---

### Task 0: Backlog-задача

**Files:** нет (Backlog CLI).

- [ ] **Step 1: Создать задачу и взять в работу**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
backlog task create "Менюбар-хелпер: shemma menubar + SwiftBar shim" \
  --priority medium --labels feature --milestone m-12 \
  -d "$(cat <<'EOF'
**TL;DR:** Команда `shemma menubar` (render/do/install/uninstall/status) + тонкий SwiftBar-shim: статус-иконка демона, start/stop/restart, stop-all, доска/spaces, doctor, update-badge из menu bar.

Спека: docs/superpowers/specs/2026-07-15-menubar-helper-design.md
План: docs/superpowers/plans/2026-07-15-menubar-helper.md
Архитектура — логика в CLI (вариант A), установка `shemma menubar install`, обновления вместе с `shemma update`.
EOF
)" \
  --ac "shemma menubar render печатает валидное SwiftBar-меню для состояний работает/остановлен/ошибка" \
  --ac "menubar do: start/stop/restart/stop-all/open-board/open-space/open-log/edit-config/update работают" \
  --ac "menubar install ставит shim в plugin-папку SwiftBar (defaults-автонастройка), uninstall убирает" \
  --ac "bun run test зелёный, bun run lint чистый, CHANGELOG/README/usage обновлены" \
  --plain
```

- [ ] **Step 2: Переименовать файл задачи (конвенция lowercase `drw-NNN-short-name.md`) и поставить In Progress**

```bash
# N — номер, который выдал create (смотри вывод)
mv backlog/tasks/DRW-*"Менюбар"*.md backlog/tasks/drw-NNN-menubar-helper.md 2>/dev/null || \
  ls backlog/tasks/ | tail -3   # если glob не сработал — найди файл и переименуй руками
backlog task edit DRW-NNN -s "In Progress" --plain
git add backlog/ && git commit -m "chore(backlog): DRW-NNN менюбар-хелпер — In Progress"
```

---

### Task 1: Статусные иконки (генератор + icons.ts)

Только 3 цветные title-иконки нужны как PNG (SwiftBar-title не умеет цветные SF-символы); иконки пунктов меню — через `sfimage=<symbol>`, генерить их не надо.

**Files:**
- Create: `scripts/gen-menubar-icons.swift`
- Create: `packages/shemma-cli/src/menubar/icons.ts` (генерируется скриптом, коммитится)
- Test: `packages/shemma-cli/tests/menubar-icons.test.ts`

- [ ] **Step 1: Написать failing test**

```typescript
// packages/shemma-cli/tests/menubar-icons.test.ts
import { describe, expect, test } from "bun:test";
import {
  ICON_ERROR,
  ICON_RUNNING,
  ICON_STOPPED,
} from "../src/menubar/icons";

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

describe("menubar icons", () => {
  test("три статусные иконки — непустой base64 PNG", () => {
    for (const icon of [ICON_RUNNING, ICON_STOPPED, ICON_ERROR]) {
      expect(icon.length).toBeGreaterThan(100);
      expect(icon).toMatch(BASE64_RE);
      // PNG magic bytes в base64 начинаются с iVBOR
      expect(icon.startsWith("iVBOR")).toBe(true);
    }
  });

  test("иконки различаются (разные цвета)", () => {
    expect(ICON_RUNNING).not.toBe(ICON_STOPPED);
    expect(ICON_STOPPED).not.toBe(ICON_ERROR);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bun test tests/menubar-icons.test.ts`
Expected: FAIL — `Cannot find module '../src/menubar/icons'`

- [ ] **Step 3: Написать генератор**

```swift
// scripts/gen-menubar-icons.swift
import Cocoa

// Генератор packages/shemma-cli/src/menubar/icons.ts — статусные иконки menu bar.
// Использование (из корня репо):
//   swift scripts/gen-menubar-icons.swift > packages/shemma-cli/src/menubar/icons.ts
// Цветные PNG @2x (image= в title; sfimage там был бы монохромным template).
// Символ по умолчанию square.on.square — «слои канваса» (см. спеку).

func render(_ name: String, pt: CGFloat, color: NSColor) -> Data {
    let scale = 2
    let cfg = NSImage.SymbolConfiguration(pointSize: pt, weight: .regular)
    guard let sym = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(cfg) else { fatalError("no symbol \(name)") }
    let ptSize = sym.size
    let pxW = Int(ptSize.width * CGFloat(scale)), pxH = Int(ptSize.height * CGFloat(scale))
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pxW, pixelsHigh: pxH,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fatalError("no rep") }
    rep.size = ptSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let r = NSRect(origin: .zero, size: ptSize)
    sym.draw(in: r)
    color.set()
    r.fill(using: .sourceAtop)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func c(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

func emitTs(_ name: String, _ data: Data) {
    print("export const \(name) = \"\(data.base64EncodedString())\";")
}

print("// Сгенерировано scripts/gen-menubar-icons.swift — НЕ редактировать руками.")
print("// SF square.on.square @2x: зелёная (работает) / серая (остановлен) / красная (ошибка).")
emitTs("ICON_RUNNING", render("square.on.square", pt: 16, color: c(0x34C759)))
emitTs("ICON_STOPPED", render("square.on.square", pt: 16, color: c(0x8E8E93)))
emitTs("ICON_ERROR", render("square.on.square", pt: 16, color: c(0xFF3B30)))
```

- [ ] **Step 4: Сгенерировать icons.ts**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
mkdir -p packages/shemma-cli/src/menubar
swift scripts/gen-menubar-icons.swift > packages/shemma-cli/src/menubar/icons.ts
head -c 300 packages/shemma-cli/src/menubar/icons.ts   # глазами: export const ICON_RUNNING = "iVBOR...
```

- [ ] **Step 5: Тест зелёный**

Run: `cd packages/shemma-cli && bun test tests/menubar-icons.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Lint + commit**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw && bun run lint
# Если biome ругается на сгенерированный файл (длина строк ок, но formatter может
# захотеть переформатировать) — прогони `bunx biome format --write packages/shemma-cli/src/menubar/icons.ts`
git add scripts/gen-menubar-icons.swift packages/shemma-cli/src/menubar/icons.ts packages/shemma-cli/tests/menubar-icons.test.ts
git commit -m "feat(cli): статусные иконки menubar — генератор + icons.ts"
```

---

### Task 2: Рефакторинг ps.ts — экспорт collectProfileStatuses

`cmdPs` печатает; menubar'у нужны данные. Выделить сбор в экспортируемую функцию, печать оставить в `cmdPs`.

**Files:**
- Modify: `packages/shemma-cli/src/ps.ts:52-91`
- Test: существующий `packages/shemma-cli/tests/ps.test.ts` (регрессия)

- [ ] **Step 1: Зафиксировать зелёную базу**

Run: `cd packages/shemma-cli && bun test tests/ps.test.ts`
Expected: PASS

- [ ] **Step 2: Рефакторинг**

В `ps.ts` заменить `cmdPs` на:

```typescript
/** Собирает статусы всех профилей (без печати) — используется ps и menubar. */
export async function collectProfileStatuses(): Promise<ProfileStatus[]> {
  return Promise.all(
    ALL_PROFILES.map(async (p): Promise<ProfileStatus> => {
      try {
        const s = await status(p);
        const port = portForPs(p);
        const healthy = s.running ? await isHealthy(port) : false;
        return {
          profile: p,
          port,
          pid: (s as { pid?: number }).pid,
          running: s.running,
          healthy,
        };
      } catch {
        return {
          profile: p,
          port: portForPs(p),
          running: false,
          healthy: false,
        };
      }
    }),
  );
}

export async function cmdPs(): Promise<void> {
  const results = await collectProfileStatuses();
  const ui = getOutput();
  if (ui.mode === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  // Human mode: table-ish output with one line per profile.
  for (const r of results) {
    const state = r.running
      ? r.healthy
        ? "healthy"
        : "running (unhealthy)"
      : "not running";
    const pid = r.pid !== undefined ? ` pid=${r.pid}` : "";
    uiInfo(`${r.profile.padEnd(8)} :${r.port}  ${state}${pid}`);
  }
}
```

- [ ] **Step 3: Тесты зелёные**

Run: `bun test tests/ps.test.ts`
Expected: PASS (без изменений в тестах)

- [ ] **Step 4: Commit**

```bash
git add src/ps.ts && git commit -m "refactor(cli): ps — выделен collectProfileStatuses для menubar"
```

---

### Task 3: Рефакторинг doctor.ts — экспорт runDoctorChecks c опцией network

Menubar рендерится каждые 5 с — сетевой чек `manifest-reachable` (fetch, 3 с timeout) в рендере недопустим. Выделить запуск чеков с флагом.

**Files:**
- Modify: `packages/shemma-cli/src/doctor.ts:304-342`
- Test: существующий `packages/shemma-cli/tests/doctor.test.ts` (регрессия)

- [ ] **Step 1: Зелёная база**

Run: `bun test tests/doctor.test.ts`
Expected: PASS

- [ ] **Step 2: Рефакторинг**

В `doctor.ts` перед `cmdDoctor` добавить, а тело `cmdDoctor` переключить на неё (порядок чеков сохранён 1-в-1, `manifest-reachable` — условный):

```typescript
export interface DoctorChecksOptions {
  /** false → пропустить сетевой manifest-reachable (menubar-рендер каждые 5 с). */
  network?: boolean;
}

/** Прогоняет doctor-чеки без печати — используется doctor и menubar. */
export async function runDoctorChecks(
  profiles: readonly Profile[],
  opts: DoctorChecksOptions = {},
): Promise<CheckResult[]> {
  const network = opts.network ?? true;
  return Promise.all([
    Promise.resolve(checkBunVersion()),
    Promise.resolve(checkShemmaVersion()),
    ...profiles.map((p) => checkDaemonStatus(p)),
    ...profiles.map((p) => checkPortOwner(p)),
    ...profiles.map((p) => Promise.resolve(checkStorageWritable(p))),
    ...(network ? [checkManifestReachable()] : []),
    Promise.resolve(checkConfigReadable()),
  ]);
}

export async function cmdDoctor(opts: DoctorOptions): Promise<void> {
  const profiles: Profile[] = opts.all ? [...ALL_PROFILES] : [opts.profile];
  const results = await runDoctorChecks(profiles, { network: true });
  // ... остальное тело cmdDoctor без изменений (печать + exit 3 на fail)
}
```

(Из старого `cmdDoctor` удалить инлайновый `Promise.all([...])` — он переехал в `runDoctorChecks`.)

- [ ] **Step 3: Тесты зелёные**

Run: `bun test tests/doctor.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/doctor.ts && git commit -m "refactor(cli): doctor — runDoctorChecks с опцией network для menubar"
```

---

### Task 4: Рефакторинг update.ts — экспорт resolveCurrentVersion и checkUpdateAvailable

**Files:**
- Modify: `packages/shemma-cli/src/update.ts:22-38, 193-219`
- Test: существующий `packages/shemma-cli/tests/update-fetch.test.ts` (регрессия)

- [ ] **Step 1: Зелёная база**

Run: `bun test tests/update-fetch.test.ts`
Expected: PASS

- [ ] **Step 2: Рефакторинг**

1. Строка 22: `function resolveCurrentVersion(...)` → `export function resolveCurrentVersion(...)` (тело без изменений).
2. Перед `cmdUpdateCheck` добавить тип и функцию, `cmdUpdateCheck` переключить на неё:

```typescript
export interface UpdateBadge {
  current: string;
  latest: string | null;
  available: boolean;
  channel: string;
}

/** Проверка наличия обновления (данные без печати) — используется update --check и menubar. */
export async function checkUpdateAvailable(): Promise<UpdateBadge> {
  const channel = resolveChannel();
  const { manifest } = await fetchManifest();
  const latest = manifest.channels?.[channel]?.version ?? null;
  const available = !!latest && semverCmp(latest, CURRENT_VERSION) > 0;
  return { current: CURRENT_VERSION, latest, available, channel };
}

export async function cmdUpdateCheck() {
  try {
    const { current, latest, available, channel } = await checkUpdateAvailable();
    const ui = getOutput();
    if (ui.mode === "json") {
      console.log(JSON.stringify({ current, latest, available, channel }));
    } else if (available) {
      uiSuccess(
        `update available: v${latest} (current v${current}, channel ${channel})`,
      );
    } else {
      uiSuccess(`already on latest v${current} (channel ${channel})`);
    }
  } catch (e) {
    fail(e);
  }
}
```

- [ ] **Step 3: Тесты зелёные**

Run: `bun test tests/update-fetch.test.ts && bun test tests/version-cmd.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/update.ts && git commit -m "refactor(cli): update — экспорт resolveCurrentVersion/checkUpdateAvailable"
```

---

### Task 5: daemon.stopAll возвращает результаты

Для notify «Остановлено N демонов» после stop-all.

**Files:**
- Modify: `packages/shemma-cli/src/daemon.ts:509-533`
- Test: `packages/shemma-cli/tests/daemon-lock.test.ts` (регрессия)

- [ ] **Step 1: Зелёная база**

Run: `bun test tests/daemon-lock.test.ts`
Expected: PASS

- [ ] **Step 2: Типизировать возврат**

В `daemon.ts` (строки 509-533) заменить сигнатуру и добавить возврат; печать не меняется:

```typescript
export type StopAllResult = {
  ok: true;
  profile: Profile;
  stopped?: number;
  already?: boolean;
};

export async function stopAll(onlyProfile?: Profile): Promise<StopAllResult[]> {
  const profiles = onlyProfile ? [onlyProfile] : [...ALL_PROFILES];
  const results: StopAllResult[] = [];
  for (const p of profiles) {
    const outcome = await stopOneProfile(p);
    if ("already" in outcome) {
      results.push({ ok: true, already: true, profile: p });
    } else {
      results.push({ ok: true, stopped: outcome.stopped, profile: p });
    }
  }
  const ui = getOutput();
  if (ui.mode === "json") {
    console.log(JSON.stringify(results));
  } else {
    for (const r of results) {
      if (r.already) {
        uiSuccess(`daemon not running (profile ${r.profile})`);
      } else {
        uiSuccess(`daemon stopped (pid ${r.stopped}, profile ${r.profile})`);
      }
    }
  }
  return results;
}
```

(Старый локальный каст `const e = r as {...}` больше не нужен — тип известен.)

- [ ] **Step 3: Тесты зелёные**

Run: `bun test tests/daemon-lock.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts && git commit -m "refactor(cli): stopAll возвращает StopAllResult[] для menubar-notify"
```

---

### Task 6: Конфиг-ключ menubar.label

**Files:**
- Modify: `apps/backend/src/config.ts:199-204` (тип `ConfigFile`)
- Modify: `packages/shemma-cli/src/config.ts`
- Test: `packages/shemma-cli/tests/menubar-config.test.ts` (новый, subprocess)

- [ ] **Step 1: Failing test**

```typescript
// packages/shemma-cli/tests/menubar-config.test.ts
// Subprocess-паттерн из cli-spaces.test.ts: Bun.spawn + XDG_CONFIG_HOME в tmpdir.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpXdg: string;

async function runCli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: tmpXdg,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-config-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
});

describe("config menubar.label", () => {
  test("get до set — [unset]", async () => {
    const r = await runCli(["config", "get", "menubar.label"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[unset]");
  });

  test("set → get возвращает значение", async () => {
    const set = await runCli(["config", "set", "menubar.label", "shemma"]);
    expect(set.status).toBe(0);
    const get = await runCli(["config", "get", "menubar.label"]);
    expect(get.status).toBe(0);
    expect(get.stdout).toContain('"shemma"');
    // Значение реально в config.json
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmpXdg, "shemma", "config.json"), "utf8"),
    );
    expect(raw.menubar.label).toBe("shemma");
  });

  test("unset удаляет значение", async () => {
    await runCli(["config", "set", "menubar.label", "x"]);
    const unset = await runCli(["config", "unset", "menubar.label"]);
    expect(unset.status).toBe(0);
    const get = await runCli(["config", "get", "menubar.label"]);
    expect(get.stdout).toContain("[unset]");
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `bun test tests/menubar-config.test.ts`
Expected: FAIL — `unknown config key: menubar.label`

- [ ] **Step 3: Реализация**

1. `apps/backend/src/config.ts` — расширить тип:

```typescript
export interface ConfigFile {
  miro?: {
    token?: string;
    createdAt?: string;
  };
  menubar?: {
    label?: string;
  };
}
```

2. `packages/shemma-cli/src/config.ts`:

```typescript
// импорт дополнить:
import {
  readConfig,
  readMiroToken,
  unsetMiroToken,
  writeConfig,
  writeMiroToken,
} from "@shemma/backend/src/config";

const SUPPORTED_KEYS = new Set(["miro.token", "menubar.label"]);
```

В `cmdConfigSet` после ветки `miro.token` добавить:

```typescript
  if (key === "menubar.label") {
    const cfg = readConfig() ?? {};
    cfg.menubar = { ...cfg.menubar, label: value };
    writeConfig(cfg);
    uiSuccess(`menubar.label = ${JSON.stringify(value)}`);
    return;
  }
```

В `cmdConfigGet` после ветки `miro.token` добавить (label — не секрет, показываем как есть):

```typescript
  if (key === "menubar.label") {
    const label = readConfig()?.menubar?.label ?? null;
    const ui = getOutput();
    if (ui.mode === "json") {
      process.stdout.write(
        JSON.stringify({ ok: true, key, value: label }) + "\n",
      );
      return;
    }
    console.log(
      `menubar.label = ${label === null ? "[unset]" : JSON.stringify(label)}`,
    );
    return;
  }
```

В `cmdConfigUnset` после ветки `miro.token` добавить:

```typescript
  if (key === "menubar.label") {
    const cfg = readConfig();
    if (cfg?.menubar?.label !== undefined) {
      delete cfg.menubar.label;
      writeConfig(cfg);
    }
    uiInfo("menubar.label removed");
    return;
  }
```

- [ ] **Step 4: Тесты зелёные**

Run: `bun test tests/menubar-config.test.ts && bun test src/config.test.ts`
Expected: PASS (оба файла)

- [ ] **Step 5: Commit**

```bash
git add ../../apps/backend/src/config.ts src/config.ts tests/menubar-config.test.ts
git commit -m "feat(cli): config-ключ menubar.label"
```

---

### Task 7: error-file — маркер упавшего старта

**Files:**
- Create: `packages/shemma-cli/src/menubar/error-file.ts`
- Test: `packages/shemma-cli/tests/menubar-error-file.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/shemma-cli/tests/menubar-error-file.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearMenubarError,
  menubarErrorPath,
  readMenubarError,
  writeMenubarError,
} from "../src/menubar/error-file";

let tmp: string;
let file: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-err-"));
  file = path.join(tmp, ".shemma-menubar-error");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("menubar error file", () => {
  test("read без файла — null", () => {
    expect(readMenubarError(file)).toBeNull();
  });

  test("write → read возвращает сообщение", () => {
    writeMenubarError("Старт демона упал: boom", file);
    expect(readMenubarError(file)).toBe("Старт демона упал: boom");
  });

  test("clear удаляет; повторный clear не бросает", () => {
    writeMenubarError("x", file);
    clearMenubarError(file);
    expect(readMenubarError(file)).toBeNull();
    clearMenubarError(file); // идемпотентно
  });

  test("пустой файл читается как null", () => {
    fs.writeFileSync(file, "  \n");
    expect(readMenubarError(file)).toBeNull();
  });

  test("дефолтный путь — ~/.claude/.shemma-menubar-error", () => {
    expect(menubarErrorPath()).toBe(
      path.join(os.homedir(), ".claude", ".shemma-menubar-error"),
    );
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `bun test tests/menubar-error-file.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализация**

```typescript
// packages/shemma-cli/src/menubar/error-file.ts
// Маркер последнего упавшего старта (паттерн ERRORFILE из madstudio-helper):
// упавший `do start` пишет сообщение, render показывает его красным,
// успешный start/stop чистит. Конвенция state-файлов CLI: ~/.claude/.shemma-*.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function menubarErrorPath(): string {
  return join(homedir(), ".claude", ".shemma-menubar-error");
}

export function readMenubarError(path = menubarErrorPath()): string | null {
  try {
    if (!existsSync(path)) return null;
    const msg = readFileSync(path, "utf8").trim();
    return msg.length > 0 ? msg : null;
  } catch {
    return null;
  }
}

export function writeMenubarError(msg: string, path = menubarErrorPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, msg);
  } catch {
    // best-effort: сломанный маркер не должен ломать action
  }
}

export function clearMenubarError(path = menubarErrorPath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // идемпотентно
  }
}
```

- [ ] **Step 4: Тест зелёный**

Run: `bun test tests/menubar-error-file.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/menubar/error-file.ts tests/menubar-error-file.test.ts
git commit -m "feat(cli): menubar error-file — маркер упавшего старта"
```

---

### Task 8: update-cache — кешированный update-badge

**Files:**
- Create: `packages/shemma-cli/src/menubar/update-cache.ts`
- Test: `packages/shemma-cli/tests/menubar-update-cache.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/shemma-cli/tests/menubar-update-cache.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getUpdateBadge,
  updateCachePath,
  withTimeout,
} from "../src/menubar/update-cache";

let tmp: string;
let cache: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-upd-"));
  cache = path.join(tmp, "update.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TTL = 6 * 3600_000;

describe("getUpdateBadge", () => {
  test("холодный кеш → зовёт check и пишет кеш", async () => {
    let calls = 0;
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1_000_000,
      check: async () => {
        calls++;
        return { available: true, latest: "0.33.0" };
      },
    });
    expect(calls).toBe(1);
    expect(badge).toEqual({ available: true, latest: "0.33.0" });
    const raw = JSON.parse(fs.readFileSync(cache, "utf8"));
    expect(raw.checkedAt).toBe(1_000_000);
  });

  test("свежий кеш → check НЕ вызывается", async () => {
    fs.writeFileSync(
      cache,
      JSON.stringify({
        checkedAt: 1_000_000,
        badge: { available: false, latest: null },
      }),
    );
    let calls = 0;
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1_000_000 + TTL - 1,
      check: async () => {
        calls++;
        return { available: true, latest: "9.9.9" };
      },
    });
    expect(calls).toBe(0);
    expect(badge.available).toBe(false);
  });

  test("протухший кеш → перепроверка", async () => {
    fs.writeFileSync(
      cache,
      JSON.stringify({
        checkedAt: 1_000_000,
        badge: { available: false, latest: null },
      }),
    );
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1_000_000 + TTL + 1,
      check: async () => ({ available: true, latest: "0.33.0" }),
    });
    expect(badge.latest).toBe("0.33.0");
  });

  test("упавший check → available:false, кеш записан (не долбим сеть каждые 5с)", async () => {
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 42,
      check: async () => {
        throw new Error("offline");
      },
    });
    expect(badge).toEqual({ available: false, latest: null });
    const raw = JSON.parse(fs.readFileSync(cache, "utf8"));
    expect(raw.checkedAt).toBe(42);
  });

  test("битый кеш-файл → как холодный", async () => {
    fs.writeFileSync(cache, "{not json");
    const badge = await getUpdateBadge({
      cachePath: cache,
      ttlMs: TTL,
      now: 1,
      check: async () => ({ available: false, latest: null }),
    });
    expect(badge.available).toBe(false);
  });
});

describe("withTimeout", () => {
  test("быстрый промис проходит", async () => {
    const v = await withTimeout(Promise.resolve(7), 1000);
    expect(v).toBe(7);
  });

  test("медленный — reject по таймауту", async () => {
    const slow = new Promise((r) => setTimeout(() => r(1), 5000));
    await expect(withTimeout(slow, 20)).rejects.toThrow("timeout");
  });
});

describe("updateCachePath", () => {
  test("дефолт — ~/.claude/.shemma-menubar-update.json", () => {
    expect(updateCachePath()).toBe(
      path.join(os.homedir(), ".claude", ".shemma-menubar-update.json"),
    );
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `bun test tests/menubar-update-cache.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализация**

```typescript
// packages/shemma-cli/src/menubar/update-cache.ts
// Кеш update-badge: `update --check` — сетевой, а render дергается каждые 5 с.
// TTL 6 ч; протух — перепроверка прямо в рендере с жёстким таймаутом (caller
// оборачивает check в withTimeout). Упавшая проверка тоже кешируется как
// «нет обновления», чтобы офлайн не превращался в fetch на каждый рефреш.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CachedBadge {
  available: boolean;
  latest: string | null;
}

interface CacheFile {
  checkedAt: number;
  badge: CachedBadge;
}

export function updateCachePath(): string {
  return join(homedir(), ".claude", ".shemma-menubar-update.json");
}

export async function getUpdateBadge(opts: {
  cachePath: string;
  ttlMs: number;
  now: number;
  check: () => Promise<CachedBadge>;
}): Promise<CachedBadge> {
  const cached = readCache(opts.cachePath);
  if (cached && opts.now - cached.checkedAt < opts.ttlMs) return cached.badge;
  let badge: CachedBadge;
  try {
    badge = await opts.check();
  } catch {
    badge = { available: false, latest: null };
  }
  try {
    mkdirSync(dirname(opts.cachePath), { recursive: true });
    writeFileSync(
      opts.cachePath,
      JSON.stringify({ checkedAt: opts.now, badge } satisfies CacheFile),
    );
  } catch {
    // кеш — best-effort
  }
  return badge;
}

function readCache(path: string): CacheFile | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (typeof parsed?.checkedAt !== "number" || parsed.badge === undefined) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
```

- [ ] **Step 4: Тест зелёный**

Run: `bun test tests/menubar-update-cache.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/menubar/update-cache.ts tests/menubar-update-cache.test.ts
git commit -m "feat(cli): menubar update-cache — кешированный update-badge (TTL 6ч)"
```

---

### Task 9: render.ts — чистый рендер меню

Сердце фичи. Формат меню — по спеке (секция UX).

**Files:**
- Create: `packages/shemma-cli/src/menubar/render.ts`
- Test: `packages/shemma-cli/tests/menubar-render.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/shemma-cli/tests/menubar-render.test.ts
import { describe, expect, test } from "bun:test";
import type { CheckResult } from "../src/doctor";
import type { ProfileStatus } from "../src/ps";
import {
  ICON_ERROR,
  ICON_RUNNING,
  ICON_STOPPED,
} from "../src/menubar/icons";
import {
  type MenubarData,
  menubarState,
  renderErrorMenu,
  renderMenu,
} from "../src/menubar/render";

const RELEASE_OK: ProfileStatus = {
  profile: "release",
  port: 8787,
  pid: 61713,
  running: true,
  healthy: true,
};
const RELEASE_OFF: ProfileStatus = {
  profile: "release",
  port: 8787,
  running: false,
  healthy: false,
};
const RELEASE_SICK: ProfileStatus = {
  profile: "release",
  port: 8787,
  pid: 999,
  running: true,
  healthy: false,
};
const DEV_OFF: ProfileStatus = {
  profile: "dev",
  port: 8788,
  running: false,
  healthy: false,
};
const DEV_ON: ProfileStatus = {
  profile: "dev",
  port: 8788,
  pid: 111,
  running: true,
  healthy: true,
};

function base(over: Partial<MenubarData> = {}): MenubarData {
  return {
    release: RELEASE_OK,
    dev: DEV_OFF,
    version: "0.32.1",
    lastError: null,
    spaces: [],
    doctor: [],
    update: { available: false, latest: null },
    label: "",
    self: "/plugins/shemma.5s.sh",
    paramPrefix: [],
    ...over,
  };
}

describe("menubarState", () => {
  test("running+healthy → running", () => {
    expect(menubarState(base())).toBe("running");
  });
  test("running+unhealthy → error", () => {
    expect(menubarState(base({ release: RELEASE_SICK }))).toBe("error");
  });
  test("остановлен с lastError → error", () => {
    expect(
      menubarState(base({ release: RELEASE_OFF, lastError: "boom" })),
    ).toBe("error");
  });
  test("остановлен без ошибки → stopped", () => {
    expect(menubarState(base({ release: RELEASE_OFF }))).toBe("stopped");
  });
});

describe("renderMenu — работает", () => {
  const menu = renderMenu(
    base({
      spaces: [{ id: "di-draw", label: "di.draw" }, { id: "ios" }],
      dev: DEV_ON,
      update: { available: true, latest: "0.33.0" },
    }),
  );
  const lines = menu.split("\n");

  test("title — зелёная иконка", () => {
    expect(lines[0]).toBe(`| image=${ICON_RUNNING}`);
  });
  test("статусная строка", () => {
    expect(menu).toContain("Работает · :8787 · pid 61713 · v0.32.1");
  });
  test("dev-строка при живом dev", () => {
    expect(menu).toContain("dev · :8788 · работает");
  });
  test("update-badge с terminal=true", () => {
    const l = lines.find((x) => x.includes("Доступно обновление 0.33.0"));
    expect(l).toBeDefined();
    expect(l).toContain("terminal=true");
    expect(l).toContain("param1=do param2=update");
  });
  test("управление: Остановить/Перезапустить, без Запустить", () => {
    expect(menu).toContain("Остановить |");
    expect(menu).toContain("Перезапустить |");
    expect(lines.some((l) => l.startsWith("Запустить"))).toBe(false);
  });
  test("stop-all присутствует", () => {
    const l = lines.find((x) => x.startsWith("Остановить все инстансы"));
    expect(l).toContain("param1=do param2=stop-all");
  });
  test("spaces-сабменю: label приоритетнее id", () => {
    expect(menu).toContain("-- di.draw |");
    expect(menu).toContain("-- ios |");
    const l = lines.find((x) => x.includes("-- di.draw"));
    expect(l).toContain("param1=do param2=open-space param3=di-draw");
  });
  test("doctor ok — плоская строка", () => {
    expect(menu).toContain("Doctor: ✔ ok");
  });
  test("хвост: конфиг и версия хелпера", () => {
    expect(menu).toContain("Изменить конфиг…");
    expect(menu).toContain("Helper v0.32.1");
  });
  test("action-строки зовут self", () => {
    const l = lines.find((x) => x.startsWith("Остановить |"));
    expect(l).toContain('bash="/plugins/shemma.5s.sh"');
  });
});

describe("renderMenu — остановлен", () => {
  const menu = renderMenu(base({ release: RELEASE_OFF }));
  const lines = menu.split("\n");

  test("title — серая иконка, статус Остановлен", () => {
    expect(lines[0]).toBe(`| image=${ICON_STOPPED}`);
    expect(menu).toContain("Остановлен |");
  });
  test("Запустить есть, Остановить/Перезапустить нет", () => {
    expect(lines.some((l) => l.startsWith("Запустить"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Остановить |"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Перезапустить"))).toBe(false);
  });
  test("Открыть доску остаётся (ensure+open)", () => {
    expect(menu).toContain("Открыть доску");
  });
});

describe("renderMenu — ошибка", () => {
  test("lastError показан красным", () => {
    const menu = renderMenu(
      base({ release: RELEASE_OFF, lastError: "Старт демона упал: boom" }),
    );
    expect(menu.split("\n")[0]).toBe(`| image=${ICON_ERROR}`);
    expect(menu).toContain("Старт демона упал: boom | color=red");
  });
  test("unhealthy — своя формулировка", () => {
    const menu = renderMenu(base({ release: RELEASE_SICK }));
    expect(menu).toContain("Демон не отвечает на :8787 | color=red");
  });
});

describe("renderMenu — doctor warn/fail", () => {
  const doctor: CheckResult[] = [
    { check: "daemon-status[release]", status: "ok", detail: "fine" },
    { check: "port-owner[release]", status: "warn", detail: "port busy" },
    { check: "storage-writable[release]", status: "fail", detail: "/nope" },
  ];
  const menu = renderMenu(base({ doctor }));

  test("счётчик warn/fail", () => {
    expect(menu).toContain("Doctor: ⚠ 1 fail, 1 warn");
  });
  test("сабменю содержит только не-ok чеки", () => {
    expect(menu).toContain("-- [warn] port-owner[release]: port busy");
    expect(menu).toContain("-- [fail] storage-writable[release]: /nope");
    expect(menu).not.toContain("-- [ok]");
  });
});

describe("renderMenu — метка и paramPrefix", () => {
  test("label рядом с иконкой", () => {
    const menu = renderMenu(base({ label: "shemma" }));
    expect(menu.split("\n")[0]).toBe(`shemma | image=${ICON_RUNNING}`);
  });
  test("paramPrefix для прямого вызова бинаря", () => {
    const menu = renderMenu(
      base({ self: "/usr/local/bin/shemma", paramPrefix: ["menubar"] }),
    );
    const l = menu.split("\n").find((x) => x.startsWith("Остановить |"));
    expect(l).toContain("param1=menubar param2=do param3=stop");
  });
});

describe("renderErrorMenu", () => {
  test("красная иконка + сообщение, валидный формат", () => {
    const menu = renderErrorMenu("TypeError: x");
    const lines = menu.split("\n");
    expect(lines[0]).toBe(`| image=${ICON_ERROR}`);
    expect(lines[1]).toBe("---");
    expect(menu).toContain("TypeError: x");
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `bun test tests/menubar-render.test.ts`
Expected: FAIL — модуль render не найден

- [ ] **Step 3: Реализация**

```typescript
// packages/shemma-cli/src/menubar/render.ts
// Чистый рендер SwiftBar-меню: MenubarData → текст. Никакого IO — все данные
// собирает caller (menubar/index.ts), поэтому модуль полностью unit-тестируем.
// Формат SwiftBar: https://github.com/swiftbar/SwiftBar#plugin-api
import type { CheckResult } from "../doctor";
import type { ProfileStatus } from "../ps";
import { ICON_ERROR, ICON_RUNNING, ICON_STOPPED } from "./icons";

export interface MenubarSpace {
  id: string;
  label?: string;
}

export interface MenubarUpdate {
  available: boolean;
  latest: string | null;
}

export interface MenubarData {
  release: ProfileStatus;
  dev: ProfileStatus;
  version: string;
  lastError: string | null;
  spaces: MenubarSpace[];
  doctor: CheckResult[];
  update: MenubarUpdate;
  /** Подпись рядом с иконкой (config menubar.label); пусто → только иконка. */
  label: string;
  /** Путь, который SwiftBar вызовет в action-строках (shim или бинарь). */
  self: string;
  /** [] — вызов через shim; ["menubar"] — прямой вызов бинаря. */
  paramPrefix: string[];
}

export type MenubarState = "running" | "stopped" | "error";

export function menubarState(d: MenubarData): MenubarState {
  if (d.release.running && d.release.healthy) return "running";
  if (d.release.running && !d.release.healthy) return "error";
  if (d.lastError !== null) return "error";
  return "stopped";
}

/** Собирает `bash=... paramN=...` для пункта меню. */
function act(d: MenubarData, parts: string[], extra: string): string {
  const params = [...d.paramPrefix, ...parts]
    .map((p, i) => `param${i + 1}=${p}`)
    .join(" ");
  return `bash="${d.self}" ${params} ${extra}`;
}

const RUN = "terminal=false refresh=true";
const OPEN = "terminal=false refresh=false";

export function renderMenu(d: MenubarData): string {
  const out: string[] = [];
  const state = menubarState(d);
  const icon =
    state === "running"
      ? ICON_RUNNING
      : state === "error"
        ? ICON_ERROR
        : ICON_STOPPED;
  out.push(`${d.label ? `${d.label} ` : ""}| image=${icon}`);
  out.push("---");

  // Статус-блок
  if (state === "running") {
    out.push(
      `Работает · :${d.release.port} · pid ${d.release.pid ?? "?"} · v${d.version} | color=gray`,
    );
  } else if (state === "error") {
    const msg = d.release.running
      ? `Демон не отвечает на :${d.release.port}`
      : (d.lastError ?? "Ошибка");
    out.push(`${msg} | color=red`);
  } else {
    out.push("Остановлен | color=gray");
  }
  if (d.dev.running) {
    out.push(`dev · :${d.dev.port} · работает | color=gray`);
  }
  if (d.update.available && d.update.latest !== null) {
    out.push(
      `⬆ Доступно обновление ${d.update.latest} | sfimage=arrow.down.circle ${act(d, ["do", "update"], "terminal=true refresh=true")}`,
    );
  }
  out.push("---");

  // Управление демоном
  if (state === "running") {
    out.push(`Остановить | sfimage=stop ${act(d, ["do", "stop"], RUN)}`);
    out.push(
      `Перезапустить | sfimage=arrow.clockwise ${act(d, ["do", "restart"], RUN)}`,
    );
  } else {
    out.push(`Запустить | sfimage=play ${act(d, ["do", "start"], RUN)}`);
  }
  out.push(
    `Остановить все инстансы | sfimage=xmark.octagon ${act(d, ["do", "stop-all"], RUN)}`,
  );
  out.push("---");

  // Открытие
  out.push(
    `Открыть доску | sfimage=rectangle.on.rectangle ${act(d, ["do", "open-board"], OPEN)}`,
  );
  if (d.spaces.length > 0) {
    out.push("Spaces | sfimage=square.grid.2x2");
    for (const s of d.spaces) {
      out.push(
        `-- ${s.label ?? s.id} | ${act(d, ["do", "open-space", s.id], OPEN)}`,
      );
    }
  }
  out.push("---");

  // Диагностика
  const bad = d.doctor.filter((c) => c.status !== "ok");
  if (bad.length === 0) {
    out.push("Doctor: ✔ ok | color=gray");
  } else {
    const fails = bad.filter((c) => c.status === "fail").length;
    const warns = bad.filter((c) => c.status === "warn").length;
    const counts = [
      ...(fails > 0 ? [`${fails} fail`] : []),
      ...(warns > 0 ? [`${warns} warn`] : []),
    ].join(", ");
    out.push(`Doctor: ⚠ ${counts}`);
    for (const c of bad) {
      out.push(`-- [${c.status}] ${c.check}: ${c.detail}`);
    }
  }
  out.push(
    `Открыть лог демона | sfimage=doc.plaintext ${act(d, ["do", "open-log"], OPEN)}`,
  );
  out.push("---");

  // Хвост
  out.push(
    `Изменить конфиг… | sfimage=gearshape ${act(d, ["do", "edit-config"], OPEN)}`,
  );
  out.push(`Helper v${d.version} | color=gray`);
  return out.join("\n");
}

/** Аварийное меню: render никогда не падает — исключение превращается в это. */
export function renderErrorMenu(message: string): string {
  return [
    `| image=${ICON_ERROR}`,
    "---",
    "Ошибка рендера меню | color=red",
    `${message} | color=gray`,
  ].join("\n");
}
```

- [ ] **Step 4: Тест зелёный**

Run: `bun test tests/menubar-render.test.ts`
Expected: PASS (все тесты)

- [ ] **Step 5: Commit**

```bash
git add src/menubar/render.ts tests/menubar-render.test.ts
git commit -m "feat(cli): menubar render — чистый рендер SwiftBar-меню"
```

---

### Task 10: actions.ts — действия меню

Тонкие IO-обёртки; тестируем чистые хелперы (`formatStopAllSummary`, URL-билдеры), сами действия проверяются в Task 12 smoke + финальной live-проверке.

**Files:**
- Create: `packages/shemma-cli/src/menubar/actions.ts`
- Test: `packages/shemma-cli/tests/menubar-actions.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/shemma-cli/tests/menubar-actions.test.ts
import { describe, expect, test } from "bun:test";
import type { StopAllResult } from "../src/daemon";
import {
  boardUrl,
  formatStopAllSummary,
  spaceUrl,
} from "../src/menubar/actions";

describe("URL-билдеры", () => {
  test("boardUrl", () => {
    expect(boardUrl(8787)).toBe("http://localhost:8787/");
  });
  test("spaceUrl экранирует id", () => {
    expect(spaceUrl(8787, "di-draw")).toBe(
      "http://localhost:8787/?space=di-draw",
    );
    expect(spaceUrl(8787, "a b")).toBe("http://localhost:8787/?space=a%20b");
  });
});

describe("formatStopAllSummary", () => {
  test("остановленные считаются", () => {
    const results: StopAllResult[] = [
      { ok: true, profile: "release", stopped: 61713 },
      { ok: true, profile: "dev", already: true },
      { ok: true, profile: "debug", already: true },
    ];
    expect(formatStopAllSummary(results)).toBe("Остановлено демонов: 1");
  });
  test("нечего останавливать", () => {
    const results: StopAllResult[] = [
      { ok: true, profile: "release", already: true },
      { ok: true, profile: "dev", already: true },
      { ok: true, profile: "debug", already: true },
    ];
    expect(formatStopAllSummary(results)).toBe("Демоны уже остановлены");
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `bun test tests/menubar-actions.test.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализация**

```typescript
// packages/shemma-cli/src/menubar/actions.ts
// Действия пунктов меню (`shemma menubar do <action> [arg]`). Тонкие обёртки
// над существующими daemon/browser/update функциями. Ошибки — громко:
// error-file (render покажет красным) + macOS-notification, никаких тихих
// падений. stdout действий SwiftBar игнорирует.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  configFilePath,
  readConfig,
  writeConfig,
} from "@shemma/backend/src/config";
import { openBrowser } from "../browser";
import { ensure, stop, stopAll, type StopAllResult } from "../daemon";
import { logFile, portFor } from "../profile";
import { cmdUpdate } from "../update";
import { clearMenubarError, writeMenubarError } from "./error-file";

/** Menubar управляет release-профилем (спека: dev — read-only строка). */
const PROFILE = "release" as const;

export function boardUrl(port: number): string {
  return `http://localhost:${port}/`;
}

export function spaceUrl(port: number, spaceId: string): string {
  return `http://localhost:${port}/?space=${encodeURIComponent(spaceId)}`;
}

export function formatStopAllSummary(results: StopAllResult[]): string {
  const stopped = results.filter((r) => r.stopped !== undefined).length;
  return stopped > 0
    ? `Остановлено демонов: ${stopped}`
    : "Демоны уже остановлены";
}

/** macOS-уведомление, best-effort (не darwin / нет osascript → no-op). */
export function notify(message: string): void {
  if (process.platform !== "darwin") return;
  const esc = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFile(
      "osascript",
      ["-e", `display notification "${esc}" with title "shemma"`],
      () => {},
    );
  } catch {
    // best-effort
  }
}

export async function runAction(action: string, arg?: string): Promise<void> {
  switch (action) {
    case "start":
      return doStart();
    case "stop":
      await stop(PROFILE);
      clearMenubarError();
      return;
    case "restart":
      await stop(PROFILE).catch(() => {});
      return doStart();
    case "stop-all": {
      const results = await stopAll();
      clearMenubarError();
      notify(formatStopAllSummary(results));
      return;
    }
    case "open-board":
      await doStart();
      openBrowser(boardUrl(portFor(PROFILE)));
      return;
    case "open-space": {
      if (!arg) {
        notify("open-space: не передан id space");
        process.exit(1);
      }
      openBrowser(spaceUrl(portFor(PROFILE), arg));
      return;
    }
    case "open-log": {
      const p = logFile(PROFILE);
      if (!existsSync(p)) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "");
      }
      execFile("open", ["-t", p], () => {});
      return;
    }
    case "edit-config": {
      try {
        if (readConfig() === null) writeConfig({});
      } catch {
        // битый JSON — всё равно откроем файл, юзер поправит руками
      }
      execFile("open", ["-t", configFilePath()], () => {});
      return;
    }
    case "update":
      // Запускается из меню с terminal=true — прогресс виден в Terminal.
      return cmdUpdate([]);
    default:
      notify(`Неизвестное действие меню: ${action}`);
      process.exit(1);
  }
}

async function doStart(): Promise<void> {
  try {
    await ensure(PROFILE);
    clearMenubarError();
  } catch (e) {
    const msg = `Старт демона упал: ${String(e)}`;
    writeMenubarError(msg);
    notify(msg);
    throw e;
  }
}
```

- [ ] **Step 4: Тест зелёный**

Run: `bun test tests/menubar-actions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/menubar/actions.ts tests/menubar-actions.test.ts
git commit -m "feat(cli): menubar actions — do start/stop/restart/stop-all/open-*/update"
```

---

### Task 11: shim + install/uninstall/status

**Files:**
- Create: `packages/shemma-cli/src/menubar/shim.sh`
- Create: `packages/shemma-cli/src/menubar/shim.d.ts`
- Create: `packages/shemma-cli/src/menubar/install.ts`
- Test: `packages/shemma-cli/tests/menubar-install.test.ts`

Контракт `--plugin-dir <path>`: явный путь = «экспертный/тестовый» режим — пишем/удаляем shim только в нём, БЕЗ darwin-проверки, brew, defaults и активации SwiftBar. Без флага — полный macOS-флоу.

- [ ] **Step 1: Failing test (subprocess, как cli-spaces.test.ts)**

```typescript
// packages/shemma-cli/tests/menubar-install.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpXdg: string;
let pluginDir: string;

async function runCli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      XDG_CONFIG_HOME: tmpXdg,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

beforeEach(() => {
  tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-xdg-"));
  pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-plugins-"));
});

afterEach(() => {
  fs.rmSync(tmpXdg, { recursive: true, force: true });
  fs.rmSync(pluginDir, { recursive: true, force: true });
});

describe("menubar install --plugin-dir", () => {
  test("ставит исполняемый shim shemma.5s.sh", async () => {
    const r = await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    expect(r.status).toBe(0);
    const shim = path.join(pluginDir, "shemma.5s.sh");
    expect(fs.existsSync(shim)).toBe(true);
    const mode = fs.statSync(shim).mode;
    expect(mode & 0o111).toBeGreaterThan(0); // исполняемый
    const body = fs.readFileSync(shim, "utf8");
    expect(body).toContain("<bitbar.title>shemma</bitbar.title>");
    expect(body).toContain('menubar "${1:-render}"');
    expect(body).not.toContain("__VERSION__"); // placeholder заменён
  });

  test("--interval 10s → shemma.10s.sh; старый shim удаляется", async () => {
    await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    const r = await runCli([
      "menubar",
      "install",
      "--plugin-dir",
      pluginDir,
      "--interval",
      "10s",
    ]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(pluginDir, "shemma.10s.sh"))).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, "shemma.5s.sh"))).toBe(false);
  });

  test("невалидный interval → exit 1", async () => {
    const r = await runCli([
      "menubar",
      "install",
      "--plugin-dir",
      pluginDir,
      "--interval",
      "banana",
    ]);
    expect(r.status).toBe(1);
  });
});

describe("menubar status --plugin-dir", () => {
  test("не установлен", async () => {
    const r = await runCli(["menubar", "status", "--plugin-dir", pluginDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("not installed");
  });

  test("установлен — путь и интервал", async () => {
    await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    const r = await runCli(["menubar", "status", "--plugin-dir", pluginDir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shemma.5s.sh");
    expect(r.stdout).toContain("5s");
  });
});

describe("menubar uninstall --plugin-dir", () => {
  test("удаляет shim; повторный uninstall не падает", async () => {
    await runCli(["menubar", "install", "--plugin-dir", pluginDir]);
    const r1 = await runCli(["menubar", "uninstall", "--plugin-dir", pluginDir]);
    expect(r1.status).toBe(0);
    expect(fs.existsSync(path.join(pluginDir, "shemma.5s.sh"))).toBe(false);
    const r2 = await runCli(["menubar", "uninstall", "--plugin-dir", pluginDir]);
    expect(r2.status).toBe(0);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `bun test tests/menubar-install.test.ts`
Expected: FAIL — `menubar` ещё не команда CLI (usage + exit 1)

Примечание: диспетчер `cmd === "menubar"` появится в Task 12 — для этого теста нужен минимальный wiring. Добавь его прямо в этом task'е (Step 3.4), Task 12 доведёт остальное (render/do/usage).

- [ ] **Step 3: Реализация**

3.1. Shim-шаблон:

```bash
# файл: packages/shemma-cli/src/menubar/shim.sh
#!/usr/bin/env bash
# <bitbar.title>shemma</bitbar.title>
# <bitbar.version>__VERSION__</bitbar.version>
# <bitbar.author>shemma</bitbar.author>
# <bitbar.desc>Управление shemma-демоном из menu bar.</bitbar.desc>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
#
# Тонкий shim: вся логика меню — в `shemma menubar` (обновляется вместе с
# бинарём через `shemma update`). Здесь только резолв бинаря + fallback-меню.
set -u

resolve_bin() {
  if [ -n "${SHEMMA_BIN:-}" ] && [ -x "$SHEMMA_BIN" ]; then
    printf '%s' "$SHEMMA_BIN"
    return 0
  fi
  if command -v shemma >/dev/null 2>&1; then
    command -v shemma
    return 0
  fi
  for p in "$HOME/.local/bin/shemma" /opt/homebrew/bin/shemma /usr/local/bin/shemma; do
    if [ -x "$p" ]; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

if ! BIN="$(resolve_bin)"; then
  echo "⚠️"
  echo "---"
  echo "shemma не найден | color=red"
  echo "Установи бинарь или задай SHEMMA_BIN в env | color=gray"
  echo "Открыть README | href=https://github.com/denizztret/shemma"
  exit 0
fi

exec "$BIN" menubar "${1:-render}" "${@:2}"
```

ВАЖНО: первая строка файла — `#!/usr/bin/env bash` (комментарий `# файл:` выше — только для плана, в файл не писать).

3.2. Декларация для text-импорта:

```typescript
// packages/shemma-cli/src/menubar/shim.d.ts
declare module "*.sh" {
  const text: string;
  export default text;
}
```

3.3. install.ts:

```typescript
// packages/shemma-cli/src/menubar/install.ts
// install/uninstall/status shim'а. Вся macOS-специфика фичи живёт здесь.
// `--plugin-dir <path>` = экспертный/тестовый режим: только файл-операции,
// без brew/defaults/open (поэтому subprocess-тесты гоняются на любой ОС).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { error as uiError, info as uiInfo, success as uiSuccess } from "../ui";
import { resolveCurrentVersion } from "../update";
import shimTemplate from "./shim.sh" with { type: "text" };

const DEFAULT_PLUGIN_DIR = join(homedir(), ".config", "swiftbar-plugins");
const SWIFTBAR_DEFAULTS_DOMAIN = "com.ameba.SwiftBar";
const SHIM_RE = /^shemma\..+\.sh$/;
const INTERVAL_RE = /^[0-9]+[smhd]$/;

export interface MenubarInstallOpts {
  interval: string;
  pluginDir?: string;
  yes: boolean;
}

export function parseMenubarFlags(argv: string[]): MenubarInstallOpts {
  const opts: MenubarInstallOpts = { interval: "5s", yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--interval") opts.interval = argv[++i] ?? "";
    else if (argv[i] === "--plugin-dir") opts.pluginDir = argv[++i];
    else if (argv[i] === "--yes") opts.yes = true;
  }
  return opts;
}

function dieUsage(msg: string): never {
  uiError(msg, { code: "usage" });
  process.exit(1);
}

function shimFileName(interval: string): string {
  return `shemma.${interval}.sh`;
}

export function renderShim(version: string): string {
  return shimTemplate.replace("__VERSION__", version);
}

/** y/N-подтверждение через stdin (для brew-установки SwiftBar). */
async function confirmYes(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

function swiftBarInstalled(): boolean {
  return [
    "/Applications/SwiftBar.app",
    join(homedir(), "Applications", "SwiftBar.app"),
  ].some((p) => existsSync(p));
}

function readDefaultsPluginDir(): string | null {
  try {
    const out = execFileSync(
      "defaults",
      ["read", SWIFTBAR_DEFAULTS_DOMAIN, "PluginDirectory"],
      { encoding: "utf8", timeout: 3000 },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // домен/ключ не заведён — SwiftBar ещё не настраивался
  }
}

function writeDefaultsPluginDir(dir: string): void {
  execFileSync(
    "defaults",
    ["write", SWIFTBAR_DEFAULTS_DOMAIN, "PluginDirectory", "-string", dir],
    { timeout: 3000 },
  );
}

function refreshSwiftBar(): void {
  // Запустить (если не запущен) и перечитать плагины; best-effort.
  try {
    execFileSync("open", ["-a", "SwiftBar"], { timeout: 5000 });
    execFileSync("open", ["swiftbar://refreshallplugins"], { timeout: 5000 });
  } catch {
    uiInfo("SwiftBar не откликнулся на refresh — обнови плагины вручную");
  }
}

/** Кладёт shim в dir, убирая варианты с другим интервалом. Идемпотентно. */
function writeShim(dir: string, interval: string): string {
  mkdirSync(dir, { recursive: true });
  const name = shimFileName(interval);
  for (const f of readdirSync(dir)) {
    if (SHIM_RE.test(f) && f !== name) rmSync(join(dir, f), { force: true });
  }
  const target = join(dir, name);
  writeFileSync(target, renderShim(resolveCurrentVersion()));
  chmodSync(target, 0o755);
  return target;
}

function findInstalledShim(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).find((f) => SHIM_RE.test(f));
  return found ?? null;
}

export async function cmdMenubarInstall(
  opts: MenubarInstallOpts,
): Promise<void> {
  if (!INTERVAL_RE.test(opts.interval)) {
    dieUsage(
      `invalid --interval "${opts.interval}" (ожидается вида 5s | 30s | 1m)`,
    );
  }
  // Экспертный/тестовый путь: только файлы.
  if (opts.pluginDir !== undefined) {
    const target = writeShim(opts.pluginDir, opts.interval);
    uiSuccess(`shim installed: ${target}`);
    return;
  }
  if (process.platform !== "darwin") {
    uiError("menubar install поддерживается только на macOS", {
      code: "not-darwin",
    });
    process.exit(1);
  }
  if (!swiftBarInstalled()) {
    const doInstall =
      opts.yes || (await confirmYes("SwiftBar не установлен. brew install --cask swiftbar?"));
    if (!doInstall) {
      uiError("SwiftBar не установлен", {
        code: "swiftbar-missing",
        hint: "brew install --cask swiftbar, затем повтори shemma menubar install",
      });
      process.exit(1);
    }
    execFileSync("brew", ["install", "--cask", "swiftbar"], {
      stdio: "inherit",
    });
  }
  let dir = readDefaultsPluginDir();
  if (dir === null) {
    dir = DEFAULT_PLUGIN_DIR;
    mkdirSync(dir, { recursive: true });
    writeDefaultsPluginDir(dir);
    uiInfo(`SwiftBar plugin dir → ${dir} (defaults write)`);
  }
  const target = writeShim(dir, opts.interval);
  refreshSwiftBar();
  uiSuccess(`shim installed: ${target}`);
}

export async function cmdMenubarUninstall(
  opts: MenubarInstallOpts,
): Promise<void> {
  const dir =
    opts.pluginDir ?? readDefaultsPluginDir() ?? DEFAULT_PLUGIN_DIR;
  const found = findInstalledShim(dir);
  if (found === null) {
    uiInfo("shim not installed — nothing to remove");
    return;
  }
  rmSync(join(dir, found), { force: true });
  if (opts.pluginDir === undefined && process.platform === "darwin") {
    try {
      execFileSync("open", ["swiftbar://refreshallplugins"], { timeout: 5000 });
    } catch {
      // best-effort
    }
  }
  uiSuccess(`shim removed: ${join(dir, found)}`);
}

export async function cmdMenubarStatus(
  opts: MenubarInstallOpts,
): Promise<void> {
  const dir =
    opts.pluginDir ?? readDefaultsPluginDir() ?? DEFAULT_PLUGIN_DIR;
  const found = findInstalledShim(dir);
  if (found === null) {
    uiInfo(`not installed (plugin dir: ${dir})`);
    return;
  }
  const interval = found.replace(/^shemma\./, "").replace(/\.sh$/, "");
  uiInfo(`installed: ${join(dir, found)} (interval ${interval})`);
}
```

3.4. Минимальный wiring в `packages/shemma-cli/src/index.ts` — после блока `if (cmd === "config") {...}` (строка ~337), до `isOpenCmd`:

```typescript
  if (cmd === "menubar") {
    const { cmdMenubar } = await import("./menubar");
    return cmdMenubar(argv.slice(1));
  }
```

и временный минимальный `packages/shemma-cli/src/menubar/index.ts` (Task 12 расширит):

```typescript
// packages/shemma-cli/src/menubar/index.ts
import { error as uiError } from "../ui";
import {
  cmdMenubarInstall,
  cmdMenubarStatus,
  cmdMenubarUninstall,
  parseMenubarFlags,
} from "./install";

export async function cmdMenubar(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "render";
  const rest = argv.slice(1);
  if (sub === "install") return cmdMenubarInstall(parseMenubarFlags(rest));
  if (sub === "uninstall") return cmdMenubarUninstall(parseMenubarFlags(rest));
  if (sub === "status") return cmdMenubarStatus(parseMenubarFlags(rest));
  uiError(`unknown menubar subcommand: ${sub}`, { code: "usage" });
  process.exit(1);
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `bun test tests/menubar-install.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/menubar/shim.sh src/menubar/shim.d.ts src/menubar/install.ts src/menubar/index.ts src/index.ts tests/menubar-install.test.ts
git commit -m "feat(cli): menubar install/uninstall/status + SwiftBar shim"
```

---

### Task 12: Диспетчер render/do + usage()

**Files:**
- Modify: `packages/shemma-cli/src/menubar/index.ts`
- Modify: `packages/shemma-cli/src/index.ts:595-599` (usage, секция Config) и после строки ~604 (новая секция)
- Test: `packages/shemma-cli/tests/menubar-cli.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// packages/shemma-cli/tests/menubar-cli.test.ts
// Smoke: render выдаёт валидное SwiftBar-меню независимо от состояния демона
// (детерминированные проверки — структура, а не конкретный статус).
// HOME уводим в tmpdir, чтобы не читать реальные ~/.claude state-файлы.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "index.ts");

let tmpHome: string;

async function runCli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "menubar-home-"));
  // Кеш update-badge кладём заранее свежим, чтобы render не ходил в сеть.
  fs.mkdirSync(path.join(tmpHome, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, ".claude", ".shemma-menubar-update.json"),
    JSON.stringify({
      checkedAt: Date.now(),
      badge: { available: false, latest: null },
    }),
  );
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("shemma menubar render", () => {
  test("выдаёт валидную структуру меню и exit 0", async () => {
    const r = await runCli(["menubar", "render"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toContain("| image=");   // title с иконкой
    expect(lines[1]).toBe("---");
    expect(r.stdout).toContain("Остановить все инстансы");
    expect(r.stdout).toContain("Doctor:");
    expect(r.stdout).toContain("Изменить конфиг…");
  });

  test("zero-arg menubar = render", async () => {
    const r = await runCli(["menubar"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("| image=");
  });
});

describe("shemma menubar do", () => {
  test("без action — exit 1", async () => {
    const r = await runCli(["menubar", "do"]);
    expect(r.status).toBe(1);
  });
  test("неизвестный action — exit 1", async () => {
    const r = await runCli(["menubar", "do", "self-destruct"]);
    expect(r.status).toBe(1);
  });
});

describe("usage", () => {
  test("help упоминает menubar", async () => {
    const r = await runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("menubar install");
    expect(r.stdout).toContain("menubar.label");
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `bun test tests/menubar-cli.test.ts`
Expected: FAIL — render/do ещё не реализованы (unknown menubar subcommand)

- [ ] **Step 3: Полный menubar/index.ts**

```typescript
// packages/shemma-cli/src/menubar/index.ts
// Диспетчер `shemma menubar <sub>` + сборка данных для рендера.
// render — presentation-интерфейс для SwiftBar (НЕ machine API: формат вывода
// не покрывается гарантиями стабильности CLI, см. README).
import { listSpaces } from "@shemma/spaces";
import { readConfig } from "@shemma/backend/src/config";
import { runDoctorChecks } from "../doctor";
import { collectProfileStatuses } from "../ps";
import { error as uiError } from "../ui";
import { checkUpdateAvailable, resolveCurrentVersion } from "../update";
import { runAction } from "./actions";
import { readMenubarError } from "./error-file";
import {
  cmdMenubarInstall,
  cmdMenubarStatus,
  cmdMenubarUninstall,
  parseMenubarFlags,
} from "./install";
import {
  type MenubarData,
  type MenubarSpace,
  renderErrorMenu,
  renderMenu,
} from "./render";
import { getUpdateBadge, updateCachePath, withTimeout } from "./update-cache";

const UPDATE_TTL_MS = 6 * 3600_000;
const UPDATE_CHECK_TIMEOUT_MS = 2000;
/** Только релевантные меню чеки: без bun/shemma-version (шум) и manifest (сеть). */
const MENU_DOCTOR_RE = /^(daemon-status|port-owner|storage-writable|config-readable)/;

export async function cmdMenubar(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "render";
  const rest = argv.slice(1);
  if (sub === "render") return cmdRender();
  if (sub === "do") {
    const action = rest[0];
    if (!action) {
      uiError("usage: shemma menubar do <action> [arg]", { code: "usage" });
      process.exit(1);
    }
    return runAction(action, rest[1]);
  }
  if (sub === "install") return cmdMenubarInstall(parseMenubarFlags(rest));
  if (sub === "uninstall") return cmdMenubarUninstall(parseMenubarFlags(rest));
  if (sub === "status") return cmdMenubarStatus(parseMenubarFlags(rest));
  uiError(`unknown menubar subcommand: ${sub}`, { code: "usage" });
  process.exit(1);
}

/** SwiftBar зовёт action-строки: через shim (SWIFTBAR_PLUGIN_PATH) или бинарь. */
function resolveSelf(): { self: string; paramPrefix: string[] } {
  const plugin = process.env.SWIFTBAR_PLUGIN_PATH;
  if (plugin) return { self: plugin, paramPrefix: [] };
  return { self: process.execPath, paramPrefix: ["menubar"] };
}

async function cmdRender(): Promise<void> {
  try {
    const [statuses, doctorAll, update] = await Promise.all([
      collectProfileStatuses(),
      runDoctorChecks(["release"], { network: false }),
      getUpdateBadge({
        cachePath: updateCachePath(),
        ttlMs: UPDATE_TTL_MS,
        now: Date.now(),
        check: async () => {
          const b = await withTimeout(
            checkUpdateAvailable(),
            UPDATE_CHECK_TIMEOUT_MS,
          );
          return { available: b.available, latest: b.latest };
        },
      }),
    ]);
    const release = statuses.find((s) => s.profile === "release");
    const dev = statuses.find((s) => s.profile === "dev");
    if (!release || !dev) throw new Error("profile status missing");
    let spaces: MenubarSpace[] = [];
    try {
      spaces = listSpaces().map((s) => ({ id: s.id, label: s.label }));
    } catch {
      // реестр spaces битый/недоступен — меню живёт без сабменю
    }
    let label = "";
    try {
      label = readConfig()?.menubar?.label ?? "";
    } catch {
      // битый config.json — не роняем рендер
    }
    const data: MenubarData = {
      release,
      dev,
      version: resolveCurrentVersion(),
      lastError: readMenubarError(),
      spaces,
      doctor: doctorAll.filter((c) => MENU_DOCTOR_RE.test(c.check)),
      update,
      label,
      ...resolveSelf(),
    };
    console.log(renderMenu(data));
  } catch (e) {
    // render никогда не падает — SwiftBar получает валидное error-меню.
    console.log(renderErrorMenu(String(e)));
  }
}
```

- [ ] **Step 4: Обновить usage() в src/index.ts**

В секции Config заменить строку поддерживаемых ключей:

```
                                              # Supported keys: miro.token, menubar.label
```

После секции «MCP integration» (перед «Versioning:») добавить:

```
Menu bar (macOS):
  menubar install [--interval 5s] [--plugin-dir <path>] [--yes]
                                              # install SwiftBar shim (brew cask hint included)
  menubar uninstall | status
  menubar render | do <action> [arg]          # presentation interface for SwiftBar (not a machine API)
```

- [ ] **Step 5: Тесты зелёные**

Run: `bun test tests/menubar-cli.test.ts`
Expected: PASS (5 tests)

Примечание: если smoke-тест `render` флачит из-за живого демона на :8787 (isHealthy видит реальный порт) — это ок, тест проверяет структуру, не статус. Убедись, что assertions не завязаны на «Работает/Остановлен».

- [ ] **Step 6: Весь пакет зелёный + commit**

```bash
bun test && cd /Users/tretyakov_dv/Projects/sandbox/di.draw && bun run lint
git add packages/shemma-cli/src/menubar/index.ts packages/shemma-cli/src/index.ts packages/shemma-cli/tests/menubar-cli.test.ts
git commit -m "feat(cli): shemma menubar — диспетчер render/do + usage"
```

---

### Task 13: Документация — CHANGELOG + README

**Files:**
- Modify: `CHANGELOG.md` (секция Unreleased)
- Modify: `README.md` (новая секция после установки)

- [ ] **Step 1: CHANGELOG**

В `CHANGELOG.md` под `## Unreleased` добавить:

```markdown
### Added

- **Menu bar helper (macOS): `shemma menubar` + SwiftBar shim.** Статус демона
  цветной иконкой (работает/остановлен/ошибка), start/stop/restart, «Остановить
  все инстансы» (`daemon stop --all`), открытие доски и галерей spaces, doctor-чеки,
  update-badge (кеш 6 ч), лог и конфиг — из menu bar. Установка:
  `shemma menubar install` (сам предложит `brew install --cask swiftbar`,
  настроит plugin-папку через defaults, положит тонкий shim). Логика меню живёт
  в CLI и обновляется вместе с бинарём (`shemma update`); shim стабильный.
  Новый config-ключ `menubar.label` (подпись рядом с иконкой). `menubar render` —
  presentation-интерфейс для SwiftBar, формат не является stable machine API.
  Спека: `docs/superpowers/specs/2026-07-15-menubar-helper-design.md`.
```

- [ ] **Step 2: README**

В `README.md` добавить секцию (рядом с установкой/CLI; найди секцию про install и вставь после неё):

```markdown
## Menu bar helper (macOS)

Статус и управление shemma-демоном из menu bar (через [SwiftBar](https://github.com/swiftbar/SwiftBar)):

```bash
brew install --cask swiftbar   # если ещё нет
shemma menubar install         # shim в plugin-папку SwiftBar + автонастройка
```

Иконка показывает состояние демона (зелёная — работает, серая — остановлен,
красная — ошибка). Меню: start/stop/restart, «Остановить все инстансы», открытие
доски и spaces, doctor, лог, обновление shemma. Логика меню живёт в самом CLI —
обновляется вместе с `shemma update`, shim трогать не нужно.

`shemma menubar uninstall` — убрать; `shemma menubar status` — где стоит.
Подпись рядом с иконкой: `shemma config set menubar.label shemma`.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: menubar helper — CHANGELOG + README"
```

---

### Task 14: Финальная проверка

- [ ] **Step 1: Полный прогон из корня**

```bash
cd /Users/tretyakov_dv/Projects/sandbox/di.draw
bun run test    # все пакеты
bun run lint
```
Expected: тесты зелёные, lint чистый.

- [ ] **Step 2: Сверка со спекой**

Открыть `docs/superpowers/specs/2026-07-15-menubar-helper-design.md`, пройтись по секциям UX/Техника — каждая позиция либо реализована, либо явно в «Будущее».

- [ ] **Step 3: Live-проверка (координатор/юзер, НЕ subagent)**

```bash
# из checkout'а (dev-режим, бинарь не нужен):
cd packages/shemma-cli
bun src/index.ts menubar render | head -30        # валидное меню глазами
bun src/index.ts menubar install                   # реальная установка (SwiftBar уже стоит)
```
Затем в menu bar: иконка появилась; Запустить/Остановить работают; «Остановить все инстансы» гасит демона (`shemma ps` подтверждает); «Открыть доску» открывает браузер; Spaces открывает галерею; лог/конфиг открываются. ВНИМАНИЕ: shim резолвит установленный бинарь `shemma` — там команды `menubar` ещё нет до релиза; для live-теста задай `SHEMMA_BIN` на dev-обёртку или проверяй действия через `bun src/index.ts menubar do ...` (см. memory «source-mode daemon cleanup» перед откатом).

- [ ] **Step 4: Backlog + отметка**

```bash
backlog task edit DRW-NNN -s "Done" --plain
git add backlog/ && git commit -m "chore(backlog): DRW-NNN — Done"
```

Merge в main, тег и релиз — ПОСЛЕ приёмки юзером (memory: merge needs acceptance), стандартный `--no-ff` флоу.

---

## Self-review плана (выполнен)

- **Spec coverage:** иконка/состояния (T1, T9), меню всех трёх состояний (T9), dev-строка (T9), update-badge+кеш (T4, T8, T9), stop-all (T5, T10), доска/spaces (T10), doctor-фильтр (T3, T12), лог/конфиг (T10), `menubar.label` (T6), shim+fallback (T11), install/defaults/brew (T11), uninstall/status (T11), error-file (T7, T10), usage/README/CHANGELOG (T12, T13), тесты unit+subprocess (везде). «Будущее» из спеки не реализуется — ок.
- **Placeholders:** нет TBD; весь код приведён.
- **Type consistency:** `ProfileStatus` (ps), `CheckResult` (doctor), `StopAllResult` (daemon), `CachedBadge`/`UpdateBadge`, `MenubarData` — имена сверены между задачами.
