/**
 * [[EXT-180]] fixture — the END-TO-END proof that an aborted **ollama** call releases its socket,
 * not merely its promise. Driven by `packages/core/spec/abortDrainsProcess.spec.ts`; see that spec
 * for why this has to be a separate process.
 *
 * It is the ollama twin of `ext179-drain-fixture.mjs`, and it needs a third mode that the OpenAI
 * one does not. There the question was only *is the call aborted*; here the client ignores the
 * signal on the call, so the question is *does our fetch bridge reach the socket* — and telling
 * that apart from "aborting helps somehow" takes a run with the signal and without the bridge.
 *
 * - a local HTTP server on 127.0.0.1 that accepts the request and **never answers** — a stalled
 *   provider, with no network, no daemon and no model involved;
 * - an exit by **draining**: `process.exitCode` is set and `process.exit()` is never called, which
 *   is how `askCommand`/`execCommand` end (`setExitCode`). A provider socket still in flight is
 *   then the only thing that can keep this process alive.
 *
 * Usage: node ext180-ollama-drain-fixture.mjs <ollama-abort|ollama-nofix|ollama-noabort>
 *   ollama-abort   — the production client from `processJsonConfig`, aborted by the budget (the fix)
 *   ollama-nofix   — the same budget and the same signal against a BARE `ChatOllama`, i.e. what
 *                    `@langchain/ollama` does on its own (a control, and the upstream tripwire)
 *   ollama-noabort — the production client with the pre-fix race: a timer, no signal (a control)
 *
 * The production client is built through `processJsonConfig` on purpose. A hand-rolled
 * `new ChatOllama({ fetch })` here would prove that the bridge works and nothing at all about
 * whether the shipped provider installs it.
 */
import http from 'node:http';
import { CALL_TIMED_OUT, withCallDeadline } from '@gaunt-sloth/core/runtime/abortableCall.js';
import { processJsonConfig } from '@gaunt-sloth/core/providers/ollama.js';

const mode = process.argv[2];
const BUDGET_MS = 300;

const server = http.createServer((req) => {
  req.resume(); // accept the request body, then never answer it
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

// `checkOrPullModel` is off by default, so no model is looked up and the stalled server sees
// exactly one request: the chat call this fixture is measuring.
const modelFields = { model: 'gth-ext180-fixture-model', baseUrl };

let model;
if (mode === 'ollama-nofix') {
  const { ChatOllama } = await import('@langchain/ollama');
  model = new ChatOllama(modelFields);
} else {
  model = await processJsonConfig(modelFields);
}

const messages = [{ role: 'user', content: 'hello' }];

let outcome;
if (mode === 'ollama-noabort') {
  // The pre-fix shape: race a timer, return on timeout, never abort. Written out rather than
  // reusing the helper, because the control has to be the OLD mechanism — a control that shares
  // the code under test cannot fail differently from it.
  const call = model.invoke(messages);
  call.catch(() => {});
  outcome = await Promise.race([
    call,
    new Promise((resolve) => setTimeout(() => resolve(CALL_TIMED_OUT), BUDGET_MS)),
  ]);
} else {
  outcome = await withCallDeadline(BUDGET_MS, (signal) => model.invoke(messages, { signal }));
}

console.log(outcome === CALL_TIMED_OUT ? 'TIMED_OUT' : 'ANSWERED');

// Close the LISTENING handle so the server itself cannot hold the loop open. Any socket the
// provider client still holds is precisely what this fixture is measuring.
server.close();

process.exitCode = 0;
// Deliberately NO process.exit() — see the module doc. Whether this process ends here is the
// measurement.
