# Moseek Script Runtime

This is the first Phase 3 runtime slice. It is a standalone JSON-lines process,
not a remote script loader and not a CatVod/JAR executor.

Input:

```json
{
  "script": "function main(input) { return {title: input.title.toUpperCase()}; }",
  "entry": "main",
  "input": { "title": "demo" }
}
```

Output:

```json
{ "ok": true, "value": { "title": "DEMO" } }
```

The runtime has no filesystem, shell, DOM, `fetch`, or host network bindings.
It enforces script/input/output size limits, QuickJS memory and stack limits,
and an interrupt deadline. Remote JS, JAR and Spider configuration remain
blocked until a later integration adds explicit trust and host APIs.

## Explicit HTTP host call

The host may include an explicit `httpHosts` allowlist in the request. Only
then does the runtime expose `http_get`; the function returns a JSON string and
the host still applies its public-HTTP, redirect, response-size, and SSRF
policy:

```json
{
  "script": "function main(input) { return JSON.parse(http_get(input.url)).body; }",
  "entry": "main",
  "input": { "url": "https://example.com/data.json" },
  "httpHosts": ["example.com"]
}
```

An empty or missing `httpHosts` list leaves network access unavailable.
