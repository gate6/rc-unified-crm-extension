---
title: ServiceTitan by Gate6 — App Connect
---

# ServiceTitan by Gate6

<div class="bld-hero">
  <div class="bld-hero__logo">
    <img src="../../img/crm-logo-servicetitan.png" alt="ServiceTitan">
  </div>
  <div>
    <div class="bld-hero__category">Field Service Management</div>
    <p class="bld-hero__tagline">Gate6's App Connect connector for ServiceTitan — log RingEX calls and communications directly into jobs and customer records for field service teams.</p>
  </div>
</div>

!!! success "Now Available"
    This integration has been released and is available today. To get licensed and onboarded, reach out to Gate6 directly at [gate6.com/contact-us](https://www.gate6.com/contact-us/).

!!! info "Requires App Connect 2.0"
    This integration is only available in [App Connect 2.0](../2.0/index.md). Make sure you have the latest version installed before getting started.

## About this integration

ServiceTitan is the operating system for the trades — used by plumbing, HVAC, electrical, and other home service businesses to manage dispatch, jobs, customers, and revenue. Gate6's App Connect connector brings RingEX communications into ServiceTitan, logging every call and SMS against the right customer and job record so your team has a complete communication history alongside their service work.

Gate6 built this connector for the communication-heavy workflows that define the home services industry, where every missed call or unlogged interaction is a potential lost job.

## Features

- **Automatic call logging** — inbound and outbound calls logged to the matching ServiceTitan customer and job record
- **SMS logging** — inbound and outbound messages logged alongside call history
- **Click-to-dial** — dial any phone number in ServiceTitan with a single click
- **Screen pop** — customer records surface automatically when a call arrives
- **Job record association** — calls linked to active or recent jobs for the matched customer
- **Multi-location support** — designed for businesses operating across multiple service areas
- **AI Transcription and Notes** — Generate AI-powered transcriptions and concise summary notes for every call, pushing them directly into ServiceTitan customer items for instant visibility.

## Requirements

- An active RingEX account
- ServiceTitan subscription
- App Connect 2.0 or later
- Gate6 connector license

## Setup

### 1. Purchase a license from Gate6

The ServiceTitan connector is licensed by Gate6, so this is the first step — you will not be able to connect until your account has been provisioned.

[Contact Gate6](https://www.gate6.com/contact-us/){ .md-button .md-button--primary }

Their team will discuss pricing, confirm how many seats you need, and provision your RingCentral account for the connector. Once that is done, your users can connect.

### 2. Install App Connect

If you have not already done so, [install App Connect](../getting-started.md) from the Chrome or Edge web stores. The ServiceTitan connector requires [App Connect 2.0](../2.0/index.md) or later.

### 3. Gather your ServiceTitan API credentials

An admin sets these up once for the whole organization. From the [ServiceTitan developer portal](https://developer.servicetitan.io/), create an application for your tenant and collect:

* **Client ID**
* **Client Secret**
* **Tenant ID**
* **App Key**

!!! info "Entered once, shared across your organization"
    These credentials are stored at the account level. Once an admin has entered them, other users in your organization connect without needing the credentials themselves.

### 4. Connect App Connect to ServiceTitan

1. [Login to ServiceTitan](https://go.servicetitan.com/).

2. While visiting a ServiceTitan page, click the quick access button to bring the dialer to the foreground.

3. Login with your RingCentral account.

4. Navigate to the Settings screen in App Connect, and find the option labeled "Service Titan."

5. Click the "Connect" button.

6. A window will be opened prompting you for your ServiceTitan API credentials. Enter the Client ID, Client Secret, Tenant ID and App Key gathered above, then submit.

When you login successfully, the browser extension will automatically update to show you are connected to ServiceTitan. If you are connected, the button next to Service Titan will say "logout."

And with that, you will be connected to ServiceTitan and ready to begin using the integration.

!!! warning "Seeing a licensing error when you connect?"
    If you see *"No active subscription found for this account"* or *"License seat limit reached,"* your account has either not been provisioned by Gate6 yet, or all of your purchased seats are in use. [Contact Gate6](https://www.gate6.com/contact-us/) to resolve it.

<div class="bld-cta">
  <div>
    <div class="bld-cta__title">Get started with Gate6</div>
    <p class="bld-cta__desc">Contact Gate6 to purchase a license, get a demo, or ask about configuring the connector for your ServiceTitan environment.</p>
  </div>
  <a href="https://www.gate6.com/contact-us/" class="bld-cta__btn" target="_blank" rel="noopener">Contact Gate6 →</a>
</div>
