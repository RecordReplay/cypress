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
const os = require("os");
const path = require("path");
const {
  getPlaywrightBrowserPath,
  listAllRecordings,
  uploadRecording,
} = require("@recordreplay/recordings-cli");
const { spawnSync } = require("child_process");

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
      let testOutput = "";
      return spawn.start(args, {
        dev: options.dev,
        onTestOutput(data, stderr) {
          if (stderr) {
            process.stderr.write(data);
          } else {
            process.stdout.write(data);
            testOutput += data.toString();
          }
        }
      }).then(async code => {
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

// Parse the passing/failing tests from stdout data.
function readTestsFromOutput(testOutput) {
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

  return tests;
}

async function maybeRecordTests(options, testOutput) {
  const tests = readTestsFromOutput(testOutput);

  debug(`Found tests: ${JSON.stringify(tests)}`);

  const configuration = loadRecordReplayConfiguration();
  console.log(`Loaded record/replay configuration: ${JSON.stringify(configuration)}`);

  let testRecordings = tests.filter(testInfo => shouldRecordTest(testInfo, configuration));

  if (configuration.shuffleOrder) {
    testRecordings = _.shuffle(testRecordings);
  }

  // How many recordings of a test we can create at once.
  const maxRecordings = configuration.maxRecordings || 20;

  if (testRecordings.length > maxRecordings) {
    console.log(`Too many tests to record: ${testRecordings.length}, limit is ${maxRecordings}`);
    testRecordings.length = maxRecordings;
  }

  for (const testInfo of testRecordings) {
    await createTestRecording(options, testInfo);
  }
}

function loadRecordReplayConfiguration() {
  try {
    let configurationStr = process.env.RECORD_REPLAY_CYPRESS_CONFIGURATION;
    if (!configurationStr) {
      const configurationFile = process.env.RECORD_REPLAY_CYPRESS_CONFIGURATION_FILE;
      if (configurationFile) {
        configurationStr = fs.readFileSync(configurationFile, "utf8");
      }
    }
    if (configurationStr) {
      return JSON.parse(configurationStr);
    }
  } catch (e) {
    console.log(`Error: Exception loading record/replay configuration: ${e}`);
  }
  return {};
}

function shouldRecordTest({ title, passed }, configuration) {
  if (configuration.recordAll) {
    return true;
  }
  if (configuration.titleFilters) {
    return configuration.titleFilters.some(filter => title.includes(filter));
  }
  return !passed;
}

async function createTestRecording(options, { spec, title, passed }) {
  console.log("\n");
  console.log("====================================================================================================");
  console.log(`Creating Test Recording: ${spec} "${title}"`);
  console.log("====================================================================================================");

  const apiKey = process.env.RECORD_REPLAY_API_KEY;
  if (!apiKey) {
    console.log("Error: RECORD_REPLAY_API_KEY env var not set.");
    return;
  }

  const replayBrowserPath = getPlaywrightBrowserPath("gecko");
  if (!replayBrowserPath) {
    console.log("Error: Replay browser is not available for this platform.");
    return;
  }

  if (!fs.existsSync(replayBrowserPath)) {
    console.log("Error: Replay browser is not installed. Try 'npm i @recordreplay/cypress' to reinstall");
    return;
  }

  // Create a temporary directory for recordings associated with this run.
  const recordingsDir = path.join(os.tmpdir(), `recordreplay-cypress-${(Math.random() * 1e9) | 0}`);
  fs.mkdirSync(recordingsDir);

  const specFile = path.join(options.project, "cypress", "tests", spec);
  if (!fs.existsSync(specFile)) {
    console.log(`Error: Creating recording failed: could not find spec file, checked path ${specFile}`);
    return;
  }

  const newSpec = path.join(path.dirname(spec), "recordreplay-" + path.basename(spec));
  const newSpecFile = path.join(options.project, "cypress", "tests", newSpec);
  if (fs.existsSync(newSpecFile)) {
    console.log(`Error: Creating new spec file failed: ${newSpecFile} already exists`);
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
      browser: replayBrowserPath,
    });

    let childProcess = null;
    let testOutput = "";
    let testOutputIncludingErrors = "";

    // Start Cypress, and wait for a single test to either pass or fail or
    // for a timeout to elapse.
    const childProcessRunning = await new Promise(resolve => {
      setTimeout(() => resolve(true), 180_000);
      spawn.start(args, {
        dev: options.dev,
        env: {
          RECORD_ALL_CONTENT: "1",
          RECORD_REPLAY_DIRECTORY: recordingsDir,
        },
        onChildProcess(child) {
          childProcess = child;
        },
        onTestOutput(data, stderr) {
          testOutputIncludingErrors += data.toString();
          if (!stderr) {
            testOutput += data.toString();
            const tests = readTestsFromOutput(testOutput);
            if (tests.length) {
              // Once we've detected a test finished, wait another second
              // for recording data associated with the test to be written out.
              // Recording data is flushed to disk several times a second.
              debug("Detected test finished");
              setTimeout(() => resolve(true), 1000);
            }
          }
        }
      }).then(() => resolve(false), () => resolve(false));
    });

    debug("Begin Cypress output while recording");
    debug(testOutputIncludingErrors);
    debug("End Cypress output while recording");

    if (!childProcess || !childProcess.pid || !childProcessRunning) {
      console.log("Error: Cypress process not running");
      return;
    }

    // Tear down Cypress and the Replay browser processes by killing them.
    // We do this as soon as we've detected the test has finished to avoid
    // padding the recording as Cypress attempts to take a video, and because
    // when it fails to take a video and exits, the browser processes are not
    // killed properly.
    killProcessAndTransitiveSubprocesses(childProcess.pid);

    // If the test originally failed, only use the recording if it also failed.
    const tests = readTestsFromOutput(testOutput);
    if (!passed && !tests.some(test => !test.passed)) {
      console.log("Error: No test failures while recording, skipping upload.");
      return;
    }

    const recordingOptions = { directory: recordingsDir };
    const recordings = listAllRecordings(recordingOptions);
    debug(`Found recordings ${JSON.stringify(recordings)}`);

    const recording = recordings.find(recording => {
      return recording.metadata && recording.metadata.uri && recording.metadata.uri.includes(newSpec);
    });
    if (!recording) {
      console.log("Error: Could not find test recording");
      return;
    }

    console.log("Found test recording, beginning upload...");
    const recordingId = await uploadRecording(recording.id, recordingOptions);

    if (recordingId) {
      console.log(`Created test recording ${spec} "${title}": https://app.replay.io/recording/${recordingId}`);
    } else {
      console.log("Error: Recording upload failed");
    }
  } finally {
    fs.unlinkSync(newSpecFile);
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  }
}

function killProcessAndTransitiveSubprocesses(pid) {
  const childToParent = new Map();

  const lines = spawnSync("ps", ["-A", "-o", "ppid,pid"]).stdout.toString().split("\n");
  for (const line of lines) {
    const match = /(\d+)\s+(\d+)/.exec(line);
    if (match && +match[1] > 1) {
      childToParent.set(+match[2], +match[1]);
    }
  }

  for (const childPid of childToParent.values()) {
    if (shouldKillSubprocess(childPid)) {
      try {
        spawnSync("kill", ["-KILL", childPid.toString()]);
      } catch (e) {}
    }
  }
  spawnSync("kill", ["-KILL", pid.toString()]);

  function shouldKillSubprocess(childPid) {
    while (true) {
      const parent = childToParent.get(childPid);
      if (!parent) {
        return false;
      }
      if (parent == pid) {
        return true;
      }
      childPid = parent;
    }
  }
}
