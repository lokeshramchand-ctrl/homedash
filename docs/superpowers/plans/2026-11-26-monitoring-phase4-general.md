# Phase 4 (revised): connect almost any software

Spec: `docs/superpowers/specs/2026-11-26-monitoring-module-design.md`. This phase replaces the spec's "more providers one by one" with something general: an administrator can connect **any software that has an HTTP endpoint, a metrics page, a port, a certificate or a way to send a webhook**, from the browser, and well-known tools are **templates** (saved configuration), not new code.

## Why this shape

A fixed list of providers can never cover "most of the software in the world". What nearly all of it has in common is a small set of things homedash can describe in data: an HTTP request, an answer in JSON or Prometheus text, a way to turn the answer into "up/down" or "alert", a port, a certificate. So:

1. **Custom HTTP source** (`http`): method, address, authentication (none, bearer, basic, custom header, query parameter), extra headers, request body, optional self-signed certificate acceptance, and one of four readings of the answer:
   - **JSON list as checks**: where the list is, which fields hold the name and the status, and what the status words mean (already built for `jsonpoll`).
   - **JSON list as alerts**: each item is a problem; fields for name, severity (with a map), message and start time; an optional "only when status is one of" filter.
   - **Prometheus text** (`/metrics` pages: Netdata, node_exporter, Kuma, most self-hosted tools): pick a metric, optional label filter, the label that names the check, and conditions such as `== 1` for up or `> 90` for warning.
   - **Reachability**: up when the status code is acceptable and, optionally, the text contains a word. Works for any website or API with no knowledge of it.
2. **Service checks** (`probe`): a list of `name | type | address` lines with type `http`, `tcp` or `tls` (certificate expiry). homedash does the probing itself, so anything with an address can be watched without the tool's own API.
3. **Webhook with a custom mapping**: the receiver already understands Alertmanager, Grafana and a plain shape; an administrator can now also map **any** JSON payload to name, status and message, so a tool homedash has never heard of can push to it.
4. **Templates**: a template is a saved configuration of the above plus a short form (usually just the address and a token). Adding a tool means adding data, not code. Templates ship only for tools whose request and answer formats were verified from their own documentation (`docs/research/monitoring-templates-formats.md`); anything unverified stays available through the custom source, with the template marked as such in the guide.
5. **Self-signed HTTPS** is accepted per source on request (a long-standing gap): `insecure_tls`.

## Safety rules for a configurable request

- The address passes the shared destination guard (link-local and metadata addresses are refused; LAN addresses are the point and allowed).
- No redirects; time limit; 2 MB answer limit; at most 50 service-check targets; body at most 4 KB.
- Header names are restricted to `[A-Za-z0-9-]`, values may not contain line breaks, and hop-by-hop or framing headers (`Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade`) are refused.
- The only placeholder is `{{secret}}`, replaced in the address, headers and body by the sealed secret. Nothing else is templated or evaluated; there is no scripting.
- Secrets stay sealed, are never returned, logged or put in audit lines; error messages never contain the request headers or body.
- Probes (`probe`) connect only to the addresses an administrator listed, with short timeouts, and never follow what a server says.

## Tasks

1. **Generic engine (tests first):** `conditions.ts` (parse `< 90`, `== 1`), `prometheus-text.ts` (exposition format parser), `request.ts` (build and validate a request), JSON-alerts mapper, status reading, `providers/generic.ts` (kind `http`), `insecure_tls` through the shared fetch helper.
2. **Service checks:** `providers/probe.ts` with pure target parsing, HTTP, TCP and TLS probes; tests against local servers, including an expired and a self-signed certificate.
3. **Webhook mapping:** custom field mapping in `hook.ts`.
4. **Catalog and admin:** new field types (`bool`, `select`, `textarea`) with conditional display, kinds `http` and `probe`, validation, test messages, templates in the catalog.
5. **Templates** from the verified research, each with a test that its saved configuration produces the expected checks or alerts from an adapted official example.
6. **UI:** the form renders the new field types; a template picker above the kind list; "Custom" for the rest.
7. **Docs and verification:** `docs/MONITORING.md` gets a "Connect anything" chapter with worked examples; full suite three times; a browser run connecting a custom JSON tool, a `/metrics` page, a service check and a self-signed HTTPS server through the forms; first-user audit rerun on the new flow.

## Out of scope

Scripting or transforms beyond the mappings above; OAuth flows; client certificates; SNMP, SSH and other non-HTTP protocols (a later source kind); the same generalisation for Logs.
