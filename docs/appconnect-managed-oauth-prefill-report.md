# Bug Report: Managed OAuth setup form ignores manifest OAuth defaults (only Redirect URI prefills)

**Repo:** `ringcentral/rc-unified-crm-extension-client`
**Branch verified:** `beta`
**Component:** Admin-managed OAuth setup page

## Summary

When a connector uses admin-managed OAuth (`auth.oauth.adminManaged.enabled = true`), the
admin setup form prefills **only** the Redirect URI. The manifest's
`auth.oauth.authorizationUri`, `auth.oauth.accessTokenUri`, and `auth.oauth.scope`
values are never used to populate the form, even though they are present in the
published connector manifest. As a result every admin must manually paste the
Authorization URI, Access Token URI, and Scopes that the connector author already
specified in the manifest.

These fields are also marked `required`, so the admin cannot submit without them —
making the missing prefill a hard blocker, not a cosmetic one.

## Root cause

`src/components/managedOAuthSetupPage.js` →
`getManagedOAuthSetupPageRender({ platform, pendingValues })`

The returned `formData` hardcodes only the redirect URI:

```js
formData: {
    redirectUri: DEFAULT_REDIRECT_URI,
    ...pendingValues
}
```

`platform.auth.oauth.authorizationUri`, `platform.auth.oauth.accessTokenUri`, and
`platform.auth.oauth.scope` are available on the `platform` argument (they are read
elsewhere, e.g. `core/auth.js` `buildOAuthUrl`) but are not referenced here.

## Proposed fix

Populate `formData` defaults from the manifest's `auth.oauth` block, while still
letting any saved `pendingValues` win:

```js
const oauth = platform?.auth?.oauth ?? {};
return {
    // ...unchanged schema/uiSchema...
    formData: {
        redirectUri: oauth.redirectUri || DEFAULT_REDIRECT_URI,
        authorizationUri: oauth.authorizationUri,
        accessTokenUri: oauth.accessTokenUri,
        scopes: oauth.scope,            // manifest key is `scope`; form field is `scopes`
        ...pendingValues
    }
};
```

Note the key name mismatch: the manifest uses `auth.oauth.scope` (singular) while the
form field is `scopes` (plural). The mapping above accounts for that.

With this change, an admin-managed connector that ships `authorizationUri`,
`accessTokenUri`, and `scope` in its manifest would require the admin to enter only
**Client ID**, **Client Secret**, and **Hostname** — the three genuinely
per-deployment values.

## Reproduction

1. Publish a connector manifest with `auth.type: "oauth"`,
   `auth.oauth.adminManaged.enabled: true`, and non-empty
   `auth.oauth.authorizationUri` / `auth.oauth.accessTokenUri` / `auth.oauth.scope`.
2. As an admin, open the connector and trigger the managed-OAuth setup form.
3. Observe: only Redirect URI is prefilled; Authorization URI, Access Token URI and
   Scopes are blank despite being defined in the manifest.

## Affected files

- `src/components/managedOAuthSetupPage.js` (form render / `formData`)

## Interim workaround (no extension change)

The manifest's `auth.oauth.adminManaged.setupNotes` IS rendered on the form. We have
placed the exact Authorization URI, Access Token URI, and Scopes values in
`setupNotes` so the admin can copy them during the one-time setup. After the first
successful connect the values persist in account data and the form no longer appears.

---

# Secondary request: managed auth custom fields are not shown for OAuth connectors

`src/components/admin/adminPage.js` gates the "Managed authentication" admin section on
`platform.auth?.type === 'apiKey'`:

```js
const hasManagedAuthFields = platform.auth?.type === 'apiKey'
    && (platform.auth?.apiKey?.page?.content ?? []).some(field => field?.managed);
```

This means an OAuth (managed) connector cannot collect any admin-managed custom fields
(e.g. a board ID, an instance path) — only the seven hardcoded OAuth credential fields
are available. Request: allow `auth.apiKey.page.content` managed fields to render for
OAuth connectors too (the SDK already reads them via `getManagedAuthAdminSettings`),
or provide another supported surface for per-account custom config on OAuth connectors.

---

# Tertiary request: allow `{boardId}` / arbitrary contact fields in URL templates

`contactPageUrl` / `logPageUrl` / `callPopUrl` substitute only `{hostname}`,
`{contactId}`, `{contactType}` (and `{logId}` for logs) — see
`src/core/contact.js` and `src/core/log.js`. Connectors whose record URLs need a second
identifier (Monday needs the board id: `/boards/{boardId}/pulses/{itemId}`) currently
have to smuggle it through `{contactType}`. Request: substitute additional fields from
the matched contact object (e.g. a generic `{contactType}`-style passthrough already
works, but a documented `{boardId}` / `{additionalId}` would be cleaner) in all three
URL templates and the log page.

---

# Note: `edit_update` reliability (Monday-specific, no extension change needed)

For our own connector: Monday's API returns `INTERNAL_SERVER_ERROR` when `updates(ids:)`
or `edit_update` is given a non-numeric update id. Our `updateCallLog` now validates the
stored id, falls back to creating a fresh update on the contact item, and repoints the
stored `thirdPartyLogId`. Documented here only for traceability.
