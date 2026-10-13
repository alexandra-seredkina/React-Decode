<p align="center">
  <img src="docs/banner.jpeg" alt="react-decode" width="100%">
</p>

<h1 align="center">react-decode</h1>

<p align="center">
  <b>Превращает минифицированные React-сборки в читаемый код и достаёт из них API.</b><br>
  Vite · webpack · CRA · Next &nbsp;|&nbsp; статический анализ, ничего не запускается
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.de.md">Deutsch</a> · <b>Русский</b>
</p>

<p align="center">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-E8334A?style=flat-square&labelColor=0B0C0F">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-E8334A?style=flat-square&labelColor=0B0C0F">
</p>

<p align="center">
  <img src="docs/decode-flow.svg" alt="Минифицированный код превращается в читаемый код и карту API" width="100%">
</p>

## Что делает

Продакшен-бандл — это одна строка на 300 КБ. `react-decode` делает его читаемым и отвечает на практические
вопросы: **какие запросы уходят на сервер, с какими полями, что читается из ответов, какие есть роуты и ключи.**

| | |
|---|---|
| **Читаемый код** | Де-минификация и форматирование, короткие имена заменяются осмысленными |
| **HTTP API** | `fetch`, axios, `$.ajax`, XHR, WebSocket, SSE: метод, путь, query, тело, заголовки, читаемые поля ответа |
| **Остальное** | Роуты, env-переменные, ключи storage, GraphQL, секреты, библиотеки, UI-тексты |
| **Вход** | URL, `.js`, `.html`, `.map` или папка. Сам идёт по чанкам и source map |

## Быстрый старт

```bash
git clone https://github.com/alexandra-seredkina/React-Decode.git
cd React-Decode && npm install

node bin/react-decode.js https://example.com/           # страница
node bin/react-decode.js ./dist/assets/index-abc123.js  # один бандл
node bin/react-decode.js ./build                        # папка со сборкой
```

```
decoded-example.com/
├── report.md      эндпоинты, роуты, env, секреты, библиотеки …
├── decoded/       читаемый код каждого бандла
└── src/           исходники, если нашлась source map
```

## Пример

**Было**

```js
const api={listUsers:(e,t)=>a.get("/users",{params:{page:e,per_page:t}}),
createUser:e=>a.post("/users",{name:e.name,email:e.email,admin:!1})};
async function load(){const{data:e}=await api.getUser(7);return e.profile.avatar_url}
```

**Стало**

```js
const api = {
  listUsers: (page, per_page) => a.get('/users', { params: { page, per_page } }),
  createUser: (e) => a.post('/users', { name: e.name, email: e.email, admin: false }),
};
async function load() {
  const { data } = await api.getUser(7);
  return data.profile.avatar_url;
}
```

**`report.md`**

| Метод | Путь | Query | Тело | Читаемые поля ответа |
|---|---|---|---|---|
| GET | `/users` | `page`, `per_page` | — | `data.items` |
| POST | `/users` | — | `name`, `email`, `admin`:boolean | — |
| GET | `/users/{userId}` | — | — | `data.profile.avatar_url` |

> Большинство приложений не вызывают `fetch` напрямую: есть функция `request(method, path, body)` и объект
> `api` вокруг неё. `react-decode` находит такие обёртки любой вложенности и разворачивает каждый вызов в
> конкретный URL.

## Опции

| Флаг | Описание |
|---|---|
| `-o, --out <dir>` | папка результата (по умолчанию `./decoded-<имя>`) |
| `-H, --header "K: V"` | заголовок для запросов к удалённому входу (можно несколько) |
| `--no-chunks` | не подтягивать динамические чанки |
| `--max-files <n>` | лимит загружаемых файлов (150) |
| `--no-rename` | оставить минифицированные имена |
| `--no-prettier` | без prettier |
| `--json` | полный анализ в stdout (секреты без маски) |
| `-q, --quiet` | без прогресса |

```bash
node bin/react-decode.js https://staging.example.com/ -H "Cookie: session=…" -o out
node bin/react-decode.js ./dist -q --json | jq -r '.endpoints[] | "\(.method) \(.path)"'
```

## Ограничения

- Анализ статический: значения из переменных остаются `{param}`, типы оценочные.
- Сборка query через `new URL().searchParams` и `qs.stringify` не находится.
- Control-flow flattening и string-array обфускация не разворачиваются.

## Этичное использование

Инструмент читает то, что сайт и так отдаёт любому браузеру. Анализируйте свои приложения и те, на изучение
которых у вас есть разрешение, и соблюдайте правила сервиса.

## Лицензия

MIT — см. [LICENSE](LICENSE). Тесты: `npm test`.
