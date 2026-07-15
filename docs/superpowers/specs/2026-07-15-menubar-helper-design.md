# Menu-bar helper для shemma (SwiftBar) — дизайн

- **Дата:** 2026-07-15
- **Статус:** draft (ждёт ревью)
- **Milestone:** m-12 Platform
- **Образец:** `~/Projects/madstudio-helper` (SwiftBar-плагин поверх CLI)

## TL;DR

Менюбар-хелпер для управления shemma-демоном: статус-иконка, start/stop/restart,
«остановить все инстансы», открытие доски и spaces, doctor, лог, обновление.
Архитектура — **логика внутри CLI** (`shemma menubar …`), в plugin-папке SwiftBar
лежит только тонкий bash-shim. Установка одной командой `shemma menubar install`,
обновления приезжают вместе с `shemma update`.

## Цели

1. Управлять release-демоном (`:8787`) из menu bar без терминала.
2. Видеть состояние демона постоянно (цветная иконка).
3. Одним пунктом гасить все запущенные инстансы (все профили).
4. Установка одной командой; обновление хелпера — вместе с бинарём shemma.

## Не-цели (YAGNI)

- Комнаты в меню, badge pending-prompts.
- Тумблеры профиля (release/dev) и keep-alive против idle-shutdown.
- Локализация меню (сейчас русский; `menubar.lang` — при первом внешнем запросе).
- Linux/Windows.
- Нативное .app без SwiftBar (возможная будущая обёртка над той же логикой).
- Добор ad-hoc процессов по портам в stop-all (см. «Будущее»).

## Ключевые решения

| Решение | Выбор | Альтернативы (отклонены) |
|---|---|---|
| Архитектура | Логика в CLI + тонкий shim | bash-плагин (дрейф, свой канал обновлений); отдельный репо (второй бэклог); .app (нотариизация, CI) |
| Scope меню | Средний: супервизор + Spaces + doctor + update-badge | минимальный; максимальный (rooms/prompts/тумблеры) |
| Stop-all | Стандартный `daemon stop --all` (все профили по lock-PID) | двухступенчатый с lsof-добором — отложен |
| Язык меню | Русский | английский |
| Конфиг | Ключи `menubar.*` в существующем `~/.config/shemma/config.json` | отдельный конфиг-файл хелпера |

## UX

### Иконка (статус release-профиля)

| Цвет | Состояние |
|---|---|
| зелёная | демон работает, healthy |
| серая | остановлен (в т.ч. сам погас по idle-shutdown — норма) |
| красная | работает-но-unhealthy, порт занят чужим (doctor-чек `port-owner`), или последний старт упал |

Иконка заголовка — цветной PNG data-URI (SwiftBar `sfimage` в title монохромный);
генерация от SF-символа скриптом по образцу `gen-icons.swift` madstudio-helper.
Символ по умолчанию — `square.on.square` (два наложенных квадрата ≈ слои канваса);
допустимо заменить на этапе генерации, если визуально не сядет. Пункты меню —
те же сгенерированные template-PNG @2x pt 16 (`templateImage=`, как в
madstudio-helper): `sfimage=` SwiftBar рендерит заметно мельче (фидбек live-приёмки).

### Меню — состояние «работает»

```
● shemma
──────────────────────────────
Работает · :8787 · pid 61713 · v0.32.1
dev · :8788 · работает                    ← только если dev-демон жив (read-only)
⬆ Доступно обновление 0.33.0              ← только если есть; клик = shemma update
──────────────────────────────
Остановить
Перезапустить
Остановить всё                            ← daemon stop --all (release+dev+debug)
──────────────────────────────
Открыть доску                             ← браузер на :8787
Spaces ▸
    di.draw                               ← клик = открыть галерею space
    ios
    …все зарегистрированные (s list)
──────────────────────────────
Doctor: ✔ ok | ⚠ 2 warn ▸                 ← при ok — плоская строка без сабменю;
                                            при warn/error — сабменю с этими чеками
Открыть лог демона
──────────────────────────────
Изменить конфиг…                          ← config.json в редакторе
Helper v0.32.1                            ← версия = версия shemma
```

### Меню — «остановлен» и «ошибка»

- **Остановлен:** вместо блока управления — «Запустить» (`daemon ensure`).
  «Открыть доску» и «Spaces» неактивны (серые, без действия и сабменю) — пока
  демон не запущен, открывать нечего (фидбек live-приёмки: раньше открывали
  пустую страницу). Doctor/лог/конфиг — на месте.
- **Ошибка:** красная строка с текстом последней ошибки (упавший старт /
  «порт занят чужим: …»), пункт «Запустить», остальное как в «остановлен».

### Обновления

`update --check` — сетевой: кеш с TTL 6 ч; протух — проверка прямо в рендере
с таймаутом ~2 с (раз в 6 часов незаметно). Строка видна только при наличии
новой версии; клик — `shemma update` с `terminal=true` (виден прогресс).

## Техника

### Структура кода — `packages/shemma-cli/src/menubar/`

| Файл | Ответственность |
|---|---|
| `index.ts` | диспетчер сабкоманды `shemma menubar <sub>` |
| `render.ts` | **чистая** функция: данные статуса → строки SwiftBar-меню |
| `actions.ts` | действия — тонкие обёртки над существующими daemon/spaces/update функциями |
| `install.ts` | install/uninstall/status shim'а — вся macOS-специфика здесь |
| `icons.ts` | PNG data-URI константы (сгенерированы разово) |
| `shim.sh` | шаблон shim'а, вшивается в бинарь text-импортом (паттерн embedded UI) |

`render` получает данные внутренними вызовами (те же функции, что `ps`,
`s list`, `doctor`) — без субпроцессов и парсинга собственного JSON.

### CLI-поверхность

```
shemma menubar render                    # напечатать меню (формат SwiftBar)
shemma menubar do <action> [arg]         # start|stop|restart|stop-all|open-board|
                                         # open-space <id>|open-log|edit-config|update
shemma menubar install [--interval 5s] [--plugin-dir <path>] [--yes]
shemma menubar uninstall | status
```

В help — секция «Menu bar (macOS)». Команда документируется как
**presentation-интерфейс** для SwiftBar (не machine API): формат вывода
`render` не покрывается гарантиями стабильности CLI.

### Shim

`shemma.5s.sh` (~15 строк, имя кодирует интервал рефреша): метаданные SwiftBar
в комментариях → резолв бинаря (`$SHEMMA_BIN` override → `command -v shemma` →
`~/.local/bin` → `/opt/homebrew/bin` → `/usr/local/bin`) →
`exec "$BIN" menubar "${1:-render}" "${@:2}"`.
Бинарь не найден — shim печатает fallback-меню «shemma не найден».
Действия меню диспатчатся через shim: `bash="$SELF" param1=do param2=stop`.
Это единственный bash в фиче.

### Install

1. Не darwin → честный отказ (exit 1).
2. SwiftBar отсутствует → предложить `brew install --cask swiftbar`
   (интерактивное подтверждение; `--yes` для скриптов).
3. `defaults read com.ameba.SwiftBar PluginDirectory`: пусто →
   `defaults write … ~/.config/swiftbar-plugins` + `mkdir -p`; непусто —
   уважаем существующее значение.
4. Записать shim идемпотентно; `shemma.*.sh` с другим интервалом — удалить.
5. `open -a SwiftBar` + `open "swiftbar://refreshallplugins"`.

`uninstall` — удалить shim + refresh. `status` — установлен ли, куда, интервал.

### Stop-all

Пункт «Остановить все инстансы» = внутренний `stopAll()` из `daemon.ts`
(все профили по lock-PID; обычно закрывает и dev, и debug). Итог — в notify.

### Ошибки

- `render` никогда не падает: try/catch → валидное error-меню с текстом исключения.
- Упавший старт пишет `~/.claude/.shemma-menubar-error` (конвенция state-файлов
  CLI: `~/.claude/.shemma-*`); render показывает красную строку; файл чистится
  при успешном start/stop (паттерн ERRORFILE madstudio-helper).
- Ошибки действий — громко через notify (osascript), никаких тихих падений.

### Тесты

- **Unit (bun:test):** `render` на фикстурах (ps/spaces/doctor/update → строки
  меню), форматирование статусных строк.
- **Integration (subprocess, как существующие CLI-тесты):** `install`/`uninstall`
  с `--plugin-dir <tmpdir>`; побочки (defaults/open/brew) подавляются в
  тест-режиме; XDG-изоляция (`XDG_CONFIG_HOME=tmpdir`).
- Инвариант CLI: обновить integration-тест help + `CHANGELOG.md`.

## Конфиг

Ключи в `~/.config/shemma/config.json` (через `shemma config set/get`):

- `menubar.label` — подпись рядом с иконкой (default: пусто, только иконка).

Интервал рефреша — имя файла shim'а, задаётся `install --interval` (default 5s).

## Будущее (вне scope, фиксируем идеи)

- **Добор ad-hoc инстансов:** процессы без lock (source-демон из SessionStart-хука,
  tool-sandbox) `stop --all` не видит. Если грабли повторятся — отдельный пункт
  меню «Добить процессы на портах» (lsof :8787/:8788 + распознавание cmdline,
  чужие не трогать). Doctor такие процессы уже подсвечивает.
- `menubar.lang` (en) при первом внешнем запросе.
- Нативное .app как обёртка над `shemma menubar` (уйдёт зависимость SwiftBar).

## Процесс

Ветка `feature/menubar-helper`; Backlog-задача в m-12 Platform при переходе
к execution; MINOR-релиз по завершении фазы. README shemma получает секцию
«Menu bar helper (macOS)»: `brew install --cask swiftbar && shemma menubar install`.
