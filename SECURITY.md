# Security policy

## Supported versions

The latest tagged release and the latest commit on `main` are supported.

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on
[github.com/1977744311/inklab](https://github.com/1977744311/inklab/security/advisories/new).
Do not open a public issue for a vulnerability.

Include the commit you tested (`git rev-parse --short HEAD`), your OS and Node.js version, and the
smallest steps that reproduce the problem. You can expect an acknowledgement within 5 working days
and a status update at least every 14 days until the report is resolved. Fixes land on `main` and
are credited in the changelog unless you ask otherwise.

## Scope and threat model

InkLab is a local development tool. Its server is meant to be reachable only from the machine it
runs on, and it has no authentication of its own: any process on that machine can talk to it, so
run it only on machines you trust.

What it does to keep web pages out:

- `npm start` binds to `127.0.0.1`, and every route rejects a request whose `Host` header is not
  a loopback name (a DNS-rebinding defence).
- Cross-site subresource requests (`Sec-Fetch-Site: cross-site`) are rejected. Top-level
  navigation is allowed, and the LLM route has its own check below.
- The LLM forwarding route answers CORS only for the workbench page's own origin (`127.0.0.1` or
  `localhost` on the same port). It neither holds nor injects keys: the `Authorization` header is
  the one the engine in the page sends.
- The LLM key, from `INKLAB_LLM_API_KEY`, `INKLAB_LLM_API_KEY_FILE` or the git-ignored
  `llm.local.json`, is handed to the workbench page through `/api/manifest`, because the engine in
  the page makes the model request. That endpoint sends no CORS headers and sits behind the `Host`
  check above.
- Cassettes store only the normalized request, never headers. Capability ledgers in evidence
  files redact credential-like fields (`authorization`, API keys, tokens, cookies, secrets,
  passwords).
- External network requests made by the app under test are blocked by default.
- With `--device`, control requests also require a same-origin page and the session token of the
  running server.

In scope: anything that lets a web page, or a scenario, read local files, keys or reports through
InkLab, or run code outside the sandbox the engine provides.

Out of scope: vulnerabilities in the Ink engine itself (report those to Rokid), and issues that
need an attacker who already controls the local account.
