# Registering provider

## Setup

Add new relic provider in the top of providers list.

```js
// app/start.js

const providers = [
  `@frubana/adonis-newrelic/providers/Provider`
  // ...
];
```

In the main directory add `newrelic.js` and copy

```js
/** @type {import('@adonisjs/framework/src/Env')} */
const Env = use("Env");

/**
 * New Relic agent configuration.
 *
 * See lib/config/default.js in the agent distribution for a more complete
 * description of configuration variables and their potential values.
 */
exports.config = {
  /**
   * Array of application names.
   */
  app_name: [Env.get("APP_NAME")],
  /**
   * Your New Relic license key.
   */
  license_key: Env.get("NEW_RELIC"),

  logging: {
    /**
     * Level at which to log. 'trace' is most useful to New Relic when diagnosing
     * issues with the agent, 'info' and higher will impose the least overhead on
     * production applications.
     */
    level: "info"
  },
  /**
   * When true, all request headers except for those listed in attributes.exclude
   * will be captured for all traces, unless otherwise specified in a destination's
   * attributes include/exclude lists.
   */
  allow_all_headers: true,

  attributes: {
    /**
     * Prefix of attributes to exclude from all destinations. Allows * as wildcard
     * at end.
     *
     * NOTE: If excluding headers, they must be in camelCase form to be filtered.
     *
     * @env NEW_RELIC_ATTRIBUTES_EXCLUDE
     */
    exclude: [
      "request.headers.cookie",
      "request.headers.authorization",
      "request.headers.proxyAuthorization",
      "request.headers.setCookie*",
      "request.headers.x*",
      "response.headers.cookie",
      "response.headers.authorization",
      "response.headers.proxyAuthorization",
      "response.headers.setCookie*",
      "response.headers.x*"
    ]
  }
};
```

In your `.env` file add this variable and paste your new relic key

```env
NEW_RELIC=
```
