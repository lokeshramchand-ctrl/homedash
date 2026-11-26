# Web and mobile experience

## Principles in use
- One status vocabulary where services are shown: Healthy, Degraded, Down, Stale, Unknown, Not monitored (and Maintenance). Missing data is never drawn as healthy.
- Plain words for problems, with what to do ("The issuer is X, not Y. Sign-in checks this and will refuse the provider.").
- Destructive actions ask again in place (a second button), and administrators-only controls are not shown to others.
- Light and dark themes follow the system or a choice; modals trap focus and return it.

## Web
Full administration. New: **Service registry** (list with health and criticality, filter "needs attention" and "not monitored", add and edit with dependency checkboxes, Impact dialog) and **Identity (OIDC)** (homedash's sign-in settings, findings sorted by severity, endpoints, signing keys, what the provider supports, inspect any provider). Both are in the menu and the smoke test.

## Mobile
Built around "is anything wrong and what is it": Overview, Guests, Node, Uptime, More. New: **Services** under More, read-only, sorted with the worst first, with a section for services at risk because something they need is down. Editing stays on the web. Not verified on a device (type check only).

## Known gaps
No push receiver in the app (ntfy is used). No security or network screens on mobile. Overview is not configurable. The registry has a list and an impact view but no drawn graph.
