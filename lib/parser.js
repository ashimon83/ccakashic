'use strict';

const fs = require('fs');
const readline = require('readline');
const path = require('path');

async function parseSession(sessionPath) {
  const lines = await readJsonlLines(sessionPath);
  const messages = buildConversation(lines);

  // Check for subagent conversations
  const sessionId = path.basename(sessionPath, '.jsonl');
  const subagentsDir = path.join(path.dirname(sessionPath), sessionId, 'subagents');
  const subagents = {};

  if (fs.existsSync(subagentsDir)) {
    const agentFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
    for (const f of agentFiles) {
      const agentLines = await readJsonlLines(path.join(subagentsDir, f));
      const agentMessages = buildConversation(agentLines);
      // Extract agent ID from filename: agent-a1234.jsonl → a1234
      const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      subagents[agentId] = agentMessages;
    }
  }

  // Inline subagent conversations into the main message list
  inlineSubagents(messages, subagents);

  // Aggregate token usage stats
  const stats = aggregateUsage(lines);

  return { messages, subagents: {}, sessionPath, stats };
}

function aggregateUsage(lines) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let turns = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const line of lines) {
    if (line.timestamp) {
      if (!firstTimestamp) firstTimestamp = line.timestamp;
      lastTimestamp = line.timestamp;
    }

    if (line.type === 'assistant') {
      const usage = line.message?.usage;
      if (usage) {
        turns++;
        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cacheCreation += usage.cache_creation_input_tokens || 0;
        cacheRead += usage.cache_read_input_tokens || 0;
      }
    }
  }

  const totalInput = inputTokens + cacheCreation + cacheRead;
  const totalTokens = totalInput + outputTokens;
  const cacheTotal = cacheCreation + cacheRead;
  const cacheHitRate = cacheTotal > 0 ? cacheRead / cacheTotal : 0;

  let durationMs = 0;
  if (firstTimestamp && lastTimestamp) {
    durationMs = new Date(lastTimestamp) - new Date(firstTimestamp);
  }

  return {
    turns,
    inputTokens,
    outputTokens,
    cacheCreation,
    cacheRead,
    totalTokens,
    cacheHitRate,
    durationMs,
  };
}

function readJsonlLines(filePath) {
  return new Promise((resolve) => {
    const lines = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        lines.push(JSON.parse(line));
      } catch {
        // skip
      }
    });

    rl.on('close', () => resolve(lines));
    rl.on('error', () => resolve(lines));
  });
}

function buildConversation(lines) {
  const messages = [];

  // Deduplicate assistant messages by message.id (streaming: keep last)
  const assistantById = new Map();
  for (const line of lines) {
    if (line.type === 'assistant' && line.message?.id) {
      assistantById.set(line.message.id, line);
    }
  }
  const seenAssistantIds = new Set();

  for (const line of lines) {
    // Skip metadata-only types
    if (['file-history-snapshot', 'last-prompt', 'permission-mode'].includes(line.type)) {
      continue;
    }

    if (line.type === 'user') {
      processUserMessage(line, messages);
    } else if (line.type === 'assistant') {
      // Deduplicate: skip if we've already processed this message.id
      const msgId = line.message?.id;
      if (msgId) {
        if (seenAssistantIds.has(msgId)) continue;
        // Only process the final version
        if (assistantById.get(msgId) !== line) continue;
        seenAssistantIds.add(msgId);
      }
      processAssistantMessage(line, messages);
    } else if (line.type === 'system') {
      processSystemMessage(line, messages);
    }
    // Skip progress, queue-operation, etc.
  }

  // Pair tool_use with tool_result
  pairToolMessages(messages);

  return messages;
}

function parseLocalCommand(text) {
  // Parse <bash-input>, <bash-stdout>, <bash-stderr> tags
  const inputMatch = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  const stdoutMatch = text.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
  const stderrMatch = text.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);

  if (inputMatch) {
    return { type: 'local_command', subtype: 'input', command: inputMatch[1] };
  }
  if (stdoutMatch || stderrMatch) {
    return {
      type: 'local_command',
      subtype: 'output',
      stdout: stdoutMatch ? stdoutMatch[1] : '',
      stderr: stderrMatch ? stderrMatch[1] : '',
    };
  }
  return null;
}

function processUserText(text, line, messages) {
  // Skip local-command-caveat (system instruction, not user input)
  if (text.match(/^<local-command-caveat>/)) {
    return;
  }

  // Parse local command input/output
  const localCmd = parseLocalCommand(text);
  if (localCmd) {
    if (localCmd.subtype === 'input') {
      messages.push({
        type: 'local_command',
        command: localCmd.command,
        timestamp: line.timestamp,
        uuid: line.uuid,
      });
    } else if (localCmd.subtype === 'output') {
      // Attach to previous local_command if exists
      const prev = messages.length > 0 ? messages[messages.length - 1] : null;
      if (prev && prev.type === 'local_command' && !prev.stdout) {
        prev.stdout = localCmd.stdout;
        prev.stderr = localCmd.stderr;
      } else {
        messages.push({
          type: 'local_command',
          command: '',
          stdout: localCmd.stdout,
          stderr: localCmd.stderr,
          timestamp: line.timestamp,
          uuid: line.uuid,
        });
      }
    }
    return;
  }

  // Strip system-reminder tags but keep surrounding user text
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();

  if (stripped) {
    messages.push({
      type: 'user',
      text: stripped,
      timestamp: line.timestamp,
      uuid: line.uuid,
    });
  }
}

function processUserMessage(line, messages) {
  const content = line.message?.content;
  if (!content) return;

  if (typeof content === 'string') {
    if (content.trim()) {
      processUserText(content, line, messages);
    }
    return;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) {
        processUserText(block.text, line, messages);
      } else if (block.type === 'tool_result') {
        const toolResult = {
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          timestamp: line.timestamp,
          uuid: line.uuid,
        };

        // Extract structured result from toolUseResult
        if (line.toolUseResult) {
          toolResult.richResult = line.toolUseResult;
        }

        // Raw content
        if (typeof block.content === 'string') {
          toolResult.content = block.content;
        } else if (Array.isArray(block.content)) {
          const texts = block.content
            .filter(b => b.type === 'text')
            .map(b => b.text);
          toolResult.content = texts.join('\n');
        }

        // Try to read persisted output
        if (toolResult.content && toolResult.content.includes('<persisted-output>')) {
          const match = toolResult.content.match(/Full output saved to: ([^\n<]+)/);
          if (match) {
            const persistedPath = match[1].trim();
            try {
              if (fs.existsSync(persistedPath)) {
                toolResult.fullContent = fs.readFileSync(persistedPath, 'utf-8');
              }
            } catch {
              // ignore
            }
          }
        }

        messages.push(toolResult);
      }
    }
  }
}

function processAssistantMessage(line, messages) {
  const content = line.message?.content;
  if (!content || !Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'thinking') {
      messages.push({
        type: 'thinking',
        timestamp: line.timestamp,
        uuid: line.uuid,
      });
    } else if (block.type === 'text' && block.text?.trim()) {
      messages.push({
        type: 'assistant',
        text: block.text,
        model: line.message.model,
        timestamp: line.timestamp,
        uuid: line.uuid,
      });
    } else if (block.type === 'tool_use') {
      messages.push({
        type: 'tool_use',
        toolName: block.name,
        toolUseId: block.id,
        input: block.input,
        timestamp: line.timestamp,
        uuid: line.uuid,
      });
    }
  }
}

function processSystemMessage(line, messages) {
  if (line.subtype === 'turn_duration') {
    messages.push({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: line.durationMs,
      timestamp: line.timestamp,
    });
  } else if (line.subtype === 'bridge_status') {
    // skip
  } else if (line.content) {
    messages.push({
      type: 'system',
      subtype: line.subtype || 'info',
      content: typeof line.content === 'string' ? line.content : JSON.stringify(line.content),
      timestamp: line.timestamp,
    });
  }
}

function inlineSubagents(messages, subagents) {
  if (!Object.keys(subagents).length) return;

  // For each Agent tool_use that has a paired result, extract agentId from the result content
  for (const msg of messages) {
    if (msg.type !== 'tool_use' || msg.toolName !== 'Agent') continue;
    if (!msg.result) continue;

    const content = msg.result.content || msg.result.fullContent || '';
    const match = content.match(/agentId:\s*([a-f0-9]+)/);
    if (match) {
      const agentId = match[1];
      if (subagents[agentId]) {
        msg.subagentMessages = subagents[agentId];
        msg.subagentId = agentId;
      }
    }
  }

  // Fallback: match remaining subagents by description in meta files
  const usedIds = new Set(
    messages.filter(m => m.subagentId).map(m => m.subagentId)
  );
  const unmatchedAgents = Object.keys(subagents).filter(id => !usedIds.has(id));

  if (unmatchedAgents.length) {
    for (const msg of messages) {
      if (msg.type !== 'tool_use' || msg.toolName !== 'Agent') continue;
      if (msg.subagentMessages) continue;

      const desc = (msg.input?.description || '').toLowerCase();
      if (!desc) continue;

      for (let i = unmatchedAgents.length - 1; i >= 0; i--) {
        const agentId = unmatchedAgents[i];
        // Check first user message of subagent for matching description
        const firstMsg = subagents[agentId]?.[0];
        if (firstMsg?.type === 'user') {
          const agentText = (firstMsg.text || '').toLowerCase();
          if (agentText.includes(desc) || desc.includes(agentText.slice(0, 30))) {
            msg.subagentMessages = subagents[agentId];
            msg.subagentId = agentId;
            unmatchedAgents.splice(i, 1);
            break;
          }
        }
      }
    }
  }
}

function pairToolMessages(messages) {
  // Build map of tool_use id → index
  const toolUseMap = new Map();
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type === 'tool_use') {
      toolUseMap.set(messages[i].toolUseId, i);
    }
  }

  // Attach tool_result to corresponding tool_use
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type === 'tool_result' && messages[i].toolUseId) {
      const useIdx = toolUseMap.get(messages[i].toolUseId);
      if (useIdx !== undefined) {
        messages[useIdx].result = messages[i];
        messages[i]._paired = true;
      }
    }
  }

  // Remove paired tool_results (they're now nested in tool_use)
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._paired) {
      messages.splice(i, 1);
    }
  }
}

module.exports = { parseSession };
