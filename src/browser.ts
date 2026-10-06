import { Result } from "./result";

const BIN = new URL("../node_modules/.bin/agent-browser", import.meta.url).pathname;
const COMMAND_TIMEOUT_MS = 60_000;
const IGNORED_LABELS = new Set(["", "toggle flyout", "clear selections"]);

/** `choice` is a radio group or a row of answer buttons (Yes/No); the options are known up front. */
export type FieldKind = "text" | "select" | "checkbox" | "choice";

export type Field = {
  label: string;
  kind: FieldKind;
  required: boolean;
  value: string;
  ref: string;
  /** Position among fields with the same label, so repeated labels stay addressable. */
  ordinal: number;
  /** Known options. Set for choices; for dropdowns it is filled in later by reading the list. */
  options: string[] | null;
};

export type Node = { role: string; name: string; attrs: string[]; ref: string | null; value: string; depth: number };

type Choice = { name: string; ref: string };
type ChoiceGroup = { label: string; required: boolean; choices: Choice[] };

const NODE_LINE = /^\s*- (\S+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?:: (.*))?$/;
/** Longest button label that still counts as an answer choice (Yes, No, Prefer not to say). */
const MAX_CHOICE_CHARS = 40;
const MAX_GROUP_LABEL_CHARS = 300;

const FIELD_KINDS: Record<string, FieldKind> = { textbox: "text", combobox: "select", checkbox: "checkbox" };

const normalize = (label: string) => label.replace(/\s+/g, " ").trim();

const unescape = (name: string) => name.replace(/\\(["\\])/g, "$1");

/** Parses `agent-browser snapshot` output, one accessibility node per line. */
const parseSnapshot = (text: string): Node[] =>
  text.split("\n").flatMap((line) => {
    const match = NODE_LINE.exec(line);
    if (!match) return [];
    const [, role, name, attrs, value] = match;
    if (!role) return [];
    const attrList = attrs ? attrs.split(",").map((attr) => attr.trim()) : [];
    const ref = attrList.find((attr) => attr.startsWith("ref="))?.slice(4) ?? null;
    const depth = Math.floor(line.search(/\S/) / 2);
    return [{ role, name: unescape(name ?? ""), attrs: attrList, ref, value: value ?? "", depth }];
  });

/** Gives repeated labels a running ordinal so each stays addressable. */
const withOrdinals = (fields: Omit<Field, "ordinal">[]): Field[] => {
  const seen = new Map<string, number>();
  return fields.map((field) => {
    const ordinal = seen.get(field.label) ?? 0;
    seen.set(field.label, ordinal + 1);
    return { ...field, ordinal };
  });
};

const toFields = (nodes: Node[]): Field[] =>
  withOrdinals(
    nodes.flatMap((node) => {
      const kind = FIELD_KINDS[node.role];
      const label = normalize(node.name);
      if (!kind || !node.ref || IGNORED_LABELS.has(label.toLowerCase())) return [];
      return [{ label, kind, required: node.attrs.includes("required"), value: node.value, ref: node.ref, options: null }];
    })
  );

/** Text of the nodes nested under `nodes[index]`, with the "*" required marker split out. */
const subtreeText = (nodes: Node[], index: number) => {
  const root = nodes[index];
  const parts: string[] = [];
  let required = false;
  if (!root) return { text: "", required };
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= root.depth) break;
    if (node.role !== "StaticText") continue;
    if (node.name.trim() === "*") required = true;
    else parts.push(node.name);
  }
  return { text: normalize(parts.join(" ")).slice(0, MAX_GROUP_LABEL_CHARS), required };
};

/** Closest earlier node at exactly `depth`, stopping if the walk leaves that level's parent. */
const previousSibling = (nodes: Node[], index: number, depth: number) => {
  for (let i = index - 1; i >= 0; i--) {
    const node = nodes[i];
    if (!node || node.depth < depth) return -1;
    if (node.depth === depth) return i;
  }
  return -1;
};

const TEXTUAL_ROLES = new Set(["StaticText", "strong", "emphasis", "link"]);
const MAX_INTRO_NODES = 12;

/**
 * The question shown above a group of options. A labelled wrapper gives it directly; plain prose
 * arrives as a run of sibling text, bold, and link nodes, so those are joined, keeping the tail
 * nearest the options.
 */
const introText = (nodes: Node[], before: number, depth: number) => {
  const nearest = previousSibling(nodes, before, depth);
  const nearestNode = nodes[nearest];
  if (!nearestNode) return { text: "", required: false };
  if (!TEXTUAL_ROLES.has(nearestNode.role)) return subtreeText(nodes, nearest);
  const parts: string[] = [];
  for (let index = nearest, count = 0; index >= 0 && count < MAX_INTRO_NODES; index = previousSibling(nodes, index, depth), count++) {
    const node = nodes[index];
    if (!node || !TEXTUAL_ROLES.has(node.role)) break;
    parts.unshift(node.role === "StaticText" || node.role === "link" ? node.name : subtreeText(nodes, index).text);
  }
  return { text: normalize(parts.join(" ")).slice(-MAX_GROUP_LABEL_CHARS), required: false };
};

/** Yes/No style rows: a bare container whose only children are short buttons, introduced by a label. */
const buttonGroups = (nodes: Node[]): ChoiceGroup[] =>
  nodes.flatMap((node, index) => {
    if (node.role !== "generic" || node.name) return [];
    const children = [];
    for (const child of nodes.slice(index + 1)) {
      if (child.depth <= node.depth) break;
      children.push(child);
    }
    const buttons = children.flatMap((child) => (child.depth === node.depth + 1 && child.role === "button" && child.ref ? [{ name: normalize(child.name), ref: child.ref }] : []));
    const onlyShortButtons = buttons.length >= 2 && buttons.length === children.length && buttons.every((button) => button.name && button.name.length <= MAX_CHOICE_CHARS);
    const labelIndex = previousSibling(nodes, index, node.depth);
    if (!onlyShortButtons || nodes[labelIndex]?.role !== "LabelText") return [];
    const { text, required } = subtreeText(nodes, labelIndex);
    return text ? [{ label: text, required, choices: buttons }] : [];
  });

/**
 * Radio groups. The question is the group's own name when it has one; otherwise it is the text
 * of the sibling just before the first option, which is how Ashby lays them out.
 */
const radioGroups = (nodes: Node[]): ChoiceGroup[] => {
  const groups: { first: number; childDepth: number; choices: Choice[]; required: boolean }[] = [];
  let previous = -1;
  nodes.forEach((node, index) => {
    if (node.role !== "radio" || !node.ref) return;
    const parentIndex = previousSibling(nodes, index, node.depth - 1);
    const parent = nodes[parentIndex];
    const wrapped = parent?.role === "LabelText";
    const childDepth = wrapped ? node.depth - 1 : node.depth;
    const current = groups[groups.length - 1];
    const sameGroup =
      current !== undefined &&
      current.childDepth === childDepth &&
      !nodes.slice(previous + 1, index).some((between) => between.depth <= childDepth && between.role !== "LabelText" && between.role !== "radio");
    const choice = { name: normalize(node.name), ref: node.ref };
    const required = node.attrs.includes("required");
    if (sameGroup) {
      current.choices.push(choice);
      current.required ||= required;
    } else {
      // The question comes before the first option's wrapper, not before the radio inside it.
      groups.push({ first: wrapped ? parentIndex : index, childDepth, choices: [choice], required });
    }
    previous = index;
  });

  return groups.flatMap(({ first, childDepth, choices, required }) => {
    const owner = nodes[previousSibling(nodes, first, childDepth - 1)];
    const named = owner && (owner.role === "radiogroup" || owner.role === "group") && owner.name ? normalize(owner.name) : "";
    const intro = introText(nodes, first, childDepth);
    const label = named || intro.text;
    return label ? [{ label, required: required || intro.required, choices }] : [];
  });
};

const choiceGroups = (nodes: Node[]): ChoiceGroup[] => [...radioGroups(nodes), ...buttonGroups(nodes)];

const toChoiceFields = (nodes: Node[]): Field[] =>
  withOrdinals(
    choiceGroups(nodes).map((group) => ({
      label: group.label,
      kind: "choice" as const,
      required: group.required,
      value: "",
      ref: group.choices[0]?.ref ?? "",
      options: group.choices.map((choice) => choice.name)
    }))
  );

/** Picks the option closest to `wanted`: exact, then prefix, then substring, ignoring case. */
const matchOption = (options: string[], wanted: string) => {
  const target = normalize(wanted).toLowerCase();
  const lowered = options.map((option) => normalize(option).toLowerCase());
  const index = [
    lowered.indexOf(target),
    lowered.findIndex((option) => option.startsWith(target)),
    lowered.findIndex((option) => option.includes(target))
  ].find((candidate) => candidate >= 0);
  return index === undefined ? null : (options[index] ?? null);
};

const run = async (args: string[]): Promise<Result<string>> => {
  const proc = Bun.spawn([BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  clearTimeout(timer);
  const out = stdout.trim();
  if (code !== 0 || out.startsWith("✗")) {
    return Result.err(`agent-browser ${args[0]} failed: ${(out || stderr).trim().slice(0, 300) || `exit code ${code}`}`);
  }
  return Result.ok(out);
};

const RENDER_RETRIES = 3;
const RENDER_RETRY_WAIT_MS = 600;

/** Single-page apps briefly render nothing while they update, so empty or failed snapshots are retried. */
const nodes = async (interactive: boolean): Promise<Result<Node[]>> => {
  let last: Result<Node[]> = Result.err("snapshot was never taken");
  for (let attempt = 0; attempt < RENDER_RETRIES; attempt++) {
    const snapshot = await run(interactive ? ["snapshot", "-i"] : ["snapshot"]);
    last = snapshot.ok ? Result.ok(parseSnapshot(snapshot.value)) : snapshot;
    if (last.ok && last.value.length > 0) return last;
    await run(["wait", String(RENDER_RETRY_WAIT_MS)]);
  }
  return last;
};

const fieldRef = async (label: string, ordinal: number): Promise<Result<string>> => {
  for (let attempt = 0; attempt < RENDER_RETRIES; attempt++) {
    const snapshot = await nodes(true);
    if (!snapshot.ok) return snapshot;
    const field = toFields(snapshot.value).find((candidate) => candidate.label === normalize(label) && candidate.ordinal === ordinal);
    if (field) return Result.ok(field.ref);
    await run(["wait", String(RENDER_RETRY_WAIT_MS)]);
  }
  return Result.err(`Field not found on page: "${label}"`);
};

const clickRef = (ref: string) => run(["click", `@${ref}`]);

const OPTION_RETRY_WAIT_MS = 400;

/** Reads the options of the open dropdown. Lists render late after another dropdown closes, so an empty read gets one retry. */
const optionNodes = async (): Promise<Result<Node[]>> => {
  for (const attempt of [0, 1]) {
    const snapshot = await nodes(true);
    if (!snapshot.ok) return snapshot;
    const options = snapshot.value.filter((node) => node.role === "option" && node.ref);
    if (options.length > 0 || attempt === 1) return Result.ok(options);
    await run(["wait", String(OPTION_RETRY_WAIT_MS)]);
  }
  return Result.ok([]);
};

/** The first click after typing in a text field sometimes only blurs it, so a dropdown that shows no options gets one more click. */
const openDropdown = async (ref: string): Promise<Result<Node[]>> => {
  let options: Node[] = [];
  for (let attempt = 0; attempt < 2 && options.length === 0; attempt++) {
    const clicked = await clickRef(ref);
    if (!clicked.ok) return clicked;
    const found = await optionNodes();
    if (!found.ok) return found;
    options = found.value;
  }
  return Result.ok(options);
};

/**
 * Thin wrapper over the agent-browser CLI. Refs change after almost every action, so each
 * operation resolves its target by label from a fresh snapshot instead of caching refs.
 */
export const Browser = {
  open: async (url: string) => {
    const opened = await run(["open", url]);
    if (!opened.ok) return opened;
    return run(["wait", "1500"]);
  },
  close: () => run(["close"]),
  url: async () => {
    const url = await run(["get", "url"]);
    return url.ok ? url.value.split("\n").pop()?.trim() ?? "" : "";
  },
  title: async () => {
    const title = await run(["get", "title"]);
    return title.ok ? title.value : "";
  },
  wait: (ms: number) => run(["wait", String(ms)]),

  /** Inputs and dropdowns from the flat interactive snapshot, plus radio and button groups from the nested one. */
  fields: async (): Promise<Result<Field[]>> => {
    const flat = await nodes(true);
    if (!flat.ok) return flat;
    const nested = await nodes(false);
    return Result.ok([...toFields(flat.value), ...(nested.ok ? toChoiceFields(nested.value) : [])]);
  },

  /** Clicks the radio or button whose text best matches `wanted` inside the labelled group. */
  pickChoice: async (label: string, ordinal: number, wanted: string): Promise<Result<string>> => {
    for (let attempt = 0; attempt < RENDER_RETRIES; attempt++) {
      const snapshot = await nodes(false);
      if (!snapshot.ok) return snapshot;
      const group = choiceGroups(snapshot.value).filter((candidate) => candidate.label === normalize(label))[ordinal];
      if (group) {
        const choice = matchOption(group.choices.map((candidate) => candidate.name), wanted);
        const target = group.choices.find((candidate) => candidate.name === choice);
        if (!choice || !target) return Result.err(`No choice matching "${wanted}" for "${label}". Options: ${group.choices.map((candidate) => candidate.name).join(" | ")}.`);
        const clicked = await clickRef(target.ref);
        return clicked.ok ? Result.ok(choice) : clicked;
      }
      await run(["wait", String(RENDER_RETRY_WAIT_MS)]);
    }
    return Result.err(`Choice group not found on page: "${label}"`);
  },

  /** Visible page text from the accessibility tree, for confirmation and error detection. */
  text: async () => {
    const snapshot = await run(["snapshot"]);
    return snapshot.ok ? snapshot.value : "";
  },

  fill: async (label: string, ordinal: number, text: string) => {
    const ref = await fieldRef(label, ordinal);
    return ref.ok ? run(["fill", `@${ref.value}`, text]) : ref;
  },

  setChecked: async (label: string, ordinal: number, checked: boolean) => {
    const ref = await fieldRef(label, ordinal);
    return ref.ok ? run([checked ? "check" : "uncheck", `@${ref.value}`]) : ref;
  },

  /** Opens a dropdown, reads its options, and closes it again. */
  options: async (label: string, ordinal: number): Promise<Result<string[]>> => {
    const ref = await fieldRef(label, ordinal);
    if (!ref.ok) return ref;
    const found = await openDropdown(ref.value);
    await run(["press", "Escape"]);
    return found.ok ? Result.ok(found.value.map((node) => node.name)) : found;
  },

  pick: async (label: string, ordinal: number, wanted: string): Promise<Result<string>> => {
    const ref = await fieldRef(label, ordinal);
    if (!ref.ok) return ref;
    const found = await openDropdown(ref.value);
    if (!found.ok) return found;
    const choice = matchOption(found.value.map((node) => node.name), wanted);
    const target = found.value.find((node) => node.name === choice);
    if (!choice || !target?.ref) {
      await run(["press", "Escape"]);
      const seen = found.value.slice(0, 6).map((node) => node.name).join(" | ");
      return Result.err(`No option matching "${wanted}" for "${label}". ${found.value.length} options seen${seen ? `, first: ${seen}` : ""}.`);
    }
    const clicked = await clickRef(target.ref);
    return clicked.ok ? Result.ok(choice) : clicked;
  },

  clickButton: async (name: RegExp): Promise<Result<string>> => {
    const snapshot = await nodes(true);
    if (!snapshot.ok) return snapshot;
    const button = snapshot.value.find((node) => (node.role === "button" || node.role === "link") && node.ref && name.test(node.name));
    if (!button?.ref) return Result.err(`No button matching ${name} on the page.`);
    const clicked = await clickRef(button.ref);
    return clicked.ok ? Result.ok(button.name) : clicked;
  },

  /** Types into a box that auto-advances between characters, such as an emailed security code. */
  typeInto: async (label: RegExp, text: string): Promise<Result<string>> => {
    const snapshot = await nodes(true);
    if (!snapshot.ok) return snapshot;
    const box = toFields(snapshot.value).find((field) => label.test(field.label));
    if (!box) return Result.err(`No field matching ${label} on the page.`);
    const focused = await clickRef(box.ref);
    return focused.ok ? run(["keyboard", "type", text]) : focused;
  },

  upload: (selector: string, path: string) => run(["upload", selector, path]),
  screenshot: (path: string) => run(["screenshot", "--full", path]),
  pdf: (path: string) => run(["pdf", path])
} as const;

export const BrowserParsing = { parseSnapshot, toFields, toChoiceFields, matchOption, normalize } as const;
