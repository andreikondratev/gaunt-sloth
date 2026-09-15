import { describe, expect, it } from 'vitest';
import type { ToolResultRecord } from '#src/types.js';

/** Shorthand for one captured tool result. */
function result(name: string, isError: boolean, content?: string): ToolResultRecord {
  return { name, isError, ...(content !== undefined ? { content } : {}) };
}

describe('runToolResultChecks — must_error', () => {
  it('passes when a tool matching the pattern returned an error', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks(
      [result('mcp__authz__get_data', true, '{"error":"denied"}')],
      { mustError: ['mcp__authz__*'], toolResultJsonPath: [] }
    );
    expect(failures).toEqual([]);
  });

  it('fails with the exact message when the matching tool succeeded', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('mcp__authz__get_data', false, '{"rows":[]}')], {
      mustError: ['mcp__authz__get_data'],
      toolResultJsonPath: [],
    });
    expect(failures).toEqual(['tool "mcp__authz__get_data" did not return an error']);
  });

  it('fails when no tool matching the pattern was called at all', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('read_file', false, 'body')], {
      mustError: ['mcp__*'],
      toolResultJsonPath: [],
    });
    expect(failures).toEqual(['tool "mcp__*" did not return an error']);
  });

  it('passes when ANY of several same-named calls errored (retry-then-denied trace)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks(
      [result('mcp__x__y', false, 'ok'), result('mcp__x__y', true, 'denied')],
      { mustError: ['mcp__x__y'], toolResultJsonPath: [] }
    );
    expect(failures).toEqual([]);
  });

  it('grades each pattern independently (one miss = one failure line)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('mcp__a__x', true)], {
      mustError: ['mcp__a__*', 'mcp__b__*'],
      toolResultJsonPath: [],
    });
    expect(failures).toEqual(['tool "mcp__b__*" did not return an error']);
  });
});

describe('runToolResultChecks — tool_result_json_path', () => {
  it('passes an equals check against a matching JSON payload', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks(
      [result('mcp__authz__get_data', true, '{"error":{"code":"MODULE_DISABLED"}}')],
      {
        mustError: [],
        toolResultJsonPath: [
          { tool: 'mcp__authz__*', path: 'error.code', equals: 'MODULE_DISABLED' },
        ],
      }
    );
    expect(failures).toEqual([]);
  });

  it('fails an equals check on a wrong value, quoting actual vs expected', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks(
      [result('mcp__authz__get_data', false, '{"error":{"code":"OTHER"}}')],
      {
        mustError: [],
        toolResultJsonPath: [
          { tool: 'mcp__authz__*', path: 'error.code', equals: 'MODULE_DISABLED' },
        ],
      }
    );
    expect(failures).toEqual([
      'tool_result_json_path "error.code" (tool "mcp__authz__*"): is "OTHER", expected "MODULE_DISABLED"',
    ]);
  });

  it('passes a contains check on a substring of a string value', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks(
      [result('mcp__x__y', false, '{"message":"access denied for caller"}')],
      {
        mustError: [],
        toolResultJsonPath: [{ tool: 'mcp__x__y', path: 'message', contains: 'denied' }],
      }
    );
    expect(failures).toEqual([]);
  });

  it('fails a contains check against a non-string value', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('mcp__x__y', false, '{"message":42}')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 'mcp__x__y', path: 'message', contains: 'denied' }],
    });
    expect(failures).toEqual([
      'tool_result_json_path "message" (tool "mcp__x__y"): is 42 (contains check requires a string)',
    ]);
  });

  it('treats an entry with neither equals nor contains as a pure existence check', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const pass = runToolResultChecks([result('t', false, '{"data":{"rows":[]}}')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 't', path: 'data.rows' }],
    });
    expect(pass).toEqual([]);
    const fail = runToolResultChecks([result('t', false, '{"data":{}}')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 't', path: 'data.rows' }],
    });
    expect(fail).toEqual(['tool_result_json_path "data.rows" (tool "t"): path did not resolve']);
  });

  it('asserts an explicit `equals: null` (key presence, not value-definedness)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('t', false, '{"data":null}')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 't', path: 'data', equals: null }],
    });
    expect(failures).toEqual([]);
  });

  it('fails deterministically (no throw) on a NON-JSON payload', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('t', true, 'Error: access denied')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 't', path: 'error.code', equals: 'X' }],
    });
    expect(failures).toEqual([
      'tool_result_json_path "error.code" (tool "t"): result payload is not JSON',
    ]);
  });

  it('fails deterministically on an ABSENT payload (no content captured)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('t', true)], {
      mustError: [],
      toolResultJsonPath: [{ tool: 't', path: 'error' }],
    });
    expect(failures).toEqual([
      'tool_result_json_path "error" (tool "t"): result payload is not JSON',
    ]);
  });

  it('fails with a distinct message when NO tool result matches the tool pattern', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('read_file', false, '{}')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 'mcp__*', path: 'error' }],
    });
    expect(failures).toEqual([
      'tool_result_json_path "error" (tool "mcp__*"): no result from a matching tool',
    ]);
  });

  it('passes when ANY matching result satisfies the check (several calls, one denial)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks(
      [
        result('mcp__x__y', false, 'not json at all'),
        result('mcp__x__y', true, '{"error":{"code":"DENIED"}}'),
      ],
      {
        mustError: [],
        toolResultJsonPath: [{ tool: 'mcp__x__*', path: 'error.code', equals: 'DENIED' }],
      }
    );
    expect(failures).toEqual([]);
  });

  it('reports DISTINCT per-result reasons once each when every matching result fails', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks(
      [
        result('mcp__x__y', false, 'not json'),
        result('mcp__x__y', false, 'still not json'),
        result('mcp__x__y', false, '{"error":{}}'),
      ],
      {
        mustError: [],
        toolResultJsonPath: [{ tool: 'mcp__x__*', path: 'error.code' }],
      }
    );
    expect(failures).toEqual([
      'tool_result_json_path "error.code" (tool "mcp__x__*"): ' +
        'result payload is not JSON; path did not resolve',
    ]);
  });

  it('supports the indexed-path form on a tool payload (same evaluator as json_path)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('t', false, '{"items":[{"scope":"caller"}]}')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 't', path: '$.items[0].scope', equals: 'caller' }],
    });
    expect(failures).toEqual([]);
  });

  it('passes trivially when both assertion lists are empty (nothing to assert)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    expect(
      runToolResultChecks([result('anything', true, 'x')], {
        mustError: [],
        toolResultJsonPath: [],
      })
    ).toEqual([]);
  });

  // BATCH-43 — an errored MCP tool's observed payload is the adapter's prose-prefixed message and
  // will never parse. Capture records the server's own error body beside it, and the check grades
  // that when it is there.
  it('grades the recovered MCP error body while the observed payload stays un-parseable', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const observed =
      "MCP tool 'contract_search' on server 'unimarket' returned an error: " +
      '{"code":"forbidden","reason":"identity lacks scope contracts:read"}';
    const record: ToolResultRecord = {
      name: 'mcp__unimarket__contract_search',
      isError: true,
      content: observed,
      errorPayload: '{"code":"forbidden","reason":"identity lacks scope contracts:read"}',
    };

    expect(
      runToolResultChecks([record], {
        mustError: ['mcp__unimarket__*'],
        toolResultJsonPath: [
          { tool: 'mcp__unimarket__*', path: 'code', equals: 'forbidden' },
          { tool: 'mcp__unimarket__*', path: 'reason', contains: 'contracts:read' },
        ],
      })
    ).toEqual([]);

    // The half that must not be traded away for the half above: strip the recovered body and the
    // very same assertions go back to failing on the untouched observed payload.
    expect(
      runToolResultChecks([{ ...record, errorPayload: undefined }], {
        mustError: [],
        toolResultJsonPath: [{ tool: 'mcp__unimarket__*', path: 'code', equals: 'forbidden' }],
      })
    ).toEqual([
      'tool_result_json_path "code" (tool "mcp__unimarket__*"): result payload is not JSON',
    ]);
  });

  it('still reads content when no MCP error body was recovered (unchanged behaviour)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('read_file', false, '{"lines":3}')], {
      mustError: [],
      toolResultJsonPath: [{ tool: 'read_file', path: 'lines', equals: 3 }],
    });
    expect(failures).toEqual([]);
  });

  it('combines a must_error miss and a json_path failure (the acceptance shape)', async () => {
    const { runToolResultChecks } = await import('#src/toolResultChecks.js');
    const failures = runToolResultChecks([result('mcp__x__y', false, '{"rows":[1,2]}')], {
      mustError: ['mcp__x__y'],
      toolResultJsonPath: [{ tool: 'mcp__x__y', path: 'error.code', equals: 'DENIED' }],
    });
    expect(failures).toEqual([
      'tool "mcp__x__y" did not return an error',
      'tool_result_json_path "error.code" (tool "mcp__x__y"): path did not resolve',
    ]);
  });
});
