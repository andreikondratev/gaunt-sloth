/**
 * [[EXT-142]] — **an ACP client can see the refusals it saved, and take one back.**
 *
 * ## The defect this measures
 *
 * [[EXT-107]] wired *Reject and remember* on both ACP dialects, and wired the control that LIFTS a
 * saved refusal on the terminal only. So a refusal made in an editor was permanent from inside that
 * editor. Every cell here drives that whole round trip — refuse, save, list, lift, ask again —
 * through the in-process ACP client/server harness, which is the "real client" this node's
 * acceptance means: `session/new`, `session/update`, `session/request_permission` and
 * `session/prompt` all cross the SDK's own connection, against the production
 * `GthAgentRunner`, the production config loader and the production grant stores.
 *
 * ## What is faked, and what is not
 *
 * No `vi.mock`. The only scripted pieces are the model-facing agent — which stands in for a model
 * deciding to run a shell command, a thing no unit test may do for real — and the session model the
 * rater would otherwise reach for, so the rung's rater arm is chosen rather than fetched over the
 * network from whatever credentials the host happens to have. Everything the node is about is real:
 * the refusal is recorded by the runner, written to a real file in a real temp project, listed from
 * the runner's own `getRefusals`, and lifted through `liftRefusal`.
 *
 * ## Both dialects, and the one that matters most is v1
 *
 * **v1 is the dialect Zed speaks**, which makes it the dialect the node's complaint is actually
 * about, so the whole round trip is driven there as well as on v2 rather than inferred across. The
 * two apps advertise and dispatch independently; only the module under them is shared.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acpV1 from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { SHELL_TOOL_NAME } from '@gaunt-sloth/core/config/shell-policy.js';
import type {
  AgentStreamEvent,
  GthAgentInterface,
  PendingToolInterrupt,
  ToolApprovalDecision,
} from '@gaunt-sloth/core/core/types.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { createAcpAgentApp } from '#src/modules/acp/acpAgentApp.js';
import { createAcpV1AgentApp } from '#src/modules/acp/acpAgentAppV1.js';
import { loadConfigForCwd } from '#src/modules/acp/acpCommon.js';

/**
 * The grant store anchors at the project dir, and every cell here drives a gated call that SAVES —
 * so this must be clamped or the suite reads and rewrites the deny list of whoever runs it.
 */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-acp-approvals-spec-'));

/** The command the scripted agent asks to run, unless a cell says otherwise. */
const GATED_COMMAND = 'curl refused.example';

/**
 * A real project directory with a real config file, for the production loader to discover.
 *
 * `.git` stops the upward walk inside the fixture, and `llm.type` is present because a config
 * without it is one the loader rejects.
 */
function workspaceWith(name: string, config: Record<string, unknown> = {}): string {
  const dir = join(projectDir, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.gsloth.config.json'),
    JSON.stringify({ llm: { type: 'vertexai' }, ...config })
  );
  return dir;
}

/**
 * A scripted backend that reports one suspended shell call **on every turn**.
 *
 * The re-arming is the point and is not incidental. The acceptance is a sequence of turns in ONE
 * session — refuse, list, lift, call again — and the two halves it turns on are *the second call is
 * refused without asking* and *the call after the lift IS asked about*. A fixture that offered the
 * call once would satisfy the first of those by simply having nothing left to gate, which is a
 * green run over a question never asked.
 */
class GatedShellAgent implements GthAgentInterface {
  /** What the gate decided, in order, as handed back on resume. */
  readonly decisions: ToolApprovalDecision[] = [];
  /** Whether this turn still has its gated call to report. */
  private armed = false;

  constructor(private command: string) {}

  /** Point the next turn's call at a different command. */
  setCommand(command: string): void {
    this.command = command;
  }

  async init(): Promise<void> {}
  async invoke(): Promise<string> {
    return '';
  }
  async stream(): Promise<never> {
    throw new Error('the ACP surface drives the event stream, never the text stream');
  }

  async *streamWithEvents(): AsyncGenerator<AgentStreamEvent> {
    this.armed = true;
    yield { type: 'tool_start', id: 'call-1', name: SHELL_TOOL_NAME } as AgentStreamEvent;
    yield {
      type: 'tool_args',
      id: 'call-1',
      delta: JSON.stringify({ command: this.command }),
    } as AgentStreamEvent;
    yield { type: 'tool_end', id: 'call-1' } as AgentStreamEvent;
  }

  async getPendingToolInterrupts(): Promise<PendingToolInterrupt[]> {
    // Reported once per turn, so the runner's drain loop terminates on the next poll — and armed
    // again by the next `streamWithEvents`, so the next turn has a call to gate.
    if (!this.armed) return [];
    this.armed = false;
    return [{ name: SHELL_TOOL_NAME, args: { command: this.command } }];
  }

  async *streamWithEventsResume(resumeValue: unknown): AsyncGenerator<AgentStreamEvent> {
    this.decisions.push(
      ...((resumeValue as { decisions: ToolApprovalDecision[] }).decisions ?? [])
    );
    yield { type: 'text', delta: 'done' } as AgentStreamEvent;
  }

  async cleanup(): Promise<void> {}
}

/**
 * A session model that cannot rate anything.
 *
 * `rateShellCommand` reaches for `withStructuredOutput` on `config.llm` when no rater profile is
 * configured, and treats a model without one as no rater at all. At the default `assisted` rung the
 * gate then fails closed and escalates — which is exactly the state this node is about: the request
 * reaches the client, and the client can answer *Reject and remember*.
 */
function unratableModel(): unknown {
  const base = { _llmType: () => 'test', verbose: false, bindTools: () => base };
  return base;
}

/** The production loader with only the session model replaced. */
function loadWithTestModel(cwd: string): Promise<GthConfig> {
  return loadConfigForCwd(cwd).then(
    (config) => ({ ...config, llm: unratableModel() }) as GthConfig
  );
}

/** Let the scheduled `available_commands_update` (a `setImmediate`) reach the client. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The text of a v2 `agent_message`'s content blocks. */
function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block as { text?: unknown }).text)
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

/** What a driven session lets a cell say and see. */
interface Drive {
  /** Send one prompt and wait for the turn to finish. */
  prompt(text: string): Promise<void>;
  /** Every `agent_message` the client has been sent, in order. */
  readonly messages: string[];
  /** Every `session/request_permission` the client has been asked, in order. */
  readonly permissionRequests: unknown[];
  /** Every `available_commands_update` payload the client has been sent, in order. */
  readonly commandUpdates: Record<string, unknown>[][];
}

interface DriveOptions {
  cwd: string;
  agent: GatedShellAgent;
  /** The option id to answer the next permission request with; consumed in order. */
  answers: string[];
  run: (drive: Drive) => Promise<void>;
}

/** Drives one v2 session across as many turns as the cell needs. */
async function driveV2(options: DriveOptions): Promise<void> {
  const messages: string[] = [];
  const permissionRequests: unknown[] = [];
  const commandUpdates: Record<string, unknown>[][] = [];
  let idleCount = 0;

  const agentApp = createAcpAgentApp({
    loadConfig: loadWithTestModel,
    agentFactory: () => () => options.agent,
    resolvers: {},
  });

  await acpV2
    .client({ name: 'ext-142-v2-client' })
    .onNotification(acpV2.CLIENT_METHODS.session_update, ({ params }) => {
      const update = params.update as unknown as Record<string, unknown>;
      if (update.sessionUpdate === 'state_update' && update.state === 'idle') idleCount += 1;
      if (update.sessionUpdate === 'agent_message') messages.push(blocksText(update.content));
      if (update.sessionUpdate === 'available_commands_update') {
        commandUpdates.push(update.availableCommands as Record<string, unknown>[]);
      }
    })
    .onRequest(acpV2.CLIENT_METHODS.session_request_permission, async ({ params }) => {
      permissionRequests.push(params);
      const optionId = options.answers.shift();
      if (optionId === undefined) throw new Error('the client was asked with no answer scripted');
      return { outcome: { outcome: 'selected', optionId } as acpV2.RequestPermissionOutcome };
    })
    .connectWith(agentApp, async (ctx) => {
      await ctx.request(acpV2.AGENT_METHODS.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: 'ext-142-v2-client', version: '0.0.0' },
      });
      const created = await ctx.request(acpV2.AGENT_METHODS.session_new, { cwd: options.cwd });
      await settle();

      const prompt = async (text: string): Promise<void> => {
        const before = idleCount;
        await ctx.request(acpV2.AGENT_METHODS.session_prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text }],
        });
        // v2 answers the prompt request on acceptance; the turn is over when an idle state update
        // lands, which is the only thing that says so.
        const deadline = Date.now() + 10000;
        while (idleCount === before) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for the turn: ${text}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };

      await options.run({ prompt, messages, permissionRequests, commandUpdates });
    });
}

/**
 * Drives one v1 session across as many turns as the cell needs.
 *
 * Simpler than its v2 twin for one protocol reason: v1 has no `state_update`, so the still-open
 * `session/prompt` request IS the end of the turn and awaiting it is the whole synchronisation.
 * v1 also has no whole-message update, so the agent's lines arrive as `agent_message_chunk`.
 */
async function driveV1(options: DriveOptions): Promise<void> {
  const messages: string[] = [];
  const permissionRequests: unknown[] = [];
  const commandUpdates: Record<string, unknown>[][] = [];

  const agentApp = createAcpV1AgentApp({
    loadConfig: loadWithTestModel,
    agentFactory: () => () => options.agent,
    resolvers: {},
  });

  await acpV1
    .client({ name: 'ext-142-v1-client' })
    .onNotification(acpV1.CLIENT_METHODS.session_update, ({ params }) => {
      const update = params.update as unknown as Record<string, unknown>;
      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = (update.content as { text?: unknown } | undefined)?.text;
        if (typeof text === 'string') messages.push(text);
      }
      if (update.sessionUpdate === 'available_commands_update') {
        commandUpdates.push(update.availableCommands as Record<string, unknown>[]);
      }
    })
    .onRequest(acpV1.CLIENT_METHODS.session_request_permission, async ({ params }) => {
      permissionRequests.push(params);
      const optionId = options.answers.shift();
      if (optionId === undefined) throw new Error('the client was asked with no answer scripted');
      return { outcome: { outcome: 'selected', optionId } as acpV1.RequestPermissionOutcome };
    })
    .connectWith(agentApp, async (ctx) => {
      await ctx.request(acpV1.AGENT_METHODS.initialize, {
        protocolVersion: acpV1.PROTOCOL_VERSION,
        clientInfo: { name: 'ext-142-v1-client', version: '0.0.0' },
      });
      const created = await ctx.request(acpV1.AGENT_METHODS.session_new, {
        cwd: options.cwd,
        mcpServers: [],
      });
      await settle();

      const prompt = async (text: string): Promise<void> => {
        await ctx.request(acpV1.AGENT_METHODS.session_prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text }],
        });
      };

      await options.run({ prompt, messages, permissionRequests, commandUpdates });
    });
}

let priorProjectDir: string | undefined;
let priorInitCwd: string | undefined;

beforeEach(() => {
  priorProjectDir = peekProjectDir();
  priorInitCwd = process.env.INIT_CWD;
  setProjectDir(projectDir);
  // A DIFFERENT directory from any workspace, so a loader reading the ambient cwd would find the
  // wrong config rather than accidentally agreeing with the right answer.
  process.env.INIT_CWD = projectDir;
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  // The production loader assigns INIT_CWD, a process-global that outlives the connection.
  if (priorInitCwd === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = priorInitCwd;
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

describe('[[EXT-142]] the commands an ACP session advertises', () => {
  /**
   * The bridge itself. Without the update the client draws no command, the user has nothing to
   * invoke, and every cell below would still pass by sending the text by hand — which is why this
   * is asserted separately from what the command does.
   */
  it('tells a v2 client about /approvals before anything is prompted', async () => {
    const agent = new GatedShellAgent(GATED_COMMAND);
    await driveV2({
      cwd: workspaceWith('v2-advertise'),
      agent,
      answers: [],
      run: async (drive) => {
        expect(drive.commandUpdates).toHaveLength(1);
        const commands = drive.commandUpdates[0];
        expect(commands.map((command) => command.name)).toEqual(['approvals']);
        // A name with no description is a row the client renders blank, which is a command nobody
        // can tell the purpose of — the same dead end one step along.
        expect(commands[0].description).toContain('refused');
        // v2's command input is a DISCRIMINATED union; a payload with no `type` presents as the
        // open "future variant" arm. The hint is what tells the user the command takes a number.
        expect(commands[0].input).toEqual({
          type: 'text',
          hint: 'undeny <number> to lift a refusal, or leave empty to list them',
        });
      },
    });
  });

  /**
   * **v1 carries the same update, and v1 is what Zed speaks.** Asserting this on v2 alone would
   * measure the bridge on the draft protocol and infer it on the shipping one — and the two apps
   * build their payloads independently, because the dialects spell the input differently.
   */
  it('tells a v1 client about /approvals too, in v1’s own input shape', async () => {
    const agent = new GatedShellAgent(GATED_COMMAND);
    await driveV1({
      cwd: workspaceWith('v1-advertise'),
      agent,
      answers: [],
      run: async (drive) => {
        expect(drive.commandUpdates).toHaveLength(1);
        const commands = drive.commandUpdates[0];
        expect(commands.map((command) => command.name)).toEqual(['approvals']);
        // v1's only input variant is unstructured and carries NO discriminator, so a `type` here
        // would be an unrecognised key rather than the tag it is in v2.
        expect(commands[0].input).toEqual({
          hint: 'undeny <number> to lift a refusal, or leave empty to list them',
        });
      },
    });
  });
});

describe('[[EXT-142]] a refusal saved from an ACP client can be lifted from that client', () => {
  /**
   * **The node's acceptance, driven end to end in one session.**
   *
   * Five turns: the call is refused and remembered, the same call is then refused WITHOUT asking,
   * the list shows it, the lift removes it, and the call after that is asked about again. Both
   * halves of the gate's behaviour are asserted — the silence before the lift and the question
   * after it — because either alone is satisfied by a fixture that stopped offering the call.
   */
  it('lists it, lifts it, and the next call is asked about again (v2)', async () => {
    const cwd = workspaceWith('v2-roundtrip');
    const agent = new GatedShellAgent(GATED_COMMAND);
    // No `.gsloth` directory in the fixture, so this is where the deny file lands.
    const denyFile = join(cwd, 'shell-denylist.json');

    await driveV2({
      cwd,
      agent,
      answers: ['reject-always', 'reject-once'],
      run: async (drive) => {
        await drive.prompt('run it');
        expect(drive.permissionRequests).toHaveLength(1);
        // The answer LANDED as a save — asserted from the surface's own sentence and from the file
        // it claims, because the rest of this cell is about lifting something that was saved.
        expect(drive.messages.join('\n')).toContain('Rejected and remembered');
        expect(existsSync(denyFile)).toBe(true);
        expect(readFileSync(denyFile, 'utf8')).toContain(GATED_COMMAND);

        // The saved refusal is in force: the same call is refused with nobody asked.
        await drive.prompt('run it again');
        expect(drive.permissionRequests).toHaveLength(1);
        expect(agent.decisions).toHaveLength(2);
        expect(agent.decisions[1].type).toBe('reject');

        // And it is FINDABLE — which is the whole defect. One entry, numbered, and saying which of
        // the three lists holds it.
        await drive.prompt('/approvals');
        const listed = drive.messages[drive.messages.length - 1];
        expect(listed).toContain('Refused calls: 1');
        expect(listed).toContain(`1. ${GATED_COMMAND}`);
        expect(listed).toContain('saved to this project');

        await drive.prompt('/approvals undeny 1');
        const lifted = drive.messages[drive.messages.length - 1];
        expect(lifted).toContain('Refusal lifted');
        expect(lifted).not.toContain('still refused');
        // Gone from the file as well as from the session, or it returns tomorrow.
        expect(readFileSync(denyFile, 'utf8')).not.toContain(GATED_COMMAND);

        // The acceptance's last clause: the next call is asked about again.
        await drive.prompt('run it once more');
        expect(drive.permissionRequests).toHaveLength(2);
        expect(agent.decisions).toHaveLength(3);

        // And the list is empty, said in words rather than by silence.
        await drive.prompt('/approvals');
        expect(drive.messages[drive.messages.length - 1]).toContain('Nothing is refused');
      },
    });
  });

  /**
   * **The same round trip in v1**, the dialect Zed speaks. The v1 app dispatches the command from
   * its own prompt handler and answers in its own update shape, so nothing above proves this.
   */
  it('lists it, lifts it, and the next call is asked about again (v1)', async () => {
    const cwd = workspaceWith('v1-roundtrip');
    const agent = new GatedShellAgent(GATED_COMMAND);
    const denyFile = join(cwd, 'shell-denylist.json');

    await driveV1({
      cwd,
      agent,
      answers: ['reject-always', 'reject-once'],
      run: async (drive) => {
        await drive.prompt('run it');
        expect(drive.permissionRequests).toHaveLength(1);
        expect(drive.messages.join('\n')).toContain('Rejected and remembered');
        expect(existsSync(denyFile)).toBe(true);

        await drive.prompt('run it again');
        expect(drive.permissionRequests).toHaveLength(1);

        await drive.prompt('/approvals');
        const listed = drive.messages[drive.messages.length - 1];
        expect(listed).toContain('Refused calls: 1');
        expect(listed).toContain('saved to this project');

        await drive.prompt('/approvals undeny 1');
        expect(drive.messages[drive.messages.length - 1]).toContain('Refusal lifted');
        expect(readFileSync(denyFile, 'utf8')).not.toContain(GATED_COMMAND);

        await drive.prompt('run it once more');
        expect(drive.permissionRequests).toHaveLength(2);
      },
    });
  });

  /**
   * **The control that must NOT change.** `approvals.deny` is a file the user wrote, and no session
   * command rewrites somebody's config out from under them — so a configured entry is listed,
   * reported, and left exactly where it is.
   *
   * Its own cell rather than a line in the one above, because breaking the lift would satisfy this
   * assertion too: a lift path that does nothing refuses a configured entry just as well as a
   * correct one. What pins it here is that the notice NAMES the config file and that the call is
   * still refused afterwards with nobody asked.
   */
  it('reports a configured refusal instead of lifting it, and leaves it in force', async () => {
    const configured = 'curl configured.example';
    const cwd = workspaceWith('v2-configured', {
      approvals: { deny: [{ type: 'shell', matcher: 'exact', pattern: configured }] },
    });
    const agent = new GatedShellAgent(configured);

    await driveV2({
      cwd,
      agent,
      answers: [],
      run: async (drive) => {
        await drive.prompt('/approvals');
        const listed = drive.messages[drive.messages.length - 1];
        expect(listed).toContain('Refused calls: 1');
        expect(listed).toContain(`1. ${configured}`);
        expect(listed).toContain('from your approvals.deny');

        await drive.prompt('/approvals undeny 1');
        const refused = drive.messages[drive.messages.length - 1];
        expect(refused).toContain('That refusal is in your config');
        expect(refused).toContain('Nothing was changed');
        expect(refused).not.toContain('Refusal lifted');

        // Still in force, and still not liftable: the call is refused with nobody asked, and the
        // entry is still on the list under the same origin.
        await drive.prompt('run it');
        expect(drive.permissionRequests).toHaveLength(0);
        expect(agent.decisions[0]?.type).toBe('reject');

        await drive.prompt('/approvals');
        expect(drive.messages[drive.messages.length - 1]).toContain('from your approvals.deny');
      },
    });
  });

  /**
   * **The three origins, in one list, told apart.**
   *
   * The node turns on this: a list that shows entries without saying which of the three each is
   * leaves the user unable to tell what they can lift. All three are produced for real —
   *
   * - `config`    — an `approvals.deny` entry in the fixture's own config file.
   * - `persisted` — a deny file seeded in the project before the session reads it.
   * - `session`   — a *Reject and remember* whose file write could not land, which is the one case
   *   that produces a session-scoped refusal on this surface. The directory holding the deny file
   *   is removed after the store has been read, so the write fails on a path rather than on a
   *   permission, which behaves the same on every platform.
   */
  it('keeps configured, saved and session refusals distinguishable in one list', async () => {
    const configured = 'curl configured.example';
    const saved = 'curl saved.example';
    const sessionOnly = 'curl session.example';
    const cwd = workspaceWith('v2-origins', {
      approvals: { deny: [{ type: 'shell', matcher: 'exact', pattern: configured }] },
    });
    const agent = new GatedShellAgent(sessionOnly);
    const settingsDir = join(cwd, '.gsloth', '.gsloth-settings');

    await driveV2({
      cwd,
      agent,
      answers: ['reject-always'],
      run: async (drive) => {
        // Seeded AFTER `session/new`, so the config the loader discovered is the one written above
        // and the `.gsloth` directory cannot change what it found.
        mkdirSync(settingsDir, { recursive: true });
        writeFileSync(
          join(settingsDir, 'shell-denylist.json'),
          JSON.stringify({
            version: 2,
            grants: [
              {
                entry: { type: 'shell', matcher: 'exact', pattern: saved },
                grantedAt: '2026-01-01T00:00:00.000Z',
                scope: 'always',
              },
            ],
          })
        );

        // This read is what loads the persisted store — once per runner — so everything after it
        // writes to a path that is about to stop existing.
        await drive.prompt('/approvals');
        expect(drive.messages[drive.messages.length - 1]).toContain('Refused calls: 2');

        rmSync(join(cwd, '.gsloth'), { recursive: true, force: true });

        await drive.prompt('run it');
        expect(drive.permissionRequests).toHaveLength(1);
        // The save did NOT land, which is what makes this refusal session-scoped rather than a
        // third saved one — asserted here so the origin below is not an accident.
        expect(drive.messages.join('\n')).toContain('Rejected for this session only');

        await drive.prompt('/approvals');
        const listed = drive.messages[drive.messages.length - 1];
        expect(listed).toContain('Refused calls: 3');
        // Each entry against its own origin label, rather than "all three labels appear somewhere":
        // a list that put the wrong label on each line would satisfy the weaker assertion.
        expect(listed).toContain(`${configured} — from your approvals.deny`);
        expect(listed).toContain(`${saved} — saved to this project`);
        expect(listed).toContain(`${sessionOnly} — this conversation only`);
      },
    });
  });

  /**
   * The arms this surface does not offer, answered rather than guessed at. `/approvals bypass`
   * parses — the parser is shared with the terminal — so without a branch for it the user would
   * read a successful-looking list in answer to a command that changed nothing.
   */
  it('explains the verbs it does not offer instead of silently listing', async () => {
    const agent = new GatedShellAgent(GATED_COMMAND);
    await driveV2({
      cwd: workspaceWith('v2-unsupported'),
      agent,
      answers: [],
      run: async (drive) => {
        await drive.prompt('/approvals bypass');
        const said = drive.messages[drive.messages.length - 1];
        expect(said).toContain('Nothing was changed');
        expect(said).not.toContain('Refused calls');

        // A mistyped number is explained rather than coerced, because this command REMOVES a
        // protection and a coerced argument would remove a different one than the user named.
        await drive.prompt('/approvals undeny two');
        expect(drive.messages[drive.messages.length - 1]).toContain('Not a refusal number: two');
      },
    });
  });

  /**
   * The command layer must not swallow ordinary prompts. A prompt that merely mentions the word
   * still reaches the model, which is what the `decisions` here prove: the turn ran, the gate was
   * asked, and nothing was intercepted.
   */
  it('leaves an ordinary prompt alone', async () => {
    const agent = new GatedShellAgent(GATED_COMMAND);
    await driveV2({
      cwd: workspaceWith('v2-ordinary'),
      agent,
      answers: ['reject-once'],
      run: async (drive) => {
        await drive.prompt('what does the approvals command do?');
        expect(drive.permissionRequests).toHaveLength(1);
        expect(agent.decisions).toHaveLength(1);
      },
    });
  });
});
