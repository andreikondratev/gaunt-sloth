/**
 * [[EXT-158]] — the detector, the gate, the repeat rule, and the seam that connects them.
 *
 * ## What each group of cells is allowed to claim
 *
 * The cells are split by what they actually exercise, because a suite that blurs that is how a
 * change ships with tests that would pass if it did nothing.
 *
 * - **The detector** runs on real `BaseMessage` objects. Nothing is stubbed; the input IS the
 *   contract, so there is nothing to substitute.
 * - **The gate and the repeat rule** run on real values through the real functions.
 * - **The seam** is the group that matters most. `throughARealGraph` builds an actual LangGraph
 *   `StateGraph` with a real `MemorySaver`, runs it, and points a real `GthAbstractAgent` at it —
 *   so the chain under test is the production one end to end: the checkpointer holds the messages,
 *   `getConversationMessages` reads them out of `state.values.messages`, and the detector runs on
 *   what it finds. **A cell that mocked `getConversationMessages` would pass with the state read
 *   deleted**, which is exactly the defect class this project cares most about, so none does.
 * - **The premise cell** pins the fact the whole node rests on and that nothing else here would
 *   catch: a turn that ends cleanly with a checklist outstanding classifies `completed`. If a later
 *   change reclassifies it, this reds — rather than the feature silently never firing again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { MemorySaver, MessagesAnnotation, START, END, StateGraph } from '@langchain/langgraph';
import {
  CHECKLIST_TOOL_NAME,
  OUTSTANDING_WORK_AUTOMATED_MARKER,
  OUTSTANDING_WORK_NOTICE_MAX_PER_SIGNATURE,
  detectOutstandingWork,
  latestChecklistInMessages,
  outstandingWorkNotice,
  parseChecklistToolArgs,
  shouldAnnounceOutstandingWork,
  type GthOutstandingWork,
} from '#src/core/outstandingWork.js';
import { terminationReason } from '#src/core/terminationReason.js';
import type { GthTerminationCategory } from '#src/core/terminationReason.js';

/**
 * The tool's rendered observation, reproduced here rather than imported.
 *
 * `formatChecklist` lives in `packages/agent`, which `core` cannot import — and this is a fixture
 * for the prose the reader must NOT read, so a local copy drifting from the real renderer would not
 * weaken anything. The glyphs match `gthChecklistTool.ts` so the fixture is realistic.
 */
function formatChecklist(items: Array<[string, string]>): string {
  const glyph: Record<string, string> = {
    completed: '[x]',
    in_progress: '[~]',
    pending: '[ ]',
  };
  const done = items.filter(([, status]) => status === 'completed').length;
  return [
    `Checklist (${done}/${items.length} completed):`,
    ...items.map(([content, status]) => `${glyph[status]} ${content}`),
  ].join('\n');
}

/** One `gth_checklist` tool call, in the shape an `AIMessage` carries it. */
function checklistCall(items: Array<[string, string]>, id = 'call-1') {
  return {
    id,
    name: CHECKLIST_TOOL_NAME,
    args: { items: items.map(([content, status]) => ({ content, status })) },
  };
}

/** The message pair a `gth_checklist` call actually produces: the call, then its observation. */
function checklistExchange(items: Array<[string, string]>, id = 'call-1'): BaseMessage[] {
  return [
    new AIMessage({ content: '', tool_calls: [checklistCall(items, id)] }),
    new ToolMessage({
      content: formatChecklist(items),
      tool_call_id: id,
      name: CHECKLIST_TOOL_NAME,
    }),
  ];
}

/** A finished turn: a user message, a checklist exchange, and a closing answer with no calls. */
function turnEndingWith(items: Array<[string, string]>, answer = 'Implementing that next.') {
  return [
    new HumanMessage('do the thing'),
    ...checklistExchange(items),
    new AIMessage({ content: answer }),
  ];
}

const PARTLY_DONE: Array<[string, string]> = [
  ['Read the config', 'completed'],
  ['Wire the write path', 'in_progress'],
  ['Thread the flag through init', 'pending'],
  ['Add a test', 'pending'],
];

describe('[[EXT-158]] the detector', () => {
  it('fires on the landmark shape: a clean answer with the checklist part done', () => {
    // The shape both Grok dumps recorded, twice, identically: one completed, one in_progress,
    // two pending, and a closing text segment announcing an action it never takes.
    const work = detectOutstandingWork(turnEndingWith(PARTLY_DONE));

    expect(work).toMatchObject({ outstanding: 3, completed: 1, total: 4, inProgress: 1 });
  });

  it('stays silent when every item is completed', () => {
    expect(
      detectOutstandingWork(
        turnEndingWith([
          ['Read the config', 'completed'],
          ['Add a test', 'completed'],
        ])
      )
    ).toBeNull();
  });

  /**
   * THE BOUND, stated as a test so a later reader finds it here rather than filing the silence as
   * a defect. `gth_checklist`'s own description tells the model to *"skip it for a single trivial
   * step"*, so a stop with no checklist is invisible to this detector — permanently, by design.
   */
  it('stays silent when the model kept no checklist at all — the stated bound', () => {
    expect(
      detectOutstandingWork([new HumanMessage('do the thing'), new AIMessage({ content: 'Done.' })])
    ).toBeNull();
  });

  it('stays silent when the last AI message is still requesting tools', () => {
    const messages = [
      new HumanMessage('do the thing'),
      ...checklistExchange(PARTLY_DONE),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call-2', name: 'read_file', args: { path: 'a.ts' } }],
      }),
    ];

    expect(detectOutstandingWork(messages)).toBeNull();
  });

  it('stays silent when the history ends on a tool result — that turn stopped elsewhere', () => {
    // A turn parked on an approval, aborted mid-drain or suspended ends here, and each of those
    // has its own termination category and its own notice. This one speaks only for a clean end.
    expect(detectOutstandingWork(checklistExchange(PARTLY_DONE))).toBeNull();
  });

  it('reads the NEWEST checklist call, because the tool is whole-list-replace', () => {
    const messages = [
      new HumanMessage('do the thing'),
      ...checklistExchange(PARTLY_DONE, 'call-1'),
      ...checklistExchange(
        [
          ['Read the config', 'completed'],
          ['Wire the write path', 'completed'],
          ['Thread the flag through init', 'completed'],
          ['Add a test', 'pending'],
        ],
        'call-2'
      ),
      new AIMessage({ content: 'Nearly there.' }),
    ];

    expect(detectOutstandingWork(messages)).toMatchObject({ outstanding: 1, completed: 3 });
  });

  /**
   * **The args are the contract; the observation is not.** `formatChecklist` renders the list as
   * markdown for the model to read back, and that prose is free to change wording at any time. This
   * cell proves the reader is keyed on the tool-call arguments by handing it a `ToolMessage` whose
   * CONTENT is a full rendered checklist with unticked boxes — and no tool call anywhere.
   */
  it('reads the tool-call ARGS, never the rendered observation prose', () => {
    const messages = [
      new HumanMessage('do the thing'),
      new ToolMessage({
        content: formatChecklist(PARTLY_DONE),
        tool_call_id: 'call-1',
        name: CHECKLIST_TOOL_NAME,
      }),
      new AIMessage({ content: 'Implementing that next.' }),
    ];

    expect(latestChecklistInMessages(messages)).toBeNull();
    expect(detectOutstandingWork(messages)).toBeNull();
  });

  it('ignores another tool with an items argument', () => {
    const messages = [
      new HumanMessage('do the thing'),
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call-9',
            name: 'some_other_tool',
            args: { items: [{ content: 'x', status: 'pending' }] },
          },
        ],
      }),
      new AIMessage({ content: 'Done.' }),
    ];

    expect(detectOutstandingWork(messages)).toBeNull();
  });

  it('survives malformed arguments rather than throwing on the path that explains a stop', () => {
    expect(parseChecklistToolArgs(undefined)).toBeNull();
    expect(parseChecklistToolArgs({})).toBeNull();
    expect(parseChecklistToolArgs({ items: 'not an array' })).toBeNull();
    expect(parseChecklistToolArgs({ items: [null, 7, 'x'] })).toBeNull();
    // A status outside the three literals is DROPPED, never coerced: a checklist whose statuses we
    // guessed at is worse evidence than no checklist.
    expect(parseChecklistToolArgs({ items: [{ content: 'a', status: 'blocked' }] })).toBeNull();
    expect(detectOutstandingWork(undefined)).toBeNull();
    expect(detectOutstandingWork([])).toBeNull();
  });
});

describe('[[EXT-158]] which endings this speaks for', () => {
  const work: GthOutstandingWork = {
    outstanding: 3,
    completed: 1,
    total: 4,
    inProgress: 1,
    signature: 'sig',
    repeat: false,
  };
  const reasonFor = (category: GthTerminationCategory) =>
    terminationReason('runner.events-completed', 'control', category);

  it('announces the clean stop — the one ending nothing else says anything about', () => {
    expect(shouldAnnounceOutstandingWork(work, reasonFor('completed'))).toBe(true);
  });

  /**
   * **Two cells for the error classes, not one, and they are two distinct members of the enum
   * rather than two readings of one did-it-error bit.** A turn the provider refused for quota and a
   * turn that hit a provider-side fault both END with the checklist outstanding, and neither is a
   * turn that "stopped with work outstanding" — the first was refused and the second faulted, and
   * `displayTermination` already says so in each case's own words. A gate that collapsed the
   * taxonomy back to a boolean would fire on both.
   */
  it('stays silent on a rate-limited refusal — that turn was refused, not abandoned', () => {
    expect(shouldAnnounceOutstandingWork(work, reasonFor('rate_limited'))).toBe(false);
  });

  it('stays silent on a provider fault — EXT-159 already announces it in its own words', () => {
    expect(shouldAnnounceOutstandingWork(work, reasonFor('provider_error'))).toBe(false);
  });

  /**
   * **The trap the positive gate exists to avoid.** `shouldAnnounceTermination` declines two
   * categories, and writing this gate as its complement would have looked like the natural reading
   * and been a defect: a `suspended` run is parked on a tool-approval interrupt with its checklist
   * outstanding BY CONSTRUCTION, because the work is mid-flight. Every gated tool call would have
   * drawn this notice. This cell goes red if the gate is ever rewritten that way.
   */
  it('stays silent on a suspended run, which is parked mid-work and not ended at all', () => {
    expect(shouldAnnounceOutstandingWork(work, reasonFor('suspended'))).toBe(false);
  });

  it('stays silent when nothing classified the ending, rather than assuming it completed', () => {
    expect(shouldAnnounceOutstandingWork(work, null)).toBe(false);
  });

  it('stays silent when there is nothing outstanding', () => {
    expect(shouldAnnounceOutstandingWork(null, reasonFor('completed'))).toBe(false);
  });
});

describe('[[EXT-158]] the notice', () => {
  const work: GthOutstandingWork = {
    outstanding: 3,
    completed: 1,
    total: 4,
    inProgress: 1,
    signature: 'sig',
    repeat: false,
  };

  it('states the counts and marks itself as the runtime automated observation', () => {
    const notice = outstandingWorkNotice(work);

    expect(notice.title).toContain('3 of 4');
    expect(notice.lines).toContain(OUTSTANDING_WORK_AUTOMATED_MARKER);
    expect(OUTSTANDING_WORK_AUTOMATED_MARKER.toLowerCase()).toContain('automated');
  });

  /**
   * §(3) — nothing this emits may be mistakable for the user's own words. The one reliable marker
   * for finding this failure in a transcript is a human typing "continue", and a product that
   * emitted a bare "continue" of its own would destroy that marker retroactively across every
   * future report.
   */
  it('never emits a bare continuation that could read as the user typing it', () => {
    const notice = outstandingWorkNotice(work);
    const text = [notice.title, ...notice.lines].join('\n');

    expect(text).not.toMatch(/^\s*continue\.?\s*$/i);
    expect(text).not.toMatch(/please continue/i);
    expect(text).not.toMatch(/what happend/i);
  });

  /**
   * **Counts only — the model's own item text never reaches the terminal through here.** Checklist
   * `content` is model-authored, which is why the TUI's reader neutralises it before it reaches a
   * panel. Rendering counts sidesteps that class rather than depending on a neutraliser staying
   * correct.
   */
  it('renders no item text at all', () => {
    const detected = detectOutstandingWork(turnEndingWith(PARTLY_DONE));
    const notice = outstandingWorkNotice({ ...detected!, repeat: false });
    const text = [notice.title, ...notice.lines].join('\n');

    for (const [content] of PARTLY_DONE) expect(text).not.toContain(content);
  });
});

describe('[[EXT-158]] the seam, driven through a real graph and a real agent', () => {
  let GthAbstractAgent: typeof import('#src/core/GthAbstractAgent.js').GthAbstractAgent;

  beforeEach(async () => {
    vi.resetModules();
    ({ GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js'));
  });

  /**
   * A real compiled LangGraph with a real `MemorySaver`, run once so the checkpointer actually
   * holds `messages` — then a real `GthAbstractAgent` pointed at it.
   *
   * Everything from here to the assertion is production code: `getConversationMessages` reads
   * `state.values.messages` off the checkpointer, and the detector runs on what comes back. Mocking
   * either would leave a cell that passes with the state read deleted.
   */
  async function throughARealGraph(messages: BaseMessage[]) {
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('emit', () => ({ messages }))
      .addEdge(START, 'emit')
      .addEdge('emit', END)
      .compile({ checkpointer: new MemorySaver() });
    const runConfig: RunnableConfig = { configurable: { thread_id: 'ext-158' } };
    await graph.invoke({ messages: [] }, runConfig);

    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* the graph is injected directly */
      }
    }
    const agent = new TestAgent(() => {});
    (agent as unknown as { agent: unknown }).agent = graph;
    return { agent, runConfig };
  }

  it('records the fact from the checkpointed conversation', async () => {
    const { agent, runConfig } = await throughARealGraph(turnEndingWith(PARTLY_DONE));

    await agent.noteOutstandingWork(runConfig);

    expect(agent.getOutstandingWork()).toMatchObject({
      outstanding: 3,
      completed: 1,
      total: 4,
      repeat: false,
    });
  });

  it('records nothing when the checkpointed conversation has no outstanding items', async () => {
    const { agent, runConfig } = await throughARealGraph(
      turnEndingWith([['Read the config', 'completed']])
    );

    await agent.noteOutstandingWork(runConfig);

    expect(agent.getOutstandingWork()).toBeNull();
  });

  /**
   * **The repeat rule, and it is keyed on the ITEMS rather than on the calls.** A stuck model
   * re-emits `gth_checklist` with an identical list turn after turn — the node's §(2) says so
   * explicitly — so a second, byte-identical call is NOT progress and must not re-announce.
   */
  it('announces one unchanged stalled state once, however many times the model re-emits it', async () => {
    const { agent, runConfig } = await throughARealGraph(turnEndingWith(PARTLY_DONE));

    await agent.noteOutstandingWork(runConfig);
    expect(agent.getOutstandingWork()?.repeat).toBe(false);

    // A second turn, and a second identical `gth_checklist` call inside it. Nothing moved.
    const again = await throughARealGraph([
      ...turnEndingWith(PARTLY_DONE),
      ...checklistExchange(PARTLY_DONE, 'call-3'),
      new AIMessage({ content: 'Implementing that next.' }),
    ]);
    (agent as unknown as { agent: unknown }).agent = (
      again.agent as unknown as { agent: unknown }
    ).agent;
    await agent.noteOutstandingWork(again.runConfig);

    expect(agent.getOutstandingWork()?.repeat).toBe(true);
    expect(
      shouldAnnounceOutstandingWork(
        agent.getOutstandingWork(),
        terminationReason('runner.completed', 'control', 'completed')
      )
    ).toBe(false);
  });

  it('announces again once the checklist actually changes — a state change is progress', async () => {
    const { agent, runConfig } = await throughARealGraph(turnEndingWith(PARTLY_DONE));
    await agent.noteOutstandingWork(runConfig);
    expect(agent.getOutstandingWork()?.repeat).toBe(false);

    const moved = await throughARealGraph(
      turnEndingWith([
        ['Read the config', 'completed'],
        ['Wire the write path', 'completed'],
        ['Thread the flag through init', 'in_progress'],
        ['Add a test', 'pending'],
      ])
    );
    (agent as unknown as { agent: unknown }).agent = (
      moved.agent as unknown as { agent: unknown }
    ).agent;
    await agent.noteOutstandingWork(moved.runConfig);

    expect(agent.getOutstandingWork()).toMatchObject({ outstanding: 2, repeat: false });
  });

  /**
   * An agent whose graph exposes no state records nothing rather than failing a turn that had
   * otherwise succeeded. `getConversationMessages` throws by design there, and a fact nobody could
   * read is "no fact".
   */
  it('records nothing, and does not throw, when the graph exposes no state', async () => {
    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* no graph at all */
      }
    }
    const agent = new TestAgent(() => {});

    await expect(agent.noteOutstandingWork({ configurable: {} })).resolves.toBeUndefined();
    expect(agent.getOutstandingWork()).toBeNull();
  });

  it('forgets the fact at a turn boundary but remembers what it has already announced', async () => {
    const { agent, runConfig } = await throughARealGraph(turnEndingWith(PARTLY_DONE));
    await agent.noteOutstandingWork(runConfig);
    expect(agent.getOutstandingWork()?.repeat).toBe(false);

    // `resetTerminationReason` is what the runner calls at each turn boundary.
    agent.resetTerminationReason();
    expect(agent.getOutstandingWork()).toBeNull();

    await agent.noteOutstandingWork(runConfig);
    expect(agent.getOutstandingWork()?.repeat).toBe(true);
  });
});

/**
 * **The named constant has to MOVE BEHAVIOUR, or it is decoration.**
 *
 * The module is re-imported with only {@link OUTSTANDING_WORK_NOTICE_MAX_PER_SIGNATURE} replaced —
 * everything else, the detector included, stays the real implementation — and the agent that
 * consumes it is re-imported against that. If the constant is ever inlined, ignored, or replaced by
 * a literal at the comparison, this cell goes red.
 */
describe('[[EXT-158]] the announce budget is a named constant whose value decides behaviour', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is one — one announcement per unchanged stalled state', () => {
    expect(OUTSTANDING_WORK_NOTICE_MAX_PER_SIGNATURE).toBe(1);
  });

  it('announces nothing at all when the budget is moved to zero', async () => {
    vi.doMock('#src/core/outstandingWork.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('#src/core/outstandingWork.js')>()),
      OUTSTANDING_WORK_NOTICE_MAX_PER_SIGNATURE: 0,
    }));
    const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');

    const graph = new StateGraph(MessagesAnnotation)
      .addNode('emit', () => ({ messages: turnEndingWith(PARTLY_DONE) }))
      .addEdge(START, 'emit')
      .addEdge('emit', END)
      .compile({ checkpointer: new MemorySaver() });
    const runConfig: RunnableConfig = { configurable: { thread_id: 'ext-158-budget' } };
    await graph.invoke({ messages: [] }, runConfig);

    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* the graph is injected directly */
      }
    }
    const agent = new TestAgent(() => {});
    (agent as unknown as { agent: unknown }).agent = graph;

    await agent.noteOutstandingWork(runConfig);

    // The fact is still DETECTED — only the announcement is withheld, which is what a budget of
    // zero should mean and is a different thing from the detector going blind.
    expect(agent.getOutstandingWork()).toMatchObject({ outstanding: 3, repeat: true });
  });
});
