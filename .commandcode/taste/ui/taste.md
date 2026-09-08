# UI taste

- Prefers chat UIs where a single user turn produces ONE consolidated assistant bubble — all thinking, text, and tool-call cards render inside the same bubble, rather than opening a new bubble per tool call or thinking step. Confidence: 0.85
- Prefers thinking/reasoning content collapsed by default (toggleable summary), not expanded inline. Confidence: 0.85
- Likes motion effects that signal in-progress states: e.g. an animated "thinking" indicator (shimmer text, pulsing dots) while the model reasons, and a spinner + pulsing border on tool cards while a tool executes, swapped for a green ✓ when it finishes. Confidence: 0.85
- Prefers compact, single-line tool-call cards in chat UIs: tool name plus the most relevant argument only (Bash `command`, otherwise `file_path`/`pattern`/`query`, etc.); never show the `description` field or the full JSON input, and ellipsize long values. Confidence: 0.8
