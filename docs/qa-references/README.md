# QA reference diagrams

Эталонные диаграммы для проверки качества shemma — что AI должен уметь рисовать через MCP, чтобы получалась «адекватная и красивая картинка».

Каждый референс — пара: PNG (от пользователя) + spec.md с разбором features, который сторона shemma должна закрыть.

## References

### `01-madsight-ci.md`
Первый референс — CI-тест-инфраструктура: 7 нод (включая database/external), 10 связей с разными kinds + WS-пунктир.
Features tested: define + connect + roles + kinds + bidir + dashed stream.

### `02-inline-ad-loader.md`
Второй референс — iOS-архитектурная схема InlineAdLoader: containers (`integration`, `UIView`), color-coded boxes (delegate=purple/protocol=blue/internal=gray), multi-line code в ноде, цветные edges с labels.
Features tested: groups with visible labels + visual styling beyond role + multi-line richText + edge coloring.

## Acceptance criterion

После каждого fix-цикла (DRW-XXX merged) — попытаться нарисовать каждый референс через shemma MCP в чистой комнате, сравнить скриншот с эталоном, обновить `last-attempt.png` рядом со spec'ом.
