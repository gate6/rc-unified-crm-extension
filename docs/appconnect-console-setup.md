# AppConnect Developer Console Setup Guide

## Prerequisites

- Server deployed and reachable at `https://rc-crmapi.test.gate6.com`
- `GET https://rc-crmapi.test.gate6.com/isAlive` returns `OK`
- DB migration run (see Step 0 below)

---

## Step 0 — DB Migration (run once)

Run against your production database before deploying:

```sql
ALTER TABLE "adminConfigs"
  ADD COLUMN IF NOT EXISTS "adminAccessToken" TEXT,
  ADD COLUMN IF NOT EXISTS "adminRefreshToken" TEXT,
  ADD COLUMN IF NOT EXISTS "adminTokenExpiry" BIGINT;
```

---

## Step 1 — Open the Developer Console

Go to: **https://appconnect.labs.ringcentral.com/console**

Log in with your RingCentral admin account.

---

## Step 2 — Register / Update Each Connector

For each of the 4 connectors below, create a new connector profile (or update the existing one).

### Common settings across all connectors

| Field | Value |
|---|---|
| Server URL | `https://rc-crmapi.test.gate6.com` |
| Redirect URI | `https://ringcentral.github.io/ringcentral-embeddable/redirect.html` |

---

### ServiceNow

| Field | Value |
|---|---|
| Connector name | `servicenow` |
| Auth type | OAuth — **Admin-managed** |
| Enable admin-managed OAuth | ✅ On |

**What admin sets up (per customer account):**

| Field | Where to find it |
|---|---|
| Client ID | ServiceNow OAuth app → Application Registry |
| Client Secret | ServiceNow OAuth app → Application Registry |
| Authorization URL | `https://<instance>.service-now.com/oauth_auth.do` |
| Token URL | `https://<instance>.service-now.com/oauth_token.do` |
| Hostname | `<instance>.service-now.com` |
| Redirect URI | `https://ringcentral.github.io/ringcentral-embeddable/redirect.html` |

---

### Monday

| Field | Value |
|---|---|
| Connector name | `monday` |
| Auth type | OAuth — **Admin-managed** |
| Enable admin-managed OAuth | ✅ On |
| Scopes | `me:read users:read boards:read boards:write updates:write` |

**What admin sets up (per customer account):**

| Field | Where to find it |
|---|---|
| Client ID | Monday Developer → Apps → OAuth |
| Client Secret | Monday Developer → Apps → OAuth |
| Authorization URL | `https://auth.monday.com/oauth2/authorize` |
| Token URL | `https://auth.monday.com/oauth2/token` |
| Redirect URI | `https://ringcentral.github.io/ringcentral-embeddable/redirect.html` |

---

### ServiceTitan

| Field | Value |
|---|---|
| Connector name | `servicetitan` |
| Auth type | API Key |
| Admin-managed fields | Handled via manifest (no extra console config needed) |

The manifest already defines 4 admin-managed hidden fields (`clientId`, `clientSecret`, `tenantId`, `appKey`).
Admin sets these once via the AppConnect admin panel and they are shared across all users in the account.

**What admin sets up:**

| Field | Where to find it |
|---|---|
| Client ID | developer.servicetitan.io → Your App → Settings |
| Client Secret | developer.servicetitan.io → Your App → Settings |
| Tenant ID | ServiceTitan account settings |
| App Key | developer.servicetitan.io → Your App → Settings |

---

### AgencyZoom

| Field | Value |
|---|---|
| Connector name | `agencyzoom` |
| Auth type | API Key |
| Admin-managed fields | None — users enter their own credentials |

Users log in with their own AgencyZoom username (email) and password. No admin setup required.

---

## Step 3 — Verify Server Endpoints

After registering, confirm each connector is wired correctly:

```
GET https://rc-crmapi.test.gate6.com/isAlive
→ OK

GET https://rc-crmapi.test.gate6.com/implementedInterfaces?platform=servicenow
GET https://rc-crmapi.test.gate6.com/implementedInterfaces?platform=servicetitan
GET https://rc-crmapi.test.gate6.com/implementedInterfaces?platform=monday
GET https://rc-crmapi.test.gate6.com/implementedInterfaces?platform=agencyzoom
→ Each should list the implemented methods (getUserInfo, findContact, createCallLog, etc.)
```

---

## Step 4 — Admin Onboarding Flow (per customer)

### For ServiceNow and Monday (admin-managed OAuth)

1. Customer's RC admin opens the AppConnect admin panel
2. Selects the connector (ServiceNow or Monday)
3. Enters: Client ID, Client Secret, Authorization URL, Token URL, Hostname, Redirect URI
4. Core stores credentials encrypted at the account level
5. All users in that account can now log in via the standard OAuth flow — they never see the credentials

### For ServiceTitan (admin-managed API key fields)

1. Customer's RC admin opens the AppConnect admin panel
2. Selects ServiceTitan connector
3. Enters: Client ID, Client Secret, Tenant ID, App Key
4. Core stores these and injects them into every user's login flow automatically
5. Users only need to enter their email to log in

### For AgencyZoom

No admin setup. Users log in directly with their own username and password.

---

## Backwards Compatibility Note

Existing users on AppConnect 1.6.x clients are **not affected** — the server is backwards compatible. New 2.0 features (admin-managed OAuth, admin panel) are only visible to users on 2.0+ clients.
