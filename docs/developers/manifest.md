# Configuring your adapter manifest

{! docs/developers/beta_notice.inc !}

Each adapter provides a configuration that in some ways also acts as a manifest file. The manifest file not only provides key pieces of metadata to enable the framework to connect to the CRM, and display other properties to the user (name and so forth), but it also allows developers to customize the appearance of screens, add custom fields to various CRM object types, and more. Here is a list of things the manifest file enables for developers:

* Provide CRM connectivity and authorization details
* Define custom fields for:
    * call logging and disposition
    * SMS and messagig logging
* Customize the "Connect to CRM" or authorization screen
* Define custom contact record types/categories
* Customize the welcome screen for a given CRM

Note: The extension has a fixed redirect uri: `https://ringcentral.github.io/ringcentral-embeddable/redirect.html`. It should suffice standard OAuth use cases. If there's any special case, please contact us.

## Test sample

Under `src/adapters/testCRM`, there's an existing `manifest.json` as a test sample. 

## Manifest file

You should create a folder `src/adapters/{yourCrmName}` and then create a manifest file under it as `manifest.json`.

### Refresh manifest on client side

Go to extension's option page and change `Custom CRM manifest url` to `{serverUrl}/crmManifest?platformName={crmName}` and save.

## Configuration options

| Name             | Type            | Description |
|------------------|-----------------|-------------|
| `serverUrl`      | string          | Domain url for your server|
| `author`         | string          | (Optional) For client side app to track server identity |
| `redirectUri`    | string          | Redirect Uri for RingCentral login |
| `platforms`      | object          | Platform config object, explained [here](#platforms-config) |
| `version`        | string          | Version of this service |

### Platform config:

| Name             | Type            | Description |
|------------------|-----------------|-------------|
| `urlIdentifier`  | string          | The URL for which this CRM will be enabled. When the CRM is enabled for a domain, the extension's organge quick access button will appear. ( * for wildcard match is surpported) |
| `name`           | string          | The name of the CRM. |
| `authType`       | string          | The supported auth type for the corresponding CRM. Only two values are supported: `oauth` and `apiKey`. |
| `authUrl`        | string          | Only used with `authType` equal to `oauth`. The auth URL to initiate the OAuth process with the CRM. |
| `scope`| string |(Optional) Only if you want to specify scopes in OAuth url. eg. "scope":"scopes=write,read" |
| `customState`| string |(Optional) Only if you want to override state query string in OAuth url |
| `clientId`       | string          | Only used with `authType` equal to `oauth`. The client ID of the application registered with the CRM to access it's API. |
| `canOpenLogPage` | boolean         | Set to `true` if the corresponding CRM supports permalinks for a given activity/log. When set to `true` users will have the option view/open the activity log in the CRM from the call history page. When set to `false`, users will open the contact page instead. |
| `contactTypes`   | ARRAY of string | (Optional) CRMs often adopt unique vernaculars to describe contacts. Provide the enumerated list of contact types supported by the corresponding CRM. |
| `embeddedOnCrmPage` | object       | The rendering config for embedded page, explained [here](#customizing-the-welcome-message) |
| `page`           | object          | The rendering config for all pages, explained [here](#customizing-pages-within-the-client-application) |

The client-side authorization url that is opened by the extension will be: `{authUrl}?responseType=code&client_id={clientId}&{scope}&state=platform={name}&redirect_uri=https://ringcentral.github.io/ringcentral-embeddable/redirect.html`

Note: `customState` overrides state string. It'll be `state={customState}` instead.

## Customizing the welcome message

When a user installs the CRM extension for the first time and accesses it from their CRM, a welcome page or splash screen appears to the user. This screen can be very effective in educating the end user about how to setup and connect to the associated CRM. 

Currently welcome pages are relatively simple, providing developers with the ability to direct users to two key resources under `embeddedOnCrmPage.welcomePage`:

* `videoLink`: A URL to watch a video
* `docLink`: A URL to read documentation

## Customizing pages within the client application

There are a number of pages within the Unified CRM client application that often need to be customized in some way for the corresponding CRM. Those pages are:

* CRM authentication page (ONLY for `apiKey` auth)
* Call logging form
* Message logging form

### Authentication page

=== "Sample adapter"

    ```js
    {!> src/adapters/testCRM/manifest.json [ln:23-33] !}
    ```

![Auth page](../img/test-auth-page.png)

=== "Insightly adapter"

    ```js
    {!> src/adapters/manifest.json [ln:57-84] !}
    ```

![Auth page](../img/insightly-auth-page.png)


### Adding custom fields to logging forms

CRMs almost always have a set of fields associated with logging an activity that are relatively unique. Consider for example Clio, a CRM used by legal professionals, in which users link calls to "matters" (e.g. a "legal matter"). Where CRMs like Insightly link calls to opportunities. To account for this, the framework makes it easy to add new custom form fields to two key forms users interact with frequently:

* Call logging page
* Create contact page

For each page, you will define an array of `additionalFields`. Each additional field element consists of the properties below.

| Name               | Type    | Description |
|--------------------|---------|-------------|
| `const`            | string  | A unique key identifying the field. |
| `title`            | string  | The display name of the field. |
| `type`             | string  | The data type associated with the field. |
| `contactDependent` | boolean | Set to `true` if this field would change when the selected contact is changed, or `false` if the value is static.  |

#### Custom call log fields

Set up associated deals as dropdown options:

1. Christmas special A351
2. Easter A22
3. Anniversary C92

and address as free input field.

```js
{! src/adapters/testCRM/manifest.json [ln:35-48] !}
```

#### Custom SMS log fields

Set up associated deals the same as call log

```js
{! src/adapters/testCRM/manifest.json [ln:51-64] !}
```

## Sample manifest file

Here is a sample manifest file that illustrates the full syntax and structure of the manifest file. 

```js
{! src/adapters/testCRM/manifest.json !}
```