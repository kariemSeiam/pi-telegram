// src/telegram/tool-prompt.ts — AI tool registration & system-prompt append text

export interface AiToolDefinition {
  name: string;
  instructions: string;
}

export class AiToolRegistry {
  private readonly tools: AiToolDefinition[] = [];

  register(tool: AiToolDefinition): this {
    this.tools.push(tool);
    return this;
  }

  renderInstructions(): string {
    if (!this.tools.length) return "";
    const blocks = this.tools.map((t, i) => `# Tool ${i + 1}: ${t.name}\n${t.instructions}`);
    return [
      "You can use the following bridge tool protocol. Use only when needed.",
      ...blocks,
      "If no tool call needed, just answer normally.",
    ].join("\n\n");
  }
}

const telegramAttachmentTool: AiToolDefinition = {
  name: "tg-attachment",
  instructions: [
    "When you need Telegram to send an attachment/media, output a <tg-attachment> tag in your reply.",
    "Supported sources: file_id, URL, local path, upload content (encoding=base64|text).",
    "Supported types as: photo | document | video | audio | animation | voice | video_note | sticker.",
    "Do not wrap tags in markdown code blocks.",
    "URL/file_id/path can use self-closing tags.",
    "Upload content uses paired tags, recommended with filename.",
    "Local path refers to the server path where Pi-Telegram runs, not the user's device path.",
    "Example 1 (file_id): <tg-attachment as=\"photo\" file_id=\"AgAC...\" />",
    "Example 2 (URL): <tg-attachment as=\"document\" url=\"https://example.com/a.pdf\" />",
    "Example 3 (local path): <tg-attachment as=\"document\" path=\"C:/data/report.pdf\" />",
    "Example 4 (upload text): <tg-attachment as=\"document\" filename=\"note.txt\" encoding=\"text\">hello</tg-attachment>",
    "Example 5 (upload binary): <tg-attachment as=\"video\" filename=\"clip.mp4\" encoding=\"base64\">...</tg-attachment>",
  ].join("\n"),
};

const telegramReplyTool: AiToolDefinition = {
  name: "tg-reply",
  instructions: [
    "When you want to reply to a specific historical message (from the user or yourself), output a <tg-reply ... /> tag.",
    "You can reply to the entire message, or quote a specific segment (quote).",
    "Common attributes:",
    "- from: any | user | self (default any)",
    "- contains: used to locate the target message (target message text must contain this)",
    "- quote: the substring to quote (optional, if omitted just reply by message)",
    "- message_id: reply directly by message ID (optional, highest priority)",
    "Example 1: <tg-reply from=\"user\" contains=\"this plan is unsafe\" quote=\"unsafe\" />",
    "Example 2: <tg-reply from=\"self\" contains=\"my previous conclusion\" />",
    "Example 3: <tg-reply message_id=\"1234\" quote=\"key paragraph\" />",
    "The tg-reply tag can appear alongside body text and tg-attachment.",
  ].join("\n"),
};

const telegramCronTool: AiToolDefinition = {
  name: "tg-cron",
  instructions: [
    "When you need to manage scheduled tasks within a Telegram chat, output a <tg-cron ... /> tag.",
    "Supported action: add | list | stat | on | off | del | run | rename.",
    "add requires kind: at | every | cron.",
    "add(kind=at) requires at (ISO time) and prompt (task content, can be in tag body).",
    "add(kind=every) requires every (e.g. 10m/2h/1d) and prompt.",
    "add(kind=cron) requires expr (cron expression) and prompt, optional timezone.",
    "on/off/del/run require id.",
    "rename requires id and name (or tag body as name).",
    "Do not wrap tags in markdown code blocks.",
    "Example 1: <tg-cron action=\"add\" kind=\"every\" every=\"30m\" prompt=\"Check alerts and summarize\" />",
    "Example 2: <tg-cron action=\"add\" kind=\"cron\" expr=\"0 9 * * 1-5\" timezone=\"Asia/Shanghai\" prompt=\"Weekday morning report\" />",
    "Example 3: <tg-cron action=\"list\" />",
    "Example 4: <tg-cron action=\"off\" id=\"abcd1234\" />",
    "Example 5: <tg-cron action=\"rename\" id=\"abcd1234\" name=\"Weekday morning report\" />",
  ].join("\n"),
};

const defaultRegistry = new AiToolRegistry()
  .register(telegramReplyTool)
  .register(telegramAttachmentTool)
  .register(telegramCronTool);

export function getRegisteredToolSystemPrompt(): string {
  return defaultRegistry.renderInstructions();
}
