"use strict";

const _ = require('lodash');

const debug = require('debug')('cypress:cli:run');

const util = require('../util');

const spawn = require('./spawn');

const verify = require('../tasks/verify');

const {
  exitWithError,
  errors
} = require('../errors');

const {
  processTestingType,
  throwInvalidOptionError
} = require('./shared');

const fs = require("fs");
const path = require("path");

/**
 * Typically a user passes a string path to the project.
 * But "cypress open" allows using `false` to open in global mode,
 * and the user can accidentally execute `cypress run --project false`
 * which should be invalid.
 */


const isValidProject = v => {
  if (typeof v === 'boolean') {
    return false;
  }

  if (v === '' || v === 'false' || v === 'true') {
    return false;
  }

  return true;
};
/**
 * Maps options collected by the CLI
 * and forms list of CLI arguments to the server.
 *
 * Note: there is lightweight validation, with errors
 * thrown synchronously.
 *
 * @returns {string[]} list of CLI arguments
 */


const processRunOptions = (options = {}) => {
  debug('processing run options %o', options);

  if (!isValidProject(options.project)) {
    debug('invalid project option %o', {
      project: options.project
    });
    return throwInvalidOptionError(errors.invalidRunProjectPath);
  }

  const args = ['--run-project', options.project];

  if (options.browser) {
    args.push('--browser', options.browser);
  }

  if (options.ciBuildId) {
    args.push('--ci-build-id', options.ciBuildId);
  }

  if (options.config) {
    args.push('--config', options.config);
  }

  if (options.configFile !== undefined) {
    args.push('--config-file', options.configFile);
  }

  if (options.env) {
    args.push('--env', options.env);
  }

  if (options.exit === false) {
    args.push('--no-exit');
  }

  if (options.group) {
    args.push('--group', options.group);
  }

  if (options.headed) {
    args.push('--headed', options.headed);
  }

  if (options.headless) {
    if (options.headed) {
      return throwInvalidOptionError(errors.incompatibleHeadlessFlags);
    }

    args.push('--headed', !options.headless);
  } // if key is set use that - else attempt to find it by environment variable


  if (options.key == null) {
    debug('--key is not set, looking up environment variable CYPRESS_RECORD_KEY');
    options.key = util.getEnv('CYPRESS_RECORD_KEY');
  } // if we have a key assume we're in record mode


  if (options.key) {
    args.push('--key', options.key);
  }

  if (options.outputPath) {
    args.push('--output-path', options.outputPath);
  }

  if (options.parallel) {
    args.push('--parallel');
  }

  if (options.port) {
    args.push('--port', options.port);
  }

  if (options.quiet) {
    args.push('--quiet');
  } // if record is defined and we're not
  // already in ci mode, then send it up


  if (options.record != null) {
    args.push('--record', options.record);
  } // if we have a specific reporter push that into the args


  if (options.reporter) {
    args.push('--reporter', options.reporter);
  } // if we have a specific reporter push that into the args


  if (options.reporterOptions) {
    args.push('--reporter-options', options.reporterOptions);
  } // if we have specific spec(s) push that into the args


  if (options.spec) {
    args.push('--spec', options.spec);
  }

  if (options.tag) {
    args.push('--tag', options.tag);
  }

  args.push(...processTestingType(options.testingType));
  return args;
};

module.exports = {
  processRunOptions,
  isValidProject,

  // resolves with the number of failed tests
  start(options = {}) {
    _.defaults(options, {
      key: null,
      spec: null,
      reporter: null,
      reporterOptions: null,
      project: process.cwd()
    });

    function run() {
      let args;

      try {
        args = processRunOptions(options);
      } catch (err) {
        if (err.details) {
          return exitWithError(err.details)();
        }

        throw err;
      }

      debug('run to spawn.start args %j', args);
      return spawn.start(args, {
        dev: options.dev,
        wantTestOutput: true
      }).then(async ({ code, testOutput }) => {
        await maybeRecordTests(options, testOutput);
        return code;
      });
    }

    if (options.dev) {
      return run();
    }

    return verify.start().then(run);
  }

};

// How many recordings of a test we can create at once.
const MaxTestRecordings = 20;

async function maybeRecordTests(options, testOutput) {
  // Remove coloring from the output.
  testOutput = testOutput.replace(/\x1B[[(?);]{0,2}(;?\d)*./g, '');

  const tests = [];

  let currentSpec = null;
  const lines = testOutput.split("\n");
  for (const line of lines) {
    let match = /Running: (.*?) \(\d+ of \d+\)/.exec(line);
    if (match) {
      currentSpec = match[1].trim();
    }
    match = /\u2713 (.*?) \(\d+ms\)/.exec(line);
    if (match && currentSpec) {
      tests.push({ spec: currentSpec, title: match[1].trim(), passed: true });
    }
    match = /^\s*\d+\) (.*)/.exec(line);
    if (match && currentSpec) {
      tests.push({ spec: currentSpec, title: match[1].trim(), passed: false });
    }
    if (/\d+ passing/.test(line) || /\d+ failing/.test(line)) {
      currentSpec = null;
    }
  }

  debug(`Found tests: ${JSON.stringify(tests)}`);

  let numTestRecordings = 0;
  for (const testInfo of tests) {
    if (shouldRecordTest(testInfo) && numTestRecordings < MaxTestRecordings) {
      await createTestRecording(options, testInfo);
      numTestRecordings++;
    }
  }
}

function shouldRecordTest({ passed }) {
  return !passed;
}

async function createTestRecording(options, { spec, title }) {
  console.log("\n");
  console.log("====================================================================================================");
  console.log(`Creating Test Recording: ${spec} "${title}"`);
  console.log("====================================================================================================");

  const specFile = path.join(options.project, "cypress", "tests", spec);
  if (!fs.existsSync(specFile)) {
    console.log(`Creating recording failed: could not find spec file, checked path ${specFile}`);
    return;
  }

  const newSpec = path.join(path.dirname(spec), "recordreplay-" + path.basename(spec));
  const newSpecFile = path.join(options.project, "cypress", "tests", newSpec);
  if (fs.existsSync(newSpecFile)) {
    console.log(`Creating new spec file failed: ${newSpecFile} already exists`);
    return;
  }

  const contents = fs.readFileSync(specFile, "utf8");
  const transformed = `
const original_it = it;
it = function(name, config, fn) {
  if (name == "${title}") {
    if (typeof config == "function") {
      fn = config;
      config = {};
    }
    config = { ...config, retries: 0 };
    original_it(name, config, fn);
  }
}
for (const property of ["skip", "only"]) {
  it[property] = original_it[property];
}
  ` + contents;

  fs.writeFileSync(newSpecFile, transformed);

  try {
    const args = processRunOptions({
      ...options,
      spec: path.join("cypress", "tests", newSpec),
    });

    const code = await spawn.start(args, { dev: options.dev });
    return code;
  } finally {
    fs.unlinkSync(newSpecFile);
  }
}
