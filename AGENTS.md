# Работа с проектом

## Команды

- Окружение: `mise trust`, `mise install`, `mise run setup`.
- Разработка: `mise run dev`; управление серверами: `mise run dev:status`, `mise run dev:logs`, `mise run dev:stop`.
- Генерация OpenAPI и SDK: `mise run generate`.
- Сборка: `mise run build`.
- Все проверки: `mise run check`; форматирование: `mise run fix`.
- Проверка уязвимостей (нужна сеть): `mise run security:audit`.

## Устройство

- `apps/api` — бекенд Fastify; `apps/web` — фронтенд React/Vite/Mantine.
- `packages/api-client` — SDK, используемый фронтендом и HTTP-тестом.
- `contracts/main.tsp` — источник API-контракта.

## Правила

- Изменения API начинай с TypeSpec; генерируй OpenAPI и SDK и коммить результаты вместе с контрактом.
- Компиляция приложения использует TS 7. Корневой `typescript` — совместимый API TS 6 для Hey API и dependency-cruiser; корневой `tsc` предоставляет алиас `@typescript/native`.
- После изменений кода выполни `mise run check`; если проверка недоступна, укажи причину в результате работы.

## Коммиты

- Conventional Commits: `feat: …`, `fix: …`, `chore: …`, `docs: …`; описание на русском. В теле кратко перечисли изменения.
- Создавай коммиты с `git commit --no-gpg-sign …`.

## Agent skills

### Issue tracker

Issues живут в GitHub Issues этого репозитория (через `gh` CLI). Подробности: `docs/agents/issue-tracker.md`.

### Triage labels

Дефолтный словарь из пяти канонических ролей (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Подробности: `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` в корне репозитория. Подробности: `docs/agents/domain.md`.
