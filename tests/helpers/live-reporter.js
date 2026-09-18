// Streams test progress as one JSON object per line, each prefixed with a marker, so the
// dashboard can follow a run live while the normal `list` reporter output stays readable.
// Used only when the dashboard starts Playwright; `npm test` keeps the config's reporters.
const MARKER = '@@PW@@';

function emit(event) {
  process.stdout.write(`${MARKER}${JSON.stringify(event)}\n`);
}

function testIdOf(test, result) {
  const annotations = [...(result?.annotations || []), ...(test.annotations || [])];
  return annotations.find((a) => a.type === 'testId')?.description || null;
}

class LiveReporter {
  onBegin(_config, suite) {
    emit({ type: 'begin', total: suite.allTests().length });
  }

  onTestBegin(test) {
    emit({ type: 'testBegin', id: test.id, title: test.title, file: test.location.file });
  }

  onTestEnd(test, result) {
    // titlePath is ['', project, file, ...describes, title]; keep file + describes.
    const [, project, ...rest] = test.titlePath();
    emit({
      type: 'testEnd',
      id: test.id,
      testId: testIdOf(test, result),
      title: test.title,
      path: rest.slice(0, -1),
      project,
      status: result.status,
      expectedStatus: test.expectedStatus,
      outcome: test.outcome(),
      durationMs: result.duration,
      error: result.error?.message?.split('\n')[0] || null,
    });
  }

  onEnd(result) {
    emit({ type: 'end', status: result.status });
  }

  printsToStdio() {
    return false;
  }
}

module.exports = LiveReporter;
