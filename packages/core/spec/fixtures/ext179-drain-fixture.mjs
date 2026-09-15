/**
 * [[EXT-179]] fixture — the END-TO-END proof that the abort reaches the SOCKET, not merely the
 * promise. Driven by `packages/core/spec/abortDrainsProcess.spec.ts`; see that spec for why this
 * has to be a separate process.
 *
 * It reproduces the node's actual symptom in miniature:
 *
 * - a local HTTP server on 127.0.0.1 that accepts the request and **never answers** — a stalled
 *   provider, with no network and no API key involved;
 * - a real `ChatOpenAI` client pointed at it via `configuration.baseURL`, with a literal dummy key
 *   and `maxRetries: 0`;
 * - the real `withCallDeadline` helper, exactly as the four production sites call it;
 * - an exit by **draining**: `process.exitCode` is set and `process.exit()` is never called, which
 *   is how `askCommand`/`execCommand` end (`setExitCode`). So if the provider socket is still in
 *   flight, the process cannot exit — which is the bug — and if the abort truly closed it, the
 *   process exits on its own.
 *
 * Usage: node ext179-drain-fixture.mjs <abort|noabort>
 *   abort   — the budget fires and aborts the call (the fix)
 *   noabort — the same race with NO signal (the pre-fix behaviour, and the control)
 *
 * The control is what makes this a measurement: without it, a process that exits proves nothing,
 * because it might simply have had nothing to hold it open.
 */
import http from 'node:http';
import { ChatOpenAI } from '@langchain/openai';
import * as z from 'zod';
import { CALL_TIMED_OUT, withCallDeadline } from '@gaunt-sloth/core/runtime/abortableCall.js';

const mode = process.argv[2];
const BUDGET_MS = 300;

const server = http.createServer((req) => {
  req.resume(); // accept the request body, then never answer it
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
  apiKey: 'ext179-fixture-not-a-real-key',
  maxRetries: 0,
  configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
});
const structured = model.withStructuredOutput(z.object({ answer: z.string() }));

let outcome;
if (mode === 'abort') {
  outcome = await withCallDeadline(BUDGET_MS, (signal) =>
    structured.invoke([{ role: 'user', content: 'hello' }], { signal })
  );
} else {
  // The pre-fix shape: race a timer, return on timeout, never abort. Written out rather than
  // reusing the helper, because the control has to be the OLD mechanism — a control that shares
  // the code under test cannot fail differently from it.
  const call = structured.invoke([{ role: 'user', content: 'hello' }]);
  call.catch(() => {});
  outcome = await Promise.race([
    call,
    new Promise((resolve) => setTimeout(() => resolve(CALL_TIMED_OUT), BUDGET_MS)),
  ]);
}

console.log(outcome === CALL_TIMED_OUT ? 'TIMED_OUT' : 'ANSWERED');

// Close the LISTENING handle so the server itself cannot hold the loop open. Any socket the
// provider client still holds is precisely what this fixture is measuring.
server.close();

process.exitCode = 0;
// Deliberately NO process.exit() — see the module doc. Whether this process ends here is the
// measurement.
