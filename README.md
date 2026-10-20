<p align="center">
  <img src="docs/banner.jpeg" alt="react-decode" width="100%">
</p>

<h1 align="center">react-decode</h1>

<p align="center">
  <b>Turn minified React bundles into readable code — and pull the API out of them.</b><br>
  Vite · webpack · CRA · Next &nbsp;|&nbsp; static analysis, nothing is executed
</p>

<p align="center">
  <b>English</b> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://awesomerea.org/resources/react-decode/"><img src="https://raw.githubusercontent.com/reacher-z/Awesome-REA/477658fa73f6860e86cd1fc526657c2efdc25194/assets/featured-by-awesome-rea-inline.svg" alt="Featured by Awesome REA"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-E8334A?style=flat-square&labelColor=0B0C0F">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-E8334A?style=flat-square&labelColor=0B0C0F">
</p>

<p align="center">
  <img src="docs/decode-flow.svg" alt="minified code becomes readable code and an API map" width="100%">
</p>

## What it does

A production bundle is a single 300 KB line. `react-decode` makes it readable and answers the practical
questions: **which requests does the app send, with which fields, what does it read from the responses,
which routes and keys exist?**

| | |
|---|---|
| **Readable code** | De-minified and prettified, short names replaced with meaningful ones |
| **HTTP API** | `fetch`, axios, `$.ajax`, XHR, WebSocket, SSE: method, path, query, body, headers, used response fields |
| **Extras** | Routes, env vars, storage keys, GraphQL, secrets, libraries, UI texts |
| **Input** | URL, `.js`, `.html`, `.map` or a folder. Follows chunks and source maps on its own |

## Quick start

```bash
git clone https://github.com/alexandra-seredkina/React-Decode.git
cd React-Decode && npm install

node bin/react-decode.js https://example.com/           # a page
node bin/react-decode.js ./dist/assets/index-abc123.js  # one bundle
node bin/react-decode.js ./build                        # a build folder
```

```
decoded-example.com/
├── report.md      endpoints, routes, env, secrets, libraries …
├── decoded/       readable code of every bundle
└── src/           original sources, if a source map was found
```

<p align="center">
  <img src="docs/cli.jpg" alt="Running it" width="80%">
</p>

## Example

**Before**

```js
const api={listUsers:(e,t)=>a.get("/users",{params:{page:e,per_page:t}}),
createUser:e=>a.post("/users",{name:e.name,email:e.email,admin:!1})};
async function load(){const{data:e}=await api.getUser(7);return e.profile.avatar_url}
```

**After**

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

| Method | Path | Query | Body | Response fields used |
|---|---|---|---|---|
| GET | `/users` | `page`, `per_page` | — | `data.items` |
| POST | `/users` | — | `name`, `email`, `admin`:boolean | — |
| GET | `/users/{userId}` | — | — | `data.profile.avatar_url` |

> Most apps never call `fetch` directly. They have a `request(method, path, body)` helper and an `api`
> object around it. `react-decode` finds such wrappers at any depth and resolves every call to a concrete URL.

<p align="center">
  <img src="docs/output.jpg" alt="What you get: <code>report.md</code>" width="100%">
</p>

## Options

| Flag | Description |
|---|---|
| `-o, --out <dir>` | output folder (default `./decoded-<name>`) |
| `-H, --header "K: V"` | extra request header for remote input (repeatable) |
| `--no-chunks` | do not follow dynamic chunks |
| `--max-files <n>` | limit of downloaded files (default 150) |
| `--no-rename` | keep minified names |
| `--no-prettier` | skip prettier |
| `--json` | print the full analysis to stdout (secrets unmasked) |
| `-q, --quiet` | no progress output |

```bash
node bin/react-decode.js https://staging.example.com/ -H "Cookie: session=…" -o out
node bin/react-decode.js ./dist -q --json | jq -r '.endpoints[] | "\(.method) \(.path)"'
```

## Limits

- Static analysis: values coming from variables stay as `{param}`, types are estimated.
- Query building via `new URL().searchParams` or `qs.stringify` is not detected.
- Control-flow flattening and string-array obfuscation are not reversed.

## Responsible use

The tool reads what a site already sends to every browser. Analyse your own apps or ones you have
permission to study, and respect the service's rules.

## License

MIT — see [LICENSE](LICENSE). Tests: `npm test`.
