const DEFAULT_MAX_LENGTH = 4000;

/**
 * Return the text from the final assistant message in a normalized transcript,
 * as { text, truncated }. Tool calls and thinking blocks are deliberately
 * ignored: the overview hover is a preview of what the assistant ultimately
 * said to the user. `truncated` lets the hover say so instead of ending
 * mid-sentence with no sign that there is more.
 */
function lastAssistantMessage(entries, maxLength = DEFAULT_MAX_LENGTH) {
  if (!Array.isArray(entries)) return { text: '', truncated: false };

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || (entry.type !== 'assistant' && entry.message?.role !== 'assistant')) continue;

    const content = entry.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n\n');
    }

    text = text.replace(/\r\n?/g, '\n').trim();
    if (!text) continue;
    if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) return { text, truncated: false };
    return { text: text.slice(0, maxLength).trimEnd(), truncated: true };
  }

  return { text: '', truncated: false };
}

// A path as the last few segments, so a line stays readable.
function shortPath(p, keep = 3) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length > keep ? '\u2026/' + parts.slice(-keep).join('/') : parts.join('/');
}

function firstLine(text, max = 160) {
  const line = String(text || '').trim().split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '\u2026' : line;
}

/** One line for a tool call: what the agent is doing with it. */
function describeToolUse(block) {
  const name = block.name || '';
  const input = block.input || {};
  switch (name) {
    case 'Bash':
      return input.description ? `Running: ${firstLine(input.description)}` : `Running \`${firstLine(input.command, 120)}\``;
    case 'Edit': case 'MultiEdit': return `Editing ${shortPath(input.file_path)}`;
    case 'Write': return `Writing ${shortPath(input.file_path)}`;
    case 'Read': return `Reading ${shortPath(input.file_path)}`;
    case 'NotebookEdit': return `Editing ${shortPath(input.notebook_path)}`;
    case 'Grep': return `Searching for \`${firstLine(input.pattern, 80)}\``;
    case 'Glob': return `Finding files \`${firstLine(input.pattern, 80)}\``;
    case 'Task': case 'Agent': return `Running an agent: ${firstLine(input.description || input.prompt, 120)}`;
    case 'WebFetch': return `Reading ${firstLine(input.url, 120)}`;
    case 'WebSearch': return `Searching the web: ${firstLine(input.query, 120)}`;
    case 'TodoWrite': {
      const current = (input.todos || []).find(t => t.status === 'in_progress');
      return current ? firstLine(current.activeForm || current.content) : 'Updating its todo list';
    }
    default: return name ? `Using ${name}` : '';
  }
}

/**
 * What the agent is doing right now, as one line: its latest step in the
 * transcript. A tool call is described ("Editing …/Migrate.php") and thinking
 * is "Thinking…". When the latest step is text it says nothing: that text is
 * the last message, which is shown on its own.
 */
function currentActivity(entries) {
  if (!Array.isArray(entries)) return '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || (entry.type !== 'assistant' && entry.message?.role !== 'assistant')) continue;
    const content = entry.message?.content;
    if (typeof content === 'string') { if (content.trim()) return ''; continue; }
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (!block) continue;
      if (block.type === 'tool_use') { const line = describeToolUse(block); if (line) return line; }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') return 'Thinking\u2026';
      if (block.type === 'text' && block.text?.trim()) return '';
    }
  }
  return '';
}

module.exports = { DEFAULT_MAX_LENGTH, lastAssistantMessage, currentActivity, describeToolUse };
