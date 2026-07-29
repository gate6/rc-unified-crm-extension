# App Connect and ServiceNow

ServiceNow is an IT service and operations management company that helps companies automate IT business processes. Gate6's App Connect connector brings RingEX communications into ServiceNow — logging every call, message and voicemail as an Interaction record against the right user or contact, so your service desk has the full communication history alongside the work it belongs to.

RingCentral supports ServiceNow via a trusted third-party vendor [Gate6](https://gate6.com/).

!!! money "As a third-party integration, the ServiceNow integration comes at an additional cost"

## Features

- **Automatic call logging** — inbound and outbound calls logged as Interaction records against the matching ServiceNow user or contact
- **SMS and voicemail logging** — messages logged alongside call history on the same records
- **Click-to-dial** — dial any phone number displayed in ServiceNow with a single click
- **Screen pop** — the matching ServiceNow record surfaces automatically when a call arrives
- **Call recording archival** — recordings are attached directly to the Interaction record for enhanced compliance
- **AI transcription and notes** — AI-generated call summaries and full transcripts written into the Interaction's work notes
- **Interaction state and type mapping** — set the default state and type applied to inbound calls, outbound calls, SMS and voicemails

## Setup

### 1. Purchase a license from Gate6

![Gate6 Logo](../img/vendor-gate6.png){ .mw-250 .float-right }
The ServiceNow connector is licensed by Gate6, so this is the first step — you will not be able to connect until your account has been provisioned.

[Contact Gate6](https://www.gate6.com/contact-us/){ .md-button .md-button--primary}

Their team will discuss pricing, confirm how many seats you need, and provision your RingCentral account for the connector.

### 2. Install App Connect

If you have not already done so, [install App Connect](../getting-started.md) from the Chrome or Edge web stores.

### 3. Connect App Connect to ServiceNow

1. Login to your ServiceNow instance.

2. While visiting a ServiceNow page, click the quick access button to bring the dialer to the foreground.

3. Login with your RingCentral account.

4. Navigate to the Settings screen in App Connect, and find the option labeled "ServiceNow."

5. Click the "Connect" button.

6. A window will be opened prompting you to login to ServiceNow and authorize App Connect. Complete the authorization.

When you login successfully, the browser extension will automatically update to show you are connected to ServiceNow. If you are connected, the button next to ServiceNow will say "logout."

And with that, you will be connected to ServiceNow and ready to begin using the integration.

!!! warning "Seeing a licensing error when you connect?"
    If you see *"No active subscription found for this account"* or *"License seat limit reached,"* your account has either not been provisioned by Gate6 yet, or all of your purchased seats are in use. [Contact Gate6](https://www.gate6.com/contact-us/) to resolve it.

<div class="bld-cta">
  <div>
    <div class="bld-cta__title">Get started with Gate6</div>
    <p class="bld-cta__desc">Contact Gate6 to purchase a license, get a demo, or ask about onboarding the connector onto your ServiceNow instance.</p>
  </div>
  <a href="https://www.gate6.com/contact-us/" class="bld-cta__btn" target="_blank" rel="noopener">Contact Gate6 →</a>
</div>
