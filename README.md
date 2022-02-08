# Cypress

[Replay](https://replay.io) enabled fork of the [Cypress](https://www.cypress.io) library.

## Overview

This is an alternative to Cypress that runs tests in the same way as the upstream Cypress library, and adds support for recording tests using replay enabled browsers.

## Install

Please check the [Cypress system requirements](https://on.cypress.io/installing-cypress).  Additionally, using replay enabled browsers is currently only supported on macOS and linux.

```sh
npm install --save-dev @recordreplay/cypress
```

## Documentation

Visit the [Cypress documentation](https://on.cypress.io/cli) for a full list of commands and examples.

Recordings will only be created when using `cypress run`, and not `cypress open`.  The `RECORD_REPLAY_API_KEY` environment variable must be set in order to record and upload tests.

By default, recordings will only be created for failing tests, and at most 20 recordings will be created in one test run. Each recording takes a minute or so to create and upload.

To override this default behavior, a configuration JSON object can be specified with additional options. This can be specified either via the value of the `RECORD_REPLAY_CYPRESS_CONFIGURATION` environment variable, or in a file referenced by the `RECORD_REPLAY_CYPRESS_CONFIGURATION_FILE` environment variable.

Configuration objects can have the following properties:

* `maxRecordings`: A number overriding the maximum number of recordings which can be created in one test run.

* `recordAll`: Set to record all tests, up to the maximum number of recordings allowed.

* `titleFilters`: An array of strings containing patterns for the titles of tests to record, whether they passed or not.

* `randomize`: Set to randomize which tests will be selected to record if there are more than the maximum number allowed. This is useful to improve coverage in CI environments when there are many tests which could be recorded.
