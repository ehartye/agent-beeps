# Shareable previews

`audition open`, `audition formats` and `album open` now return a `share` object.
Copy **`share.url`** into chat or a text message. It opens the actual Beeps UI.
It prefers an existing Tailscale IPv4 adapter when the existing server bind can
serve it; `share.localUrl` works on the serving machine. `share.tailscaleUrl` is
null when no compatible adapter/bind is found. Reachability from a phone is not
proven merely by producing an address: tailnet ACLs, the host firewall, and the
server's lifetime still apply.

Legacy top-level `url` / `ipUrl` / `ipUrls` and the queue URL remain owner controls
for compatibility. They contain the broad server token: do not paste them into
chat as preview links. The `share` object contains no owner token or project path.

The default link is read-only and lasts one hour. It does not record plays or
feedback. To renew it or deliberately enable ratings and notes:

```text
beeps preview create --kind session --id <session-id>
beeps preview create --kind album --id <album-id> --feedback --seconds 7200
beeps preview create --kind delivery --id <delivery-id> --feedback
beeps preview revoke --id <share-id>
```

Use the returned share `id` for revocation, not the audition/album ID. The CLI
uses the selected project's exact root, so two projects with the same ID remain
isolated. `preview create` requires an already running current server and a
registered project; it never starts, replaces, or rebinds a server. When updating
a running older server, arrange its restart with its owner after active work ends.

Feedback links permit only session plays/lineup/duels, album plays/marks/tags/notes/
moments, or delivery device reports/ratings/notes. They never permit shipping,
refinement, abandonment, format reveal, project enumeration or link management.
The full delivery `/results` export stays owner-only because it contains project
and device diagnostics; previews can still show the comparison key after the owner
reveals it.
The owner handles those steps through their existing local controls. Session
preview content includes its configured kit/bed context; links follow updates to
that one resource until they expire. Do not interpret a shared preview as a frozen
export or a new session-specific taste identity.

## Lifetime and transport

Each link contains a random 256-bit capability in its URL fragment. The page
removes it from the current history entry, exchanges it in a POST body for an
HttpOnly, SameSite=Strict cookie scoped to that resource's API path, and sends no
preview credential in media URLs. Responses use no-store and no-referrer.
Each link has a distinct cookie name. A public `?preview=<share-id>` selector
stays in the page and media URLs to select that exact grant across reloads and
tabs, including duplicate resource IDs in different projects or links with different
feedback permissions. The selector alone grants no access; the matching cookie
is required. Keep it when copying a link.
Cookie access is rechecked for each request; expiration and revocation therefore
apply to already opened pages as well as unopened links. Permission is checked
again after reading mutation bodies. Feedback permission survives page reloads.

The server keeps only capability hashes in memory. Links last 60 seconds to 24
hours; the default is one hour, with a maximum of 256 live links per server.
Revocation and server exit invalidate them. Restart does not restore them, even
when the legacy owner token is reused. Revocation cannot erase audio already
downloaded or decoded by a browser. A recipient can forward an unexpired link;
this is bounded bearer access, not identity authentication.

No firewall, Tailscale ACL, Serve/Funnel, DNS, certificate, or listener settings
are changed. Direct HTTP over a Tailscale address relies on Tailscale's encrypted
transport; it is not an HTTPS deployment and the cookie does not claim Secure.
Only a named Tailscale adapter with a CGNAT address is advertised, avoiding a guess
based on a CGNAT address alone. Unrecognized adapter names yield local-only output.
Proxy deployments and custom IPv6 tailnet addresses need separate integration;
forwarded headers are not trusted automatically.

Tailscale distinguishes [tailnet-only Serve](https://tailscale.com/docs/features/tailscale-serve)
from [public Funnel](https://tailscale.com/docs/features/tailscale-funnel).
Neither is enabled by Beeps. The [CGNAT range is shared with other network uses](https://tailscale.com/docs/concepts/tailscale-ip-addresses).

## Pattern for other preview plugins

Reuse this contract without a shared global credential or central daemon:

1. The owning host/project creates a grant for one explicit resource, with default
   read-only access, bounded expiry and an independent revocation ID.
2. Return `url`, `localUrl`, `tailscaleUrl`, `expiresAt` and `access`. Advertise only
   existing supported interfaces. A missing remote URL is a connectivity limit,
   not permission to change network configuration or access another host.
3. Keep the native preview UI. Exchange a fragment capability into resource-scoped
   browser access; do not put a management token in chat, asset URLs or referrers.
4. Enforce target/project and per-action permission on the server, including media,
   byte ranges and mutations. UI controls explain permission; they do not enforce it.
5. Test duplicate IDs in different projects, cross-resource access, management
   denial, expiry/revocation/restart, CSRF, URL leakage, playback and legacy behavior.

This change implements the contract in Beeps only. Other plugins should adopt it
at their own preview boundary and release independently.
