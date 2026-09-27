---
type: llm
---
The plan (a) produces several candidate coin sounds rather than a single one, (b) inspects each render objectively (measurements, lint, or looking at a waveform/spectrogram image) because the agent cannot hear, (c) has the human listen to and choose among the candidates before the sound is considered done, and (d) does not hard-code a loudness level into the sound itself (levels are matched to a target automatically). Fail if the plan delivers one sound as finished without the human choosing, or if it skips objective inspection.
