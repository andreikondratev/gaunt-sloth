import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import { SelectList, type SelectItem } from '#src/tui/components/SelectList.js';
import type { SlashCommandNotice } from '@gaunt-sloth/agent/modules/slashCommands.js';
import type { ConversationSummary } from '@gaunt-sloth/core/history/historyStore.js';

/**
 * GS2-112 — the picker's heading, exported so a spec can assert it is present here and **absent**
 * from the readline notice. A literal in the spec would stop asserting anything the moment this
 * wording changed, which is exactly the shape of mistake the absence check exists to catch: one
 * surface's copy leaking into the other's.
 */
export const RESUME_PICKER_TITLE = 'Pick a conversation to resume:';

/**
 * GS2-112 — the controls line under the rows. True as written because the list turns filtering
 * off: with a filter available the first Esc would clear it rather than close the picker, and this
 * line would be promising something the widget does not do on the first press.
 */
export const RESUME_PICKER_FOOTER = '↑↓ to move · Enter to resume · Esc to stay here';

/** How much of the last prompt a row shows before it is clipped. */
const PREVIEW_CHARS = 40;

/**
 * GS2-112 — one conversation as one picker row.
 *
 * The parts and their order are `formatConversationList`'s (id, when, command, model, turn count,
 * a preview of the last prompt), because a person who has run `gth history list` should recognise
 * the row. It is **not** that function: a `SelectItem` is a single `label`, and the printed list
 * spends a second, indented line on the preview. So the preview is folded onto the same line after
 * a `·` and clipped hard, and a conversation whose turns span a period shows the last of them
 * rather than a `first → last` range. That is a layout difference forced by the medium, not a
 * second copy of any authored sentence — there is no prose here to diverge.
 *
 * The id leads the row because it is what the user asked for by name (`/resume <id>` still works,
 * `/status` prints it, and `gth history list` lists it), and because it makes a highlighted row
 * identifiable in a spec assertion.
 */
export function resumeRowLabel(summary: ConversationSummary): string {
  const parts = [`#${summary.id}`, summary.lastTs ?? summary.firstTs ?? summary.startedTs];
  if (summary.command) parts.push(`[${summary.command}]`);
  if (summary.model) parts.push(summary.model);
  parts.push(`(${summary.turnCount} ${summary.turnCount === 1 ? 'turn' : 'turns'})`);
  const row = parts.join('  ');
  const preview = (summary.lastPrompt ?? '').replace(/\s+/g, ' ').trim();
  if (!preview) return row;
  const clipped =
    preview.length > PREVIEW_CHARS ? `${preview.slice(0, PREVIEW_CHARS - 1)}…` : preview;
  return `${row}  · ${clipped}`;
}

/**
 * GS2-112 — what a cancelled picker says. It lives here, beside the picker, rather than with the
 * shared resume notices in `sessionResume.ts`: no other surface can cancel a picker, because no
 * other surface has one, and a sentence about a keystroke in the module both surfaces read from is
 * how the readline session ends up describing a widget it does not have.
 */
export function resumeCancelledNotice(): SlashCommandNotice {
  return {
    title: 'Resume cancelled',
    lines: ['You are still in the conversation you were in. Nothing was changed.'],
  };
}

/**
 * GS2-112 — the interactive bare-`/resume` picker: the resumable conversations as selectable rows,
 * on a TTY. Arrow keys move, Enter resumes the highlighted conversation, Esc leaves the session
 * where it is.
 *
 * Keyboard handling and cancellation are `SelectList`'s — the same widget the first-run dialog,
 * the slash-command menu and `/approvals` use — so the keys behave here as they do everywhere else
 * in the TUI. `Ctrl+C` is the app's, as it is for the approvals picker: this renders inside the
 * session's own Ink tree, so `<App>`'s ladder answers it and leaves the session. While it is
 * mounted the parent `<App>` suspends the prompt.
 *
 * **Type-to-filter is off** (`filterable={false}`), and that is a correctness choice rather than a
 * concession to the list being short. With filtering on, the first Esc clears the filter and only
 * a second one cancels — so Esc would stop being a single-press "leave everything alone", which is
 * the behaviour this picker is required to have and the behaviour its footer states. A stray
 * keystroke would also narrow the list to nothing and leave Enter with no row to pick. The list is
 * capped at the 20 candidates `listResumeCandidates` returns and scrolls within `SelectList`'s
 * window, so arrowing reaches every row.
 *
 * **It is never opened empty.** `<App>` commits the "nothing can be resumed" notice instead,
 * because a `SelectList` with no items renders `(no matches for "")` and Enter is inert — a modal
 * the user can only Esc out of, which is a worse answer than the sentence.
 */
export function ResumePicker({
  candidates,
  onSelect,
  onCancel,
}: {
  candidates: ConversationSummary[];
  /** Called with the chosen conversation's id. The parent performs the resume. */
  onSelect: (id: number) => void;
  /** Esc — leave the session in the conversation it is already in. */
  onCancel: () => void;
}): React.ReactElement {
  const items: SelectItem[] = candidates.map((candidate) => ({
    label: resumeRowLabel(candidate),
  }));
  return (
    <Box flexDirection="column">
      <Rule />
      <SelectList
        title={RESUME_PICKER_TITLE}
        items={items}
        filterable={false}
        // The chosen row's id, not its position: the parent resumes by id, and the list is a
        // snapshot that the resume itself invalidates.
        onSelect={(index) => onSelect(candidates[index].id)}
        onCancel={onCancel}
      />
      <Text dimColor>{`  ${RESUME_PICKER_FOOTER}`}</Text>
    </Box>
  );
}
