import { describe, expect, test } from "bun:test";
import type { CheckResult } from "../src/doctor";
import { ICON_ERROR, ICON_RUNNING, ICON_STOPPED } from "../src/menubar/icons";
import {
  type MenubarData,
  menubarState,
  renderErrorMenu,
  renderMenu,
} from "../src/menubar/render";
import type { ProfileStatus } from "../src/ps";

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
    const l = lines.find((x) => x.startsWith("Остановить всё"));
    expect(l).toContain("param1=do param2=stop-all");
  });
  test("иконки пунктов — templateImage, не sfimage", () => {
    expect(menu).toContain("templateImage=");
    expect(menu).not.toContain("sfimage=");
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
  const menu = renderMenu(
    base({ release: RELEASE_OFF, spaces: [{ id: "di-draw" }] }),
  );
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
  test("Открыть доску и Spaces неактивны: серые, без action и сабменю", () => {
    const board = lines.find((l) => l.startsWith("Открыть доску"));
    expect(board).toContain("color=gray");
    expect(board).not.toContain("bash=");
    const spaces = lines.find((l) => l.startsWith("Spaces"));
    expect(spaces).toContain("color=gray");
    expect(spaces).not.toContain("bash=");
    expect(lines.some((l) => l.startsWith("-- di-draw"))).toBe(false);
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
