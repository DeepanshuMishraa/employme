import { tool } from "ai";
import { z } from "zod";
import { Applications } from "./applications";
import { Apply } from "./apply";
import { Drafts } from "./drafts";
import { Gmail } from "./gmail";
import { Profile } from "./profile";
import { Writing } from "./writing";

const IP_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$|:/;

/** Application pages must be public https sites. Blocks local and private targets before the browser opens them. */
const applicationUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const isPublic = url.protocol === "https:" && host.includes(".") && !IP_LITERAL.test(host) && host !== "localhost" && !host.endsWith(".local");
    return isPublic ? url.toString() : null;
  } catch {
    return null;
  }
};

/** Tools that act on the user's behalf. `turnId` identifies the current user message for approval gating. */
export const createApplyTools = (turnId: string) => ({
  connect_gmail: tool({
    description: "Check whether Gmail is connected. If not, returns a Google sign-in link for the user to open. Gmail is used to read emailed verification codes and to create and send approved email drafts.",
    inputSchema: z.object({}),
    execute: async () => {
      if (await Gmail.isConnected()) return { connected: true as const };
      const url = Gmail.authUrl();
      return url.ok ? { connected: false as const, authUrl: url.value } : { connected: false as const, error: url.error };
    }
  }),

  view_profile: tool({
    description: "Show every fact saved about the user (contact, links, visa, relocation, demographics). Check this before asking the user anything.",
    inputSchema: z.object({}),
    execute: async () => ({ facts: (await Profile.load()).map(({ key, value, source, date }) => ({ key, value, source, date })) })
  }),

  save_profile_facts: tool({
    description: "Save facts the user just told you so they are never asked again. Keys are dotted, e.g. contact.phone, visa.sponsorship.US, relocation.open, demographics.gender, agreement.arbitration.<company>. Use the value 'decline' when the user prefers not to answer a demographic question. Only save what the user actually said.",
    inputSchema: z.object({
      facts: z.array(z.object({ key: z.string(), value: z.string().min(1) })).min(1)
    }),
    execute: async ({ facts }) => {
      const invalid = facts.filter(({ key }) => !Profile.isValidKey(key)).map(({ key }) => key);
      if (invalid.length > 0) return { saved: 0, error: `Invalid keys: ${invalid.join(", ")}. Use letters, digits, dots, dashes.` };
      const profile = facts.reduce((current, { key, value }) => Profile.set(current, key, value, "user"), await Profile.load());
      await Profile.save(profile);
      return { saved: facts.length };
    }
  }),

  prepare_application: tool({
    description: "Open a job application page, read its form, and fill it from the saved profile and resume. It never submits. If it needs facts that are not in the profile it returns questions instead: ask the user ONE message with all of them, save the replies with save_profile_facts, then call this again with the same url. When ready, show the user what was filled (flag anything generated and anything unfilled) and wait for their approval before submit_application.",
    inputSchema: z.object({ url: z.string().describe("Direct application link (https).") }),
    execute: async ({ url }) => {
      const safe = applicationUrl(url);
      if (!safe) return { status: "failed" as const, error: "Only public https application links are allowed." };
      return Apply.prepare(safe, turnId);
    }
  }),

  submit_application: tool({
    description: "Submit a prepared application. Requires the user to have approved the filled form in a message AFTER prepare_application ran; calls in the same turn are refused. If the site emails a verification code and Gmail is not connected, the result is needs_code: ask the user for the code and call again with securityCode.",
    inputSchema: z.object({ id: z.number().int(), securityCode: z.string().optional() }),
    execute: ({ id, securityCode }) => Apply.submit(id, turnId, securityCode)
  }),

  list_applications: tool({
    description: "List recent applications with their status.",
    inputSchema: z.object({ limit: z.number().int().positive().max(50).optional() }),
    execute: async ({ limit }) => ({
      applications: Applications.list(limit ?? 20).map(({ id, url, status, note, updatedAt }) => ({ id, url, status, note, updatedAt }))
    })
  }),

  draft_email: tool({
    description: "Create a Gmail draft, for example outreach to a founder or recruiter, replacing any draft still waiting. Write it as the user would: short, specific, no em dashes. It is NOT sent. Reply with the full draft (to, subject, body) and ask him to confirm. Call this only for a new email or a requested revision, never because he answered a pending draft.",
    inputSchema: z.object({ to: z.string().email(), subject: z.string().min(1), body: z.string().min(1) }),
    execute: async ({ to, subject, body }) => {
      const cleaned = { subject: Writing.clean(subject), body: Writing.clean(body) };
      const created = await Gmail.createDraft(to, cleaned.subject, cleaned.body);
      if (!created.ok) return { ok: false as const, error: created.error };
      for (const stale of Drafts.pendingIds()) {
        await Gmail.deleteDraft(stale);
        Drafts.markDiscarded(stale);
      }
      Drafts.add({ id: created.value, to, subject: cleaned.subject, body: cleaned.body, createdTurn: turnId });
      return { ok: true as const, draftId: created.value, to, subject: cleaned.subject, body: cleaned.body };
    }
  }),

  send_email_draft: tool({
    description: "Send the pending email draft once the user has approved it. Call it as soon as he says send, yes, confirm, or go ahead, with no draftId unless you have a specific one. Calls in the same turn the draft was created are refused.",
    inputSchema: z.object({ draftId: z.string().optional() }),
    execute: async ({ draftId }) => {
      const draft = draftId ? Drafts.get(draftId) : Drafts.latestPending();
      if (!draft) return { ok: false as const, error: "No pending draft to send. Nothing was sent." };
      if (draft.createdTurn === turnId) return { ok: false as const, error: "Show the user the draft and wait for their reply in a new message. Nothing was sent." };
      const sent = await Gmail.sendDraft(draft.id);
      if (!sent.ok) return { ok: false as const, error: sent.error };
      Drafts.markSent(draft.id);
      return { ok: true as const, sentTo: draft.to, subject: draft.subject };
    }
  }),

  discard_email_draft: tool({
    description: "Discard the pending email draft when the user says no or cancel.",
    inputSchema: z.object({}),
    execute: async () => {
      const draft = Drafts.latestPending();
      if (!draft) return { ok: true as const, discarded: 0 };
      await Gmail.deleteDraft(draft.id);
      Drafts.markDiscarded(draft.id);
      return { ok: true as const, discarded: 1 };
    }
  })
});
