---
type: llm
---
The answer tells the user to check and then (re)install the agent-beeps managed runtime with the plugin's setup script (a --check run, then an install run, then check again for ok), which installs Chromium for rendering, and does not suggest installing dependencies into the plugin cache or making unrelated system changes. Fail if it proposes a generic fix (e.g. a global Playwright or Chrome install) instead of the plugin's setup script.
