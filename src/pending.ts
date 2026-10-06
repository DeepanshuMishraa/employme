import { Applications } from "./applications";
import { Apply } from "./apply";
import { Drafts } from "./drafts";

/**
 * Work that is waiting on the user's reply. Each chat message starts without the tool results of
 * earlier ones, so this is put in front of the model every turn. Without it, "send" arrives with
 * nothing to send and the agent starts over.
 */
const describe = () => {
  const blocks: string[] = [];

  const draft = Drafts.latestPending();
  if (draft) {
    blocks.push(
      `EMAIL DRAFT AWAITING HIS DECISION (draftId ${draft.id})\nTo: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}\n\n` +
        "If his message approves it (send, yes, confirm, go ahead, looks good), call send_email_draft right now with no changes and no further questions. " +
        "If he asks for changes, call draft_email with the revised text. If he says no or cancel, call discard_email_draft. Never create a new draft just because he replied."
    );
  }

  const open = Apply.activeApplication();
  const application = open ? Applications.get(open.id) : null;
  if (open && application?.status === "prepared") {
    blocks.push(
      `APPLICATION FILLED AND AWAITING HIS DECISION (id ${open.id}, ${open.url})\n` +
        "If his message approves it (submit, send, yes, confirm, go ahead), call submit_application with this id right now. Do not call prepare_application again. " +
        "If he wants a change, say what you can change and re-run prepare_application only after he gives the new fact."
    );
  }

  return blocks.length === 0 ? "" : `\n\nPENDING ITEMS (state from the system, not from the user):\n${blocks.join("\n\n")}\n`;
};

export const PendingWork = { describe } as const;
